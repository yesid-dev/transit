import json
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
from datetime import date
from threading import Event
from uuid import uuid4

import pytest
from sqlalchemy import event, text
from sqlalchemy.exc import DBAPIError
from test_alert_recovery import NOW, REPORTS, candidate
from test_alert_recovery_published import index, page
from typer.testing import CliRunner

from transit_ops.cli import app
from transit_ops.commands import alert_recovery as command
from transit_ops.commands.alert_recovery import (
    build_recovery_source_readers,
    run_alert_archive_recovery,
)
from transit_ops.gold.alert_archive import sync_alert_archive_on_connection
from transit_ops.history.alert_recovery import recover_alert_archive_entries
from transit_ops.history.alert_recovery_models import SourceReport
from transit_ops.history.alert_recovery_published import read_published_candidates
from transit_ops.settings import Settings
from transit_ops.snapshots.storage import LocalSnapshotStorage


@pytest.fixture
def target(real_db_engine, seed_provider):
    provider = "recovery-" + uuid4().hex
    with real_db_engine.begin() as c:
        seed_provider(c, provider, display_name="Recovery fixture")
    try:
        yield real_db_engine, provider
    finally:
        with real_db_engine.begin() as c:
            c.execute(
                text("DELETE FROM gold.alert_archive_entry WHERE provider_id=:p"), {"p": provider}
            )
            c.execute(text("DELETE FROM core.providers WHERE provider_id=:p"), {"p": provider})


def recover(c, p, candidates=(), reports=REPORTS, dry_run=False, **kwargs):
    candidates = tuple(candidates)
    if reports is REPORTS:
        counts = {r.kind: sum(x.source_kind == r.kind for x in candidates) for r in reports}
        reports = tuple(
            replace(r, scanned=counts[r.kind], candidates=counts[r.kind]) for r in reports
        )
    return recover_alert_archive_entries(
        c,
        provider_id=p,
        candidates=candidates,
        source_reports=reports,
        recovered_at_utc=NOW,
        dry_run=dry_run,
        **kwargs,
    )


def rows(c, p):
    return list(
        c.execute(
            text("SELECT * FROM gold.alert_archive_entry WHERE provider_id=:p ORDER BY alert_id"),
            {"p": p},
        ).mappings()
    )


@pytest.mark.parametrize("kind", ["backup", "capture"])
def test_insert_preserves_fields_rerun_and_provider_isolation(target, kind):
    engine, p = target
    item = candidate(p, kind=kind)
    with engine.begin() as c:

        def reader(connection, *, provider_id, recovered_at_utc):
            return (item,), SourceReport(
                kind, scanned=1, candidates=1, coverage=("synthetic bounded scan",), complete=True
            )

        items, evidence = reader(c, provider_id=p, recovered_at_utc=NOW)
        reports = tuple(evidence if r.kind == kind else r for r in REPORTS)
        report = recover(c, p, items, reports)
        assert report.inserted == ("a",)
        before = rows(c, p)
        row = before[0]
        assert row["description_text"] == "Travaux" and row["description_text_en"] == "Works"
        assert row["message"] is None
        assert row["archive_month"] == date(2020, 1, 1)
        assert row["updated_at_utc"] == NOW
        assert row["first_seen_utc"].isoformat() == "2020-01-02T00:00:00+00:00"
        richer = replace(item, record={**item.record, "description_text": "Different"})
        again = recover(c, p, [richer])
        assert again.inserted == again.would_insert == ()
        assert again.already_present == ("a",) and rows(c, p) == before
        assert recover(c, p + "-other", expected_ids=["a"]).unrecovered_expected_ids == ("a",)


@pytest.mark.parametrize("kind", ["backup", "published", "capture"])
def test_incomplete_or_missing_source_blocks_entire_apply(target, kind):
    engine, p = target
    for reports in (
        tuple(r for r in REPORTS if r.kind != kind),
        tuple(SourceReport(kind) if r.kind == kind else r for r in REPORTS),
    ):
        with engine.begin() as c:
            report = recover(
                c,
                p,
                [candidate(p, kind="capture" if kind == "backup" else "backup")],
                reports,
                expected_ids=["lost"],
            )
            assert not report.complete and report.inserted == ()
            assert report.unrecovered_expected_ids is None
            assert report.would_insert == ("a",) and rows(c, p) == []


def test_conflicting_evidence_and_current_identity(target):
    engine, p = target
    a = candidate(p)
    different = replace(a, record={**a.record, "description_text": "Conflict"})
    with engine.begin() as c:
        report = recover(c, p, [candidate(p, "z"), different, a], expected_ids=["a", "lost"])
        assert report.conflicts == ("a",) and report.would_insert == ("z",)
        assert report.inserted == () and report.unrecovered_expected_ids == ("lost",)
        recover(c, p, [a])
        assert recover(c, p, expected_ids=["a"]).already_present == ("a",)
        assert recover(c, p).unrecovered_expected_ids is None
        report = recover(c, p, [different, a], expected_ids=["a", "lost"])
        assert report.complete and report.conflicts == () and report.already_present == ("a",)


def test_dry_run_writes_nothing(target):
    engine, p = target
    with engine.begin() as c:
        with pytest.raises(ValueError, match="read-only"):
            recover(c, p, dry_run=True)
    with engine.begin() as c:
        c.execute(text("SET TRANSACTION READ ONLY"))
        assert c.exec_driver_sql("SHOW transaction_read_only").scalar_one() == "on"
        with pytest.raises(DBAPIError) as refused, c.begin_nested():
            c.execute(text("DELETE FROM gold.alert_archive_entry WHERE provider_id=:p"), {"p": p})
        assert refused.value.orig.sqlstate == "25006"
        report = recover_alert_archive_entries(
            c,
            provider_id=p,
            candidates=[candidate(p)],
            source_reports=REPORTS,
            recovered_at_utc=NOW,
        )
        assert report.would_insert == ("a",) and report.inserted == () and rows(c, p) == []
    with engine.connect() as c:
        assert rows(c, p) == []


def test_batch_failure_rolls_back_earlier_insert(target):
    engine, p = target

    def fail_second(conn, cursor, statement, parameters, context, many):
        if (
            statement.lstrip().startswith("INSERT INTO gold.alert_archive_entry")
            and parameters["alert_id"] == "z"
        ):
            assert len(rows(conn, p)) == 1
            conn.exec_driver_sql("SELECT 1/0")

    with engine.connect() as c:
        event.listen(c, "before_cursor_execute", fail_second)
        with pytest.raises(DBAPIError), c.begin():
            recover(c, p, [candidate(p), candidate(p, "z")])
    with engine.connect() as c:
        assert rows(c, p) == []


def test_entry_in_the_table_is_never_overwritten(target):
    engine, p = target
    with engine.connect() as first, engine.connect() as second:
        assert (
            first.exec_driver_sql("SELECT pg_backend_pid()").scalar_one()
            != second.exec_driver_sql("SELECT pg_backend_pid()").scalar_one()
        )
        first.rollback()
        second.rollback()
        with first.begin():
            sync_alert_archive_on_connection(
                first, provider_id=p, from_date=date(2000, 1, 1), to_date=date(2000, 1, 1)
            )
            second.execute(text("SET LOCAL lock_timeout='100ms'"))
            with pytest.raises(DBAPIError) as blocked:
                recover(second, p, [candidate(p)])
            assert blocked.value.orig.sqlstate == "55P03"
            second.rollback()
            recover(first, p, [candidate(p)])
            before = rows(first, p)
        with second.begin():
            richer = replace(candidate(p), record={**candidate(p).record, "header_text": "Richer"})
            assert recover(second, p, [richer]).inserted == ()
            assert rows(second, p) == before
            first.execute(text("SET LOCAL lock_timeout='100ms'"))
            with pytest.raises(DBAPIError) as held:
                recover(first, p, [candidate(p)])
            assert held.value.orig.sqlstate == "55P03"
            first.rollback()


def test_unique_key_winner_after_comparison_returns_no_insert(target):
    engine, p = target
    paused, resume = Event(), Event()

    def pause(conn, cursor, statement, parameters, context, many):
        if statement.lstrip().startswith("INSERT INTO gold.alert_archive_entry"):
            paused.set()
            assert resume.wait(10)

    def worker():
        with engine.begin() as c:
            event.listen(c, "before_cursor_execute", pause)
            return recover(c, p, [candidate(p)])

    with ThreadPoolExecutor(1) as pool:
        future = pool.submit(worker)
        try:
            assert paused.wait(10)
            with engine.begin() as c:
                c.execute(
                    text("""INSERT INTO gold.alert_archive_entry (
                    provider_id, alert_id, archive_month, description_text,
                    first_seen_utc, last_seen_utc, content_hash, updated_at_utc
                ) VALUES (:p, 'a', '2020-01-01', 'Winner', now(), now(), 'winner', now())"""),
                    {"p": p},
                )
                before = rows(c, p)
        finally:
            resume.set()
        report = future.result(timeout=10)
    with engine.connect() as c:
        assert rows(c, p) == before
    assert report.would_insert == ("a",)
    assert report.inserted == () and report.already_present == ("a",)


def test_entry_found_in_an_older_published_generation_is_written_back(target, tmp_path):
    engine, p = target
    storage = LocalSnapshotStorage(str(tmp_path), f"v1/{p}")
    index(storage, *page(storage, "older"))
    index(storage, *page(storage, "newest"))
    items, evidence = read_published_candidates(storage, provider_id=p, recovered_at_utc=NOW)
    reports = (REPORTS[0], evidence, REPORTS[2])
    readers = dict(build_recovery_source_readers(storage, settings=Settings(_env_file=None)))
    readers.update({k: v for k, v in complete_readers(items).items() if k != "published"})
    report = run_alert_archive_recovery(
        engine, provider_id=p, source_readers=readers, dry_run=False, recovered_at_utc=NOW
    )
    assert report.inserted == ("newest", "older")
    with engine.begin() as c:
        report = recover(c, p, reversed(items), reports)
        assert report.inserted == report.would_insert == ()
        older = rows(c, p)[1]
        assert (older["description_text"], older["description_text_en"]) == ("Travaux", "Works")
        assert older["url_en"] is None and older["updated_at_utc"] == NOW
        assert older["message"] == {
            "snapshot_id": "evidence",
            "alert_index": 2,
            "captured_utc": "2026-11-01T00:00:00Z",
            "header_language": None,
            "description_language": None,
            "url_language": None,
        }
        assert older["archive_month"] == date(2020, 1, 1)
        assert older["last_seen_utc"].isoformat() == "2026-11-01T00:00:00+00:00"
        assert recover(c, p, items, reports).inserted == ()
    assert run_alert_archive_recovery(
        engine, provider_id=p, source_readers=readers, dry_run=False, recovered_at_utc=NOW
    ).inserted == ()


@pytest.mark.parametrize("isolation", ["AUTOCOMMIT", "REPEATABLE READ"])
def test_apply_requires_caller_owned_read_committed_transaction(target, isolation):
    engine, p = target
    with engine.connect().execution_options(isolation_level=isolation) as c, c.begin():
        with pytest.raises(ValueError, match="non-autocommit"):
            recover(c, p, [candidate(p)])


def complete_readers(items=(), visited=None):
    def reader(kind):
        def read(connection, *, provider_id, recovered_at_utc):
            if visited is not None:
                visited.append(kind)
            selected = tuple(c for c in items if c.source_kind == kind)
            return selected, SourceReport(kind, scanned=len(selected), candidates=len(selected),
                                          coverage=("synthetic bounded scan",), complete=True)
        return read
    return {kind: reader(kind) for kind in ("capture", "published", "backup")}


@pytest.mark.parametrize("complete", [False, True])
def test_entry_no_source_holds_is_reported(target, tmp_path, complete):
    engine, p = target
    with engine.begin() as c:
        recover(c, p, [candidate(p)])
    readers = complete_readers()
    if not complete:
        readers = build_recovery_source_readers(
            LocalSnapshotStorage(str(tmp_path), f"v1/{p}"),
            settings=Settings(_env_file=None, BRONZE_S3_BUCKET=None),
        )
    report = run_alert_archive_recovery(engine, provider_id=p, source_readers=readers,
                                       expected_ids=["lost", "a"], recovered_at_utc=NOW)
    assert report.already_present == ("a",)
    assert report.complete is complete
    assert report.unrecovered_expected_ids == (("lost",) if complete else None)


@pytest.mark.parametrize("via_cli", [False, True])
def test_runner_and_cli_default_transaction_is_read_only(target, monkeypatch, tmp_path, via_cli):
    engine, p = target
    def observations(c):
        return [c.execute(text(f"SELECT count(*) FROM {table} WHERE provider_id=:p"),
                          {"p": p}).scalar_one() for table in
                ("silver.i3_alerts", "core.history_window", "core.history_event")]
    with engine.begin() as c:
        recover(c, p, [candidate(p)])
        before = rows(c, p)
        unchanged = observations(c)
    observed = []
    visited = []
    readers = complete_readers([candidate(p, "missing")], visited)
    original = readers["backup"]

    def probe(connection, **kwargs):
        observed.append(connection.exec_driver_sql("SHOW transaction_read_only").scalar_one())
        with pytest.raises(DBAPIError) as refused, connection.begin_nested():
            connection.execute(text("DELETE FROM gold.alert_archive_entry WHERE provider_id=:p"),
                               {"p": p})
        assert refused.value.orig.sqlstate == "25006"
        return original(connection, **kwargs)

    readers["backup"] = probe
    if via_cli:
        result = invoke_cli(monkeypatch, tmp_path, engine, p, readers)
        assert result.exit_code == 0, result.output
    else:
        report = run_alert_archive_recovery(engine, provider_id=p, source_readers=readers,
                                           recovered_at_utc=NOW)
        assert report.dry_run and report.would_insert == ("missing",) and report.inserted == ()
    assert observed == ["on"]
    assert visited == ["backup", "published", "capture"]
    with engine.connect() as c:
        assert rows(c, p) == before and observations(c) == unchanged


@pytest.mark.parametrize("kind", ["backup", "capture"])
@pytest.mark.parametrize("via_cli", [False, True])
def test_runner_complete_synthetic_source_apply(target, monkeypatch, tmp_path, kind, via_cli):
    engine, p = target
    readers = complete_readers([candidate(p, kind=kind)])
    if via_cli:
        result = invoke_cli(monkeypatch, tmp_path, engine, p, readers, apply=True)
        assert result.exit_code == 0, result.output
        assert json.loads(result.stdout)["inserted"] == ["a"]
    else:
        report = run_alert_archive_recovery(
            engine, provider_id=p, source_readers=readers, dry_run=False, recovered_at_utc=NOW)
        assert report.complete and report.inserted == ("a",)
    with engine.connect() as c:
        assert len(rows(c, p)) == 1 and rows(c, p + "-other") == []


@pytest.mark.parametrize("fault", ["exception", "mismatch", "unknown"])
def test_runner_refuses_bad_source_evidence(target, fault):
    engine, p = target
    visited = []
    readers = complete_readers([candidate(p)])

    def broken(connection, **kwargs):
        visited.append("backup")
        if fault == "exception":
            raise ValueError("secret payload")
        return (candidate(p),), SourceReport("capture")

    readers["backup"] = broken
    if fault == "unknown":
        readers["unknown"] = broken
        with pytest.raises(ValueError, match="unknown source slot"):
            run_alert_archive_recovery(engine, provider_id=p, source_readers=readers,
                                       recovered_at_utc=NOW)
        assert visited == []
    else:
        report = run_alert_archive_recovery(engine, provider_id=p, source_readers=readers,
                                           dry_run=False, recovered_at_utc=NOW)
        assert not report.complete and report.inserted == ()
        assert report.source_reports[0].errors == ("source read failed",)
    with engine.connect() as c:
        assert rows(c, p) == []


def invoke_cli(monkeypatch, tmp_path, engine, p, readers, apply=False):
    monkeypatch.setattr(command, "get_settings", lambda: Settings(
        SNAPSHOT_STORAGE_BACKEND="local", SNAPSHOT_LOCAL_ROOT=str(tmp_path)))
    monkeypatch.setattr(command, "make_engine", lambda settings: engine)
    monkeypatch.setattr(command.ProviderRegistry, "from_project_root", lambda **kw: type(
        "Registry", (), {"get_provider": lambda self, p: None})())
    monkeypatch.setattr(command, "build_recovery_source_readers",
                        lambda storage, *, settings: readers)
    return CliRunner().invoke(app, ["recover-alert-archive-entries", p, "--capture-from",
        "2020-01-01T00:00:00Z", "--capture-to", "2020-02-01T00:00:00Z"] +
        (["--apply"] if apply else []))


def test_sql_reader_failure_keeps_other_evidence_reportable(target, tmp_path):
    engine, p = target
    storage = LocalSnapshotStorage(str(tmp_path), f"v1/{p}")
    index(storage, *page(storage, "older"))
    readers = dict(build_recovery_source_readers(storage, settings=Settings(_env_file=None)))
    observed = []

    def invalid_backup_cast(connection, **kwargs):
        observed.append((connection.exec_driver_sql("SHOW transaction_read_only").scalar_one(),
                         connection.in_nested_transaction()))
        connection.exec_driver_sql("SELECT 'invalid-timestamp'::timestamptz")

    readers["backup"] = invalid_backup_cast
    report = run_alert_archive_recovery(
        engine, provider_id=p, source_readers=readers, recovered_at_utc=NOW)
    assert observed == [("on", True)] and report.dry_run and not report.complete
    assert report.would_insert == ("older",) and report.inserted == ()
    assert report.source_reports[0].errors == ("source read failed",)
    assert report.source_reports[1].complete
    assert report.source_reports[2].coverage == ("not read",)
    with engine.connect() as c:
        assert rows(c, p) == []


@pytest.mark.parametrize("boundary", ["insert", "commit"])
@pytest.mark.parametrize("via_cli", [False, True])
def test_runner_and_cli_failures_leave_no_rows_or_receipt(
    target, monkeypatch, tmp_path, boundary, via_cli
):
    engine, p = target
    injected = []

    def fail(connection, *args):
        if boundary == "insert" and not (
            args[1].lstrip().startswith("INSERT INTO gold.alert_archive_entry")
            and args[2]["alert_id"] == "z"
        ):
            return
        assert len(rows(connection, p)) == (1 if boundary == "insert" else 2)
        injected.append(boundary)
        connection.exec_driver_sql("SELECT 'secret-payload'::integer")

    hook = "before_cursor_execute" if boundary == "insert" else "commit"
    event.listen(engine, hook, fail)
    readers = complete_readers([candidate(p), candidate(p, "z")])
    try:
        if via_cli:
            result = invoke_cli(monkeypatch, tmp_path, engine, p, readers, apply=True)
        else:
            with pytest.raises(DBAPIError):
                run_alert_archive_recovery(engine, provider_id=p, source_readers=readers,
                                           dry_run=False, recovered_at_utc=NOW)
    finally:
        event.remove(engine, hook, fail)
    assert injected == [boundary]
    with engine.connect() as c:
        assert rows(c, p) == []
    if via_cli:
        assert result.exit_code == 1
        assert json.loads(result.stdout) == {"error": "alert archive recovery failed"}


def test_receipt_before_commit_mutation_fails_commit_regression(target, monkeypatch, tmp_path):
    import inspect

    source = inspect.getsource(command)
    echo = 'typer.echo(json.dumps(asdict(report), default=lambda v: v.isoformat(), sort_keys=True))'
    source = source.replace("    " + echo + "\n", "")
    source = source.replace("    return report_result\n",
        "            " + echo.replace("asdict(report)", "asdict(report_result)") +
        "\n    return report_result\n")
    mutated = dict(vars(command))
    exec(compile(source, command.__file__, "exec"), mutated)
    monkeypatch.setattr(command, "run_alert_archive_recovery",
                        mutated["run_alert_archive_recovery"])
    with pytest.raises(json.JSONDecodeError):
        test_runner_and_cli_failures_leave_no_rows_or_receipt(
            target, monkeypatch, tmp_path, "commit", True)


@pytest.fixture(autouse=True)
def ambient_storage_sentinel(monkeypatch):
    from unittest.mock import Mock

    for name, value in {
        "BUCKET": "sentinel",
        "ENDPOINT": "https://storage.invalid",
        "ACCESS_KEY": "synthetic",
        "SECRET_KEY": "synthetic",
    }.items():
        monkeypatch.setenv("BRONZE_S3_" + name, value)
    session = Mock(side_effect=AssertionError("real S3 client forbidden"))
    monkeypatch.setattr("boto3.session.Session", session)
    yield
    session.assert_not_called()


def test_no_source_uses_no_ambient_storage(tmp_path, monkeypatch):
    from contextlib import nullcontext
    from unittest.mock import MagicMock, Mock

    c = MagicMock(closed=False, invalidated=False)
    c.__enter__.return_value = c
    c.execution_options.return_value = c
    c.dialect.name = "postgresql"
    c.connection.dbapi_connection.autocommit = False
    c.get_isolation_level.return_value = "READ COMMITTED"
    c.execute.return_value = Mock(scalar_one=lambda: "on", scalars=lambda: ["a"])
    engine = Mock(connect=lambda: c, begin=lambda: nullcontext(c))
    monkeypatch.setitem(globals(), "recover", lambda *args: None)
    test_entry_no_source_holds_is_reported((engine, "fixture"), tmp_path, False)
