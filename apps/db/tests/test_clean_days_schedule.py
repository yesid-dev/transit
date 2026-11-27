from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO_ROOT = Path(__file__).parents[3]
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "clean-days.yml"
TIMER = REPO_ROOT / "apps" / "engine" / "ops" / "linux" / "transit-engine-sync.timer"
CLEAN_TIMER = REPO_ROOT / "apps" / "db" / "ops" / "linux" / "transit-clean-days.timer"

# The deployment no-merge window keeps 05:55 to 08:30 UTC clear of scheduled work.
WINDOW_START = 5 * 60 + 55
WINDOW_END = 8 * 60 + 30
DAILY_CRON = re.compile(r"([0-9]{1,2}) ([0-9]{1,2}) \* \* \*")
ON_CALENDAR = re.compile(r"OnCalendar=\*-\*-\* ([0-9]{1,2}):([0-9]{1,2}):[0-9]{2} UTC")


def _minutes_of_day(minute: str, hour: str) -> int:
    hours, minutes = int(hour), int(minute)
    assert 0 <= hours < 24 and 0 <= minutes < 60
    return hours * 60 + minutes


def _cleaning_times() -> list[int]:
    document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    triggers = document.get("on", document.get(True))
    times = []
    for entry in triggers["schedule"]:
        match = DAILY_CRON.fullmatch(entry["cron"])
        assert match, f"Expected a plain daily cron, got {entry['cron']!r}"
        times.append(_minutes_of_day(match[1], match[2]))
    assert times, "The clean-days workflow needs at least one schedule"
    return times


def _timer_times(timer: Path) -> list[int]:
    times = []
    for line in timer.read_text(encoding="utf-8").splitlines():
        if line.startswith("OnCalendar="):
            match = ON_CALENDAR.fullmatch(line)
            assert match, f"Expected a daily UTC calendar for {line!r}"
            times.append(_minutes_of_day(match[2], match[1]))
    assert times, f"{timer.name} needs at least one OnCalendar time"
    return times


def test_cleaning_stays_outside_the_no_merge_window() -> None:
    for cleaning in [*_cleaning_times(), *_timer_times(CLEAN_TIMER)]:
        assert not WINDOW_START <= cleaning <= WINDOW_END, (
            f"Cleaning at {cleaning // 60:02d}:{cleaning % 60:02d} UTC falls inside "
            f"the 05:55 to 08:30 UTC window"
        )


def test_every_cleaning_has_a_later_copy_before_the_next_days_first_cleaning() -> None:
    cleanings = [*_cleaning_times(), *_timer_times(CLEAN_TIMER)]
    copies = _timer_times(TIMER)
    deadline = min(cleanings) + 24 * 60
    for cleaning in sorted(cleanings):
        assert any(
            cleaning < copy < deadline or cleaning < copy + 24 * 60 < deadline
            for copy in copies
        ), (
            f"No VM copy lands after the {cleaning // 60:02d}:{cleaning % 60:02d} UTC "
            "cleaning before the next day's first cleaning"
        )


def test_private_cities_publish_nothing_but_an_exit_status() -> None:
    document = yaml.safe_load(WORKFLOW.read_text(encoding="utf-8"))
    clean = document["jobs"]["clean"]
    assert "'private city'" in clean["name"] and "matrix.private" in clean["name"]
    (step,) = [step for step in clean["steps"] if "run" in step]
    assert step["env"]["CLEAN_PRIVATE"] == "${{ matrix.private }}"
    script = step["run"]
    private, public = script.split('if [[ "$CLEAN_PRIVATE" == "true" ]]; then', 1)[1].split(
        "else", 1
    )
    assert "exec > /dev/null 2>&1" in private
    assert "GITHUB_STEP_SUMMARY" not in private
    assert "--summary" in public.split("fi", 1)[0]
    assert script.count("GITHUB_STEP_SUMMARY") == 1
    assert "upload-artifact" not in WORKFLOW.read_text(encoding="utf-8")


def test_cleaning_and_sync_timers_catch_up_after_a_vm_restart() -> None:
    for timer in (CLEAN_TIMER, TIMER):
        assert re.search(r"^Persistent=true$", timer.read_text(encoding="utf-8"), re.MULTILINE)


def test_each_vm_slot_has_a_backup_before_the_next_vm_slot() -> None:
    vm = sorted(_timer_times(CLEAN_TIMER))
    backup = sorted(_cleaning_times())
    assert len(backup) == len(vm)
    for primary, fallback, next_primary in zip(vm, backup, [*vm[1:], vm[0] + 1440], strict=True):
        assert primary < fallback < next_primary
