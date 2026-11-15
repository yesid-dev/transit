import csv
import os
import subprocess
from contextlib import contextmanager, nullcontext
from datetime import UTC, datetime, time, timedelta
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import duckdb
import pytest
import revision_2_seed as seed
import test_revision_2_projection as g1
from psycopg import sql
from sqlalchemy import MetaData, Table, and_, text

from transit_ops.batch.build import BuildRequest, FamilyBuilder, FamilyOutput, InputNeed, TableRows
from transit_ops.batch.compare import RUNTIME_ONLY_COLUMNS, compare_bodies, compare_tables
from transit_ops.batch.families.registry import FAMILIES, resolve_builder
from transit_ops.batch.pg_load import pinned_replay_engine, prepare_replay_database
from transit_ops.batch.postgres_rows import read_table_rows
from transit_ops.batch.run import key_matches, run_family
from transit_ops.gold import delay_hours
from transit_ops.history.datasets import WORKING_ONLY, TableSource, get_dataset
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_export import WindowSpec, export_window
from transit_ops.lake.table_schema import TableSchema


def _proven_families() -> tuple[str, ...]:
    families = tuple(name for name in FAMILIES if resolve_builder(name) is not None)
    assert "occupancy_crowding" in families, families
    return families


def test_proven_families_follow_registered_builders(monkeypatch):
    builders = {"ported": object(), "pending": None, "occupancy_crowding": object()}
    monkeypatch.setitem(globals(), "FAMILIES", dict.fromkeys(builders))
    monkeypatch.setitem(globals(), "resolve_builder", builders.__getitem__)
    assert _proven_families() == ("ported", "occupancy_crowding")
    builders["pending"] = object()
    assert _proven_families() == ("ported", "pending", "occupancy_crowding")


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


def _export_seed_rows(engine, need, destination, root):
    with engine.begin() as conn:
        table = Table(
            need.relation.split(".")[1],
            MetaData(),
            schema=need.relation.split(".")[0],
            autoload_with=conn,
        )
        columns = conn.execute(
            text(
                "SELECT attname, format_type(atttypid, atttypmod), attnotnull "
                "FROM pg_attribute WHERE attrelid=to_regclass(:relation) "
                "AND attnum > 0 AND NOT attisdropped ORDER BY attnum"
            ),
            {"relation": need.relation},
        ).all()
        schema = TableSchema.from_columns(columns, tuple(c.name for c in table.primary_key))
        conn.exec_driver_sql("SET LOCAL TimeZone='UTC'")
        conn.exec_driver_sql("SET LOCAL DateStyle='ISO, YMD'")
        conn.exec_driver_sql("SET LOCAL extra_float_digits=1")
        statement = sql.SQL(
            "COPY (SELECT * FROM {} ORDER BY {}) TO STDOUT WITH (FORMAT csv, HEADER true)"
        ).format(
            sql.Identifier(*need.relation.split(".")),
            sql.SQL(", ").join(map(sql.Identifier, schema.primary_key)),
        )
        path = destination.with_suffix(".csv")
        with conn.connection.driver_connection.cursor() as cursor, path.open("wb") as output:
            with cursor.copy(statement) as copied:
                for block in copied:
                    output.write(block)
    write_window(path, schema, destination, metadata={}, temp_dir=root)


def _export_inputs(engine, builder, request, root):
    for need in builder.inputs(request):
        destination = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
        destination.parent.mkdir(parents=True, exist_ok=True)
        if need.relation in WORKING_ONLY or (
            need.window == "all"
            and need.relation in {"raw.ingestion_runs", "raw.ingestion_objects"}
        ):
            _export_seed_rows(engine, need, destination, root)
            continue
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


def _seed_request(provider):
    days = tuple(sorted(set(seed.DAYS)))
    open_window = (seed.BUILD_CLOCK.astimezone(seed.TZ).date() - days[0]).days
    # Cover the seed, R26's prior capture day, and the partial build day;
    # empty archival retention must not create a century of daily input files.
    first_capture = datetime.combine(days[0], time(), seed.TZ).astimezone(UTC) - timedelta(days=1)
    fact_window = (seed.BUILD_CLOCK - first_capture).days + 1
    return BuildRequest(
        provider, days, seed.BUILD_CLOCK, fact_window, open_window, str(seed.TZ),
        # R28b current_at_build: seed._base(provider) + 20 is the seed's current edition.
        edition_by_day=(
            {day: seed._base(provider) + 20 for day in days}
            if provider in seed.PROVIDERS.values() else None
        ),
        edition_source="current_at_build" if provider in seed.PROVIDERS.values() else None,
    )


def test_seed_request_bounds_the_open_window():
    request = _seed_request("seed")
    assert request.local_dates == seed.DAYS
    assert request.as_of_utc.astimezone(seed.TZ).date() - timedelta(
        days=request.open_window_days
    ) == min(seed.DAYS)
    assert max(request.local_dates) == max(seed.DAYS)


def test_seed_request_fact_window_covers_seed_and_skew_without_empty_century():
    request = _seed_request("seed")
    first = datetime.combine(min(seed.DAYS), time(), seed.TZ).astimezone(UTC) - timedelta(days=1)
    cutoff = request.as_of_utc - timedelta(days=request.fact_retention_days)
    assert cutoff <= first < cutoff + timedelta(days=1)
    assert all(
        cutoff <= datetime.combine(day, time(12, 12), seed.TZ).astimezone(UTC) < request.as_of_utc
        for day in seed.DAYS
    )


def test_every_implemented_family_matches_postgres_on_the_seed(seeded, record_property):
    proven_families = _proven_families()
    engine, settings, root = seeded
    compared = []
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    for name in FAMILIES:
        builder = resolve_builder(name)
        if builder is None:
            continue
        assert isinstance(builder, FamilyBuilder), name
        for p in seed.PROVIDERS.values():
            req = _seed_request(p)
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
    assert compared == list(proven_families), f"Compared {len(compared)} families: {compared}"


def test_dated_all_is_refused_before_io(tmp_path):
    builder = SimpleNamespace(inputs=lambda _: (InputNeed("gold.route_delay_hourly", "all"),))
    with pytest.raises(ValueError, match="gold.route_delay_hourly.*all"):
        _export_inputs(None, builder, SimpleNamespace(), tmp_path)


@pytest.mark.parametrize(
    "relation",
    [
        "silver.rt_feed_snapshots",
        "silver.rt_entities",
        "silver.rt_trip_updates",
        "raw.ingestion_runs",
        "raw.ingestion_objects",
    ],
)
def test_seed_projection_bypasses_history_windows(tmp_path, monkeypatch, relation):
    exported = []
    monkeypatch.setitem(
        globals(),
        "_export_seed_rows",
        lambda engine, need, destination, root: exported.append((need, destination)),
    )
    need = InputNeed(relation, "all")
    builder = SimpleNamespace(inputs=lambda _: (need,))
    _export_inputs(None, builder, SimpleNamespace(), tmp_path)
    assert exported == [(need, tmp_path / relation / "all.parquet")]


def test_seed_projections_preserve_every_identity(seeded):
    engine, _, root = seeded
    relations = (
        "silver.rt_feed_snapshots",
        "silver.rt_entities",
        "silver.rt_trip_updates",
        "raw.ingestion_runs",
        "raw.ingestion_objects",
    )
    for relation in relations:
        destination = root / (relation + ".parquet")
        _export_seed_rows(engine, InputNeed(relation, "all"), destination, root)
        with engine.connect() as conn:
            schema, name = relation.split(".")
            table = Table(name, MetaData(), schema=schema, autoload_with=conn)
            keys = tuple(table.primary_key)
            expected = conn.execute(table.select().with_only_columns(*keys).order_by(*keys)).all()
        assert expected, relation
        with duckdb.connect() as conn:
            actual = (
                conn.read_parquet(str(destination))
                .project(",".join(c.name for c in keys))
                .order(",".join(c.name for c in keys))
                .fetchall()
            )
        assert actual == list(map(tuple, expected)), relation


@pytest.mark.parametrize("families", [{}, {"pending": None}])
def test_family_count_requires_occupancy_crowding(monkeypatch, families):
    monkeypatch.setitem(globals(), "FAMILIES", families)
    monkeypatch.setitem(globals(), "resolve_builder", families.__getitem__)
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
        FAMILIES={"occupancy_crowding": None}, resolve_builder=lambda _: builder
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
