from ..registry import Registry
from .reliability import HISTOGRAM_LAYOUTS, METRIC_CONSTANTS, METRICS, SERIES


def build_registry() -> Registry:
    return Registry(
        (SERIES,),
        METRICS,
        metric_constants=METRIC_CONSTANTS,
        histogram_layouts=HISTOGRAM_LAYOUTS,
    )
