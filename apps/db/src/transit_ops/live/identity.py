"""Verified cutover identity floors and atomic per-namespace ID allocation.

Borrows the single worker-owned LocalFile without opening another connection.
IDs start strictly above explicitly supplied, digest-verified global maxima
(never from max(local rows)) and survive crash and retry without ID reuse.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import UTC, datetime
from hashlib import sha256
from pathlib import Path
from typing import Any, Final

import duckdb

from transit_ops.live.local_file import LocalFile, LocalFileMismatch, _table_shape
from transit_ops.static.alert_seed_contract import AlertSeed

# Before activation, incompatible identity formats bump this version and refuse (live 21).
IDENTITY_FORMAT_VERSION: Final = 1
FLOORS_DOCUMENT_VERSION: Final = 1
NAMESPACES: Final[tuple[str, ...]] = (
    "ingestion_run",
    "ingestion_object",
    "realtime_snapshot",
    "alert_snapshot",
)
_INDEX_FAMILIES: Final = frozenset({"realtime_snapshot", "alert_snapshot"})
_OUTCOMES: Final = frozenset({"stored", "failed", "skipped_identical", "silver_load_failed"})
_SHA256_RE: Final = re.compile(r"^[0-9a-f]{64}$")
_ATTEMPT_KEY_RE: Final = re.compile(r"^[A-Za-z0-9._-]{1,128}$")
_MAX_BIGINT: Final = 2**63 - 1
_FLOORS_KEYS: Final = frozenset(
    {
        "version",
        "provider_id",
        "alert_seed_sha256",
        "seed_snapshot_at_utc",
        "captured_at_utc",
        "ingestion_run_id",
        "ingestion_object_id",
        "realtime_snapshot_id",
        "alert_snapshot_id",
    }
)
_DEFINITIONS: Final[dict[str, str]] = {
    "local_identity_meta": (
        "format_version INTEGER NOT NULL, "
        "provider_id VARCHAR PRIMARY KEY, "
        "floors_sha256 VARCHAR NOT NULL, "
        "alert_seed_sha256 VARCHAR NOT NULL, "
        "seed_snapshot_at_utc TIMESTAMP NOT NULL, "
        "captured_at_utc TIMESTAMP NOT NULL"
    ),
    "local_identity_namespaces": (
        "namespace VARCHAR PRIMARY KEY, "
        "floor_value BIGINT NOT NULL CHECK(floor_value >= 0), "
        "next_id BIGINT NOT NULL CHECK(next_id > floor_value)"
    ),
    "local_identity_reservations": (
        "attempt_key VARCHAR PRIMARY KEY, "
        "endpoint_key VARCHAR NOT NULL, "
        "index_family VARCHAR NOT NULL, "
        "outcome VARCHAR NOT NULL, "
        "request_digest VARCHAR NOT NULL, "
        "ingestion_run_id BIGINT NOT NULL CHECK(ingestion_run_id > 0), "
        "ingestion_object_id BIGINT CHECK(ingestion_object_id IS NULL OR ingestion_object_id > 0), "
        "capture_row_id BIGINT CHECK(capture_row_id IS NULL OR capture_row_id > 0), "
        "recorded BOOLEAN NOT NULL"
    ),
}


class IdentityRefused(ValueError):
    """Named refusal for missing, mismatched, or violated local identity floors."""


def _utc_naive(stamp: datetime) -> datetime:
    if stamp.utcoffset() is None:
        raise IdentityRefused("local_identity_floors_invalid:naive_timestamp")
    return stamp.astimezone(UTC).replace(tzinfo=None)


def _valid_provider(provider_id: object) -> bool:
    return (
        isinstance(provider_id, str)
        and bool(provider_id)
        and provider_id not in (".", "..")
        and re.search(r"[\x00-\x1f]", provider_id) is None
    )


def _valid_floor(value: object) -> bool:
    return type(value) is int and 0 <= value < _MAX_BIGINT


def _parse_aware_iso(value: object, field_name: str) -> datetime:
    if not isinstance(value, str):
        raise IdentityRefused(f"local_identity_floors_invalid:{field_name}")
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError as exc:
        raise IdentityRefused(f"local_identity_floors_invalid:{field_name}") from exc
    if parsed.utcoffset() is None:
        raise IdentityRefused(f"local_identity_floors_invalid:{field_name}")
    return parsed.astimezone(UTC)


def _no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise IdentityRefused("local_identity_floors_invalid:duplicate_key")
        result[key] = value
    return result


@dataclass(frozen=True)
class IdentityFloors:
    """Explicitly verified global maxima per identity namespace at cutover."""

    version: int
    provider_id: str
    alert_seed_sha256: str
    seed_snapshot_at_utc: datetime
    captured_at_utc: datetime
    ingestion_run_id: int
    ingestion_object_id: int
    realtime_snapshot_id: int
    alert_snapshot_id: int

    def __post_init__(self) -> None:
        if type(self.version) is not int or self.version != FLOORS_DOCUMENT_VERSION:
            raise IdentityRefused(f"local_identity_floors_version_unsupported:{self.version!r}")
        if not _valid_provider(self.provider_id):
            raise IdentityRefused("local_identity_floors_invalid:provider_id")
        if (
            not isinstance(self.alert_seed_sha256, str)
            or _SHA256_RE.fullmatch(self.alert_seed_sha256) is None
        ):
            raise IdentityRefused("local_identity_floors_invalid:alert_seed_sha256")
        if (
            not isinstance(self.seed_snapshot_at_utc, datetime)
            or self.seed_snapshot_at_utc.utcoffset() is None
            or not isinstance(self.captured_at_utc, datetime)
            or self.captured_at_utc.utcoffset() is None
            or self.captured_at_utc.astimezone(UTC) < self.seed_snapshot_at_utc.astimezone(UTC)
        ):
            raise IdentityRefused("local_identity_floors_invalid:timestamps")
        for field_name in (
            "ingestion_run_id",
            "ingestion_object_id",
            "realtime_snapshot_id",
            "alert_snapshot_id",
        ):
            if not _valid_floor(getattr(self, field_name)):
                raise IdentityRefused(f"local_identity_floors_invalid:{field_name}")

    def floor_for(self, namespace: str) -> int:
        mapping = {
            "ingestion_run": self.ingestion_run_id,
            "ingestion_object": self.ingestion_object_id,
            "realtime_snapshot": self.realtime_snapshot_id,
            "alert_snapshot": self.alert_snapshot_id,
        }
        if namespace not in mapping:
            raise IdentityRefused(f"local_identity_unknown_namespace:{namespace}")
        return mapping[namespace]

    def to_json(self) -> bytes:
        document = {
            "version": self.version,
            "provider_id": self.provider_id,
            "alert_seed_sha256": self.alert_seed_sha256,
            "seed_snapshot_at_utc": self.seed_snapshot_at_utc.astimezone(UTC).isoformat(
                timespec="microseconds"
            ),
            "captured_at_utc": self.captured_at_utc.astimezone(UTC).isoformat(
                timespec="microseconds"
            ),
            "ingestion_run_id": self.ingestion_run_id,
            "ingestion_object_id": self.ingestion_object_id,
            "realtime_snapshot_id": self.realtime_snapshot_id,
            "alert_snapshot_id": self.alert_snapshot_id,
        }
        return json.dumps(
            document, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False
        ).encode("utf-8")

    @classmethod
    def from_json(cls, payload: bytes) -> IdentityFloors:
        def _reject_constant(_value: str) -> None:
            raise IdentityRefused("local_identity_floors_invalid:nonstandard_json")

        try:
            raw = json.loads(
                payload.decode("utf-8"),
                object_pairs_hook=_no_duplicate_keys,
                parse_constant=_reject_constant,
            )
        except (UnicodeDecodeError, ValueError) as exc:
            if isinstance(exc, IdentityRefused):
                raise
            raise IdentityRefused("local_identity_floors_invalid:json") from exc
        if not isinstance(raw, dict):
            raise IdentityRefused("local_identity_floors_shape_mismatch")
        version = raw.get("version")
        if type(version) is not int or version != FLOORS_DOCUMENT_VERSION:
            raise IdentityRefused(f"local_identity_floors_version_unsupported:{version!r}")
        if set(raw) != _FLOORS_KEYS:
            raise IdentityRefused("local_identity_floors_shape_mismatch")
        return cls(
            version=version,
            provider_id=raw["provider_id"],
            alert_seed_sha256=raw["alert_seed_sha256"],
            seed_snapshot_at_utc=_parse_aware_iso(
                raw["seed_snapshot_at_utc"], "seed_snapshot_at_utc"
            ),
            captured_at_utc=_parse_aware_iso(raw["captured_at_utc"], "captured_at_utc"),
            ingestion_run_id=raw["ingestion_run_id"],
            ingestion_object_id=raw["ingestion_object_id"],
            realtime_snapshot_id=raw["realtime_snapshot_id"],
            alert_snapshot_id=raw["alert_snapshot_id"],
        )


def verify_identity_floors(
    path: Path,
    *,
    expected_sha256: str,
    seed: AlertSeed,
    alert_seed_sha256: str,
) -> IdentityFloors:
    """Read, digest-verify, and cross-check an operator-supplied floors artifact."""
    if not isinstance(expected_sha256, str) or _SHA256_RE.fullmatch(expected_sha256) is None:
        raise IdentityRefused("local_identity_floors_digest_invalid")
    if not isinstance(alert_seed_sha256, str) or _SHA256_RE.fullmatch(alert_seed_sha256) is None:
        raise IdentityRefused("local_identity_alert_seed_digest_invalid")
    try:
        payload = path.read_bytes()
    except OSError as exc:
        raise IdentityRefused("local_identity_floors_unreadable") from exc
    if sha256(payload).hexdigest() != expected_sha256:
        raise IdentityRefused("local_identity_floors_digest_mismatch")
    floors = IdentityFloors.from_json(payload)
    if floors.provider_id != seed.provider_id:
        raise IdentityRefused("local_identity_floors_provider_mismatch")
    if (
        floors.alert_seed_sha256 != alert_seed_sha256
        or floors.seed_snapshot_at_utc.astimezone(UTC) != seed.snapshot_at.astimezone(UTC)
    ):
        raise IdentityRefused("local_identity_floors_seed_mismatch")
    if (
        seed.global_max_snapshot_id is not None
        and floors.alert_snapshot_id < seed.global_max_snapshot_id
    ):
        raise IdentityRefused("local_identity_floor_below_evidence:alert_snapshot")
    return floors


@dataclass(frozen=True)
class IdentityReservation:
    attempt_key: str
    endpoint_key: str
    index_family: str
    outcome: str
    request_digest: str
    ingestion_run_id: int
    ingestion_object_id: int | None
    capture_row_id: int | None
    recorded: bool


def _existing_tables(conn: duckdb.DuckDBPyConnection) -> set[tuple[str, str]]:
    return {
        (str(schema), str(table))
        for schema, table in conn.execute(
            "SELECT schema_name, table_name FROM duckdb_tables() "
            "WHERE database_name=current_database() AND NOT temporary"
        ).fetchall()
    }


def _verify_identity_tables(conn: duckdb.DuckDBPyConnection, *, create: bool) -> bool:
    """Verify exact identity table shapes; create atomically only when absent and allowed."""
    existing_main = {table for schema, table in _existing_tables(conn) if schema == "main"}
    present = existing_main.intersection(_DEFINITIONS)
    if not present:
        if not create:
            return False
        fresh = True
    else:
        fresh = False
        if "local_identity_meta" in present:
            try:
                versions = conn.execute(
                    "SELECT format_version FROM local_identity_meta"
                ).fetchall()
            except duckdb.Error as exc:
                raise IdentityRefused("local_identity_meta_unreadable") from exc
            if versions and versions != [(IDENTITY_FORMAT_VERSION,)]:
                raise IdentityRefused(
                    f"local_identity_format_version_mismatch:{versions[0][0]!r}"
                )
    for table, definition in _DEFINITIONS.items():
        if not fresh and table not in existing_main:
            raise IdentityRefused(f"local_identity_table_missing:{table}")
        conn.execute(f"CREATE TEMP TABLE _identity_expected ({definition})")
        try:
            if fresh:
                conn.execute(f"CREATE TABLE {table} ({definition})")
            if _table_shape(conn, table) != _table_shape(conn, "_identity_expected"):
                raise IdentityRefused(f"local_identity_table_shape_differs:{table}")
        except LocalFileMismatch as exc:
            raise IdentityRefused(f"local_identity_table_shape_differs:{table}") from exc
        finally:
            conn.execute("DROP TABLE _identity_expected")
    return True


def _max_query(conn: duckdb.DuckDBPyConnection, query: str) -> int:
    row = conn.execute(query).fetchone()
    if row is None or row[0] is None:
        return 0
    return int(row[0])


def _retained_maxima(conn: duckdb.DuckDBPyConnection) -> dict[str, int]:
    """Compute the highest ID present across every retained local table per namespace."""
    tables = _existing_tables(conn)
    run_queries = [
        "SELECT max(ingestion_run_id) FROM polls",
        "SELECT max(ingestion_run_id) FROM captures",
        "SELECT max(ingestion_run_id) FROM processing WHERE ingestion_run_id IS NOT NULL",
        "SELECT max(ingestion_run_id) FROM recording_coverage",
        (
            "SELECT max(greatest(initial_run_id, after_run_id, sweep_last_run_id, "
            "coalesce(covered_through, 0))) FROM recording_cursor"
        ),
    ]
    object_queries = ["SELECT max(ingestion_object_id) FROM captures"]
    rt_queries = [
        "SELECT max(capture_row_id) FROM captures WHERE index_family='realtime_snapshot'",
        "SELECT max(capture_row_id) FROM polls WHERE index_family='realtime_snapshot'",
        "SELECT max(duplicate_of_row_id) FROM polls WHERE index_family='realtime_snapshot'",
        "SELECT max(capture_row_id) FROM processing WHERE index_family='realtime_snapshot'",
        (
            "SELECT max(capture_row_id) FROM local_applications "
            "WHERE endpoint_key IN ('trip_updates', 'vehicle_positions')"
        ),
        (
            "SELECT max(capture_row_id) FROM local_serving "
            "WHERE endpoint_key IN ('trip_updates', 'vehicle_positions')"
        ),
    ]
    alert_queries = [
        "SELECT max(capture_row_id) FROM captures WHERE index_family='alert_snapshot'",
        "SELECT max(capture_row_id) FROM polls WHERE index_family='alert_snapshot'",
        "SELECT max(duplicate_of_row_id) FROM polls WHERE index_family='alert_snapshot'",
        "SELECT max(capture_row_id) FROM processing WHERE index_family='alert_snapshot'",
        (
            "SELECT max(capture_row_id) FROM local_applications "
            "WHERE endpoint_key IN ('i3_alerts', 'service_alerts')"
        ),
        (
            "SELECT max(capture_row_id) FROM local_serving "
            "WHERE endpoint_key IN ('i3_alerts', 'service_alerts')"
        ),
    ]
    if ("main", "local_identity_reservations") in tables:
        run_queries.append("SELECT max(ingestion_run_id) FROM local_identity_reservations")
        object_queries.append("SELECT max(ingestion_object_id) FROM local_identity_reservations")
        rt_queries.append(
            "SELECT max(capture_row_id) FROM local_identity_reservations "
            "WHERE index_family='realtime_snapshot'"
        )
        alert_queries.append(
            "SELECT max(capture_row_id) FROM local_identity_reservations "
            "WHERE index_family='alert_snapshot'"
        )
    if ("main", "fact_vehicle_snapshot") in tables:
        rt_queries.append("SELECT max(realtime_snapshot_id) FROM fact_vehicle_snapshot")
    if ("main", "fact_trip_delay_snapshot") in tables:
        rt_queries.append("SELECT max(realtime_snapshot_id) FROM fact_trip_delay_snapshot")
    if ("main", "fact_processing") in tables:
        rt_queries.append("SELECT max(capture_row_id) FROM fact_processing")
    if ("main", "alert_seed_checkpoint") in tables:
        alert_queries.append("SELECT max(global_max_snapshot_id) FROM alert_seed_checkpoint")
    if ("raw", "i3_alert_snapshots") in tables:
        alert_queries.append("SELECT max(i3_alert_snapshot_id) FROM raw.i3_alert_snapshots")
        run_queries.append("SELECT max(ingestion_run_id) FROM raw.i3_alert_snapshots")
        object_queries.append("SELECT max(ingestion_object_id) FROM raw.i3_alert_snapshots")
    if ("silver", "i3_alerts") in tables:
        alert_queries.append(
            "SELECT max(greatest(i3_alert_snapshot_id, coalesce(message_snapshot_id, 0))) "
            "FROM silver.i3_alerts"
        )
    if ("silver", "i3_alert_informed_entities") in tables:
        alert_queries.append(
            "SELECT max(i3_alert_snapshot_id) FROM silver.i3_alert_informed_entities"
        )
    if ("silver", "i3_alert_active_periods") in tables:
        alert_queries.append("SELECT max(i3_alert_snapshot_id) FROM silver.i3_alert_active_periods")
    return {
        "ingestion_run": max((_max_query(conn, q) for q in run_queries), default=0),
        "ingestion_object": max((_max_query(conn, q) for q in object_queries), default=0),
        "realtime_snapshot": max((_max_query(conn, q) for q in rt_queries), default=0),
        "alert_snapshot": max((_max_query(conn, q) for q in alert_queries), default=0),
    }


def _verify_alert_seed_checkpoint(
    conn: duckdb.DuckDBPyConnection,
    *,
    provider_id: str,
    seed: AlertSeed | None = None,
) -> tuple[str, int | None]:
    if ("main", "alert_seed_checkpoint") not in _existing_tables(conn):
        raise IdentityRefused("local_identity_alert_seed_missing")
    rows = conn.execute(
        "SELECT provider_id, sha256, global_max_snapshot_id FROM alert_seed_checkpoint"
    ).fetchall()
    if len(rows) != 1 or rows[0][0] != provider_id:
        raise IdentityRefused("local_identity_alert_seed_missing")
    stored_digest, stored_global_max = str(rows[0][1]), rows[0][2]
    if seed is not None:
        expected_digest = json.loads(seed.to_json())["sha256"]
        if (
            seed.provider_id != provider_id
            or stored_digest != expected_digest
            or stored_global_max != seed.global_max_snapshot_id
        ):
            raise IdentityRefused("local_identity_alert_seed_mismatch")
    return stored_digest, None if stored_global_max is None else int(stored_global_max)


class IdentityAllocator:
    """Atomic, crash-safe local ID allocator over a borrowed LocalFile."""

    def __init__(self, local: LocalFile, *, provider_id: str) -> None:
        if not _valid_provider(provider_id):
            raise IdentityRefused("local_identity_invalid_provider")
        self.local = local
        self.provider_id = provider_id

    def initialize(
        self,
        floors: IdentityFloors,
        *,
        floors_sha256: str,
        seed: AlertSeed,
        alert_seed_sha256: str | None = None,
    ) -> None:
        """Install verified cutover floors once, or verify exact match on reopen."""
        if _SHA256_RE.fullmatch(floors_sha256) is None:
            raise IdentityRefused("local_identity_floors_digest_invalid")
        if floors.provider_id != self.provider_id or seed.provider_id != self.provider_id:
            raise IdentityRefused("local_identity_floors_provider_mismatch")
        seed_file_sha = (
            sha256(seed.to_json()).hexdigest()
            if alert_seed_sha256 is None
            else alert_seed_sha256
        )
        if _SHA256_RE.fullmatch(seed_file_sha) is None:
            raise IdentityRefused("local_identity_alert_seed_digest_invalid")
        if (
            floors.alert_seed_sha256 != seed_file_sha
            or floors.seed_snapshot_at_utc.astimezone(UTC) != seed.snapshot_at.astimezone(UTC)
        ):
            raise IdentityRefused("local_identity_floors_seed_mismatch")
        with self.local.transaction() as conn:
            if conn.execute("SELECT provider_id FROM meta").fetchall() != [(self.provider_id,)]:
                raise IdentityRefused("local_identity_provider_mismatch")
            _, global_alert_max = _verify_alert_seed_checkpoint(
                conn, provider_id=self.provider_id, seed=seed
            )
            if global_alert_max is not None and floors.alert_snapshot_id < global_alert_max:
                raise IdentityRefused("local_identity_floor_below_evidence:alert_snapshot")
            _verify_identity_tables(conn, create=True)
            retained = _retained_maxima(conn)
            existing_meta = conn.execute(
                "SELECT format_version, provider_id, floors_sha256, alert_seed_sha256, "
                "seed_snapshot_at_utc, captured_at_utc FROM local_identity_meta"
            ).fetchall()
            expected_meta = (
                IDENTITY_FORMAT_VERSION,
                self.provider_id,
                floors_sha256,
                floors.alert_seed_sha256,
                _utc_naive(floors.seed_snapshot_at_utc),
                _utc_naive(floors.captured_at_utc),
            )
            if not existing_meta:
                if conn.execute("SELECT 1 FROM local_identity_namespaces LIMIT 1").fetchone():
                    raise IdentityRefused("local_identity_state_corrupt")
                if conn.execute("SELECT 1 FROM local_identity_reservations LIMIT 1").fetchone():
                    raise IdentityRefused("local_identity_state_corrupt")
                for namespace in NAMESPACES:
                    floor_value = floors.floor_for(namespace)
                    if floor_value < retained[namespace]:
                        raise IdentityRefused(f"local_identity_floor_below_evidence:{namespace}")
                conn.execute(
                    "INSERT INTO local_identity_meta VALUES (?, ?, ?, ?, ?, ?)",
                    list(expected_meta),
                )
                conn.executemany(
                    "INSERT INTO local_identity_namespaces VALUES (?, ?, ?)",
                    [
                        (ns, floors.floor_for(ns), floors.floor_for(ns) + 1)
                        for ns in NAMESPACES
                    ],
                )
                return
            if len(existing_meta) != 1 or existing_meta[0] != expected_meta:
                raise IdentityRefused("local_identity_floors_changed")
            ns_rows = conn.execute(
                "SELECT namespace, floor_value, next_id FROM local_identity_namespaces"
            ).fetchall()
            ns_map = {
                str(ns): (int(floor_val), int(next_val))
                for ns, floor_val, next_val in ns_rows
            }
            if set(ns_map) != set(NAMESPACES) or len(ns_rows) != len(NAMESPACES):
                raise IdentityRefused("local_identity_state_corrupt")
            for namespace in NAMESPACES:
                floor_value, next_id = ns_map[namespace]
                if floor_value != floors.floor_for(namespace):
                    raise IdentityRefused("local_identity_floors_changed")
                if next_id <= floor_value or next_id <= retained[namespace]:
                    raise IdentityRefused(f"local_identity_checkpoint_below_evidence:{namespace}")

    def require_initialized(self) -> None:
        """Refuse allocation when verified seed or floors have not been installed."""
        with self.local.transaction() as conn:
            if conn.execute("SELECT provider_id FROM meta").fetchall() != [(self.provider_id,)]:
                raise IdentityRefused("local_identity_provider_mismatch")
            _verify_alert_seed_checkpoint(conn, provider_id=self.provider_id)
            if not _verify_identity_tables(conn, create=False):
                raise IdentityRefused("local_identity_floors_missing")
            meta = conn.execute(
                "SELECT format_version, provider_id FROM local_identity_meta"
            ).fetchall()
            if not meta:
                raise IdentityRefused("local_identity_floors_missing")
            if meta != [(IDENTITY_FORMAT_VERSION, self.provider_id)]:
                raise IdentityRefused("local_identity_floors_changed")
            ns_rows = conn.execute("SELECT namespace FROM local_identity_namespaces").fetchall()
            if {str(r[0]) for r in ns_rows} != set(NAMESPACES):
                raise IdentityRefused("local_identity_state_corrupt")

    def reserve(
        self,
        *,
        attempt_key: str,
        endpoint_key: str,
        index_family: str,
        outcome: str,
        request_digest: str,
    ) -> IdentityReservation:
        """Atomically allocate or retrieve durable IDs bound to one attempt digest."""
        if not isinstance(attempt_key, str) or _ATTEMPT_KEY_RE.fullmatch(attempt_key) is None:
            raise IdentityRefused("local_identity_invalid_attempt_key")
        if not isinstance(endpoint_key, str) or not endpoint_key:
            raise IdentityRefused("local_identity_invalid_endpoint_key")
        if index_family not in _INDEX_FAMILIES:
            raise IdentityRefused(f"local_identity_invalid_family:{index_family}")
        if outcome not in _OUTCOMES:
            raise IdentityRefused(f"local_identity_invalid_outcome:{outcome}")
        if not isinstance(request_digest, str) or _SHA256_RE.fullmatch(request_digest) is None:
            raise IdentityRefused("local_identity_invalid_request_digest")

        with self.local.transaction() as conn:
            self.require_initialized()
            existing = _fetch_reservation(conn, attempt_key)
            if existing is not None:
                if (
                    existing.endpoint_key,
                    existing.index_family,
                    existing.outcome,
                    existing.request_digest,
                ) != (endpoint_key, index_family, outcome, request_digest):
                    raise IdentityRefused("local_identity_reservation_conflict")
                return existing

            retained = _retained_maxima(conn)
            needed = (
                ("ingestion_run", "ingestion_object", index_family)
                if outcome == "stored"
                else ("ingestion_run",)
            )
            allocated: dict[str, int] = {}
            for namespace in needed:
                row = conn.execute(
                    "SELECT floor_value, next_id FROM local_identity_namespaces WHERE namespace=?",
                    [namespace],
                ).fetchone()
                if row is None:
                    raise IdentityRefused("local_identity_state_corrupt")
                floor_value, next_id = int(row[0]), int(row[1])
                if next_id <= floor_value or next_id <= retained[namespace]:
                    raise IdentityRefused(f"local_identity_checkpoint_below_evidence:{namespace}")
                if next_id >= _MAX_BIGINT:
                    raise IdentityRefused(f"local_identity_overflow:{namespace}")
                updated = conn.execute(
                    "UPDATE local_identity_namespaces SET next_id = next_id + 1 "
                    "WHERE namespace = ? RETURNING next_id - 1",
                    [namespace],
                ).fetchall()
                if len(updated) != 1 or int(updated[0][0]) != next_id:
                    raise IdentityRefused("local_identity_state_corrupt")
                allocated[namespace] = int(updated[0][0])

            reservation = IdentityReservation(
                attempt_key=attempt_key,
                endpoint_key=endpoint_key,
                index_family=index_family,
                outcome=outcome,
                request_digest=request_digest,
                ingestion_run_id=allocated["ingestion_run"],
                ingestion_object_id=allocated.get("ingestion_object"),
                capture_row_id=allocated.get(index_family),
                recorded=False,
            )
            conn.execute(
                "INSERT INTO local_identity_reservations VALUES (?, ?, ?, ?, ?, ?, ?, ?, false)",
                [
                    reservation.attempt_key,
                    reservation.endpoint_key,
                    reservation.index_family,
                    reservation.outcome,
                    reservation.request_digest,
                    reservation.ingestion_run_id,
                    reservation.ingestion_object_id,
                    reservation.capture_row_id,
                ],
            )
            return reservation

    def get_reservation(self, attempt_key: str) -> IdentityReservation | None:
        with self.local.transaction() as conn:
            self.require_initialized()
            return _fetch_reservation(conn, attempt_key)

    def unrecorded_reservations(
        self, *, endpoint_key: str | None = None
    ) -> tuple[IdentityReservation, ...]:
        with self.local.transaction() as conn:
            self.require_initialized()
            if endpoint_key is None:
                rows = conn.execute(
                    "SELECT attempt_key, endpoint_key, index_family, outcome, request_digest, "
                    "ingestion_run_id, ingestion_object_id, capture_row_id, recorded "
                    "FROM local_identity_reservations WHERE NOT recorded "
                    "ORDER BY ingestion_run_id"
                ).fetchall()
            else:
                rows = conn.execute(
                    "SELECT attempt_key, endpoint_key, index_family, outcome, request_digest, "
                    "ingestion_run_id, ingestion_object_id, capture_row_id, recorded "
                    "FROM local_identity_reservations WHERE NOT recorded AND endpoint_key=? "
                    "ORDER BY ingestion_run_id",
                    [endpoint_key],
                ).fetchall()
            return tuple(_row_to_reservation(r) for r in rows)

    def mark_recorded(self, attempt_key: str, *, request_digest: str) -> None:
        """Mark a reserved identity recorded inside the canonical record commit."""
        with self.local.transaction() as conn:
            existing = _fetch_reservation(conn, attempt_key)
            if existing is None:
                raise IdentityRefused("local_identity_reservation_missing")
            if existing.request_digest != request_digest:
                raise IdentityRefused("local_identity_reservation_conflict")
            conn.execute(
                "UPDATE local_identity_reservations SET recorded = true WHERE attempt_key = ?",
                [attempt_key],
            )


def _fetch_reservation(
    conn: duckdb.DuckDBPyConnection, attempt_key: str
) -> IdentityReservation | None:
    row = conn.execute(
        "SELECT attempt_key, endpoint_key, index_family, outcome, request_digest, "
        "ingestion_run_id, ingestion_object_id, capture_row_id, recorded "
        "FROM local_identity_reservations WHERE attempt_key = ?",
        [attempt_key],
    ).fetchone()
    return None if row is None else _row_to_reservation(row)


def _row_to_reservation(row: tuple[Any, ...]) -> IdentityReservation:
    return IdentityReservation(
        attempt_key=str(row[0]),
        endpoint_key=str(row[1]),
        index_family=str(row[2]),
        outcome=str(row[3]),
        request_digest=str(row[4]),
        ingestion_run_id=int(row[5]),
        ingestion_object_id=None if row[6] is None else int(row[6]),
        capture_row_id=None if row[7] is None else int(row[7]),
        recorded=bool(row[8]),
    )
