import pytest
from pydantic import ValidationError

from transit_ops.snapshots.contract import RouteReliabilityIndex

ROW = dict(
    id="R",
    state="ranked",
    rank=1,
    numerator=18,
    denominator=30,
    pct=60,
    window_start="2026-11-04",
    window_end="2026-11-10",
)


@pytest.mark.parametrize(
    "invalid",
    [
        dict(state="invented"),
        dict(rank=None),
        dict(rank=0),
        dict(numerator=-1),
        dict(denominator=-1),
        dict(denominator=29),
        dict(pct=300),
        dict(pct=59),
        dict(numerator=31),
        dict(window_end="banana"),
        dict(window_end="2026-11-31"),
        dict(window_start="2026-11-11"),
        dict(window_start="2026-11-03"),
        dict(numerator=None),
        dict(severe_pct=41),
        dict(state="too_few_units", rank=None),
    ],
)
def test_weekly_index_rejects_invalid_rows_as_a_unit(invalid):
    with pytest.raises(ValidationError):
        RouteReliabilityIndex.model_validate(
            dict(
                generated_utc="2026-11-11T00:00:00Z",
                weekly_routes=[ROW, dict(ROW, id="bad", **invalid)],
            )
        )


def test_weekly_index_keeps_legacy_files_and_masked_unranked_rows_valid():
    assert RouteReliabilityIndex.model_validate(dict(generated_utc="2026-11-11T00:00:00Z"))
    assert RouteReliabilityIndex.model_validate(
        dict(
            generated_utc="2026-11-11T00:00:00Z",
            weekly_stops=[
                dict(
                    id="S",
                    state="too_few_units",
                    window_start="2026-11-04",
                    window_end="2026-11-10",
                )
            ],
        )
    )


def test_weekly_publication_metadata_uses_the_next_scheduled_wednesday():
    from datetime import UTC, datetime

    from transit_ops.snapshots.builders.historic.weekly_ranking import next_historic_publication

    assert (
        next_historic_publication(datetime(2026, 11, 11, 7, tzinfo=UTC)) == "2026-11-18T07:00:00Z"
    )
    assert (
        next_historic_publication(datetime(2026, 11, 12, 12, tzinfo=UTC)) == "2026-11-18T07:00:00Z"
    )
