import csv
import os
import subprocess
from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime, time, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest
import revision_2_seed as seed
import test_revision_2_projection as g1
from sqlalchemy import MetaData, Table, and_, text

from transit_ops.batch.build import BuildRequest, FamilyBuilder, FamilyOutput, InputNeed, TableRows
from transit_ops.batch.compare import RUNTIME_ONLY_COLUMNS, compare_bodies, compare_tables
from transit_ops.batch.families.registry import FAMILIES, resolve_builder
from transit_ops.batch.pg_load import pinned_replay_engine, prepare_replay_database
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import key_matches, run_family
from transit_ops.gold import delay_hours
from transit_ops.history.datasets import TableSource, get_dataset
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window

PROVEN_FAMILIES: tuple[str, ...] = ("occupancy_crowding",)


@pytest.mark.parametrize("base", ["numrange", "nummultirange"])
def test_reader_refuses_ranges_through_domains(real_db_engine, base):
    with real_db_engine.connect() as conn, conn.begin() as transaction:
        try:
            conn.exec_driver_sql(
                "CREATE TEMP TABLE domain_probe ON COMMIT DROP AS "
                "SELECT 'seed'::text provider_id, 1 id"
            )
            schema = conn.exec_driver_sql(
                "SELECT pg_my_temp_schema()::regnamespace::text"
            ).scalar_one()
            value = "[1.50,2.50)" if base == "numrange" else "{[1.50,2.50)}"
            for name in ("direct", "nested"):
                conn.exec_driver_sql(f"CREATE DOMAIN pg_temp.reader_{name} AS {base}")
                conn.exec_driver_sql(
                    f"ALTER TABLE domain_probe ADD bad pg_temp.reader_{name} DEFAULT '{value}'"
                )
                with pytest.raises(ValueError, match=rf"{schema}.domain_probe.bad"):
                    read_table_rows(
                        conn,
                        f"{schema}.domain_probe",
                        ("id",),
                        provider_id="seed",
                        local_dates=None,
                    )
                conn.exec_driver_sql("ALTER TABLE domain_probe DROP bad")
                base = "pg_temp.reader_direct"
        finally:
            transaction.rollback()


def test_reader_refuses_dbapi_autocommit(real_db_engine):
    with real_db_engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
        original = conn.exec_driver_sql(
            "SELECT current_setting('extra_float_digits'), current_setting('TimeZone')"
        ).one()
        try:
            conn.exec_driver_sql(
                "CREATE TEMP TABLE autocommit_probe AS SELECT "
                "'seed'::text provider_id, 1 id, "
                "0.30000000000000004::float8 value, now() stamp"
            )
            conn.exec_driver_sql(
                "SELECT set_config('extra_float_digits','0',false), "
                "set_config('TimeZone','America/Toronto',false)"
            )
            schema = conn.exec_driver_sql(
                "SELECT pg_my_temp_schema()::regnamespace::text"
            ).scalar_one()
            assert conn.in_transaction()  # SQLAlchemy's transaction flag is not DBAPI autocommit.
            with pytest.raises(ValueError, match=rf"{schema}.autocommit_probe.*DBAPI autocommit"):
                read_table_rows(
                    conn,
                    f"{schema}.autocommit_probe",
                    ("id",),
                    provider_id="seed",
                    local_dates=None,
                )
        finally:
            conn.exec_driver_sql("DROP TABLE IF EXISTS autocommit_probe")
            conn.execute(
                text(
                    "SELECT set_config('extra_float_digits',:digits,false), "
                    "set_config('TimeZone',:zone,false)"
                ),
                dict(digits=original[0], zone=original[1]),
            )


@pytest.mark.parametrize("fault", [None, "numrange", "nummultirange", "session", "null"])
def test_reader_preserves_postgres_text_and_sorts_keys(real_db_engine, fault):
    with real_db_engine.connect() as conn, conn.begin():
        conn.exec_driver_sql("""
            CREATE TEMP TABLE reader_probe ON COMMIT DROP AS
            SELECT 'seed'::text provider_id, DATE '2025-06-03' provider_local_date, n id,
                   CASE WHEN n=2 THEN 1.500 END amount,
                   CASE WHEN n=2 THEN '{1.50,NULL}'::numeric[] END items,
                   CASE WHEN n=2 THEN '{"a": 1.00}'::jsonb END payload,
                   0.30000000000000004::float8 value, now() stamp,
                   INTERVAL '1 month 2 days' span, TIMETZ '12:00:00+03' clock
            FROM generate_series(2,1,-1) n
        """)
        schema = conn.exec_driver_sql("SELECT pg_my_temp_schema()::regnamespace::text").scalar_one()
        rel = f"{schema}.reader_probe"
        if fault in {"numrange", "nummultirange"}:
            value = "[1.50,2.50)" if fault == "numrange" else "{[1.50,2.50)}"
            conn.exec_driver_sql(f"ALTER TABLE reader_probe ADD bad {fault} DEFAULT '{value}'")
        if fault == "null":
            conn.exec_driver_sql("UPDATE reader_probe SET id=NULL WHERE id=1")
        if fault in {"numrange", "nummultirange", "null"}:
            column = "id.*NULL" if fault == "null" else "bad"
            with pytest.raises(ValueError, match=rf"{rel}.{column}"):
                read_table_rows(conn, rel, ("id",), provider_id="seed", local_dates=None)
            return
        conn.exec_driver_sql("SET LOCAL extra_float_digits=0")
        conn.exec_driver_sql("SET LOCAL TimeZone='America/Toronto'")
        rows = read_table_rows(conn, rel, ("id",), provider_id="seed", local_dates=seed.DAYS)
        assert [r[2] for r in rows.rows] == [1, 2]
        assert rows.rows[0][3:6] == (None, None, None)
        assert rows.rows[1][3:6] == ("1.500", "{1.50,NULL}", '{"a": 1.00}')
        assert rows.rows[0][6] == 0.30000000000000004
        assert rows.rows[0][7].utcoffset() == timedelta(0)
        assert rows.rows[0][8:] == ("P1M2D", "12:00:00+03")
        assert read_table_rows(conn, rel, ("id",), provider_id="seed", local_dates=()).rows == ()
        assert read_table_rows(conn, rel, ("id",), provider_id="other", local_dates=None).rows == ()
        with pytest.raises(ValueError, match="missing"):
            read_table_rows(conn, rel, ("missing",), provider_id="seed", local_dates=None)


@pytest.fixture
def replay(real_db_engine, tmp_path, monkeypatch):
    url = real_db_engine.url.render_as_string(hide_password=False)
    db = prepare_replay_database(url, os.environ)
    settings = seed.settings_for(tmp_path)
    monkeypatch.setattr(seed, "pinned_engine", lambda _, stamp: pinned_replay_engine(db, stamp))
    monkeypatch.setattr(seed.rollups, "PERCENTILE_LOOKBACK_DAYS", seed.RETENTION_DAYS - 1)
    modules = "settings_module line_history network_history network_trend provenance stop_history"
    for name in modules.split():
        monkeypatch.setattr(getattr(g1, name), "get_settings", lambda: settings)
    g1._pin(monkeypatch, seed.HISTORY_CLOCK)
    try:
        yield db, settings, tmp_path
    finally:
        seed.delete_rows(db.engine)
        db.engine.dispose()


@contextmanager
def seed_round(replay):
    db, settings, root = replay
    seed.delete_rows(db.engine)
    seed.seed_history(db.engine, settings, root)
    # Extend G1's fixed build stamp to runtime materializations, before either engine reads them.
    with db.engine.begin() as conn:
        tables = conn.exec_driver_sql(
            "SELECT table_name FROM information_schema.columns WHERE "
            "table_schema='gold' AND column_name='built_at_utc' AND table_name IN "
            "(SELECT table_name FROM information_schema.columns WHERE table_schema='gold' "
            "AND column_name='provider_id')"
        ).scalars()
        for table in list(tables):
            quoted = conn.dialect.identifier_preparer.quote_identifier(table)
            conn.execute(
                text(
                    f"UPDATE gold.{quoted} SET built_at_utc=:stamp WHERE provider_id=ANY(:ids) "
                    "AND built_at_utc IS NOT NULL"
                ),
                dict(stamp=seed.BUILD_CLOCK, ids=list(seed.PROVIDERS.values())),
            )
    with pinned_replay_engine(db, seed.HISTORY_CLOCK) as engine:
        seed.seed_live(engine, settings, root, seed.HISTORY_CLOCK)
        yield engine, settings, root


@pytest.fixture
def seeded(replay):
    with seed_round(replay) as run:
        yield run


def _bodies(engine, settings, provider):
    bodies = {}
    for tier in ("static", "historic", "live"):
        result, files = g1._publish(engine, settings, provider, tier)
        assert result.gate_report is not None and result.gate_report["errors"] == 0
        assert not bodies.keys() & files.keys()
        bodies.update(files)
    return bodies


def test_postgres_path_repeats_byte_for_byte(replay):
    rounds = []
    for _ in range(2):
        with seed_round(replay) as (engine, settings, _root):
            rounds.append({p: _bodies(engine, settings, p) for p in seed.PROVIDERS.values()})
    for provider, first in rounds[0].items():
        assert first and compare_bodies(first, rounds[1][provider]) == []


@pytest.mark.parametrize("zone,day", [("Asia/Tokyo", "03"), ("America/Toronto", "02")])
def test_window_filter_keeps_null_empty_and_multiline_text(tmp_path, zone, day):
    path = tmp_path / "window.csv"
    selected = "".join(f"2025-06-03 00:00:00+00,{v}\n" for v in ("", '""', '"été\ntext"'))
    path.write_bytes(("stamp,value\n" + selected + "2025-06-05 00:00:00+00,other\n").encode())
    result = filter_window(path, "stamp", f"local:2025-06-{day}", timezone=zone)
    assert result.read_bytes() == ("stamp,value\n" + selected).encode()


def filter_window(csv_path, column, window, *, timezone):
    filtered = csv_path.with_suffix(".filtered.csv")
    with (
        csv_path.open(newline="", encoding="utf8") as stream,
        filtered.open("w", newline="", encoding="utf8") as output,
    ):
        lines = []

        def capture():
            for line in stream:
                lines.append(line)
                yield line

        reader = csv.reader(capture())
        index = next(reader).index(column)
        output.write("".join(lines))
        lines.clear()
        for row in reader:
            value = row[index]
            if window.startswith("local:") and " " in value:
                value = (
                    datetime.fromisoformat(value).astimezone(ZoneInfo(timezone)).date().isoformat()
                )
            if value[:10] == window.removeprefix("local:"):
                output.write("".join(lines))
            lines.clear()
    return filtered


def _export_inputs(engine, builder, request, root):
    for need in builder.inputs(request):
        destination = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
        destination.parent.mkdir(parents=True, exist_ok=True)
        dataset = get_dataset(need.relation)
        source = dataset.source
        assert isinstance(source, TableSource), need
        if need.window == "all" and source.window_column is not None:
            raise ValueError(f"{need.relation} window all: bounded input required")
        window = need.window.removeprefix("local:")
        with engine.connect().execution_options(isolation_level="AUTOCOMMIT") as conn:
            if window.startswith("edition:"):
                window = conn.execute(
                    text(
                        "SELECT COALESCE(checksum_sha256, content_hash) "
                        "FROM core.dataset_versions WHERE dataset_version_id=:id"
                    ),
                    {"id": int(window.split(":")[1])},
                ).scalar_one()
            if dataset.archive_grain == "month":
                window = request.as_of_utc.strftime("%Y-%m") if window == "all" else window[:7]
            exported = export_window(
                conn.connection.driver_connection,
                WindowSpec(need.relation, request.provider_id, window),
                destination.with_suffix(".csv"),
                statement_timeout_s=60,
            )
        path = exported.csv_path
        if source.window_column is not None and not need.window.startswith("edition:"):
            path = filter_window(path, source.window_column, need.window, timezone=request.timezone)
        write_window(path, exported.schema, destination, metadata={}, temp_dir=root)


def _dirty_after_load(conn, tables, provider):
    start = datetime.combine(seed.SEASON[0], time(), UTC)
    params = dict(provider_id=provider, from_utc=start, until_utc=seed.HISTORY_CLOCK)
    expected = conn.execute(delay_hours._DIRTY_HOURS, params).all()
    with conn.begin_nested() as transaction:
        for relation, rows in tables.items():
            if relation not in RUNTIME_ONLY_COLUMNS:
                continue
            schema, name = relation.split(".")
            table = Table(name, MetaData(), schema=schema, autoload_with=conn)
            # Unmasked values already compared equal; load only the clocks R21 needs, by key.
            for row in rows.rows:
                data = dict(zip(rows.columns, row, strict=True))
                where = and_(*(table.c[k] == data[k] for k in rows.key))
                stamps = {k: data[k] for k in RUNTIME_ONLY_COLUMNS[relation]}
                assert conn.execute(table.update().where(where).values(**stamps)).rowcount == 1
        assert conn.execute(delay_hours._DIRTY_HOURS, params).all() == expected
        transaction.rollback()


def test_every_implemented_family_matches_postgres_on_the_seed(seeded, record_property):
    engine, settings, root = seeded
    days = seed.DAYS
    compared = []
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    for name in FAMILIES:
        builder = resolve_builder(name)
        if builder is None:
            continue
        assert isinstance(builder, FamilyBuilder), name
        for p in seed.PROVIDERS.values():
            req = BuildRequest(p, days, seed.BUILD_CLOCK, seed.RETENTION_DAYS, 36000, str(seed.TZ))
            _export_inputs(engine, builder, req, root / name / p)
            expected = _bodies(engine, settings, p)
            inputs = root / name / p
            result = run_family(builder, req, inputs_root=inputs, workdir=root, code_commit=commit)
            with engine.connect() as conn:
                for rel, actual in result.output.tables.items():
                    dates = seed.DAYS if "provider_local_date" in actual.columns else None
                    ref = read_table_rows(conn, rel, actual.key, provider_id=p, local_dates=dates)
                    assert compare_tables(ref, actual) == [], (name, rel)
                if "gold.route_delay_hourly" in result.output.tables:
                    _dirty_after_load(conn, result.output.tables, p)
            bodies = {k: v for k, v in expected.items() if key_matches(k, builder.published_keys)}
            assert compare_bodies(bodies, result.output.bodies) == [], name
        compared.append(name)
    record_property("compared_family_count", len(compared))
    record_property("compared_families", ",".join(compared) or "(none)")
    assert compared == list(PROVEN_FAMILIES), f"Compared {len(compared)} families: {compared}"


def test_dated_all_is_refused_before_io(tmp_path):
    builder = SimpleNamespace(inputs=lambda _: (InputNeed("gold.route_delay_hourly", "all"),))
    with pytest.raises(ValueError, match="gold.route_delay_hourly.*all"):
        _export_inputs(None, builder, SimpleNamespace(), tmp_path)


def test_family_count_requires_an_independent_declaration(monkeypatch):
    monkeypatch.setitem(globals(), "PROVEN_FAMILIES", ("missing",))
    monkeypatch.setitem(globals(), "FAMILIES", {})
    check = test_every_implemented_family_matches_postgres_on_the_seed
    with pytest.raises(AssertionError):
        check((None, None, None), lambda *_: None)


def test_repeat_detects_an_unfixed_seed_identity(monkeypatch):
    ids = iter((0, 1))
    monkeypatch.setitem(globals(), "seed_round", lambda _: nullcontext((next(ids), None, None)))
    monkeypatch.setitem(globals(), "_bodies", lambda identity, *_: {"id": bytes([identity])})
    with pytest.raises(AssertionError):
        test_postgres_path_repeats_byte_for_byte((0, None, None))


def test_nonempty_family_uses_the_reference_build_stamp(seeded, monkeypatch):
    rel = "gold.route_delay_spine"
    key = get_dataset(rel).source.key_columns
    statement = text(
        "-- q:batch.clock_probe\nSELECT * REPLACE "
        f"(CAST(:stamp AS TIMESTAMPTZ) AS built_at_utc) FROM {rel} "
        f"ORDER BY {', '.join(key)}"
    )

    def build(session, request):
        result = session.execute(statement, {"stamp": request.as_of_utc})
        rows = tuple(map(tuple, result))
        assert rows
        return FamilyOutput({rel: TableRows(rel, result.columns, key, rows)}, {})

    builder = SimpleNamespace(family_id="probe", tables=(rel,), published_keys=(), variants={})
    builder.inputs = lambda r: tuple(InputNeed(rel, f"local:{d}") for d in r.local_dates)
    builder.build = build
    for name, value in dict(
        FAMILIES={"probe": None}, resolve_builder=lambda _: builder, PROVEN_FAMILIES=("probe",)
    ).items():
        monkeypatch.setitem(globals(), name, value)
    test_every_implemented_family_matches_postgres_on_the_seed(seeded, lambda *_: None)


def test_dirty_load_preserves_histograms_and_unselected_hours(seeded, monkeypatch):
    engine, _, _ = seeded
    p = next(iter(seed.PROVIDERS.values()))
    hour, spine = "gold.route_delay_hourly", "gold.route_delay_spine"
    keys = {rel: get_dataset(rel).source.key_columns for rel in (hour, spine)}
    with engine.connect() as conn:
        before = read_table_rows(conn, hour, keys[hour], provider_id=p, local_dates=None)
        hist = read_table_rows(conn, spine, keys[spine], provider_id=p, local_dates=seed.DAYS)
        assert hist.rows and any(r[hist.columns.index("delay_histogram")] for r in hist.rows)
        one = TableRows(hour, before.columns, before.key, before.rows[:1])
        row = list(one.rows[0])
        row[one.columns.index("built_at_utc")] -= timedelta(days=2)
        stale = TableRows(hour, one.columns, one.key, (tuple(row),))
        assert compare_tables(one, stale) == []
        with pytest.raises(AssertionError):
            _dirty_after_load(conn, {hour: stale, spine: hist}, p)
        _dirty_after_load(conn, {hour: one}, p)
        monkeypatch.setattr(seed, "SEASON", (seed.DAYS[1], seed.SEASON[1]))
        _dirty_after_load(conn, {hour: stale}, p)
        assert read_table_rows(conn, hour, before.key, provider_id=p, local_dates=None) == before
