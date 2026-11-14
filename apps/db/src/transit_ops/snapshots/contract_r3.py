"""Unpublished revision-three evidence values; no active publication registration."""

from typing import Annotated, Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

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
            value is not None
            for key, value in self.model_dump().items()
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
            value is not None
            for value in (*counts, self.scheduled_trip_days, self.service_completeness_pct)
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
