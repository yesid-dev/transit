"""Replay a small, attributed extract of STM's archived service day."""

import gzip
import json
from base64 import b64decode
from collections.abc import Iterator
from datetime import UTC, date, datetime
from hashlib import sha256
from pathlib import Path
from zoneinfo import ZoneInfo

from plain_day import Capture, clean_tables, comparison, recompute

from transit_ops.clean_day import CLEANING_VERSION, build_clean_day
from transit_ops.clean_day_inputs import Edition, declaration_for, load_contexts
from transit_ops.clean_day_output import write_clean_day
from transit_ops.clean_day_realtime import DayCapture

FIXTURE = Path(__file__).parent / "fixtures" / "stm-2026-11-15"
DAY = date(2026, 11, 15)
ROUTES = {"70", "183"}


def fixture_captures() -> Iterator[Capture]:
    with gzip.open(FIXTURE / "captures.jsonl.gz", "rt", encoding="ascii") as archive:
        for line in archive:
            family, stamp, payload = json.loads(line)
            captured = datetime.strptime(stamp, "%Y%m%dT%H%M%S%fZ").replace(tzinfo=UTC)
            yield family, captured, b64decode(payload)


def cleaner_captures(captures: list[Capture]) -> Iterator[DayCapture]:
    for index, (family, captured, payload) in enumerate(captures):
        yield DayCapture(family, family, captured, str(index), payload)


def test_stm_service_day_against_independent_recomputation(tmp_path: Path) -> None:
    schedule = FIXTURE / "schedule.zip"
    captures = list(fixture_captures())
    raw_trips, raw_events, _ = recompute(
        schedule, captures, DAY, ROUTES, zone=ZoneInfo("America/Toronto"), no_live_types={"1"}
    )
    edition = Edition(schedule.name, sha256(schedule.read_bytes()).hexdigest())
    contexts, _ = load_contexts(
        declaration_for("stm"),
        DAY,
        {date(2026, 11, 4): (edition,)},
        lambda key: (FIXTURE / key).read_bytes(),
    )
    day = build_clean_day("stm", DAY, contexts, cleaner_captures(captures))
    clean_trips, clean_events = clean_tables(
        write_clean_day(day, tmp_path), "stm", DAY, CLEANING_VERSION, ROUTES
    )
    actual = comparison((raw_trips, raw_events), (clean_trips, clean_events))
    expected = json.loads((FIXTURE / "expected.json").read_text(encoding="utf-8"))
    assert actual == expected
