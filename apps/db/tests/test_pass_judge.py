from dataclasses import replace
from datetime import UTC, datetime, timedelta, timezone
from pathlib import Path
from shutil import copyfile
from tempfile import TemporaryDirectory

import pytest
from daily_pass_fakes import fake_build
from history_reader_fakes import fake_feed_day, fake_poll

from transit_ops.daily_pass.judge import account_feed, judge_buildability, planning_start_utc
from transit_ops.providers import load_providers

AT = datetime(2026, 1, 2, tzinfo=UTC)
ENDPOINT = "trip_updates"


def at(seconds):
    return AT + timedelta(seconds=seconds)


def build(seconds=133200, interval=20):
    with TemporaryDirectory() as directory:
        source = Path(__file__).parent / "fixtures/providers/fixture_city.yaml"
        copyfile(source, Path(directory) / source.name)
        provider = load_providers(Path(directory), env={})["fixture_city"]
    feed = replace(provider.feed(ENDPOINT), every_seconds=interval)
    provider = replace(provider, feeds=(feed,))
    days = tuple(
        fake_feed_day(
            provider_id=provider.id,
            utc_date=at(i * 86400).date(),
            declared_interval_seconds=interval,
        )
        for i in (-1, 0, 1)
    )
    return replace(
        fake_build(provider, AT.date(), feed_days=days),
        window_start_utc=AT,
        window_end_utc=at(seconds),
    )


def judge(b, slots):
    attempts = [fake_poll(provider_id=b.provider.id, time_utc=at(s)) for s in slots]
    result = account_feed(b, ENDPOINT, attempts)
    assert account_feed(b, ENDPOINT, reversed(attempts + attempts)) == result
    return result


def change_day(b, index, **changes):
    days = list(b.feed_days)
    days[index] = replace(days[index], **changes)
    return replace(b, feed_days=tuple(days))


def unavailable(b, index, reason):
    row = b.feed_days[index]
    day = fake_feed_day(
        provider_id=b.provider.id, utc_date=row.utc_date, state="not_available", reason=reason
    )
    return replace(b, feed_days=tuple(day if d == row else d for d in b.feed_days))


@pytest.mark.parametrize(
    "case,share,longest,complete",
    [
        ("seven", 107980 / 133200, 25220, False),
        ("six", 0, 120, False),
        ("third", 1, 0, True),
        ("nine", 132640 / 133200, 560, True),
        ("holes", 109540 / 133200, 320, False),
        ("regular", 1, 0, True),
    ],
)
def test_worked_accounting_cases(case, share, longest, complete):
    slots = [
        s
        for s in range(0, 133200, 20)
        if {
            "seven": not 36000 <= s < 61200,
            "six": s % 120 == 0,
            "third": s % 60 != 40,
            "nine": not 36000 <= s < 36540,
            "holes": s % 1800 >= 300,
            "regular": True,
        }[case]
    ]
    result = judge(build(), slots)
    assert result.accounted_share == share
    assert max(((e - s).total_seconds() for s, e in result.missing_blocks), default=0) == longest
    assert result.complete is complete
    assert result.reason == (None if complete else "under_accounted:trip_updates")
    if case in ("seven", "nine"):
        assert result.missing_blocks == ((at(35980), at(61200 if case == "seven" else 36540)),)
    if complete and case != "nine":
        assert result.missing_blocks == ()


@pytest.mark.parametrize("seconds,interval,gap", [(6000, 20, 600), (7200, 120, 720), (80, 20, 80)])
def test_accounting_thresholds_are_inclusive(seconds, interval, gap):
    b = build(seconds, interval)
    assert judge(b, [0, *range(gap, seconds, interval)]).complete
    longer = replace(b, window_end_utc=at(seconds + 0.000001)) if seconds == gap else b
    assert not judge(
        longer, [0, gap + 0.000001, *range(gap + interval, seconds, interval)]
    ).complete
    if seconds == 6000:
        assert not judge(
            replace(b, window_end_utc=at(5999.999999)), [0, *range(gap, seconds, interval)]
        ).complete


@pytest.mark.parametrize(
    "status", ["stored", "failed", "unfinished", "skipped_identical", "capture_missing"]
)
def test_every_poll_status_accounts_for_time(status):
    b = build(100)
    attempts = [
        fake_poll(provider_id=b.provider.id, time_utc=at(s), status=status) for s in (0, 40, 80)
    ]
    result = account_feed(b, ENDPOINT, attempts)
    assert result.complete and result.accounted_share == 1


@pytest.mark.parametrize(
    "slots,share,blocks,complete,reason",
    [
        ([-86400, 0, 20, 40, 60], 1.0, (), True, None),
        ([80], 0.0, ((AT, at(80)),), False, "under_accounted:trip_updates"),
    ],
    ids=["predecessor-day-poll", "exclusive-end-only-poll"],
)
def test_accounting_excludes_planning_and_exclusive_end_polls(
    slots, share, blocks, complete, reason
):
    b = build(80)
    attempts = [fake_poll(provider_id=b.provider.id, time_utc=at(s)) for s in slots]
    result = account_feed(b, ENDPOINT, attempts)
    assert result.accounted_share == share
    assert result.missing_blocks == blocks
    assert result.complete is complete
    assert result.reason == reason
    if complete:
        assert result == judge(b, [0, 20, 40, 60])


@pytest.mark.parametrize(
    "sealed,current,complete", [(60, 10, True), (10, 60, True), (10, 10, False)]
)
def test_accounting_interval_is_the_larger_of_the_sealed_and_the_declared_one(
    sealed, current, complete
):
    b = build(600, current)
    for i in (1, 2):
        b = change_day(b, i, declared_interval_seconds=sealed, observed_interval_seconds=999)
    result = judge(b, range(0, 600, 60))
    assert result.complete is complete
    assert result.accounted_share == (1 if complete else 0)


@pytest.mark.parametrize("index", [1, 2])
def test_accounting_does_not_invent_midnight_polls(index):
    b = change_day(build(86460), index, declared_interval_seconds=60)
    b = replace(b, window_start_utc=at(86340))
    result = judge(b, [86340])
    assert result.accounted_share == 0
    assert result.missing_blocks == ((at(86340), at(86460)),)


@pytest.mark.parametrize("second_interval,complete", [(120, True), (20, False)])
def test_cross_midnight_missing_block_meets_every_touched_days_limit(second_interval, complete):
    b = change_day(build(90000, 20), 1, declared_interval_seconds=120)
    b = change_day(b, 2, declared_interval_seconds=second_interval)
    b = replace(b, window_start_utc=at(82800))
    result = judge(b, [s for s in range(82800, 90000, 20) if not 86040 < s < 86760])
    assert result.accounted_share == 0.9
    assert result.missing_blocks == ((at(86040), at(86760)),)
    assert result.complete is complete


@pytest.mark.parametrize("seconds", [600, 86460])
@pytest.mark.parametrize(
    "reason,expected",
    [
        (None, "accounting_interval_missing"),
        ("never_collected", "captures_not_available"),
        ("no_polls", "under_accounted"),
    ],
)
def test_no_polls_is_a_known_outage_not_missing_evidence(reason, expected, seconds):
    b = change_day(build(seconds), 1, declared_interval_seconds=None)
    if reason:
        b = unavailable(b, 1, reason)
    result = judge(b, [])
    assert result.accounted_share == (0 if reason == "no_polls" else None)
    assert result.reason == expected + ":trip_updates"
    assert result.missing_blocks == (((AT, at(seconds)),) if reason == "no_polls" else ())


def test_planning_start_is_midnight_one_utc_day_earlier():
    expected = at(-86400)
    assert planning_start_utc(at(14400)) == expected
    assert planning_start_utc(at(14400).astimezone(timezone(timedelta(hours=-5)))) == expected


def test_first_day_is_not_built_when_the_day_before_is_missing_from_the_plan():
    b = build()
    result = judge_buildability(replace(b, feed_days=b.feed_days[1:]))
    assert (result.state, result.reason, result.detail) == (
        "refused",
        "captures_not_available",
        "edge_evidence_missing",
    )
    missing = replace(b, feed_days=b.feed_days[:1] + b.feed_days[2:])
    assert judge_buildability(missing).detail == "plan_evidence_missing"
    assert judge(missing, []).accounted_share is None


@pytest.mark.parametrize(
    "reason,state", [("still_open", "pending"), ("pruned_before_archive", "refused")]
)
def test_still_open_and_pruned_days(reason, state):
    result = judge_buildability(unavailable(build(), 1, reason))
    assert (result.state, result.reason) == (
        state,
        "still_open" if state == "pending" else "captures_not_available",
    )


def test_day_next_to_a_pruned_day_is_refused_when_its_first_poll_is_late():
    for reason in ("no_polls", "never_collected"):
        assert judge_buildability(unavailable(build(), 0, reason)).state == "buildable"
    b = unavailable(build(), 0, "pruned_before_archive")
    for seconds, state in [(60, "buildable"), (60.000001, "refused"), (None, "refused")]:
        result = judge_buildability(
            change_day(b, 1, first_time_utc=None if seconds is None else at(seconds))
        )
        assert result.state == state
    assert judge_buildability(unavailable(build(), 0, "still_open")).detail == "still_open"


def test_never_collected_feed_does_not_hide_another_feed():
    b = build()
    known = b.feed_days
    for i in (0, 1, 2):
        b = unavailable(b, i, "never_collected")
    assert judge_buildability(b).state == "refused"
    feed = replace(
        b.provider.feeds[0], family="vehicle_positions", endpoint_key="vehicle_positions"
    )
    b = replace(
        b,
        provider=replace(b.provider, feeds=(*b.provider.feeds, feed)),
        feeds={ENDPOINT: ENDPOINT, feed.endpoint_key: feed.family},
        feed_days=b.feed_days + tuple(replace(d, endpoint_key=feed.endpoint_key) for d in known),
    )
    assert judge_buildability(b).state == "buildable"
    assert judge(b, []).accounted_share is None
    assert account_feed(b, feed.endpoint_key, []).accounted_share == 0


def test_accounting_is_deterministic_and_rejects_contradictory_inputs():
    b = build(600)
    assert judge_buildability(
        replace(b, feed_days=tuple(reversed(b.feed_days)))
    ) == judge_buildability(b)
    assert judge(replace(b, feed_days=tuple(reversed(b.feed_days))), [0, 100]) == judge(b, [0, 100])
    for invalid in [
        replace(b, feeds={}),
        replace(b, window_end_utc=AT),
        replace(b, window_start_utc=AT.replace(tzinfo=None)),
        replace(b, feed_days=(*b.feed_days, replace(b.feed_days[1], poll_count=99))),
        change_day(b, 0, provider_id="other"),
    ]:
        with pytest.raises(ValueError):
            judge_buildability(invalid)
    for changes in (
        {"provider_id": "other"},
        {"endpoint_key": "other"},
        {"time_utc": AT.replace(tzinfo=None)},
    ):
        with pytest.raises(ValueError):
            account_feed(b, ENDPOINT, [replace(fake_poll(provider_id=b.provider.id), **changes)])
