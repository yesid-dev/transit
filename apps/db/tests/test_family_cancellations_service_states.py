import json
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from decimal import ROUND_HALF_UP, Decimal

import duckdb
import pytest

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.families.registry import resolve_builder
from transit_ops.batch.manifest import BuildManifest
from transit_ops.batch.run import run_family

DAY = date(2026, 11, 1)
STAMP = datetime(2026, 11, 10, 12, 0, 0, 123456, UTC)
EDITION = 98280004


def request(days=(DAY, DAY + timedelta(days=1), DAY + timedelta(days=7))):
    return BuildRequest(
        "seed",
        days,
        STAMP,
        14,
        10,
        "America/Toronto",
        edition_by_day={day: EDITION for day in days},
        edition_source="current_at_build",
    )


def _seed_trips():
    trips = [("A", f"t{i}", "week") for i in range(3)]
    trips += [
        (r, r, s)
        for r, s in [
            ("dark", "added"),
            ("", "week"),
            ("a", "week"),
            ("é", "week"),
            ("removed", "removed"),
        ]
    ]
    trips += [("tie", f"tie{i}", "week") for i in range(32)]
    trips += [("inactive", "inactive", "inactive")]
    return trips


def _seed_facts():
    # R26 assumes feed time is at most one UTC day ahead of capture; capture may lag.
    facts = [
        ("A", "t0", DAY, None, 20261101, "2026-11-01T05:30:00.000001+00:00"),
        ("A", "t0", DAY, 3, 20261102, "2026-11-03T06:30:00.000002+00:00"),
        ("A", "t1", DAY, 0, 20261101, "2026-10-31T20:00:00+00:00"),
        ("A", "t2", DAY, 2, 20261101, "2026-11-01T06:30:00.000002+00:00"),
        ("", "", DAY, 3, 20261101, "2026-11-01T07:00:00+00:00"),
        ("unknown", "u", DAY, None, 20261101, "2026-11-01T07:00:00+00:00"),
    ]
    facts += [
        ("tie", f"tie{i}", DAY, 3 if i == 0 else 0, 20261101, "2026-11-01T08:00:00+00:00")
        for i in range(32)
    ]
    facts += [
        (None, "nullroute", DAY, 3, 20261101, "2026-11-01T08:00:00+00:00"),
        ("excluded", None, DAY, 3, 20261101, "2026-11-01T08:00:00+00:00"),
        ("excluded", "nodate", None, 3, 20261101, "2026-11-01T08:00:00+00:00"),
        ("excluded", "wrongkey", DAY, 3, 20261103, "2026-11-03T08:00:00+00:00"),
        ("excluded", "wrongday", DAY - timedelta(days=1), 3, 20261101, "2026-11-01T08:00:00+00:00"),
    ]
    return facts


def seed_data(req):
    trips, facts = _seed_trips(), _seed_facts()
    prefix = (EDITION, "seed")
    return {
        "core.dataset_versions": (
            "dataset_version_id BIGINT, provider_id TEXT, dataset_kind TEXT, "
            "is_current BOOLEAN, loaded_at_utc TIMESTAMPTZ",
            [
                (EDITION, "seed", "static_schedule", True, STAMP),
                (EDITION + 1, "seed", "static_schedule", False, STAMP),
            ],
        ),
        "silver.trips": (
            "dataset_version_id BIGINT, provider_id TEXT, route_id TEXT, "
            "trip_id TEXT, service_id TEXT",
            [(*prefix, *row) for row in trips],
        ),
        "silver.calendar": (
            "dataset_version_id BIGINT, provider_id TEXT, service_id TEXT, start_date DATE, "
            "end_date DATE, monday BOOLEAN, tuesday BOOLEAN, wednesday BOOLEAN, thursday BOOLEAN, "
            "friday BOOLEAN, saturday BOOLEAN, sunday BOOLEAN",
            [
                (*prefix, s, DAY, DAY + timedelta(days=6), *([s != "inactive"] * 7))
                for s in ("week", "removed", "inactive")
            ],
        ),
        "silver.calendar_dates": (
            "dataset_version_id BIGINT, provider_id TEXT, service_id TEXT, service_date DATE, "
            "exception_type SMALLINT",
            [(*prefix, "added", DAY, 1), (*prefix, "removed", DAY, 2)],
        ),
        "gold.fact_trip_delay_snapshot": (
            "provider_id TEXT, route_id TEXT, trip_id TEXT, start_date DATE, "
            "trip_schedule_relationship SMALLINT, snapshot_date_key INTEGER, "
            "captured_at_utc TIMESTAMPTZ",
            [("seed", *row[:-1], datetime.fromisoformat(row[-1])) for row in facts],
        ),
    }


def write_inputs(root, req, data=None):
    data = data or seed_data(req)
    with duckdb.connect(config={"TimeZone": "UTC"}) as conn:
        for relation, (ddl, rows) in data.items():
            conn.execute(f"CREATE OR REPLACE TABLE source ({ddl})")
            if rows:
                conn.executemany(
                    "INSERT INTO source VALUES (" + ",".join("?" for _ in rows[0]) + ")", rows
                )
            if relation.startswith("silver."):
                windows = [
                    (f"edition:{edition}", " WHERE dataset_version_id = ?", [edition])
                    for edition in sorted(set(req.edition_by_day.values()))
                ]
            elif relation.startswith("core."):
                windows = [("all", "", [])]
            else:
                first = req.as_of_utc.date() - timedelta(days=req.fact_retention_days)
                windows = [
                    (
                        (first + timedelta(days=i)).isoformat(),
                        " WHERE captured_at_utc::DATE = ?::DATE",
                        [(first + timedelta(days=i)).isoformat()],
                    )
                    for i in range(req.fact_retention_days + 1)
                ]
            for window, where, binds in windows:
                path = root / relation / (window.replace(":", "=") + ".parquet")
                path.parent.mkdir(parents=True, exist_ok=True)
                conn.execute(
                    f"COPY (SELECT * FROM source{where}) TO ? (FORMAT PARQUET)", [*binds, str(path)]
                )


def build(root, req):
    builder = resolve_builder("cancellations_service_states")
    assert builder is not None, "cancellations_service_states must be implemented"
    return run_family(builder, req, inputs_root=root, workdir=root, code_commit="a" * 40).output


def test_calendar_exceptions_service_states_and_exact_halfway_rate(tmp_path):
    req = request()
    write_inputs(tmp_path, req)
    output = build(tmp_path, req)
    scheduled = output.tables["gold.route_scheduled_trips_daily"].rows
    assert scheduled == tuple(
        ("seed", day, route, count, EDITION, STAMP)
        for day, counts in [
            (DAY, [("", 1), ("A", 3), ("a", 1), ("dark", 1), ("tie", 32), ("é", 1)]),
            (
                DAY + timedelta(days=1),
                [("", 1), ("A", 3), ("a", 1), ("removed", 1), ("tie", 32), ("é", 1)],
            ),
        ]
        for route, count in counts
    )
    rows = output.tables["gold.route_cancellation_daily"].rows
    actual = {r[2]: r[3:] for r in rows if r[1] == DAY}
    assert actual == {
        "": (1, 1, Decimal("100.00"), STAMP, 1, 0, 0),
        "A": (3, 1, Decimal("33.33"), STAMP, 3, 2, 0),
        "a": (0, 0, None, STAMP, 1, 0, 1),
        "dark": (0, 0, None, STAMP, 1, 0, 1),
        "tie": (32, 1, Decimal("3.13"), STAMP, 32, 31, 0),
        "unknown": (1, 0, Decimal("0.00"), STAMP, None, 1, None),
        "é": (0, 0, None, STAMP, 1, 0, 1),
    }
    assert all(r[1] != DAY + timedelta(days=7) for r in rows)
    assert output.bodies == {}
    assert assert_math(output, seed_data(req)) == (0, 0)


def assert_math(output, data):
    raw = data["gold.fact_trip_delay_snapshot"][1]
    excess_days, total_excess = 0, 0
    for row in output.tables["gold.route_cancellation_daily"].rows:
        _, day, route, total, canceled, rate, _, scheduled, delivered, silent = row
        trips = {}
        keys = {int(day.strftime("%Y%m%d")), int((day + timedelta(days=1)).strftime("%Y%m%d"))}
        for p, r, trip, service, relationship, key, _ in raw:
            if p == "seed" and r == route and trip is not None and service == day and key in keys:
                trips[trip] = trips.get(trip, False) or relationship == 3
        assert total == len(trips) and canceled == sum(trips.values())
        assert all(type(n) is int and n >= 0 for n in (total, canceled, delivered))
        assert 0 <= canceled <= total and delivered + canceled == total
        expected = (
            (Decimal(100) * canceled / total).quantize(Decimal(".01"), ROUND_HALF_UP)
            if total
            else None
        )
        assert rate == expected
        if rate is not None:
            assert rate.is_finite() and not rate.is_signed() and 0 <= rate / 100 <= 1
        assert silent == (max(scheduled - total, 0) if scheduled is not None else None)
        if scheduled is not None:
            assert all(type(n) is int and n >= 0 for n in (scheduled, silent))
            assert delivered + canceled + silent == max(total, scheduled)
            excess = max(total - scheduled, 0)
            assert type(excess) is int and excess >= 0
            excess_days += int(excess > 0)
            total_excess += excess
    _assert_scheduled_math(output, data)
    return excess_days, total_excess


def _assert_scheduled_math(output, data):
    for _, day, route, count, edition, _ in output.tables["gold.route_scheduled_trips_daily"].rows:
        active = {
            r[2]
            for r in data["silver.calendar"][1]
            if r[0] == edition and r[3] <= day <= r[4] and r[5 + day.weekday()]
        }
        exceptions = [
            r for r in data["silver.calendar_dates"][1] if r[0] == edition and r[3] == day
        ]
        active -= {r[2] for r in exceptions if r[4] == 2}
        active |= {r[2] for r in exceptions if r[4] == 1}
        assert count == len(
            {
                r[3]
                for r in data["silver.trips"][1]
                if r[0] == edition and r[2] == route and r[4] in active
            }
        )
        assert type(count) is int and count >= 0


@pytest.mark.parametrize("mapping", [None, {}])
def test_missing_edition_is_refused_before_input_io(tmp_path, mapping):
    req = replace(
        request(),
        edition_by_day=mapping,
        edition_source="current_at_build" if mapping is not None else None,
    )
    with pytest.raises(ValueError, match="edition_unresolved.*2026-11-01"):
        build(tmp_path, req)


def test_feed_capture_lag_and_day_independence(tmp_path):
    req = request()
    write_inputs(tmp_path, req)
    alone = build(tmp_path, replace(req, local_dates=(DAY,)))
    combined = build(tmp_path, req)
    for name, table in alone.tables.items():
        assert table.rows == tuple(r for r in combined.tables[name].rows if r[1] == DAY)


def test_retention_edge_is_refused_before_input_io(tmp_path):
    req = replace(
        request(), local_dates=(date(2026, 10, 28),), edition_by_day={date(2026, 10, 28): EDITION}
    )
    with pytest.raises(ValueError, match="retention_edge_day 2026-10-28.*cutoff="):
        build(tmp_path, req)


def test_manifest_preserves_absent_mapping_bytes_and_encodes_dates():
    req = request((DAY,))
    args = dict(
        provider_id=req.provider_id,
        local_dates=req.local_dates,
        as_of_utc=STAMP,
        fact_retention_days=14,
        open_window_days=10,
        timezone=req.timezone,
        family_id="cancellations_service_states",
        code_commit="a" * 40,
        inputs=(),
    )
    old = BuildManifest(**args)
    expected = (
        (
            '{"as_of_utc":"2026-11-10T12:00:00.123456Z","code_commit":"'
            + "a" * 40
            + '","engine":"duckdb","engine_version":"'
            + duckdb.__version__
            + '","fact_retention_days":14,"family_id":"cancellations_service_states","inputs":[], '
            '"local_dates":["2026-11-01"],"open_window_days":10,"provider_id":"seed",'
            '"revision":2,"timezone":"America/Toronto"}'
        )
        .replace("[], ", "[],")
        .encode()
    )
    assert old.canonical_json() == expected
    with_editions = BuildManifest(
        **args, edition_by_day={DAY: EDITION}, edition_source="current_at_build"
    )
    assert with_editions.canonical_json() == expected.replace(
        b',"engine":',
        b',"edition_by_day":{"2026-11-01":98280004},"edition_source":"current_at_build","engine":',
    )
    assert old.build_id != with_editions.build_id
    later = DAY + timedelta(days=1)
    forward = replace(with_editions, edition_by_day={DAY: EDITION, later: EDITION + 1})
    backward = replace(with_editions, edition_by_day={later: EDITION + 1, DAY: EDITION})
    assert forward.canonical_json() == backward.canonical_json()
    assert (
        b'"edition_by_day":{"2026-11-01":98280004,"2026-11-02":98280005}'
        in forward.canonical_json()
    )


@pytest.mark.parametrize("weekday", range(7))
def test_only_the_enabled_weekday_runs(tmp_path, weekday):
    days = tuple(DAY + timedelta(days=i) for i in range(7))
    req = request(days)
    data = seed_data(req)
    ddl, rows = data["silver.calendar"]
    data["silver.calendar"] = (
        ddl,
        [(*r[:5], *(i == weekday for i in range(7))) for r in rows if r[2] == "week"],
    )
    data["silver.calendar_dates"] = (data["silver.calendar_dates"][0], [])
    write_inputs(tmp_path, req, data)
    output = build(tmp_path, req)
    scheduled = output.tables["gold.route_scheduled_trips_daily"].rows
    assert {r[1] for r in scheduled} == {d for d in days if d.weekday() == weekday}
    assert_math(output, data)


def retention_case():
    day = date(2026, 10, 28)
    req = replace(request((day,)), as_of_utc=datetime(2026, 11, 10, tzinfo=UTC), timezone="Etc/UTC")
    data = seed_data(req)
    ddl, _ = data["gold.fact_trip_delay_snapshot"]
    data["gold.fact_trip_delay_snapshot"] = (
        ddl,
        [("seed", "cutoff", "t", day, 3, 20261028, datetime(2026, 10, 27, tzinfo=UTC))],
    )
    return req, data


def test_retention_cutoff_fact_is_kept(tmp_path):
    req, data = retention_case()
    day = req.local_dates[0]
    write_inputs(tmp_path, req, data)
    actual = build(tmp_path, req).tables["gold.route_cancellation_daily"].rows
    assert actual == (
        ("seed", day, "cutoff", 1, 1, Decimal("100.00"), req.as_of_utc, None, 0, None),
    )


def test_only_requested_editions_are_declared():
    builder = resolve_builder("cancellations_service_states")
    req = request()
    needs = builder.inputs(req)
    editions = [n for n in needs if n.relation.startswith("silver.")]
    assert {(n.relation, n.window) for n in editions} == {
        (relation, f"edition:{EDITION}")
        for relation in ("silver.trips", "silver.calendar", "silver.calendar_dates")
    }


def test_both_engines_seed_supplies_its_current_at_build_edition():
    import revision_2_seed as seed
    from test_revision_2_both_engines_real_db import _seed_request

    for provider in seed.PROVIDERS.values():
        req = _seed_request(provider)
        assert req.edition_by_day == {day: seed._base(provider) + 20 for day in seed.DAYS}
        assert req.edition_source == "current_at_build"
        assert resolve_builder("cancellations_service_states").inputs(req)


def test_each_day_reads_its_explicit_edition_without_current_fallback(tmp_path):
    days = (DAY, DAY + timedelta(days=1))
    req = replace(request(days), edition_by_day={days[0]: EDITION, days[1]: EDITION + 1})
    data = seed_data(req)
    for relation in ("silver.calendar", "silver.calendar_dates"):
        ddl, rows = data[relation]
        data[relation] = (ddl, rows + [(EDITION + 1, *r[1:]) for r in rows])
    ddl, rows = data["silver.trips"]
    data["silver.trips"] = (
        ddl,
        rows + [(EDITION + 1, "seed", "edition-two", f"t{i}", "week") for i in range(2)],
    )
    write_inputs(tmp_path, req, data)
    output = build(tmp_path, req)
    rows = output.tables["gold.route_scheduled_trips_daily"].rows
    assert tuple(r for r in rows if r[1] == days[1]) == (
        ("seed", days[1], "edition-two", 2, EDITION + 1, STAMP),
    )
    assert all(r[4] == EDITION for r in rows if r[1] == DAY)
    assert_math(output, data)


def test_observed_excess_preserves_published_partition(tmp_path):
    req = request((DAY,))
    data = seed_data(req)
    ddl, _ = data["silver.trips"]
    data["silver.trips"] = (ddl, [(EDITION, "seed", "A", "t0", "week")])
    ddl, rows = data["gold.fact_trip_delay_snapshot"]
    data["gold.fact_trip_delay_snapshot"] = (ddl, [row for row in rows if row[1] == "A"])
    write_inputs(tmp_path, req, data)
    output = build(tmp_path, req)
    assert output.tables["gold.route_cancellation_daily"].rows == (
        ("seed", DAY, "A", 3, 1, Decimal("33.33"), STAMP, 1, 2, 0),
    )
    assert assert_math(output, data) == (1, 2)


@pytest.mark.parametrize("source", [None, "historical", "", "CURRENT_AT_BUILD"])
def test_edition_mapping_requires_supported_provenance(source):
    with pytest.raises(ValueError, match="edition_source"):
        replace(request(), edition_source=source)


def test_run_family_manifest_retains_caller_edition_provenance(tmp_path):
    req = request((DAY,))
    write_inputs(tmp_path, req)
    result = run_family(
        resolve_builder("cancellations_service_states"),
        req,
        inputs_root=tmp_path,
        workdir=tmp_path,
        code_commit="a" * 40,
    )
    manifest = json.loads(result.manifest.canonical_json())
    assert manifest["edition_by_day"] == {DAY.isoformat(): EDITION}
    assert manifest["edition_source"] == "current_at_build"
