"""Frozen Gold evidence must survive the public, guarded replay adapter."""

from datetime import timedelta
from decimal import ROUND_HALF_UP, Decimal
from importlib import import_module

import psycopg
import pytest
from sqlalchemy import text
from test_batch_replay_real_db import (
    DAY,
    STAMP,
    replay,
)
from test_batch_replay_real_db import (
    real_db_engine as real_db_engine,
)
from test_batch_replay_real_db import (
    replay_inputs as replay_inputs,
)
from test_rescue_fact_day import fact_source as fact_source

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.registry import FAMILIES
from transit_ops.batch.replay import family_input_needs, replay_day
from transit_ops.history.datasets import get_dataset
from transit_ops.lake.parquet_codec import write_window
from transit_ops.lake.table_schema import TableSchema
from transit_ops.settings import Settings


def _export_need(database, root, tmp_path, need):
    path = root / need.relation / (need.window.replace(":", "=", 1) + ".parquet")
    if path.exists():
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    with psycopg.connect(
        **database.engine.url.translate_connect_args(username="user", database="dbname")
    ) as source:
        columns = source.execute(
            "SELECT attname,format_type(atttypid,atttypmod),attnotnull FROM pg_attribute "
            "WHERE attrelid=%s::regclass AND attnum>0 AND NOT attisdropped ORDER BY attnum",
            (need.relation,),
        ).fetchall()
        keys = source.execute(
            "SELECT a.attname FROM pg_index i CROSS JOIN LATERAL "
            "unnest(i.indkey) WITH ORDINALITY k(n,pos) JOIN pg_attribute a "
            "ON a.attrelid=i.indrelid AND a.attnum=k.n WHERE i.indrelid=%s::regclass "
            "AND i.indisprimary ORDER BY k.pos",
            (need.relation,),
        ).fetchall()
        schema = TableSchema.from_columns(columns, [k[0] for k in keys])
        predicate = ""
        if need.window != "all":
            column = get_dataset(need.relation).source.window_column
            day = need.window.removeprefix("local:")
            clock = "date" if column == "provider_local_date" else "timestamptz"
            predicate = f" WHERE {column} >= '{day}'::{clock} AND {column} < "
            predicate += f"'{day}'::{clock} + interval '1 day'"
            if need.window.startswith("local:") and clock == "timestamptz":
                predicate = (
                    f" WHERE {column} >= timezone('America/Toronto', '{day}'::date::timestamp)"
                    f" AND {column} < timezone('America/Toronto', ('{day}'::date+1)::timestamp)"
                )
        csv = tmp_path / "gold-seed.csv"
        with (
            source.cursor().copy(
                f"COPY (SELECT * FROM {need.relation}{predicate}) "
                "TO STDOUT (FORMAT csv, HEADER true)"
            ) as blocks,
            csv.open("wb") as output,
        ):
            for block in blocks:
                output.write(block)
        write_window(csv, schema, path, metadata={}, temp_dir=tmp_path)


@pytest.mark.parametrize(
    "families",
    [
        ("repeat_offenders",),
        ("stop_spine_hours", "repeat_offenders"),
        (
            "repeat_offenders",
            "occupancy_crowding",
            "stop_spine_hours",
            "percentiles_histograms",
            "span_skipped_stops",
            "headways",
        ),
    ],
)
@pytest.mark.parametrize("publish_bodies", [False, True])
def test_frozen_week_survives_selected_replay(
    replay_inputs, tmp_path, monkeypatch, families, publish_bodies
):
    database, root, provider = replay_inputs
    counts = [1, 6, 6, 2, 3, 3, 2]
    sums = [1000, 5000, 5000, 4000, 4000, 4000, 3600]
    with database.engine.begin() as conn:
        for i, (severe, total) in enumerate(zip(counts, sums, strict=True)):
            conn.execute(
                text("""
                INSERT INTO gold.stop_delay_spine(provider_id, stop_id, route_id,
                    provider_local_date, observation_count, severe_delay_count,
                    sum_delay_seconds, built_at_utc)
                VALUES (:p,'1000','165',:day,24,:severe,:total,:stamp)
            """),
                dict(
                    p=provider,
                    day=DAY - timedelta(days=6 - i),
                    severe=severe,
                    total=total,
                    stamp=STAMP - timedelta(days=1),
                ),
            )
        # Give the narrow raw window a conflicting population at the same key.
        conn.execute(
            text(
                "UPDATE gold.fact_trip_delay_snapshot SET delay_stop_id='1000', "
                "route_id='165', delay_seconds=900 WHERE provider_id=:p"
            ),
            dict(p=provider),
        )
        conn.execute(
            text("""
            INSERT INTO gold.stop_delay_hourly(provider_id,period_start_utc,stop_id,route_id,
                observation_count,severe_delay_count,built_at_utc)
            VALUES (:p,'2026-11-01 06:00Z','archived','165',37,3,:stamp)
        """),
            dict(p=provider, stamp=STAMP - timedelta(days=1)),
        )
    settings = Settings()
    request = BuildRequest(
        provider,
        (DAY,),
        STAMP,
        settings.GOLD_FACT_RETENTION_DAYS,
        settings.GOLD_REPORTING_OPEN_WINDOW_DAYS,
        "America/Toronto",
    )
    builders = []
    for family in families:
        module = import_module(FAMILIES[family].module_path)
        cls = next(
            value
            for key, value in vars(module).items()
            if key.endswith("Builder") and isinstance(value, type)
        )
        builder = cls()
        monkeypatch.setattr(module, "builder", builder)
        builders.append(builder)
    # Refresh the raw fixture windows with the intentionally conflicting facts.
    for path in (root / "gold.fact_trip_delay_snapshot").glob("*.parquet"):
        # Only this generated fixture's known files, never a recursive deletion.
        path.unlink()
    for need in family_input_needs(builders, request):
        _export_need(database, root, tmp_path, need)
    from transit_ops.batch import replay as adapter

    native = adapter.build_reference
    observed = []

    def capture(conn, request, tables):
        before = conn.execute(text("SELECT * FROM gold.stop_delay_spine ORDER BY 1,2,3,4")).all()
        native(conn, request, tables)
        if "gold.stop_delay_spine" not in tables:
            assert (
                conn.execute(text("SELECT * FROM gold.stop_delay_spine ORDER BY 1,2,3,4")).all()
                == before
            )
        if "gold.repeated_problem_route_stop" in tables:
            observed.extend(
                conn.execute(
                    text(
                        "SELECT issue_count,avg_delay_seconds,built_at_utc "
                        "FROM gold.repeated_problem_route_stop "
                        "WHERE provider_id=:p AND entity_kind='stop' "
                        "AND entity_id='1000' AND route_id='165'"
                    ),
                    dict(p=provider),
                ).all()
            )
        if "gold.stop_delay_hourly" in tables:
            assert conn.execute(
                text(
                    "SELECT built_at_utc FROM gold.stop_delay_hourly WHERE provider_id=:p LIMIT 1"
                ),
                dict(p=provider),
            ).scalar_one_or_none() in (None, STAMP)

    monkeypatch.setattr(adapter, "build_reference", capture)
    report = replay(replay_inputs, tmp_path, families, publish_bodies=publish_bodies)
    assert all(f.status in ("identical", "identical_after_normalization") for f in report.families)
    mean = (Decimal(sum(sums)) / Decimal(7 * 24)).quantize(Decimal(".01"), rounding=ROUND_HALF_UP)
    assert observed == [(sum(counts), mean, STAMP)]
    # The reference transaction is read back before rollback; persisted inputs
    # remain the archive's exact rows, including input/output overlap.
    if families == ("repeat_offenders",):
        with database.engine.connect() as conn:
            assert conn.execute(
                text(
                    "SELECT SUM(severe_delay_count), SUM(sum_delay_seconds) "
                    "FROM gold.stop_delay_spine WHERE provider_id=:p"
                ),
                dict(p=provider),
            ).one() == (23, 26600)


@pytest.mark.parametrize("publish_bodies", [False, True])
def test_unarchived_family_refuses_before_reference(
    replay_inputs, tmp_path, monkeypatch, publish_bodies
):
    from transit_ops.batch import replay as adapter

    def unexpected_reference(*args, **kwargs):
        pytest.fail("unarchived inputs reached the native reference")

    monkeypatch.setattr(adapter, "build_reference", unexpected_reference)
    with pytest.raises(
        ValueError, match=r"input_not_archived: route_spine_hours silver\.rt_feed_snapshots"
    ):
        replay(
            replay_inputs,
            tmp_path,
            ("route_spine_hours", "repeat_offenders"),
            publish_bodies=publish_bodies,
        )


def test_stop_hour_input_output_overlap_carries_closed_archive_rows(
    replay_inputs, tmp_path, monkeypatch
):
    from transit_ops.batch.families import stop_spine_hours

    database, root, provider = replay_inputs
    stamp = STAMP + timedelta(days=11)
    builder = stop_spine_hours.StopSpineHoursBuilder()
    monkeypatch.setattr(stop_spine_hours, "builder", builder)
    with database.engine.begin() as conn:
        conn.execute(
            text("""
            INSERT INTO gold.stop_delay_hourly(provider_id,period_start_utc,stop_id,route_id,
                observation_count,severe_delay_count,built_at_utc)
            VALUES (:p,'2026-11-01 06:00Z','archived','165',37,3,:stamp)
        """),
            dict(p=provider, stamp=STAMP),
        )
    settings = Settings()
    request = BuildRequest(
        provider,
        (DAY,),
        stamp,
        settings.GOLD_FACT_RETENTION_DAYS,
        settings.GOLD_REPORTING_OPEN_WINDOW_DAYS,
        "America/Toronto",
    )
    for need in family_input_needs((builder,), request):
        _export_need(database, root, tmp_path, need)
    report = replay_day(
        engine=database,
        provider_id=provider,
        local_date=DAY,
        as_of_utc=stamp,
        inputs_root=root,
        workdir=tmp_path,
        families=(builder.family_id,),
        code_commit="a" * 40,
        publish_bodies=False,
    )
    assert report.families[0].status in ("identical", "identical_after_normalization")
    assert report.families[0].postgres_rows["gold.stop_delay_hourly"] == 1
    with database.engine.connect() as conn:
        assert conn.execute(
            text(
                "SELECT observation_count,built_at_utc "
                "FROM gold.stop_delay_hourly WHERE provider_id=:p"
            ),
            dict(p=provider),
        ).one() == (37, STAMP)
