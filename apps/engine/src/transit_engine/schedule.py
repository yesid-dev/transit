"""Scheduled clock periods and frequency limits shared by engine measures."""

from typing import NamedTuple

# The ranking and period tests use the same turn-up-and-go headway limit.
FREQUENT_HEADWAY_SECONDS = 600
MIN_OBSERVED_HEADWAYS = 20
BUNCHING_FRACTION = 0.5
LONG_GAP_MULTIPLE = 2
# Two trips per hour correspond to a half-hour headway if evenly spaced.
MIN_TRIPS_PER_HOUR = 2


class Period(NamedTuple):
    id: str
    start_hour: int
    end_hour: int
    en: str
    fr: str


PERIODS = (
    Period("overnight", 0, 5, "Overnight", "Nuit"),
    Period("morning", 5, 9, "Morning", "Matin"),
    Period("midday", 9, 15, "Midday", "Milieu de journée"),
    Period("afternoon", 15, 19, "Afternoon", "Après-midi"),
    Period("evening", 19, 24, "Evening", "Soirée"),
)


def period_sql(hour: str) -> str:
    cases = " ".join(
        f"WHEN {hour} >= {p.start_hour} AND {hour} < {p.end_hour} THEN '{p.id}'" for p in PERIODS
    )
    return f"CASE {cases} END"


def periods_text(language: str) -> str:
    return ", ".join(
        f"{getattr(p, language)} {p.start_hour:02d}:00–{p.end_hour:02d}:00" for p in PERIODS
    )
