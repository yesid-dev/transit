from datetime import UTC, date, datetime

import pytest

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.editions import current_edition_for_days, with_editions
from transit_ops.batch.manifest import BuildManifest

DAYS = (date(2026, 11, 1), date(2026, 11, 2))
REQUEST = BuildRequest("sample", DAYS, datetime(2026, 11, 3, 7, tzinfo=UTC), 30, 7, "UTC")


def test_current_maps_all_days_and_ignores_other_kinds():
    rows = [(7, "static_schedule", False), (8, "static_schedule", True), (9, "other", True)]
    assert current_edition_for_days(rows, DAYS) == dict.fromkeys(DAYS, 8)


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [(7, "static_schedule", False)],
        [(7, "static_schedule", True), (8, "static_schedule", True)],
    ],
)
def test_unresolved_current_refuses(rows):
    with pytest.raises(ValueError, match="edition_unresolved"):
        current_edition_for_days(rows, DAYS)


def test_non_edition_manifest_and_digest_unchanged():
    wired = with_editions(REQUEST, ("occupancy_crowding",), [])

    def manifest(request):
        return BuildManifest(
            **request.__dict__, family_id="occupancy_crowding", code_commit="a" * 40, inputs=()
        )

    assert wired is REQUEST
    assert manifest(wired).canonical_json() == manifest(REQUEST).canonical_json()
    assert manifest(wired).build_id == manifest(REQUEST).build_id


def test_edition_request_is_labelled():
    wired = with_editions(
        REQUEST, ("cancellations_service_states",), [(8, "static_schedule", True)]
    )
    assert wired.edition_by_day == dict.fromkeys(DAYS, 8)
    assert wired.edition_source == "current_at_build"
