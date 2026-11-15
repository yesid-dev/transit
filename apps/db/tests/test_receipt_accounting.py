import pytest
from pydantic import ValidationError

from transit_ops.snapshots.contract import ReceiptServiceStates


@pytest.mark.parametrize(
    "scheduled,delivered,cancelled,silent,beyond",
    [
        (1, 2, 0, 0, 1),
        (2, 1, 0, 1, 0),
        (1, 0, 2, 0, 1),
        (0, 2, 1, 0, 3),
    ],
)
def test_receipt_basis_identity(scheduled, delivered, cancelled, silent, beyond):
    states = ReceiptServiceStates(
        scheduled_trip_days=scheduled,
        delivered_trip_days=delivered,
        cancelled_trip_days=cancelled,
        silent_trip_days=silent,
        beyond_schedule_trip_days=beyond,
    )
    assert states.beyond_schedule_trip_days == beyond
    assert delivered + cancelled + silent == scheduled + states.beyond_schedule_trip_days


@pytest.mark.parametrize(
    "change",
    [
        {"beyond_schedule_trip_days": 0},
        {"delivered_trip_days": -1},
        {"silent_trip_days": None},
        {"beyond_schedule_trip_days": float("nan")},
    ],
)
def test_receipt_rejects_invalid_new_accounting(change):
    values = dict(
        scheduled_trip_days=1,
        delivered_trip_days=2,
        cancelled_trip_days=0,
        silent_trip_days=0,
        beyond_schedule_trip_days=1,
    )
    with pytest.raises(ValidationError):
        ReceiptServiceStates(**(values | change))


def test_legacy_receipt_without_basis_remains_valid():
    ReceiptServiceStates(scheduled_trip_days=1, delivered_trip_days=2)
