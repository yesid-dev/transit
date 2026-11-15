"""Dormant static values, separate from the published snapshot contract."""

from pydantic import BaseModel


class StaticHeadwayPeriod(BaseModel):
    shift: str
    window: str | None = None
    headway_min: float | None = None


class StaticRouteR3(BaseModel):
    headway: list[StaticHeadwayPeriod] | None
