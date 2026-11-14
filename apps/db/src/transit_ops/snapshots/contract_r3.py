"""Unpublished revision-three evidence values; no active publication registration."""

from datetime import date as ServiceDate
from types import MappingProxyType
from typing import Annotated, Literal, Self

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, model_validator

type Count = Annotated[int, Field(strict=True, ge=0)]
type Percentage = Annotated[float, Field(ge=0, le=100, allow_inf_nan=False)]
type Finite = Annotated[float, Field(allow_inf_nan=False)]
type NotMeasuredReason = Literal[
    "schedule_not_kept",
    "captures_not_available",
    "no_capture_record",
    "capture_gap",
    "window_too_short",
    "applicability_unresolved",
    "schedule_mismatch",
]


class EvidenceValue(BaseModel):
    model_config = ConfigDict(extra="forbid")


type ExclusionReason = Literal[
    "not_in_schedule",
    "line_not_counted",
    "not_scheduled",
    "no_delay",
    "clock_change",
    "no_edition_record",
    "other_edition",
    "before_start",
    "prediction_passed",
    "ambiguous_instance",
    "vehicle_feed_gap",
    "no_vehicle",
    "set_aside_extreme",
]


class FeedCoverage(EvidenceValue):
    covered_pct: Percentage | None
    slot_fill_pct: Percentage | None
    basis: Literal["polls", "summary_5m"] | None


class Population(EvidenceValue):
    basis: Literal["vehicle_evidence", "scheduled_window"]
    excluded: dict[ExclusionReason, Percentage | None]
    coverage: dict[str, FeedCoverage]


class ReadingValues(EvidenceValue):
    state: Literal["measured", "not_measured"]
    reason: NotMeasuredReason | None = None
    evidence: Literal["counts", "tentative"]
    reading_count: Count | None = None
    on_time_count: Count | None = None
    late_count: Count | None = None
    early_count: Count | None = None
    trip_count: Count | None = None
    service_day_count: Count | None = None
    measured_day_count: Count | None = None
    on_time_pct: Percentage | None = None
    late_pct: Percentage | None = None
    early_pct: Percentage | None = None
    avg_delay_min: Finite | None = None
    late_avg_min: Finite | None = None

    @model_validator(mode="after")
    def consistent_absence(self) -> Self:
        if (self.state == "not_measured") != (self.reason is not None):
            raise ValueError("not_measured requires a reason; measured forbids one")
        if self.state == "not_measured" and any(
            getattr(self, key) is not None
            for key in ReadingValues.model_fields
            if key not in {"state", "reason", "evidence"}
        ):
            raise ValueError("not_measured reading values must be null")
        return self


class ServiceLine(EvidenceValue):
    id: str
    short: str
    scheduled_trip_days: Count | None


class NoLiveData(EvidenceValue):
    line_count: Count | None
    scheduled_trip_days: Count | None
    lines: list[ServiceLine] | None


class ServiceValues(EvidenceValue):
    state: Literal["measured", "not_measured"]
    reason: NotMeasuredReason | None = None
    basis: Literal["facts", "stored_counts"]
    scheduled_trip_days: Count | None = None
    delivered_trip_days: Count | None = None
    cancelled_trip_days: Count | None = None
    missing_trip_days: Count | None = None
    not_measured_trip_days: Count | None = None
    service_completeness_pct: Percentage | None = None
    not_reported_lines: list[ServiceLine] | None
    no_live_data: NoLiveData | None

    @model_validator(mode="after")
    def consistent_counts(self) -> Self:
        if (self.state == "not_measured") != (self.reason is not None):
            raise ValueError("not_measured requires a reason; measured forbids one")
        counts = (
            self.delivered_trip_days,
            self.cancelled_trip_days,
            self.missing_trip_days,
            self.not_measured_trip_days,
        )
        if self.state == "not_measured" and any(
            value is not None for value in (*counts, self.service_completeness_pct)
        ):
            raise ValueError("not_measured service values must be null")
        if (
            self.basis == "facts"
            and self.scheduled_trip_days is not None
            and all(value is not None for value in counts)
            and sum(value for value in counts if value is not None) != self.scheduled_trip_days
        ):
            raise ValueError("full-basis service counts must sum to scheduled trips")
        return self


class HeadlineLine(EvidenceValue):
    id: str
    short: str
    name: str | None
    on_time_pct: Percentage | None
    on_time_delta_pts: Finite | None


class HeadlineStop(EvidenceValue):
    id: str
    code: str
    name: str | None
    on_time_pct: Percentage | None
    on_time_delta_pts: Finite | None


class Receipt(ReadingValues):
    """Dormant daily receipt; supplied evidence only, with no publication registration."""

    schema_version: Literal[1] = 1
    methodology_version: Literal["receipt-2"]
    generated_utc: AwareDatetime
    publish_generation_id: str | None = None
    data_through: ServiceDate
    date: ServiceDate
    population: Population
    service: "ServiceValues"
    worst_line: "HeadlineLine | None"
    worst_stop: "HeadlineStop | None"
    alerts: Count | None
    alerts_reason: Literal["not_tracked", "not_measured"] | None
    alerts_not_measured_reason: NotMeasuredReason | None

    @model_validator(mode="after")
    def consistent_alerts(self) -> Self:
        if (self.alerts is None) != (self.alerts_reason is not None):
            raise ValueError("absent alerts require a reason; measured alerts forbid one")
        if (self.alerts_reason == "not_measured") != (self.alerts_not_measured_reason is not None):
            raise ValueError("only not_measured alerts require a detailed reason")
        return self


class PercentileBin(EvidenceValue):
    lower_s: Annotated[int, Field(strict=True)] | None
    upper_s: Annotated[int, Field(strict=True)] | None

    @model_validator(mode="after")
    def ordered_edges(self) -> Self:
        if self.lower_s is not None and self.upper_s is not None and self.lower_s >= self.upper_s:
            raise ValueError("percentile edges must ascend")
        return self


class DelayHistogram(EvidenceValue):
    layout: Literal[2]
    bins: list[Annotated[int, Field(strict=True, ge=0, le=160)]]
    n: list[Count]

    @model_validator(mode="after")
    def aligned_bins(self) -> Self:
        if len(self.bins) != len(self.n) or any(
            a >= b for a, b in zip(self.bins, self.bins[1:], strict=False)
        ):
            raise ValueError("histogram needs aligned counts and ascending unique bins")
        return self


class NetworkAlertCell(EvidenceValue):
    """Supplied network row of S0.6 D4's alert_cell_day; no aggregation."""

    provider_id: str
    revision: Literal[3]
    scope: Literal["network"]
    entity_id: Literal[""]
    service_date: ServiceDate
    cause: str
    effect: str
    alert_days_active: Count
    episodes_started: Count
    episodes_ended: Count
    active_seconds: Count
    episodes_open_at_day_start: Count
    attribution: Literal["approximate", "exact"]
    built: Literal["at_close", "backfill"]


class NetworkTrendPoint(ReadingValues):
    date: ServiceDate
    population: Population
    service: ServiceValues
    p50_bin: PercentileBin | None
    p90_bin: PercentileBin | None
    delay_hist: DelayHistogram | None
    vehicles_reporting: Count | None
    vehicles_on_trip: Count | None
    alert_cell: NetworkAlertCell | None

    @model_validator(mode="after")
    def empty_population_has_no_percentiles(self) -> Self:
        if (
            self.delay_hist is not None
            and sum(self.delay_hist.n) == 0
            and (self.p50_bin is not None or self.p90_bin is not None)
        ):
            raise ValueError("an empty histogram has no percentile")
        if self.reading_count == 0 and any(
            rate is not None for rate in (self.on_time_pct, self.late_pct, self.early_pct)
        ):
            raise ValueError("an empty reading population has no rates")
        return self


class NetworkTrend(EvidenceValue):
    schema_version: Literal[1] = 1
    methodology_version: Literal["reliability-3"]
    generated_utc: AwareDatetime
    publish_generation_id: str | None = None
    data_through: ServiceDate
    series: Annotated[list[NetworkTrendPoint], Field(max_length=35)]

    @model_validator(mode="after")
    def closed_ordered_dates(self) -> Self:
        dates = [point.date for point in self.series]
        if any(a >= b for a, b in zip(dates, dates[1:], strict=False)) or any(
            day > self.data_through for day in dates
        ):
            raise ValueError("recent dates must ascend uniquely through data_through")
        return self


METHODOLOGY_TOKENS = MappingProxyType(
    {
        "reliability": "reliability-3",
        "receipt": "receipt-2",
        "alerts": "alerts-3",
        "history": "history-2",
        "provenance": "provenance-2",
        "revision": "revision-1",
        "registry": "registry-1",
        "matrix": "matrix-1",
    }
)

# In-memory registry only. Active exporters and publication targets never import it.
SCHEMA_MODELS: MappingProxyType[str, type[BaseModel]] = MappingProxyType(
    {
        "historic_receipt": Receipt,
        "historic_network_trend": NetworkTrend,
    }
)


def export_schemas() -> dict[str, dict[str, object]]:
    return {name: model.model_json_schema() for name, model in SCHEMA_MODELS.items()}
