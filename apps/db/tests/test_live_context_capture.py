"""PostgreSQL publication context: one read-only capture per paired-shadow cycle."""

import json
from dataclasses import replace
from datetime import timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy.exc import OperationalError
from test_live_builders_status import context
from test_live_facts import parsed_vehicle, trip_message
from test_live_running import AT, Holder, inputs, parse_at
from test_live_running import local as local

from transit_ops.capture_coverage.rules import FRESH_FEED_AGE_SECONDS
from transit_ops.live import builders_status
from transit_ops.live.context_capture import (
    CAPTURE_LOCK_TIMEOUT_MS,
    CAPTURE_STATEMENT_TIMEOUT_MS,
    CaptureTimeout,
    ContextMissing,
    assemble,
    feed_policy,
    postgres_context,
)
from transit_ops.live.facts import apply_capture
from transit_ops.live.publication_context import CapturedRows
from transit_ops.live.running import FeedPolicy
from transit_ops.sql_registry import query_name

LAG = 45
BASE_URL = "https://example.org"


def manifest(provider="network", feeds=("vehicle_positions",), lag=LAG):
    return SimpleNamespace(
        provider=SimpleNamespace(
            provider_id=provider, display_name="Network", live_source_lag_seconds=lag
        ),
        feeds={
            key: SimpleNamespace(
                endpoint_key=key, feed_kind=key, is_enabled=True, refresh_interval_seconds=30
            )
            for key in feeds
        },
    )


def registry(declared=None, basemap_url=None):
    declared = declared or manifest()
    provider = declared.provider.provider_id
    return SimpleNamespace(
        list_provider_ids=lambda: [provider],
        get_provider=lambda provider_id: declared,
        get_public_config=lambda provider_id: SimpleNamespace(basemap_url=basemap_url),
    )


def sources(provider="network", endpoints=("vehicle_positions",)):
    """The rows the five copied PostgreSQL reads return, as the driver yields them."""
    identity = {"provider_id": provider}
    return {
        "provider": [
            identity
            | dict(
                display_name="Network",
                short_name=None,
                city=None,
                timezone="America/Toronto",
                default_language="fr",
                attribution_text="",
                min_latitude=45.0,
                max_latitude=46.0,
                min_longitude=-74.0,
                max_longitude=-73.0,
            )
        ],
        "editions": [
            identity
            | dict(dataset_version_id=7, source_version="v7", loaded_at_utc=AT - timedelta(days=1))
        ],
        "endpoints": [identity | dict(endpoint_key=e) for e in endpoints],
        "tiers": [
            identity
            | dict(
                tier="static",
                generated_utc=AT - timedelta(hours=1),
                files_written=3,
                files_skipped=0,
                files_total=3,
                gate_checks_run=4,
                gate_errors=0,
                gate_warnings=1,
                gate_verdict="warn",
                gate_generated_utc=AT - timedelta(hours=1),
            )
        ],
        "feeds": [
            identity
            | dict(
                endpoint_key="vehicle_positions",
                status="succeeded",
                successful_completed_at_utc=None,
            )
        ],
    }


def capture(cycle=AT, rows=None, **options):
    options.setdefault("registry", registry())
    options.setdefault("public_base_url", BASE_URL)
    return assemble(cycle, "network", sources() if rows is None else rows, **options)


def test_budget_is_the_fresh_feed_rule_plus_declared_lag_and_enabled_follows_declaration():
    declared = manifest(feeds=("vehicle_positions",), lag=LAG)
    budget = FRESH_FEED_AGE_SECONDS + LAG
    assert feed_policy(declared, "vehicle_positions") == FeedPolicy(True, budget)
    assert feed_policy(declared, "trip_updates") == FeedPolicy(False, budget)
    declared.feeds["vehicle_positions"].is_enabled = False
    assert feed_policy(declared, "vehicle_positions") == FeedPolicy(False, budget)

    ctx = capture()
    assert (ctx.trip_policy, ctx.vehicle_policy) == (
        FeedPolicy(False, budget),
        FeedPolicy(True, budget),
    )


def test_capture_is_detached_canonical_rows_at_the_cycle_with_registry_display_inputs():
    rows = sources()
    ctx = capture(rows=rows, registry=registry(basemap_url="https://tiles.example.org/b.json"))
    rows["provider"][0]["display_name"] = "mutated after capture"
    assert all(
        isinstance(getattr(ctx, name), CapturedRows) and getattr(ctx, name).captured_at == AT
        for name in ("provider", "endpoints", "editions", "tiers", "feeds")
    )
    provider = ctx.rows("provider")[0]
    assert provider["display_name"] == "Network"
    assert provider["public_base_url"] == BASE_URL
    assert provider["basemap_url"] == "https://tiles.example.org/b.json"
    assert provider["source_lag_s"] == LAG
    assert ctx.rows("editions")[0]["loaded_at_utc"] == (AT - timedelta(days=1)).isoformat()
    assert ctx.rows("tiers")[0]["gate_generated_utc"] == (AT - timedelta(hours=1)).isoformat()


@pytest.mark.parametrize(
    ("change", "name"),
    [
        (lambda rows, options: rows.pop("provider"), "provider"),
        (lambda rows, options: rows.pop("endpoints"), "endpoints"),
        (lambda rows, options: rows.pop("editions"), "editions"),
        (lambda rows, options: rows.pop("tiers"), "tiers"),
        (lambda rows, options: rows.pop("feeds"), "feeds"),
        (lambda rows, options: rows["provider"].clear(), "provider"),
        (lambda rows, options: options.update(public_base_url=None), "public_base_url"),
        (lambda rows, options: options.update(public_base_url=""), "public_base_url"),
        (lambda rows, options: options.update(public_base_url="  "), "public_base_url"),
        (
            lambda rows, options: options.update(registry=registry(manifest(provider="other"))),
            "provider_registry",
        ),
    ],
)
def test_missing_input_refuses_by_name_never_an_empty_value(change, name):
    rows, options = sources(), {}
    change(rows, options)
    with pytest.raises(ContextMissing, match=f"^publication_context_missing:{name}$") as missing:
        capture(rows=rows, **options)
    assert missing.value.name == name


def test_naive_timestamps_refuse_rather_than_guess_a_zone():
    rows = sources()
    rows["editions"][0]["loaded_at_utc"] = AT.replace(tzinfo=None)
    with pytest.raises(ValueError, match="aware"):
        capture(rows=rows)


def test_budget_labels_evidence_only_and_never_changes_a_published_byte(local):
    """Live ruling 23: changing or crossing the freshness budget changes no byte."""
    apply_capture(local, parsed_vehicle(), provider_timezone="America/Toronto")
    trips = Holder(parse_at(trip_message(), "trip_updates", AT))
    cycle = AT + timedelta(seconds=90)  # Both recorded captures are 90 s old.
    base = context(endpoints=("trip_updates", "vehicle_positions"))
    base = replace(
        base,
        cycle=cycle,
        **{
            name: replace(getattr(base, name), captured_at=cycle)
            for name in ("provider", "endpoints", "editions", "tiers", "feeds")
        },
    )
    resolved = capture(cycle).vehicle_policy.freshness_seconds
    states, bundles = set(), set()
    budgets = (0, 89, 91, resolved, 10**9)
    for trip_budget, vehicle_budget in [(b, b) for b in budgets] + [(0, 10**9), (10**9, 0)]:
        ctx = replace(
            base,
            trip_policy=FeedPolicy(True, trip_budget),
            vehicle_policy=FeedPolicy(True, vehicle_budget),
        )
        projection = builders_status._project(local, trips, inputs(local), ctx)[3]
        states.add((projection.trip_evidence.state, projection.vehicle_evidence.state))
        bundle = builders_status.build_bundle(local, trips, inputs(local), ctx)
        bundles.add(tuple(sorted(bundle.items())))
    # Each budget is crossed in both directions, together and independently.
    assert {"stale", "fresh"} <= {trip for trip, _ in states}
    assert {"stale", "fresh"} <= {vehicle for _, vehicle in states}
    assert {("stale", "fresh"), ("fresh", "stale")} <= states
    assert len(bundles) == 1
    published = dict(next(iter(bundles)))
    assert json.loads(published["vehicles.json"])["vehicles"]  # Stale still publishes.


class Result:
    def __init__(self, rows):
        self.rows = rows

    def mappings(self):
        return iter(self.rows)

    def __iter__(self):
        return iter(tuple(row.values()) for row in self.rows)

    def scalar_one(self):
        (row,) = self.rows
        (value,) = row.values()
        return value


class Connection:
    """Answers the five named context reads; records every statement it was given."""

    def __init__(self, rows, log, fail=None):
        self.rows, self.log, self.fail = rows, log, fail or {}

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def begin(self):
        return self

    def execute(self, statement, params=None):
        self.log.append((str(statement), params))
        name = query_name(statement)
        if str(statement).strip() == "SELECT now()":
            return Result([{"now": AT}])  # The paired authority's own now() (#1153).
        if name is None:
            return Result([])
        if name in self.fail:
            raise self.fail[name]
        return Result([dict(row) for row in self.rows[name.removeprefix("live.context.")]])


class Engine:
    def __init__(self, rows, fail=None):
        self.rows, self.log, self.fail = rows, [], fail

    def connect(self):
        return Connection(self.rows, self.log, self.fail)


class DriverError(Exception):
    def __init__(self, sqlstate):
        super().__init__(f"server error {sqlstate}")
        self.sqlstate = sqlstate


def cancelled(sqlstate):
    return OperationalError("SELECT ...", {}, DriverError(sqlstate))


def test_postgres_capture_is_one_read_only_snapshot_of_the_copied_queries_without_clock_reads():
    engine = Engine(sources())
    ctx = postgres_context(
        engine, provider_id="network", registry=registry(), public_base_url=BASE_URL
    )(AT)
    assert ctx == capture()
    statements = [sql for sql, _ in engine.log]
    assert "READ ONLY" in statements[0] and "REPEATABLE READ" in statements[0]
    # Bounded before any read: the capture runs ahead of the public publish.
    assert statements[1:3] == [
        f"SET LOCAL statement_timeout = {CAPTURE_STATEMENT_TIMEOUT_MS}",
        f"SET LOCAL lock_timeout = {CAPTURE_LOCK_TIMEOUT_MS}",
    ]
    assert (CAPTURE_STATEMENT_TIMEOUT_MS, CAPTURE_LOCK_TIMEOUT_MS) == (2000, 500)
    assert [query_name(sql) for sql in statements[3:]] == [
        "live.context.provider",
        "live.context.editions",
        "live.context.endpoints",
        "live.context.tiers",
        "live.context.feeds",
    ]
    assert all(params == {"provider_id": "network"} for _, params in engine.log[3:])
    assert not any("now()" in sql.lower() for sql in statements)
    assert not any(
        word in sql.upper() for sql in statements for word in ("INSERT ", "UPDATE ", "DELETE ")
    )


@pytest.mark.parametrize(
    ("sqlstate", "name"), [("57014", "statement_timeout"), ("55P03", "lock_timeout")]
)
def test_slow_or_locked_capture_refuses_by_name(sqlstate, name):
    engine = Engine(sources(), fail={"live.context.feeds": cancelled(sqlstate)})
    capture_now = postgres_context(
        engine, provider_id="network", registry=registry(), public_base_url=BASE_URL
    )
    with pytest.raises(CaptureTimeout, match=f"^publication_context_timeout:{name}$"):
        capture_now(AT)


def test_other_database_errors_are_not_relabelled_as_timeouts():
    engine = Engine(sources(), fail={"live.context.tiers": cancelled("42P01")})
    capture_now = postgres_context(
        engine, provider_id="network", registry=registry(), public_base_url=BASE_URL
    )
    with pytest.raises(OperationalError):
        capture_now(AT)
