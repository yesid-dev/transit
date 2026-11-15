import pytest

from transit_ops.lake.alert_bundle import validate_members
from transit_ops.lake.table_export import WindowSpec


def test_incomplete_group_refuses_by_member_name():
    with pytest.raises(ValueError, match="silver.i3_alert_active_periods"):
        validate_members([WindowSpec("silver.i3_alerts", "alert_bundle_seed", "2026-11")])
