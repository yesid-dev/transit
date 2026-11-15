"""Published weekly ranking values; old indexes may omit the arrays."""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal, Self

from pydantic import BaseModel, Field, field_validator, model_validator

from transit_ops.gold.reader.rates import MIN_N_RATE, round_half_away

_SAFE_COUNT = 9_007_199_254_740_991
_DATE = r"^\d{4}-\d{2}-\d{2}$"
UTC_TIMESTAMP = r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$"


class _WeeklyWindow(BaseModel):
    id: str = Field(min_length=1)
    name: str | None = None
    window_start: str = Field(pattern=_DATE)
    window_end: str = Field(pattern=_DATE)

    @field_validator("window_start", "window_end")
    @classmethod
    def valid_date(cls, value: str) -> str:
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError("canonical calendar date required")
        return value

    @model_validator(mode="after")
    def seven_days(self) -> Self:
        if (date.fromisoformat(self.window_end) - date.fromisoformat(self.window_start)).days != 6:
            raise ValueError("weekly ranking must span seven dates")
        return self


class WeeklyRankedEntry(_WeeklyWindow):
    state: Literal["ranked"]
    rank: int = Field(ge=1, le=_SAFE_COUNT, strict=True)
    numerator: int = Field(ge=0, le=_SAFE_COUNT, strict=True)
    denominator: int = Field(ge=MIN_N_RATE, le=_SAFE_COUNT, strict=True)
    pct: float = Field(ge=0, le=100, allow_inf_nan=False, strict=True)
    severe_pct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False, strict=True)

    @model_validator(mode="after")
    def consistent_evidence(self) -> Self:
        if self.numerator > self.denominator:
            raise ValueError("successes cannot exceed readings")
        expected = round_half_away(Decimal(100 * self.numerator) / self.denominator, 0)
        if self.pct != expected:
            raise ValueError("percentage must match ranked evidence")
        if self.severe_pct is not None:
            severe = round_half_away(
                Decimal(100 * (self.denominator - self.numerator)) / self.denominator, 1
            )
            if self.severe_pct != severe:
                raise ValueError("severe share must match not-severe evidence")
        return self


class WeeklyUnrankedEntry(_WeeklyWindow):
    state: Literal[
        "too_few_trips",
        "too_few_service_days",
        "too_few_units",
        "not_defined",
        "not_measured",
        "no_live_data",
    ]
    rank: None = None
    numerator: None = None
    denominator: None = None
    pct: None = None
    severe_pct: None = None


type WeeklyRankingEntry = WeeklyRankedEntry | WeeklyUnrankedEntry


def validate_publication_times(published: str | None, following: str | None) -> None:
    if (published is None) != (following is None):
        raise ValueError("publication metadata must be supplied together")
    if published is not None and following is not None:
        start, end = datetime.fromisoformat(published), datetime.fromisoformat(following)
        if not 0 < (end - start).total_seconds() <= 7 * 86400:
            raise ValueError("next historic publication must follow within a week")
