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
        self.in_snapshot = False
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
        from contextlib import contextmanager

        @contextmanager
        def snapshot():
            self.in_snapshot = True
            try:
                yield
            finally:
                self.in_snapshot = False

        return snapshot()

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
                (
                    c,
                    "text" if c in {"provider_id", "timezone"} else "bigint",
                    True,
                    c == "provider_id",
                )
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
        # DuckDB does not parse PostgreSQL's scalar ANY(ARRAY(subquery)) syntax.
        # Translate only this operator for semantic offline execution; PG plans
        # are verified by the disposable database test against the original SQL.
        token = "= ANY (ARRAY("
        while token in selected:
            start = selected.index(token)
            body = start + len(token)
            depth, end = 1, body
            while depth:
                if selected[end] == "(":
                    depth += 1
                elif selected[end] == ")":
                    depth -= 1
                end += 1
            assert selected[end] == ")"
            selected = (
                selected[:start] + "IN (" + selected[body : end - 1] + ")" + selected[end + 1 :]
            )
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
    source.db.execute("INSERT INTO silver.i3_alert_active_periods VALUES (1,999,0)")
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


def test_snapshot_only_exports_then_fsync_and_proofs_run_after_release(tmp_path, monkeypatch):
    import os

    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.lake import table_export
    from transit_ops.lake.alert_bundle import MEMBERS, closure_statements, copy_group

    source = SeedSource()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    ]
    statements = closure_statements(source, specs)
    assert " UNION " in statements["raw.ingestion_runs"].as_string()
    assert all(" OR " not in q.as_string() for q in statements.values())
    sync = os.fsync
    events = []

    def fsync(fd):
        assert not source.in_snapshot
        events.append(fd)
        return sync(fd)

    monkeypatch.setattr(table_export.os, "fsync", fsync)
    root = tmp_path / "archive"
    root.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    try:
        copy_group(
            source,
            LocalBronzeStorage("local", root),
            specs,
            work_dir=work,
            copied_by="a" * 40,
            statement_timeout_s=60,
        )
        assert events
        assert not any("NOT EXISTS" in q for q, _ in source.events)
        assert any(v == ("jit", "off") for _, v in source.events)
    finally:
        source.db.close()


def test_space_floor_is_rechecked_before_each_member(tmp_path, monkeypatch):
    from types import SimpleNamespace

    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.lake import migration
    from transit_ops.lake.alert_bundle import MEMBERS, PREFIX, copy_group

    source = SeedSource()
    calls = []

    def space(path):
        calls.append(path)
        return SimpleNamespace(free=2 * migration.WORK_SPACE_FLOOR if len(calls) == 1 else 0)

    monkeypatch.setattr(migration.shutil, "disk_usage", space)
    root = tmp_path / "archive"
    root.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    ]
    storage = LocalBronzeStorage("local", root)
    try:
        with pytest.raises(ValueError, match="work_space"):
            copy_group(
                source, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
            )
        assert len(calls) == 2
        assert len([q for q, _ in source.events if q == "COPY"]) == 1
        assert list(storage.list_keys(PREFIX)) == []
    finally:
        source.db.close()


def test_all_provider_group_preserves_the_unfiltered_shared_periods(tmp_path):
    import duckdb

    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.lake.alert_bundle import MEMBERS, copy_group

    source = SeedSource()
    source.db.execute("INSERT INTO silver.i3_alerts VALUES (2,0,'unused')")
    source.db.execute("INSERT INTO silver.i3_alert_active_periods VALUES (2,0,0)")
    source.db.execute("INSERT INTO raw.i3_alert_snapshots VALUES (2,'unused',99,99,99)")
    root = tmp_path / "archive"
    root.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, provider, "2026-11")
        for r in MEMBERS
        for provider in (("_shared",) if r.endswith("active_periods") else ("p", "unused"))
    ]
    try:
        result = copy_group(
            source,
            LocalBronzeStorage("local", root),
            specs,
            work_dir=work,
            copied_by="a" * 40,
            statement_timeout_s=60,
        )
        periods = next(m for m in result.members if m.spec.dataset_id.endswith("active_periods"))
        with duckdb.connect() as conn:
            assert conn.execute(
                "SELECT i3_alert_snapshot_id FROM read_parquet(?)", [str(root / periods.key)]
            ).fetchall() == [(1,), (2,)]
    finally:
        source.db.close()


@pytest.mark.parametrize("orphan", [(999, 0, 0), (1, 999, 0)])
def test_every_period_is_exported_and_orphans_never_activate(tmp_path, orphan):
    from transit_ops.ingestion.storage import LocalBronzeStorage
    from transit_ops.lake.alert_bundle import MEMBERS, PREFIX, copy_group

    source = SeedSource()
    source.db.execute("INSERT INTO silver.i3_alert_active_periods VALUES (?,?,?)", orphan)
    root = tmp_path / "archive"
    root.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    specs = [
        WindowSpec(r, "_shared" if r.endswith("active_periods") else "p", "2026-11")
        for r in MEMBERS
    ]
    storage = LocalBronzeStorage("local", root)
    try:
        with pytest.raises(ValueError, match="bundle_parent_missing: silver.i3_alerts"):
            copy_group(
                source, storage, specs, work_dir=work, copied_by="a" * 40, statement_timeout_s=60
            )
        assert list(storage.list_keys(PREFIX)) == []
    finally:
        source.db.close()


def test_large_payload_parent_proof_is_key_only_and_memory_bounded(tmp_path):
    import json
    import subprocess
    import sys

    import duckdb

    child = tmp_path / "snapshots.parquet"
    parent = tmp_path / "runs.parquet"
    with duckdb.connect(config={"threads": 1, "memory_limit": "512MB"}) as conn:
        conn.execute(
            "COPY (SELECT range AS i3_alert_snapshot_id, range AS ingestion_run_id, "
            "repeat(md5(range::VARCHAR),2048) AS raw_payload_json FROM range(20000)) "
            "TO ? (FORMAT parquet, COMPRESSION uncompressed, ROW_GROUP_SIZE 2048)",
            [str(child)],
        )
        conn.execute(
            "COPY (SELECT range AS ingestion_run_id FROM range(20000)) TO ? (FORMAT parquet)",
            [str(parent)],
        )
    assert child.stat().st_size >= 1_300_000_000
    script = r"""
import ctypes, json, sys
from pathlib import Path
from transit_ops.lake.alert_bundle import prove_parent_keys, BundleRefused
root=Path(sys.argv[1])
files={'raw.i3_alert_snapshots':[root/'snapshots.parquet'],'raw.ingestion_runs':[root/'runs.parquet']}
fks=[dict(child='raw.i3_alert_snapshots',parent='raw.ingestion_runs',
          child_columns=['ingestion_run_id'],parent_columns=['ingestion_run_id'])]
prove_parent_keys(files,fks,work_dir=root,memory_limit_mb=64,temp_max_mb=128)
if sys.platform=='win32':
    from ctypes import wintypes as w
    class Counts(ctypes.Structure):
        _fields_=[('cb',w.DWORD),('faults',w.DWORD),('peak',ctypes.c_size_t),
                  ('working',ctypes.c_size_t)]+[(f'x{i}',ctypes.c_size_t) for i in range(6)]
    counts=Counts(); counts.cb=ctypes.sizeof(counts)
    ctypes.windll.kernel32.GetCurrentProcess.restype=w.HANDLE
    ctypes.windll.psapi.GetProcessMemoryInfo.argtypes=[w.HANDLE,ctypes.c_void_p,w.DWORD]
    process=ctypes.windll.kernel32.GetCurrentProcess()
    if not ctypes.windll.psapi.GetProcessMemoryInfo(process,ctypes.byref(counts),counts.cb):
        raise ctypes.WinError()
    peak=counts.peak
else:
    import resource
    peak=resource.getrusage(resource.RUSAGE_SELF).ru_maxrss*(1 if sys.platform=='darwin' else 1024)
print(json.dumps(dict(peak_bytes=peak, memory_limit_mb=64)))
"""
    result = subprocess.run(
        [sys.executable, "-c", script, str(tmp_path)],
        capture_output=True,
        text=True,
        timeout=120,
        check=True,
    )
    measured = json.loads(result.stdout)
    print(
        f"PROOF_PEAK_MIB={measured['peak_bytes'] / 2**20:.2f} "
        f"FILE_BYTES={child.stat().st_size} MEMORY_LIMIT_MB=64"
    )
    assert measured["peak_bytes"] < 512 * 2**20
