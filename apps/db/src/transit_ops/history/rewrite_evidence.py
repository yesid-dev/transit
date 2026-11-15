"""Validated processing evidence shared by history readers and rewrite producers."""

import re
from collections.abc import Mapping
from copy import deepcopy
from datetime import UTC, datetime

from transit_ops.history.poll_record import PollRecordInvalid


def _stamp(value: object) -> datetime:
    if not isinstance(value, str) or not re.fullmatch(
        r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z", value
    ):
        raise ValueError("invalid UTC timestamp")
    return datetime.fromisoformat(value)


def _keys(value: object, keys: str, name: str) -> Mapping[str, object]:
    if not isinstance(value, Mapping) or set(value) != set(keys.split()):
        raise ValueError(f"malformed {name}")
    return value


def _positive(value: object) -> bool:
    return type(value) is int and value > 0


def _hash(value: object) -> bool:
    return isinstance(value, str) and re.fullmatch(r"[0-9a-f]{64}", value) is not None


def _control_text(value: object, field: str) -> None:
    if isinstance(value, str) and re.search(r"[\x00-\x1f\x7f-\x9f]", value):
        raise ValueError(f"malformed {field}: forbidden control character")


def _rewrite(value: object, command: object, counts: Mapping[str, object]) -> None:
    rewrite = _keys(
        value,
        "schema operation_id expected_current_version "
        "expected_working_changed_at_utc edition provenance",
        "rewrite",
    )
    if type(rewrite["schema"]) is not int or rewrite["schema"] != 1:
        raise ValueError("unknown evidence version")
    _control_text(command, "command")
    _control_text(rewrite["operation_id"], "operation_id")
    if not isinstance(rewrite["operation_id"], str) or not rewrite["operation_id"].strip():
        raise ValueError("malformed operation_id")
    version = rewrite["expected_current_version"]
    if version is not None and not _positive(version):
        raise ValueError("malformed expected_current_version")
    if rewrite["expected_working_changed_at_utc"] is not None:
        _stamp(rewrite["expected_working_changed_at_utc"])
    edition = _keys(rewrite["edition"], "provider_id dataset_version_id checksum_sha256", "edition")
    _control_text(edition["provider_id"], "provider_id")
    if (
        not isinstance(edition["provider_id"], str)
        or not edition["provider_id"].strip()
        or not _positive(edition["dataset_version_id"])
        or (edition["checksum_sha256"] is not None and not _hash(edition["checksum_sha256"]))
    ):
        raise ValueError("malformed edition")
    _provenance(rewrite["provenance"], command, counts)


def _provenance(value: object, command: object, counts: Mapping[str, object]) -> None:
    p = _keys(
        value,
        "command mode capture_ids source_hashes code_revision code_revision_unknown_reason",
        "provenance",
    )
    ids, hashes = p["capture_ids"], p["source_hashes"]
    for field in ("command", "mode", "code_revision_unknown_reason"):
        _control_text(p[field], field)
    if (
        p["command"] != command
        or not isinstance(p["mode"], str)
        or not p["mode"].strip()
        or not isinstance(ids, list)
        or not ids
        or not all(_positive(i) for i in ids)
        or len(set(ids)) != len(ids)
        or not isinstance(hashes, Mapping)
        or set(hashes) != {str(i) for i in ids}
        or any(h is not None and not _hash(h) for h in hashes.values())
        or not set(counts).issubset(hashes)
    ):
        raise ValueError("malformed provenance")
    revision, reason = p["code_revision"], p["code_revision_unknown_reason"]
    if revision is None:
        if not isinstance(reason, str) or not reason.strip():
            raise ValueError("malformed provenance: unknown code revision needs reason")
    elif (
        not isinstance(revision, str)
        or not re.fullmatch(r"[0-9a-f]{40}|[0-9a-f]{64}", revision)
        or reason is not None
    ):
        raise ValueError("malformed provenance: code_revision")


def processing_evidence_details(
    *,
    command: str,
    completed_at_utc: datetime,
    index_family: str,
    rows_by_capture: Mapping[int, int],
    rewrite: Mapping[str, object],
) -> dict[str, object]:
    """Encode successful selected outcomes; absent captures remain absent.

    Edition comes from the producing GoldBuildContext, with its provider-filtered
    checksum (null when unknown). Code revisions must be verified by the caller.
    Source hashes are keyed by intended capture id; unknown hashes remain null.
    """
    if completed_at_utc.utcoffset() is None:
        raise PollRecordInvalid("completed_at_utc must be aware")
    if any(not _positive(key) for key in rows_by_capture):
        raise PollRecordInvalid("invalid capture counts")
    details: dict[str, object] = {
        "command": command,
        "completed_at_utc": completed_at_utc.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "index_family": index_family,
        "rows_by_capture": {str(k): v for k, v in rows_by_capture.items()},
        "rewrite": deepcopy(dict(rewrite)),
    }
    decode_processing_evidence(details, index_family=index_family, sequence=0)
    return details


def decode_processing_evidence(
    details: Mapping[str, object], *, index_family: str, sequence: int
) -> tuple[datetime, dict[int, int]]:
    try:
        keys = {
            "command",
            "completed_at_utc",
            "index_family",
            "rows_by_capture",
        }
        if not isinstance(details, Mapping) or set(details) not in (keys, keys | {"rewrite"}):
            raise ValueError("invalid keys")
        if "rewrite" not in details and not isinstance(details, dict):
            raise ValueError("invalid keys")
        stamp, counts = details["completed_at_utc"], details["rows_by_capture"]
        if (
            not isinstance(details["command"], str)
            or details["index_family"] != index_family
            or not isinstance(stamp, str)
            or not re.fullmatch(
                r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z", stamp
            )
            or not isinstance(counts, Mapping if "rewrite" in details else dict)
        ):
            raise ValueError("invalid evidence fields")
        if any(
            not isinstance(key, str)
            or not re.fullmatch(r"[0-9]+", key)
            or int(key) <= 0
            or type(value) is not int
            or value < 0
            for key, value in counts.items()
        ):
            raise ValueError("invalid capture counts")
        if "rewrite" in details:
            if len({int(k) for k in counts}) != len(counts):
                raise ValueError("invalid capture counts: duplicate identity")
            _rewrite(details["rewrite"], details["command"], counts)
        return _stamp(stamp), {int(k): v for k, v in counts.items()}
    except (ValueError, TypeError, KeyError) as exc:
        raise PollRecordInvalid(f"event {sequence}: {exc}") from exc
