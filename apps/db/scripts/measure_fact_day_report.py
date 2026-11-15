"""Declared JSON schema for one successful fact-day measurement report."""

import json
import math
import re

INTEGER, NUMBER = ("int",), ("number",)
TEXT = ("text", 128)
HASH = ("text", 64, r"[0-9a-f]{64}")
FIELDS = ("list", TEXT, 64)
RESULT = dict(rows=INTEGER, sha256=HASH, fields=FIELDS, seconds=NUMBER)
PARAMS = dict(p=TEXT, start=TEXT, end=TEXT, tz=TEXT, day=TEXT, key=INTEGER, built=TEXT)
POSTGRES = dict(
    **RESULT, params=PARAMS, source_query_sha256=HASH, kind={"route", "hourly", "stop", "crowding"}
)
ATTEMPT = dict(
    **RESULT, status={"equal", "different"}, row=INTEGER, first_field=TEXT, safe_key_sha256=HASH
)
FAMILY = dict(postgres=POSTGRES, duckdb=("list", ATTEMPT, 2), deterministic=bool)
COMPARISON = dict(
    scope=("text", 256),
    outputs=("map", FAMILY, r"\d{4}-\d{2}-\d{2}-(route|hourly|stop|crowding)", 64),
    status={"not_applicable_empty_sample", "equal", "different"},
)
CANDIDATE = dict(
    level=INTEGER,
    order={"primary", "analytical"},
    requested_row_group_rows=INTEGER,
    actual_row_group_rows=("list", INTEGER, 65536),
    rows=INTEGER,
    bytes=INTEGER,
    sha256=HASH,
    write_seconds=NUMBER,
    verification_seconds=NUMBER,
)
CODECS = dict(
    csv_bytes=INTEGER,
    csv_sha256=HASH,
    gzip_bytes=INTEGER,
    gzip_seconds=NUMBER,
    gzip_level=INTEGER,
    parquet=("list", CANDIDATE, 12),
    text_order={"binary"},
    null_order={"last"},
)
TABLE = dict(
    schema=("list", ("tuple", TEXT, TEXT, bool), 64),
    schema_sha256=HASH,
    csv_sha256=HASH,
    csv_bytes=INTEGER,
    copy_rows=INTEGER,
    export_seconds=NUMBER,
    codecs=CODECS,
)
QUERY = dict(
    rows=INTEGER,
    sha256=HASH,
    seconds=NUMBER,
    definition=("text", 8192),
    units={"seconds; delay_seconds"},
    cache_state={"uncontrolled"},
    warm_seconds=NUMBER,
    warm_sha256=HASH,
    trip_outcome={"empty_string", "selected", "null_only", "no_rows"},
)
SCHEMA = dict(
    format_version=INTEGER,
    provider=TEXT,
    day=TEXT,
    start=TEXT,
    end=TEXT,
    prefix=("text", 1024),
    status={"closed_emergency_snapshot", "partial_asof"},
    timezone=TEXT,
    snapshot_time=TEXT,
    server_version=TEXT,
    database_read_seconds=NUMBER,
    oracle_query_seconds=NUMBER,
    tables={name: TABLE for name in ("fact_trip_delay_snapshot", "fact_vehicle_snapshot")},
    queries=("list", QUERY, 3),
    family_comparison=COMPARISON,
    duckdb_version=TEXT,
    python_version=TEXT,
    python_traced_peak_bytes=INTEGER,
    memory_basis={"Python traced peak excludes native allocations; process lifetime RSS"},
    native_peak_rss_bytes=("nullable", INTEGER),
    native_peak_rss_reason={
        None,
        "process peak RSS unavailable on this platform",
        "resource peak RSS unavailable",
    },
)
REQUIRED = {
    "tables",
    "queries",
    "family_comparison",
    "duckdb_version",
    "python_version",
    "python_traced_peak_bytes",
    "memory_basis",
    "native_peak_rss_bytes",
    "native_peak_rss_reason",
}


def matches(value, schema):
    if isinstance(schema, type):
        return type(value) is schema
    if isinstance(schema, dict):
        return (
            type(value) is dict
            and value.keys() <= schema.keys()
            and all(matches(v, schema[k]) for k, v in value.items())
        )
    if isinstance(schema, set):
        return (value is None or type(value) is str) and value in schema
    tag, *args = schema
    if tag in ("int", "number"):
        return (type(value) is int and 0 <= value <= 2**63 - 1) or (
            tag == "number" and type(value) is float and math.isfinite(value) and value >= 0
        )
    if tag == "text":
        return (
            type(value) is str
            and len(value) <= args[0]
            and (len(args) == 1 or re.fullmatch(args[1], value) is not None)
        )
    if tag == "nullable":
        return value is None or matches(value, args[0])
    if tag == "list":
        return (
            type(value) is list
            and len(value) <= args[1]
            and all(matches(v, args[0]) for v in value)
        )
    if tag == "tuple":
        return (
            type(value) is list
            and len(value) == len(args)
            and all(matches(v, s) for v, s in zip(value, args, strict=True))
        )
    if tag == "map":
        return (
            type(value) is dict
            and len(value) <= args[2]
            and all(
                re.fullmatch(args[1], k) is not None and matches(v, args[0])
                for k, v in value.items()
            )
        )
    return False


def valid_report(value):
    return type(value) is dict and REQUIRED <= value.keys() and matches(value, SCHEMA)


def load_packet(raw):
    if len(raw) > 2097152:
        raise ValueError("invalid_worker_report")
    depth, quoted, escaped = 0, False, False
    for byte in raw:
        if quoted:
            if escaped:
                escaped = False
            elif byte == 92:
                escaped = True
            elif byte == 34:
                quoted = False
        elif byte == 34:
            quoted = True
        elif byte in (91, 123):
            depth += 1
            if depth > 32:
                raise ValueError("invalid_worker_report")
        elif byte in (93, 125):
            depth -= 1
    return json.loads(raw)
