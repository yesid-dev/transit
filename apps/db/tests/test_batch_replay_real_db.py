import hashlib
import json
import os
from datetime import UTC, date, datetime, timedelta
from importlib import import_module
from uuid import uuid4

import psycopg
import pytest
from sqlalchemy import create_engine, text
from test_rescue_fact_day import fact_source as fact_source

from transit_ops.batch import replay as replay_module
from transit_ops.batch.build import FamilyOutput, InputNeed, TableRows, utc_days
from transit_ops.batch.families.registry import FAMILIES
from transit_ops.batch.pg_load import ReplayDatabaseRefused, prepare_replay_database
from transit_ops.batch.replay import _collect_bodies, replay_day
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_schema import TableSchema
from transit_ops.settings import Settings
from transit_ops.snapshots.contract import HistoricHotspotsDay, HistoricRepeatOffendersDay
from transit_ops.snapshots.historic_tier import HistoricPointPlanBundle, HistoricValidationInputs
from transit_ops.sql_registry import named_query

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 2, 7, tzinfo=UTC)


@pytest.mark.parametrize(
    "family, model, field",
    [
        ("hotspots", HistoricHotspotsDay, b"hotspots"),
        ("repeat_offenders", HistoricRepeatOffendersDay, b"offenders"),
    ],
)
def test_body_collection_accepts_a_nonempty_point_history(monkeypatch, family, model, field):
    class Days:
        def __init__(self, rows):
            self.rows = rows

        def iter_days(self):
            return iter(self.rows)

    payload = model(
        date="2026-11-01", generated_utc="2026-11-02T00:00:00Z", methodology_version="reliability-2"
    )
    collected = HistoricValidationInputs(
        all_items=[],
        route_items=[],
        stamp="2026-11-02T00:00:00Z",
        prior_total=None,
        point_plans=HistoricPointPlanBundle(
            Days([payload] if family == "hotspots" else []),
            Days([payload] if family == "repeat_offenders" else []),
        ),
    )
    monkeypatch.setattr(replay_module.historic_tier, "collect", lambda *a, **kw: collected)
    bodies = _collect_bodies(None, "sample", Settings(), STAMP)
    expected = (
        b'{"schema_version":1,"methodology_version":"reliability-2",'
        b'"publish_generation_id":null,"generated_utc":"2026-11-02T00:00:00Z","'
        + field
        + b'":[],"by_grain":[],"date":"2026-11-01"}'
    )
    prefix = f"historic/history/{family}/generations/"
    key = f"{prefix}{hashlib.sha256(expected).hexdigest()}/2026-11-01.json"
    assert bodies[key] == expected
    index = next(
        json.loads(body)
        for path, body in bodies.items()
        if path.startswith(prefix) and path.endswith("/index.json")
    )
    assert index["available_dates"] == ["2026-11-01"]
    assert index["partitions"][0]["path"] == key
    assert index["partitions"][0]["byte_size"] == len(expected)


@pytest.fixture
def real_db_engine(real_db_engine):
    from parallel_db import _database_url, _execute, guarded_connect_kwargs

    if os.name == "nt":
        pytest.skip("Replay database execution is gated by Linux CI")
    base = real_db_engine.url.render_as_string(hide_password=False)
    template = guarded_connect_kwargs(real_db_engine.url)["dbname"].split("_xdist_")[0]
    name = f"{template}_xdist_{uuid4().hex[:16]}_gw0"
    target = _database_url(base, name)
    guarded_connect_kwargs(target)
    quote = real_db_engine.dialect.identifier_preparer.quote_identifier
    _execute(base, f"CREATE DATABASE {quote(name)} TEMPLATE {quote(template)}")
    isolated = create_engine(target)
    try:
        yield isolated
    finally:
        isolated.dispose()
        _execute(base, f"DROP DATABASE {quote(name)} WITH (FORCE)")


@pytest.fixture
def replay_inputs(real_db_engine, fact_source, tmp_path, monkeypatch, request):
    for slot in FAMILIES.values():
        monkeypatch.setattr(import_module(slot.module_path), "builder", None)
    database = prepare_replay_database(
        real_db_engine.url.render_as_string(hide_password=False), os.environ
    )
    provider = fact_source[0]
    with database.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE gold.fact_trip_delay_snapshot SET route_id='R1', "
                "stop_time_update_count=10, skipped_stop_count=2 WHERE provider_id=:p"
            ),
            {"p": provider},
        )
        if getattr(request, "param", None) == "point_history":
            # The rescue seed keeps empty trip IDs for exact round-trip coverage.
            conn.execute(
                text("""
                    INSERT INTO gold.fact_trip_delay_snapshot (
                        provider_id, realtime_snapshot_id, entity_index, snapshot_date_key,
                        snapshot_local_date, feed_timestamp_utc, captured_at_utc, entity_id,
                        trip_id, vehicle_id, route_id, delay_stop_id, delay_seconds,
                        stop_time_update_count, skipped_stop_count
                    )
                    SELECT provider_id, realtime_snapshot_id, 100, snapshot_date_key,
                        snapshot_local_date, feed_timestamp_utc, captured_at_utc, 'point-entity',
                        'point-trip', 'point-vehicle', 'R1', 'point-stop', 120, 10, 2
                    FROM gold.fact_trip_delay_snapshot
                    WHERE provider_id=:p AND entity_index=2
                """),
                {"p": provider},
            )
    root = tmp_path / "inputs"
    relations = [
        "core.providers",
        "core.feed_endpoints",
        "raw.ingestion_runs",
        "raw.ingestion_objects",
        "gold.dim_route_history",
        "gold.dim_stop_history",
        "core.dataset_versions",
        "silver.trips",
        "silver.calendar",
        "silver.calendar_dates",
        "silver.stop_times",
        "gold.fact_trip_delay_snapshot",
        "gold.fact_vehicle_snapshot",
        "raw.realtime_snapshot_index",
        "raw.i3_alert_snapshots",
        "silver.i3_alerts",
        "silver.i3_alert_active_periods",
        "silver.i3_alert_informed_entities",
    ]
    with psycopg.connect(
        **database.engine.url.translate_connect_args(username="user", database="dbname")
    ) as source:
        for relation in relations:
            columns = source.execute(
                "SELECT attname,format_type(atttypid,atttypmod),attnotnull "
                "FROM pg_attribute WHERE attrelid=%s::regclass AND attnum>0 "
                "AND NOT attisdropped ORDER BY attnum",
                (relation,),
            ).fetchall()
            keys = source.execute(
                "SELECT a.attname FROM pg_index i CROSS JOIN LATERAL "
                "unnest(i.indkey) WITH ORDINALITY k(n,pos) JOIN pg_attribute a "
                "ON a.attrelid=i.indrelid AND a.attnum=k.n WHERE i.indrelid=%s::regclass "
                "AND i.indisprimary ORDER BY k.pos",
                (relation,),
            ).fetchall()
            schema = TableSchema.from_columns(columns, [k[0] for k in keys])
            folder = root / relation
            folder.mkdir(parents=True)
            csv = tmp_path / "source.csv"
            if relation in {
                "gold.fact_trip_delay_snapshot",
                "gold.fact_vehicle_snapshot",
                "raw.realtime_snapshot_index",
            }:
                windows = [(DAY + timedelta(days=offset)).isoformat() for offset in range(-14, 3)]
            elif relation in relations[6:11]:
                windows = ["edition=1"]
            else:
                windows = ["all"]
            for window in windows:
                predicate = ""
                if window[0].isdigit():
                    predicate = (
                        f" WHERE captured_at_utc >= '{window}'::timestamptz"
                        f" AND captured_at_utc < '{window}'::timestamptz + interval '1 day'"
                    )
                with (
                    source.cursor().copy(
                        f"COPY (SELECT * FROM {relation}{predicate}) "
                        "TO STDOUT (FORMAT csv, HEADER true)"
                    ) as blocks,
                    csv.open("wb") as output,
                ):
                    for block in blocks:
                        output.write(block)
                write_window(
                    csv, schema, folder / f"{window}.parquet", metadata={}, temp_dir=tmp_path
                )
    try:
        yield database, root, provider
    finally:
        # Let the seed fixture remove its input rows after all new rollups are gone.
        with database.engine.begin() as conn:
            tables = conn.execute(
                text(
                    "SELECT DISTINCT c.table_name FROM "
                    "information_schema.columns c JOIN information_schema.tables t "
                    "USING(table_schema,table_name) WHERE c.table_schema='gold' "
                    "AND t.table_type='BASE TABLE' AND c.column_name='provider_id'"
                )
            ).scalars()
            for table in tables:
                if table.startswith(
                    (
                        "route_",
                        "stop_",
                        "repeat",
                        "repeated",
                        "citizen_",
                        "warm_",
                        "trip_delay_summary",
                    )
                ):
                    conn.execute(
                        text(f'DELETE FROM gold."{table}" WHERE provider_id=:p'), {"p": provider}
                    )
        database.engine.dispose()


def replay(replay_inputs, tmp_path, families, *, publish_bodies=False):
    database, root, provider = replay_inputs
    return replay_day(
        engine=database,
        provider_id=provider,
        local_date=DAY,
        as_of_utc=STAMP,
        inputs_root=root,
        workdir=tmp_path,
        families=families,
        code_commit="a" * 40,
        publish_bodies=publish_bodies,
    )


def test_a_seed_day_without_families_reports_postgres_rows(replay_inputs, tmp_path):
    report = replay(replay_inputs, tmp_path, [])
    assert report.families
    assert all(f.status == "not_implemented" for f in report.families)
    with replay_inputs[0].engine.connect() as conn:
        count = conn.execute(
            text(
                "SELECT count(*) FROM gold.route_skipped_stop_daily "
                "WHERE provider_id=:p AND provider_local_date='2026-11-01'"
            ),
            {"p": replay_inputs[2]},
        ).scalar_one()
    family = next(f for f in report.families if f.family_id == "span_skipped_stops")
    assert count == 1
    assert family.postgres_rows["gold.route_skipped_stop_daily"] == count


def test_a_correct_test_family_is_identical_and_a_broken_one_is_located(
    replay_inputs, tmp_path, monkeypatch
):
    from transit_ops.batch.families import span_skipped_stops

    class Builder:
        family_id = "span_skipped_stops"
        tables = ("gold.route_skipped_stop_daily",)
        published_keys = ()
        variants = {}
        broken = False

        def inputs(self, request):
            return tuple(
                InputNeed("gold.fact_trip_delay_snapshot", window)
                for window in utc_days(
                    request, lookback_days=request.fact_retention_days, after_days=1
                )
            )

        def build(self, session, request):
            columns = (
                "provider_id",
                "provider_local_date",
                "route_id",
                "stop_time_update_count",
                "skipped_stop_count",
                "skipped_stop_rate_pct",
                "built_at_utc",
            )
            result = session.execute(
                named_query(
                    "batch.replay_test.skipped_stop_daily",
                    "SELECT provider_id, :day AS provider_local_date, "
                    "route_id, sum(stop_time_update_count)::BIGINT AS stop_time_update_count, "
                    "sum(skipped_stop_count)::BIGINT + :broken AS skipped_stop_count, "
                    "CAST(100.0*sum(skipped_stop_count)/sum(stop_time_update_count) "
                    "AS DECIMAL(5,2)) "
                    "AS skipped_stop_rate_pct, :stamp AS built_at_utc "
                    "FROM gold.fact_trip_delay_snapshot WHERE snapshot_date_key=20261101 "
                    "AND provider_id=:provider GROUP BY provider_id, route_id",
                ),
                {
                    "day": DAY,
                    "stamp": STAMP,
                    "broken": int(self.broken),
                    "provider": request.provider_id,
                },
            )
            rows = tuple(tuple(row) for row in result)
            table = TableRows(
                self.tables[0], columns, ("provider_id", "provider_local_date", "route_id"), rows
            )
            return FamilyOutput({table.relation: table}, {})

    builder = Builder()
    monkeypatch.setattr(span_skipped_stops, "builder", builder)
    assert replay(replay_inputs, tmp_path, [builder.family_id]).families[0].status == "identical"
    builder.broken = True
    result = replay(replay_inputs, tmp_path, [builder.family_id]).families[0]
    assert result.status == "different"
    assert result.differences[0].column == "skipped_stop_count"
    assert result.differences[0].expected == 10
    assert result.differences[0].actual == 11
    assert result.differences[0].key == (replay_inputs[2], DAY, "R1")


def test_two_replays_give_the_same_report_bytes(replay_inputs, tmp_path):
    assert replay(replay_inputs, tmp_path, []).to_json(timings=False) == replay(
        replay_inputs, tmp_path, []
    ).to_json(timings=False)


@pytest.mark.parametrize("replay_inputs", ["point_history"], indirect=True)
def test_replay_compares_nonempty_point_history_bodies(replay_inputs, tmp_path, monkeypatch):
    from transit_ops.batch.families import hotspots

    class MissingBodyBuilder:
        family_id = "hotspots"
        tables = ()
        published_keys = ("historic/history/hotspots/generations/*/*.json",)
        variants = {}

        def inputs(self, request):
            return ()

        def build(self, session, request):
            return FamilyOutput({}, {})

    monkeypatch.setattr(hotspots, "builder", MissingBodyBuilder())
    report = replay(replay_inputs, tmp_path, ["hotspots"], publish_bodies=True)
    family = report.families[0]
    assert family.status == "different"
    assert report.exit_code() == 2
    difference = next(d for d in family.differences if d.key.endswith("/2026-11-01.json"))
    assert difference.kind == "missing"
    assert difference.actual is None
    payload = json.loads(difference.expected)
    assert payload["date"] == "2026-11-01"
    assert datetime.fromisoformat(payload["generated_utc"]) == STAMP
    digest = hashlib.sha256(difference.expected.encode()).hexdigest()
    assert difference.key == f"historic/history/hotspots/generations/{digest}/2026-11-01.json"


def test_unprepared_engine_is_refused(tmp_path):
    with pytest.raises(ReplayDatabaseRefused, match="prepare_replay_database"):
        replay_day(
            engine=create_engine("sqlite://"),
            provider_id="sample",
            local_date=date(2026, 11, 1),
            as_of_utc=datetime(2026, 11, 2, 7, tzinfo=UTC),
            inputs_root=tmp_path,
            workdir=tmp_path,
            families=[],
            code_commit="a" * 40,
            publish_bodies=False,
        )
