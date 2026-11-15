from contextlib import nullcontext
from datetime import UTC, datetime
from types import SimpleNamespace

from transit_ops.lake.migration import MigrationPlan, PlannedWindow, run_migration
from transit_ops.lake.table_export import WindowSpec


def test_migration_skips_pruning_day_but_copies_boundary(tmp_path, monkeypatch):
    from transit_ops.lake import migration
    from transit_ops.settings import Settings

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return datetime(2026, 11, 15, tzinfo=UTC)

    monkeypatch.setattr(migration, "datetime", Clock)
    monkeypatch.setattr(
        migration, "get_settings", lambda: Settings(_env_file=None, GOLD_FACT_RETENTION_DAYS=14)
    )
    monkeypatch.setattr(migration.shutil, "disk_usage", lambda _: SimpleNamespace(free=10**12))
    specs = [
        WindowSpec("gold.fact_vehicle_snapshot", "p", day) for day in ("2026-11-01", "2026-11-02")
    ]
    copied = []
    records = []

    def copy(connection, storage, spec, **kw):
        copied.append(spec)
        return SimpleNamespace(
            spec=spec,
            outcome="copied",
            rows=1,
            content_sha256="a" * 64,
            proof=SimpleNamespace(object_sha256="b" * 64),
        )

    monkeypatch.setattr(migration, "copy_table_window", copy)
    result = run_migration(
        MigrationPlan(
            SimpleNamespace(complete=True), tuple(PlannedWindow(s, "closed") for s in specs), ()
        ),
        lambda: nullcontext(object()),
        None,
        work_dir=tmp_path,
        copied_by="a" * 40,
        statement_timeout_s=60,
        not_after=datetime(2099, 1, 1, tzinfo=UTC),
        log=records.append,
    )
    assert result.failure is None
    assert copied == specs[1:]
    assert records[0]["outcome"] == "skipped"
    assert records[0]["reason"] == "window_in_pruning"
    assert result.outcomes["utc_day"] == {"skipped": 1, "copied": 1}


def test_known_incomplete_matches_both_digests_not_derived_key():
    from dataclasses import asdict

    import pytest

    from transit_ops.lake.copy_rejections import REJECTED_COPIES, require_usable_copy

    value = asdict(REJECTED_COPIES[0])
    value["key"] = value["derived_key"].replace(".c1.", ".c7.")
    with pytest.raises(ValueError, match="known_incomplete.*234241"):
        require_usable_copy(value)
    for name in ("object_sha256", "content_sha256"):
        different = dict(value)
        different[name] = "a" * 64
        require_usable_copy(different)


def test_pruning_uses_active_pruner_settings_only():
    from transit_ops.lake.pruning import retention_days, window_in_pruning
    from transit_ops.settings import Settings

    settings = Settings(
        _env_file=None,
        BRONZE_REALTIME_RETENTION_DAYS=14,
        BRONZE_STATIC_RETENTION_DAYS=50,
        BRONZE_I3_RETENTION_DAYS=30,
        SILVER_I3_CLOSED_RETENTION_DAYS=5,
    )
    assert retention_days("raw.ingestion_objects", settings) == 14
    assert retention_days("raw.ingestion_runs", settings) == 14
    assert retention_days("raw.realtime_snapshot_index", settings) == 14
    assert retention_days("raw.i3_alert_snapshots", settings) == 30
    assert retention_days("silver.i3_alerts", settings) == 30
    assert retention_days("gold.route_delay_spine", settings) is None
    assert window_in_pruning(
        WindowSpec("raw.realtime_snapshot_index", "p", "2026-11"),
        datetime(2026, 11, 15, tzinfo=UTC),
        settings,
    )
    assert not window_in_pruning(
        WindowSpec("raw.realtime_snapshot_index", "p", "2026-11"),
        datetime(2026, 11, 15, tzinfo=UTC),
        settings.model_copy(update={"BRONZE_REALTIME_RETENTION_DAYS": 0}),
    )


def test_explicit_pruning_window_skips_even_after_source_pruned_it():
    from transit_ops.lake.migration import plan_migration

    class NoSourceReads:
        autocommit = True
        info = SimpleNamespace(transaction_status=0)

        def execute(self, *args, **kw):
            raise AssertionError("source read")

        def transaction(self):
            raise AssertionError("source transaction")

    plan = plan_migration(
        NoSourceReads(),
        today_utc=datetime(2026, 11, 15).date(),
        include_open=False,
        datasets=None,
        providers=None,
        statement_timeout_s=60,
        windows=["gold.fact_vehicle_snapshot:p:2026-11-01"],
    )
    assert plan.windows[0].skip_reason == "window_in_pruning"


def test_generic_fetch_refuses_known_copy_before_payload_read(tmp_path):
    from dataclasses import asdict

    import pytest

    from transit_ops.batch.build import InputNeed
    from transit_ops.batch.fetch_inputs import fetch_inputs
    from transit_ops.lake.copy_rejections import REJECTED_COPIES

    value = asdict(REJECTED_COPIES[0])
    value["key"] = value["derived_key"]

    class NoPayload:
        def open_stream(self, *a, **kw):
            pytest.fail("known incomplete payload read")

    with pytest.raises(ValueError, match="known_incomplete"):
        fetch_inputs(
            [InputNeed(value["dataset_id"], value["window_key"])],
            NoPayload(),
            tmp_path,
            key_for=lambda _: value["key"],
            expected_sha256=lambda _: value["object_sha256"],
            receipt_for=lambda _: value,
        )
    assert not list(tmp_path.iterdir())
