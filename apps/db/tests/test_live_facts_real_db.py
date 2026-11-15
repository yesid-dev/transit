"""Vehicle projection tripwire: the production PostgreSQL path owns expected rows."""

import os
from contextlib import closing
from dataclasses import replace
from hashlib import sha256

import pytest
from google.transit import gtfs_realtime_pb2 as pb
from test_live_facts import vehicle_message
from test_live_local_file import SETTINGS
from test_live_oracle_runner import replay_case as replay_case
from test_live_oracle_seed import case as case

from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.compare import compare_rows, rows_digest
from transit_ops.live.facts import apply_capture, read_vehicle_facts
from transit_ops.live.local_file import LocalFile
from transit_ops.live.oracle import replay_window


@pytest.mark.parametrize("empty", [False, True])
def test_vehicle_facts_equal_the_postgres_path(real_db_engine, replay_case, tmp_path, empty):
    case = replay_case
    records = []
    for record in case.window.poll_records:
        if record.feed_day.endpoint_key != "vehicle_positions":
            records.append(record)
            continue
        message = (
            pb.FeedMessage(header=dict(gtfs_realtime_version="2.0")) if empty else vehicle_message()
        )
        capture = record.captures[0]
        message.header.timestamp = int(capture.feed_timestamp_utc.timestamp())
        payload = message.SerializeToString()
        (case.bronze("local").root / capture.storage_path).write_bytes(payload)
        records.append(
            replace(
                record,
                captures=(
                    replace(
                        capture,
                        sha256=sha256(payload).hexdigest(),
                        byte_size=len(payload),
                        entity_count=len(message.entity),
                    ),
                ),
                polls=(replace(record.polls[0], entity_count=len(message.entity)),),
            )
        )
    window = replace(case.window, poll_records=tuple(records))
    provider = window.provider_id
    policy = ParsePolicy.from_manifest(case.registry.get_provider(provider))
    outcomes = replay_window(
        window,
        admin_url=real_db_engine.url.render_as_string(hide_password=False),
        environment=os.environ,
        settings=case.settings,
        registry=case.registry,
        bronze=case.bronze,
    )
    with closing(
        LocalFile.open(tmp_path / "facts.db", provider_id=provider, settings=SETTINGS)
    ) as local:
        for cycle, outcome in zip(window.cycles, outcomes, strict=True):
            for family, capture_id in cycle.captures:
                record, capture = window.capture(family, capture_id)
                if record.feed_day.endpoint_key != "vehicle_positions":
                    continue
                payload = (case.bronze("local").root / capture.storage_path).read_bytes()
                parsed = parse_capture(
                    payload,
                    CaptureRef.from_entry(
                        capture,
                        provider_id=provider,
                        endpoint_key="vehicle_positions",
                    ),
                    policy,
                )
                apply_capture(local, parsed, provider_timezone="America/Toronto")
                assert apply_capture(local, parsed, provider_timezone="America/Toronto") == 0
            expected = next(t for t in outcome.facts if t.table == "gold.fact_vehicle_snapshot")
            actual = read_vehicle_facts(local)
            assert actual.columns == expected.columns
            assert not compare_rows(
                expected.table, expected.key_columns, expected.rows, actual.rows
            )
            assert rows_digest(actual.rows) == rows_digest(expected.rows)
