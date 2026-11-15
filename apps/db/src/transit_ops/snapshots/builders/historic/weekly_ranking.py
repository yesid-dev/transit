"""Adapt the published reliability windows to the shared ranking engine."""

from collections.abc import Iterable, Mapping
from datetime import datetime, timedelta
from decimal import Decimal
from typing import Any

from transit_ops.gold.reader import round_half_away
from transit_ops.gold.reader.rates import MIN_N_RATE
from transit_ops.ranking.engine import EntityWindow, rank_entities
from transit_ops.ranking.rules import RULES, MeasureSpec
from transit_ops.snapshots.contract import Alert, WeeklyRankingEntry


def cancelled_stop_ids(alerts: Iterable[Alert], as_of: datetime) -> set[str]:
    result: set[str] = set()
    for alert in alerts:
        text = (alert.description_en or alert.description or "").casefold()
        cancelled = alert.effect == "NO_SERVICE" or text.startswith(
            (
                "this stop is cancelled",
                "this stop is closed",
                "cet arrêt est annulé",
                "cet arrêt est fermé",
            )
        )
        if not cancelled:
            continue
        periods = [(p.start_utc, p.end_utc) for p in alert.active_periods]
        periods = periods or [(alert.start_utc, alert.end_utc)]
        if any(
            (start is None or datetime.fromisoformat(start) <= as_of)
            and (end is None or as_of < datetime.fromisoformat(end))
            for start, end in periods
        ):
            result.update(alert.stops)
    return result


def _weekly_line_row(key: str, payload: Any) -> dict[str, Any] | None:
    week = next((p for p in payload.periods_by_grain if p.grain == "week"), None)
    closed = next((p.date for p in payload.periods_by_grain if p.grain == "day"), None)
    if week is None or not week.date or not closed or not week.by_daytype:
        return None
    if (datetime.fromisoformat(closed) - datetime.fromisoformat(week.date)).days != 6:
        return None
    if any(p.on_time is None or p.observation_count is None for p in week.by_daytype):
        return None
    return dict(
        id=key,
        name=payload.name,
        numerator=sum(p.on_time for p in week.by_daytype),
        denominator=sum(p.observation_count for p in week.by_daytype),
        window_start=week.date,
        window_end=closed,
    )


def weekly_payload_rows(payloads: Mapping[str, Any], *, kind: str, excluded: set[str]):
    if kind == "route":
        for key, payload in payloads.items():
            if key not in excluded and (row := _weekly_line_row(key, payload)) is not None:
                yield row
        return
    all_days = [day.date for payload in payloads.values() for day in payload.daily]
    if not all_days:
        return
    end = max(all_days)
    start = (datetime.fromisoformat(end) - timedelta(days=6)).date().isoformat()
    for key, payload in payloads.items():
        if key in excluded:
            continue
        known = [day for day in payload.daily if start <= day.date <= end]
        if not known:
            continue
        denominator = sum(day.observation_count for day in known)
        numerator = sum(day.observation_count - day.severe_count for day in known)
        yield dict(
            id=key,
            name=payload.name,
            numerator=numerator,
            denominator=denominator,
            window_start=start,
            window_end=end,
            severe_pct=float(
                round_half_away(Decimal(100 * (denominator - numerator)) / denominator, 1)
            )
            if denominator
            else None,
        )


def rank_weekly_periods(rows: Iterable[Mapping[str, Any]]) -> list[WeeklyRankingEntry]:
    values = {str(row["id"]): row for row in rows}
    spec = MeasureSpec(
        id="weekly_reliability",
        numerator="success",
        denominator="readings",
        denominator_from="entity",
        scale=(100, 1),
        precision=0,
        worse="lower",
        series="delay",
        floor_trips=None,
        floor_trips_of="readings",
        floor_units=MIN_N_RATE,
        floor_units_of="readings",
        floor_service_days=False,
        pair=None,
    )
    inputs = [
        EntityWindow(
            entity_id=key,
            service_class=None,
            live_data="live",
            counts={"success": int(row["numerator"]), "readings": int(row["denominator"])},
            scheduled_days=1,
            reading_days=1,
            measured_days={"delay": 1},
            not_measured_reason={},
        )
        for key, row in values.items()
    ]
    return [
        WeeklyRankingEntry(
            id=item.entity_id,
            state=item.state,
            rank=item.rank,
            numerator=item.numerator,
            denominator=item.denominator,
            pct=item.shown_units,
            name=values[item.entity_id].get("name"),
            severe_pct=values[item.entity_id].get("severe_pct"),
            window_start=values[item.entity_id].get("window_start"),
            window_end=values[item.entity_id].get("window_end"),
        )
        for item in rank_entities(inputs, spec=spec, window_days=7, rules=RULES)
    ]
