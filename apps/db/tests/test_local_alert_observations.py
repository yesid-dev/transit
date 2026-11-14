from contextlib import closing
from datetime import UTC, date, datetime, timedelta

import duckdb
import pytest

from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.static.alert_observations import record_alert_observations
from transit_ops.static.alert_state import create_alert_tables

AT = datetime(2026, 11, 1, 6, 30, 0, 123456, tzinfo=UTC)


def snapshot(payload, at=AT, provider="network"):
    return RawI3AlertSnapshot(1, provider, "America/Toronto", at, payload)


@pytest.fixture
def duck(tmp_path):
    with closing(duckdb.connect(str(tmp_path / "alerts.db"))) as connection:
        create_alert_tables(connection)
        yield connection


def feed_rows(duck):
    return observation_rows(duck, "alert_feed_observations")


def language_rows(duck):
    return observation_rows(duck, "alert_language_observations")


def observation_rows(duck, table):
    # Read UTC through the standard datetime codec without DuckDB's optional pytz codec.
    rows = duck.execute(
        "SELECT * REPLACE (observed_at_utc AT TIME ZONE 'UTC' AS observed_at_utc) "
        f"FROM raw.{table} ORDER BY 1, 2, 3"
    ).fetchall()
    return [(*row[:-1], row[-1].replace(tzinfo=UTC)) for row in rows]


def test_empty_capture_records_zero_count_without_clearing_alerts(duck):
    duck.execute(
        "INSERT INTO silver.i3_alerts "
        "(i3_alert_snapshot_id, alert_index, provider_id, captured_at_utc, raw_alert_json, "
        "content_hash) VALUES (1, 0, 'network', ?, '{}', 'kept')",
        [AT],
    )
    query = "SELECT COLUMNS(*)::VARCHAR FROM silver.i3_alerts"
    before = duck.execute(query).fetchall()
    assert record_alert_observations(duck, snapshot([])) is True
    assert feed_rows(duck) == [("network", date(2026, 11, 1), 0, AT)]
    assert language_rows(duck) == []
    assert duck.execute(query).fetchall() == before


def test_older_capture_does_not_advance_feed_watermark(duck):
    assert record_alert_observations(duck, snapshot([{"id": "latest"}])) is True
    older = AT - timedelta(days=1)
    assert record_alert_observations(duck, snapshot([{"id": "old"}], older)) is False
    assert feed_rows(duck) == [
        ("network", date(2026, 10, 31), 1, older),
        ("network", date(2026, 11, 1), 1, AT),
    ]
    assert ("network", "id:old", date(2026, 10, 31), False, False, True, older) in language_rows(
        duck
    )
    assert record_alert_observations(duck, snapshot([], older, "other")) is True


def test_language_observation_timestamp_guard_matches_postgres(duck):
    assert record_alert_observations(duck, snapshot([{"id": "a", "header": {"fr": "Avis"}}]))
    assert not record_alert_observations(duck, snapshot([{"id": "a"}], AT - timedelta(seconds=1)))
    assert language_rows(duck) == [("network", "id:a", date(2026, 11, 1), True, False, False, AT)]
    assert record_alert_observations(duck, snapshot([{"id": "a", "header": {"en": "Notice"}}]))
    assert language_rows(duck) == [("network", "id:a", date(2026, 11, 1), False, True, False, AT)]


@pytest.mark.parametrize(
    "at, day",
    [
        ("2026-03-08T04:59:59+00:00", "2026-03-07"),
        ("2026-03-08T07:00:00+00:00", "2026-03-08"),
        ("2026-11-01T05:30:00+00:00", "2026-11-01"),
        ("2026-11-01T06:30:00+00:00", "2026-11-01"),
    ],
)
def test_dst_and_midnight_use_provider_timezone(duck, at, day):
    stamp = datetime.fromisoformat(at)
    assert record_alert_observations(duck, snapshot([{"id": "a"}], stamp))
    assert feed_rows(duck) == [("network", date.fromisoformat(day), 1, stamp)]
    assert language_rows(duck)[0][2] == date.fromisoformat(day)


@pytest.mark.parametrize(
    "payload",
    [
        [{"id": "a", "header": "Unlabelled"}],
        {"messages": [None, {"id": "a", "header": {"es": "Aviso"}}]},
        {"alerts": [{"id": "a", "header": None}, {"id": "a", "header": ""}]},
    ],
)
def test_missing_language_is_unknown_not_false_evidence(duck, payload):
    assert record_alert_observations(duck, snapshot(payload))
    assert language_rows(duck) == [("network", "id:a", date(2026, 11, 1), False, False, True, AT)]
    assert feed_rows(duck)[0][2] == (2 if isinstance(payload, dict) and "alerts" in payload else 1)
