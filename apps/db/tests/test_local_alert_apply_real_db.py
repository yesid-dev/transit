import json
from dataclasses import replace
from datetime import timedelta

import pytest
import test_i3_real_db_regression as oracle
from sqlalchemy import text
from test_local_alert_apply import ALERT, apply, read
from test_local_alert_seed import AT

from transit_ops.silver.i3 import RawI3AlertSnapshot, load_i3_snapshot_to_silver
from transit_ops.static.alert_seed import AlertSeed, read_alert_seed
from transit_ops.static.alert_seed_contract import KEYS, SCHEMAS, TABLES
from transit_ops.static.alert_state import seed_alert_state


def pg_capture(pg, payload, sid, seconds=0):
    # The old production loader reads a raw jsonb capture, not the input object's order.
    decoded = pg.execute(
        text(
            "UPDATE raw.i3_alert_snapshots SET raw_payload_json=CAST(:body AS jsonb), "
            "captured_at_utc=:at WHERE i3_alert_snapshot_id=:sid RETURNING raw_payload_json"
        ),
        {"body": json.dumps(payload), "sid": sid, "at": AT + timedelta(seconds=seconds)},
    ).scalar_one()
    return RawI3AlertSnapshot(
        sid, oracle.PROVIDER, "America/Toronto", AT + timedelta(seconds=seconds), decoded
    )


def compare(pg, store):
    for table in TABLES[:5]:
        columns = SCHEMAS[table]
        projection = ", ".join(
            f"{c}::text AS {c}" if t == "jsonb" else c for c, t in columns.items()
        )
        scope = (
            "provider_id=:p"
            if "provider_id" in columns
            else (
                "(i3_alert_snapshot_id, alert_index) IN (SELECT i3_alert_snapshot_id, alert_index "
                "FROM silver.i3_alerts WHERE provider_id=:p)"
            )
        )
        expected = [
            dict(row)
            for row in pg.execute(
                text(
                    f"SELECT {projection} FROM {table} WHERE {scope} "
                    f"ORDER BY {', '.join(KEYS[table])}"
                ),
                {"p": oracle.PROVIDER},
            ).mappings()
        ]
        assert read(store, table) == expected


def transitions(case):
    if case == "children":
        return [
            (
                1,
                1,
                [
                    ALERT
                    | {
                        "routes": ["changed", "new"],
                        "activePeriods": [{"start": "2026-01-01T00:00:00.999999Z"}],
                        "header": {"en": "Changed", "fr": "Avis é雪"},
                    }
                ],
            )
        ]
    if case == "supersede_empty":
        return [(1, 1, []), (2, 2, [ALERT | {"description": "changed"}]), (3, 3, [])]
    if case == "duplicate_equal_repeat":
        return [(1, 0, [ALERT, ALERT | {"routes": ["discarded"]}]), (0, 0, [ALERT])]
    if case == "older":
        return [(1, -86400, [{"id": "old"}]), (2, -1, []), (3, 1, [ALERT])]
    if case == "period_index":
        return [
            (1, 1, [ALERT | {"activePeriods": []}]),
            (2, 2, [ALERT | {"activePeriods": [{"start": None, "end": None}]}]),
        ]
    if case == "jsonb":
        return [
            (
                1,
                1,
                [
                    ALERT
                    | {
                        "header": {"zzz": "later", "é": "first"},
                        "url": "",
                        "extra": {"é": "雪", "a": None, "zzz": []},
                        "activePeriods": [{"start": None}, {"end": "2027-01-01T00:00:00.654321Z"}],
                    }
                ],
            )
        ]
    # English-only edits and removals must replace display fields and provenance.
    return [
        (1, 1, [ALERT | {"header": {"fr": "Avis é雪", "en": "Edited"}}]),
        (2, 2, [ALERT | {"header": {"fr": "Avis é雪"}}]),
    ]


@pytest.mark.parametrize(
    "case",
    [
        "children",
        "supersede_empty",
        "duplicate_equal_repeat",
        "older",
        "jsonb",
        "display",
        "period_index",
    ],
)
def test_seed_then_replay_equals_postgres_at_same_commit(
    real_db_engine, seed_provider, tmp_path, case
):
    from contextlib import closing

    from test_local_alert_seed import SETTINGS

    from transit_ops.live.local_file import LocalFile

    with real_db_engine.connect() as pg:
        # Export real first-capture rows, then roll back the disposable source setup.
        with pg.begin() as transaction:
            pg.execute(text("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ"))
            oracle._seed(pg, seed_provider)
            first = pg_capture(pg, [ALERT], oracle.SNAP_IDS[0])
            load_i3_snapshot_to_silver(pg, snapshot=first, loaded_at_utc=AT)
            pg.execute(text("SET TRANSACTION READ ONLY"))
            seed = AlertSeed.from_json(read_alert_seed(pg, provider_id=oracle.PROVIDER).to_json())
            transaction.rollback()
        # Rebuild the same oracle start, preserving the exported snapshot identities.
        with (
            pg.begin(),
            closing(
                LocalFile.open(
                    tmp_path / "parity.db", provider_id=oracle.PROVIDER, settings=SETTINGS
                )
            ) as store,
        ):
            oracle._seed(pg, seed_provider)
            first = pg_capture(pg, [ALERT], oracle.SNAP_IDS[0])
            load_i3_snapshot_to_silver(pg, snapshot=first, loaded_at_utc=AT)
            seed_alert_state(store, seed)
            compare(pg, store)
            for index, seconds, payload in transitions(case):
                snapshot = pg_capture(pg, payload, oracle.SNAP_IDS[index], seconds)
                expected = load_i3_snapshot_to_silver(pg, snapshot=snapshot, loaded_at_utc=AT)
                # Local input retains the capture's original key ordering.
                actual = apply(store, replace(snapshot, raw_payload_json=payload))
                assert actual == expected
                compare(pg, store)
