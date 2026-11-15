"""Exclusive producers of the batch rollup tables."""

from collections.abc import Mapping
from types import MappingProxyType

TABLE_OWNERS: Mapping[str, str] = MappingProxyType(
    {
        "gold.trip_delay_summary_5m": "route_spine_hours",
        "gold.route_delay_hourly": "route_spine_hours",
        "gold.route_delay_spine": "route_spine_hours",
        "gold.stop_delay_spine": "stop_spine_hours",
        "gold.stop_delay_shift_daily": "stop_spine_hours",
        "gold.stop_delay_hourly": "stop_spine_hours",
        "gold.route_delay_percentile_daily": "percentiles_histograms",
        "gold.stop_delay_percentile_daily": "percentiles_histograms",
        "gold.route_scheduled_trips_daily": "cancellations_service_states",
        "gold.route_cancellation_daily": "cancellations_service_states",
        "gold.route_headway_by_shift": "headways",
        "gold.route_headway_by_direction_shift": "headways",
        "gold.route_headway_shift_daily": "headways",
        "gold.route_service_span_daily": "span_skipped_stops",
        "gold.route_skipped_stop_daily": "span_skipped_stops",
        "gold.route_occupancy_band_daily": "occupancy_crowding",
        "gold.route_occupancy_band_hourly": "occupancy_crowding",
        "gold.stop_occupancy_band_daily": "occupancy_crowding",
        "gold.route_delay_by_crowding_daily": "occupancy_crowding",
        "gold.repeat_offender_daily_spine": "repeat_offenders",
        "gold.repeat_offender": "repeat_offenders",
        "gold.repeated_problem_route_stop": "repeat_offenders",
        "gold.citizen_accountability_daily": "receipts",
    }
)
