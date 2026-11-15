import pytest

from transit_ops.lake.alert_bundle import validate_members
from transit_ops.lake.table_export import WindowSpec


def test_incomplete_group_refuses_by_member_name():
    with pytest.raises(ValueError, match="silver.i3_alert_active_periods"):
        validate_members([WindowSpec("silver.i3_alerts", "alert_bundle_seed", "2026-11")])


class SeedSource:
    """Offline SQL adapter; PostgreSQL MVCC remains the real-db test's responsibility."""

    def __init__(self, *, dangling=False):
        from types import SimpleNamespace

        import duckdb

        self.db = duckdb.connect()
        self.autocommit = True
        self.info = SimpleNamespace(transaction_status=0)
        self.events = []
        self.clock_hook = None
        self.db.execute("CREATE SCHEMA silver; CREATE SCHEMA raw; CREATE SCHEMA core")
        self.columns = {
            "silver.i3_alerts": ["i3_alert_snapshot_id", "alert_index", "provider_id"],
            "silver.i3_alert_informed_entities": [
                "i3_alert_snapshot_id",
                "alert_index",
                "entity_index",
                "provider_id",
            ],
            "silver.i3_alert_active_periods": [
                "i3_alert_snapshot_id",
                "alert_index",
                "period_index",
            ],
            "raw.i3_alert_snapshots": [
                "i3_alert_snapshot_id",
                "provider_id",
                "ingestion_run_id",
                "ingestion_object_id",
                "feed_endpoint_id",
            ],
            "raw.ingestion_runs": ["ingestion_run_id", "provider_id", "feed_endpoint_id"],
            "raw.ingestion_objects": ["ingestion_object_id", "provider_id", "ingestion_run_id"],
            "core.feed_endpoints": ["feed_endpoint_id", "provider_id"],
            "core.providers": ["provider_id"],
        }
        self.fks = {
            "silver.i3_alerts": [
                ("raw.i3_alert_snapshots", ["i3_alert_snapshot_id"], ["i3_alert_snapshot_id"]),
                ("core.providers", ["provider_id"], ["provider_id"]),
            ],
            "silver.i3_alert_informed_entities": [
                (
                    "silver.i3_alerts",
                    ["i3_alert_snapshot_id", "alert_index"],
                    ["i3_alert_snapshot_id", "alert_index"],
                )
            ],
            "silver.i3_alert_active_periods": [
                (
                    "silver.i3_alerts",
                    ["i3_alert_snapshot_id", "alert_index"],
                    ["i3_alert_snapshot_id", "alert_index"],
                )
            ],
            "raw.i3_alert_snapshots": [
                (r, [c], [c])
                for r, c in [
                    ("raw.ingestion_runs", "ingestion_run_id"),
                    ("raw.ingestion_objects", "ingestion_object_id"),
                    ("core.feed_endpoints", "feed_endpoint_id"),
                ]
            ],
            "raw.ingestion_runs": [
                ("core.feed_endpoints", ["feed_endpoint_id"], ["feed_endpoint_id"])
            ],
            "raw.ingestion_objects": [
                ("raw.ingestion_runs", ["ingestion_run_id"], ["ingestion_run_id"])
            ],
            "core.feed_endpoints": [("core.providers", ["provider_id"], ["provider_id"])],
        }
        rows = {
            "silver.i3_alerts": [(1, 0, "p")],
            "silver.i3_alert_informed_entities": [(1, 0, 0, "p")],
            "silver.i3_alert_active_periods": [(1, 0, 0)],
            "raw.i3_alert_snapshots": [(1, "p", 10, 20, 30)] if not dangling else [],
            "raw.ingestion_runs": [(10, "p", 30), (99, "p", 30)],
            "raw.ingestion_objects": [(20, "p", 10), (99, "p", 99)],
            "core.feed_endpoints": [(30, "p"), (99, "p")],
            "core.providers": [("p",), ("unused",)],
        }
        for relation, columns in self.columns.items():
            definitions = ", ".join(
                c + (" VARCHAR" if c == "provider_id" else " BIGINT") for c in columns
            )
            self.db.execute(f"CREATE TABLE {relation} ({definitions})")
            if rows[relation]:
                self.db.executemany(
                    f"INSERT INTO {relation} VALUES ({','.join('?' for _ in columns)})",
                    rows[relation],
                )

    def transaction(self):
        from contextlib import nullcontext

        return nullcontext()

    def execute(self, query, values=None):
        from datetime import UTC, datetime
        from types import SimpleNamespace

        from transit_ops.history.datasets import get_dataset

        query = query.as_string() if hasattr(query, "as_string") else str(query)
        self.events.append((query, values))
        if "set_config" in query or query.startswith("SET TRANSACTION"):
            if self.clock_hook:
                self.clock_hook(query)
            return SimpleNamespace(fetchall=lambda: [], fetchone=lambda: None)
        if "transaction_timestamp()" in query:
            return SimpleNamespace(fetchall=lambda: [(datetime(2026, 11, 3, 7, tzinfo=UTC), "17")])
        if "FROM pg_attribute" in query:
            rows = [
                (c, "text" if c == "provider_id" else "bigint", True, c == "provider_id")
                for c in self.columns[values[0]]
            ]
        elif "FROM pg_index" in query:
            rows = [(c,) for c in get_dataset(values[0]).source.key_columns]
        elif "FROM pg_constraint" in query:
            rows = self.fks.get(values[0], [])
        else:
            return self.db.execute(query.replace("%s", "?"), values or [])
        return SimpleNamespace(fetchall=lambda: rows)

    def cursor(self):
        return self

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass

    def copy(self, query, values):
        import csv
        import io
        from contextlib import nullcontext

        statement = query.as_string()
        self.events.append(("COPY", None))
        assert statement.startswith("COPY (")
        selected = statement[6 : statement.rindex(") TO STDOUT")]
        result = self.db.execute(selected.replace("%s", "?"), values)
        rows = result.fetchall()
        self.rowcount = len(rows)
        output = io.StringIO(newline="")
        writer = csv.writer(output, lineterminator="\n")
        writer.writerow([c[0] for c in result.description])
        writer.writerows(rows)
        return nullcontext([output.getvalue().encode()])


@pytest.mark.parametrize("dangling", [False, True])
def test_copy_group_proves_exact_recursive_closure(tmp_path, dangling):
    import json

    import duckdb

    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.lake.alert_bundle import MEMBERS, PREFIX, copy_group

    source = SeedSource(dangling=dangling)
    archive = tmp_path / "archive"
    archive.mkdir()
    storage = LocalBronzeStorage("local", archive)
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    ]
    try:
        if dangling:
            with pytest.raises(ValueError, match="bundle_parent_missing: raw.i3_alert_snapshots"):
                copy_group(
                    source,
                    storage,
                    specs,
                    work_dir=work,
                    copied_by="a" * 40,
                    statement_timeout_s=60,
                )
            assert list(storage.list_keys(PREFIX)) == []
            return
        result = copy_group(
            source, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
        )
        bundle = json.loads(storage.read_bytes(PREFIX + result.version + ".json"))
        assert len(bundle["closure"]) == 5
        with duckdb.connect() as db:
            for m in bundle["closure"]:
                assert m["proof"]["verified"] is True and m["rows"] == 1
                assert db.execute(
                    "SELECT count(*) FROM read_parquet(?)", [str(archive / m["key"])]
                ).fetchone() == (1,)
        assert source.events[0][0] == "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"
        assert next(
            i for i, (q, _) in enumerate(source.events) if "transaction_timestamp()" in q
        ) < next(i for i, (q, _) in enumerate(source.events) if q == "COPY")
    finally:
        source.db.close()


def test_group_deadline_caps_each_statement_and_exhaustion_never_activates(tmp_path, monkeypatch):
    from datetime import UTC, datetime, timedelta

    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.lake import migration, table_export
    from transit_ops.lake.alert_bundle import MEMBERS, PREFIX, copy_group

    now = [datetime(2099, 1, 1, tzinfo=UTC)]
    deadline = now[0] + timedelta(seconds=1000)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return now[0]

    monkeypatch.setattr(table_export, "datetime", Clock)
    monkeypatch.setattr(migration, "datetime", Clock)
    source = SeedSource()
    ticks = [0]

    def advance(query):
        if "set_config('statement_timeout'" in query:
            ticks[0] += 1
            if ticks[0] == 15:
                now[0] = deadline - timedelta(seconds=330)
            elif ticks[0] == 17:
                now[0] = deadline - timedelta(seconds=299)

    source.clock_hook = advance
    root = tmp_path / "archive"
    root.mkdir()
    storage = LocalBronzeStorage("local", root)
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    ]
    try:
        with pytest.raises(ValueError, match="not_after"):
            copy_group(
                source,
                storage,
                specs,
                work_dir=work,
                copied_by="a" * 40,
                statement_timeout_s=60,
                not_after=deadline,
            )
        caps = [int(v[0]) for q, v in source.events if "set_config('statement_timeout'" in q]
        assert 30000 in caps and max(caps) == 60000
        assert list(storage.list_keys(PREFIX)) == []
    finally:
        source.db.close()


def test_shared_period_orphan_refuses_activation(tmp_path):
    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.lake.alert_bundle import MEMBERS, PREFIX, copy_group

    source = SeedSource()
    source.db.execute("INSERT INTO silver.i3_alert_active_periods VALUES (999,0,0)")
    archive = tmp_path / "archive"
    archive.mkdir()
    storage = LocalBronzeStorage("local", archive)
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    ]
    try:
        with pytest.raises(ValueError, match="bundle_parent_missing: silver.i3_alerts"):
            copy_group(
                source, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
            )
        assert list(storage.list_keys(PREFIX)) == []
    finally:
        source.db.close()
