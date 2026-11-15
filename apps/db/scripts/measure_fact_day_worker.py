"""Safe-default failure policy and bootstrap for the isolated fact-day worker."""

import json
import locale
import os
import re
import runpy
import sys
import traceback
from pathlib import Path
from urllib.parse import quote, quote_plus, unquote, unquote_to_bytes, urlsplit

transport = runpy.run_path(str(Path(__file__).with_name("measure_fact_day_transport.py")))
report_schema = runpy.run_path(str(Path(__file__).with_name("measure_fact_day_report.py")))

# Fixed metadata, reviewed with the source. New or dynamically named types map to other.
BUILTIN_EXCEPTIONS = frozenset(
    """
ArithmeticError AssertionError AttributeError BaseException BaseExceptionGroup BlockingIOError
BrokenPipeError BufferError BytesWarning ChildProcessError ConnectionAbortedError ConnectionError
ConnectionRefusedError ConnectionResetError DeprecationWarning EOFError EncodingWarning
EnvironmentError Exception ExceptionGroup FileExistsError FileNotFoundError FloatingPointError
FutureWarning GeneratorExit IOError ImportError ImportWarning IndentationError IndexError
InterruptedError IsADirectoryError KeyError KeyboardInterrupt LookupError MemoryError
ModuleNotFoundError NameError NotADirectoryError NotImplementedError OSError OverflowError
PendingDeprecationWarning PermissionError ProcessLookupError RecursionError ReferenceError
ResourceWarning RuntimeError RuntimeWarning StopAsyncIteration StopIteration SyntaxError
SyntaxWarning SystemError SystemExit TabError TimeoutError TypeError UnboundLocalError
UnicodeDecodeError UnicodeEncodeError UnicodeError UnicodeTranslateError UnicodeWarning UserWarning
ValueError Warning WindowsError ZeroDivisionError
""".split()
)

TRANSIT_EXCEPTIONS = frozenset(
    """
transit_ops.validation.historic_publish._PublicHttpxRequestError
transit_ops.backups.BackupError transit_ops.batch.checkpoints.CheckpointConflict
transit_ops.batch.checkpoints.NotAccepted transit_ops.batch.clock_guard.ClockReadRefused
transit_ops.batch.engine.BatchEngineError transit_ops.batch.engine.InputRefused
transit_ops.batch.engine.ParquetInputRefused transit_ops.batch.engine.UnnamedQueryRefused
transit_ops.batch.engine.VariantRefused transit_ops.batch.families.registry.UnknownFamilyError
transit_ops.batch.fetch_inputs.InputDigestMismatch transit_ops.batch.input_sources.SourcesMissing
transit_ops.batch.pg_load.InputSchemaRefused transit_ops.batch.pg_load.ReplayDatabaseRefused
transit_ops.batch.run.InputChanged transit_ops.batch.run.OutputRefused
transit_ops.batch.shadow.ShadowRefused transit_ops.capture_load._ReceiptIdentityError
transit_ops.control.heartbeats.HeartbeatInvalid
transit_ops.control.historic_gc_marks.HistoricGcLaneRequired transit_ops.control.leases.LeaseHeld
transit_ops.control.leases.LeaseInvalid transit_ops.control.leases.LeaseLost
transit_ops.control.objects.ObjectCollision transit_ops.control.objects.ObjectConflict
transit_ops.control.objects.ObjectRateLimited transit_ops.core.errors.OptionalSourceUnavailable
transit_ops.daily_run.DailyRunError transit_ops.gold.reader.delay_hist.HistLayoutMismatch
transit_ops.history.alert_recovery_backups._BackupReadError
transit_ops.history.alert_recovery_captures._CaptureRefusal
transit_ops.history.closed_day_rewrites.WindowTrimmed
transit_ops.history.daily_selection.DiscoveryStopped
transit_ops.history.datasets.InvalidDeclaration transit_ops.history.datasets.UndeclaredDataset
transit_ops.history.ledger.WindowNotFound transit_ops.history.ledger_r2.LedgerClockSkew
transit_ops.history.ledger_r2_documents.LedgerDocumentInvalid
transit_ops.history.ledger_r2_readers.LedgerContention
transit_ops.history.ledger_r2_transitions.LedgerTransitionCommitted
transit_ops.history.ledger_r2_transitions.LedgerTransitionIndeterminate
transit_ops.history.ledger_store.WindowChanged transit_ops.history.manifest.ManifestInvalid
transit_ops.history.pack.PackCorrupt transit_ops.history.poll_record.PollRecordInvalid
transit_ops.history.reader.ArchiveNotVerified transit_ops.history.reader.WindowNotAvailable
transit_ops.history.reader.WorkingRowsMissing transit_ops.history.seal_captures.CopyContentMissing
transit_ops.history.seal_captures.WindowNotClosed transit_ops.history.seal_captures._MarkedRejected
transit_ops.history.seal_objects.ScheduleEditionChanged transit_ops.history.verify.CopyCorrupt
transit_ops.ingestion.common.CaptureRunRefused
transit_ops.ingestion.common.CaptureTimeLimitExceeded
transit_ops.ingestion.storage.ObjectAlreadyExists transit_ops.lake.alert_bundle.BundleRefused
transit_ops.lake.csv_validation.InvalidCsvValue transit_ops.lake.migration.MigrationRefused
transit_ops.lake.objects.ObjectKeyTaken transit_ops.lake.parquet_codec.CsvHeaderMismatch
transit_ops.lake.parquet_codec.RequiredValueMissing transit_ops.lake.parquet_verify.CopyDiffers
transit_ops.lake.rescue_parquet.RescueNotConvertible transit_ops.lake.table_copy.ServerChanged
transit_ops.lake.table_copy.UnverifiedCopy transit_ops.lake.table_export.ExportRefused
transit_ops.lake.table_export.SchemaDrift transit_ops.lake.table_schema.InvalidSchema
transit_ops.lake.table_schema.UnsupportedColumnType transit_ops.live.captures.CaptureIntegrityError
transit_ops.live.captures.CaptureParseError transit_ops.live.edition.EditionMissing
transit_ops.live.local_file.LocalFileLocked transit_ops.live.local_file.LocalFileMismatch
transit_ops.live.local_file.LocalFileUnreadable
transit_ops.live.oracle.database.OracleDatabaseRefused
transit_ops.live.oracle.database.UnpinnableClockError transit_ops.live.oracle.runner.ReplayFailed
transit_ops.live.oracle.seed.SeedRefused transit_ops.live.oracle.window.WindowInvalid
transit_ops.operations.resource_plan.ResourceEvidenceMissing
transit_ops.operations.resource_plan.TenantCapacityExceeded
transit_ops.pipeline_switches.GuardRefused transit_ops.pipeline_switches.ReservedSwitch
transit_ops.pipeline_switches.SchemaNotReady transit_ops.providers.declaration.DeclarationError
transit_ops.providers.schedule.EditionNotAvailable
transit_ops.providers.schedule.InvalidScheduleEdition
transit_ops.providers.schedule.ScheduleMembersUnknown transit_ops.s3.ObjectStorageError
transit_ops.snapshots.builders.historic.history_common.HistoricPartitionError
transit_ops.snapshots.gate.GateError transit_ops.snapshots.historic_tree.HistoricGcBlockedError
transit_ops.snapshots.historic_tree.HistoricGcUnsupportedError
transit_ops.snapshots.live_trip_updates.CaptureIdentityError
transit_ops.snapshots.publication_lane.PublishLockUnavailableError
transit_ops.snapshots.storage.ImmutableKeyCollisionError
transit_ops.snapshots.storage.StableActivationConflictError
transit_ops.snapshots.storage.StoredObjectVersionMismatchError
transit_ops.static.alert_seed.AlertSeedReadRefused
transit_ops.static.alert_seed_contract.AlertSeedInvalid
transit_ops.static.alert_state.AlertStateConflict
transit_ops.validation.historic_publish.HistoricProofDeadlineExceeded
""".split()
)


def credential_values() -> set[str]:
    values = set()
    for key, value in os.environ.items():
        if value and (
            key.upper() == "PGPASSWORD"
            or re.search(r"(?:^|_)(?:PASSWORD$|SECRET|TOKEN$|KEY$|URL$)", key.upper())
        ):
            values.add(value)
    url = os.environ.get("DATABASE_URL", "")
    try:
        authority = urlsplit(url).netloc
    except ValueError:
        authority = re.split(r"[/?#]", url.partition("://")[2], maxsplit=1)[0]
    userinfo = authority.rpartition("@")[0]
    if userinfo:
        values.update((userinfo, unquote(userinfo)))
        if ":" in userinfo:
            password = userinfo.split(":", 1)[1]
            values.update((password, unquote(password)))
    return values - {""}


def short_credential() -> bool:
    return any(len(value) < 4 for value in credential_values())


def credential_forms() -> list[str]:
    forms = set()
    for value in credential_values():
        if len(value) < 4:
            continue
        encoded = {quote(value), quote(value, safe=""), quote_plus(value, safe="")}
        forms.update(encoded)
        conninfo = value.replace("\\", "\\\\").replace("'", "\\'")
        for rendered in (value, conninfo, "'" + conninfo + "'"):
            forms.update((rendered, repr(rendered)[1:-1]))
            forms.update(json.dumps(rendered, ensure_ascii=ascii)[1:-1] for ascii in (True, False))
    return sorted(forms, key=len, reverse=True)


def decoded(data: bytes) -> tuple[bytes, bool]:
    for _ in range(3):
        value = unquote_to_bytes(data)
        if value == data:
            return data, True
        data = value
    return data, not re.search(rb"%[0-9A-Fa-f]{2}", data)


def safe_stderr(data: bytes, *, truncated: bool = False) -> str:
    if short_credential():
        return ""
    raw_forms = {
        value.encode(encoding, errors="backslashreplace")
        for value in credential_forms()
        for encoding in {"utf-8", locale.getencoding()}
    }
    data, stable = decoded(data)
    if not stable:
        return ""  # Unsupported encoding depth never returns partially decoded credentials.
    forms = {value for raw in raw_forms for value, stable in [decoded(raw)] if stable}
    if truncated:
        # Three percent layers can expand each byte 27 times. Exclude any cut prefix,
        # then extend the boundary past complete known credentials before redaction.
        cut = min(len(data), 27 * max(map(len, raw_forms), default=0))
        while cut < len(data):
            end = cut
            for value in forms:
                start = data.rfind(value, max(0, cut - len(value) + 1), cut + len(value) - 1)
                if start >= 0:
                    end = max(end, start + len(value))
            if end == cut:
                break
            cut = end
        data = data[cut:]
    for value in sorted(forms, key=len, reverse=True):
        data = data.replace(value, b"<REDACTED>")
    if truncated:
        data = data.partition(b"\n")[2]
    text = data.decode("utf-8", errors="replace")
    text = re.sub(r"[a-zA-Z][a-zA-Z0-9+.-]*://[^\s'\"]+", "<REDACTED_URL>", text)
    text = re.sub(
        r"(?i)\b(password|passwd|token|secret|access_key|api_key)\s*[=:]\s*"
        r"(?:'(?:\\.|[^'\\])*'|\"(?:\\.|[^\"\\])*\"|[^\s,;]+)",
        r"\1=<REDACTED>",
        text,
    )
    text = re.sub(r"input_value=.*", "input_value=<REDACTED>", text)
    return "\n".join(text.splitlines()[-8:])[-2048:]


def safe_detail(text: str) -> str:
    return safe_stderr(text.encode("utf-8", errors="backslashreplace"))


def exception_name(error: BaseException) -> str:
    cls = type(error)
    qualified = cls.__module__ + "." + cls.__qualname__
    if qualified in TRANSIT_EXCEPTIONS:
        return qualified
    if cls.__module__ == "builtins" and cls.__qualname__ in BUILTIN_EXCEPTIONS:
        return cls.__qualname__
    return "other"


def protect_result(output: dict, code: int, diagnostic_detail: bool = False) -> dict:
    if not code:
        if report_schema["valid_report"](output):
            return output
        output, code = dict(reason="invalid_worker_report"), 1
    reasons = (
        "worker_start_failed worker_import_failed worker_crashed lifeline_lost measurement_failed "
        "bundled_timezone_unavailable scratch_ownership_invalid scratch_owner_proof_unavailable "
        "scratch_cleanup_failed scratch_recovery_incomplete unsafe_delete_unavailable "
        "interrupted invalid_arguments invalid_worker_report"
    ).split()
    name = output.get("exception_type")
    known = isinstance(name, str) and (name in BUILTIN_EXCEPTIONS or name in TRANSIT_EXCEPTIONS)
    capture = output.get("stderr_capture")
    result = dict(
        status="failed" if code else "ok",
        exit_status=code,
        exception_type=name if known else "other",
        detail="omitted",
        stderr_capture=capture
        if capture in ("complete", "did_not_close", "read_failed")
        else "unavailable",
    )
    if code:
        reason = output.get("reason")
        result["reason"] = reason if reason in reasons else "worker_crashed"
    if short_credential():
        result["detail_suppressed"] = "short_credential"
    elif diagnostic_detail and isinstance(output.get("error_detail"), str):
        detail = safe_detail(output["error_detail"])
        if detail:
            result.update(detail="included", error_detail=detail)
    return result


def failure(
    reason: str, error: BaseException, diagnostic_detail: bool = False, code: int = 1
) -> dict:
    output = dict(status="failed", reason=reason, exception_type=exception_name(error))
    if diagnostic_detail and not short_credential():
        output["error_detail"] = "".join(traceback.format_exception_only(type(error), error))
    return protect_result(output, code, diagnostic_detail)


def emit_result(output: dict, code: int = 0, diagnostic_detail: bool = False) -> None:
    failed = bool(code) or output.get("status") == "failed"
    if failed:
        output = protect_result(output, code or 1, diagnostic_detail)
    descriptor = vars(sys).get("_transit_measure_report_fd")
    if descriptor is None:
        sys.stdout.write(json.dumps(output, sort_keys=True, default=str) + "\n")
        return
    packet = dict(kind="failure" if failed else "success", data=output)
    data = memoryview((json.dumps(packet, default=str) + "\n").encode("utf-8"))
    while data:
        data = data[os.write(descriptor, data) :]


def boot() -> int:
    receipt_descriptor = transport["receive_descriptor"](sys.argv.pop(1))
    vars(sys)["_transit_measure_report_fd"] = transport["receive_descriptor"](sys.argv.pop(1))
    detail = "--diagnostic-detail" in sys.argv
    reason = "worker_import_failed"
    try:
        namespace = runpy.run_path(sys.argv[1])
        code = sys.argv.pop(4)
        proof = sys.argv.pop(3)
        reason = "worker_start_failed"
        namespace["lifeline"](
            sys.argv[2], proof, error_fd=receipt_descriptor, diagnostic_detail=detail
        )
        reason = "measurement_failed"
        exec(
            code,
            {
                "__name__": "__main__",
                "report": lambda value: emit_result(value, diagnostic_detail=detail),
            },
        )
    except SystemExit:
        raise
    except BaseException as error:
        emit_result(failure(reason, error, detail), 1, detail)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(boot())
