from contextlib import closing
from datetime import UTC, date, datetime

import pytest

from transit_ops.live.local_file import LocalFile
from transit_ops.live.settings import LaneSettings
from transit_ops.static.alert_seed import AlertSeed, AlertSeedInvalid
from transit_ops.static.alert_seed_contract import KEYS, SCHEMAS, TABLES
from transit_ops.static.alert_state import AlertStateConflict, create_alert_tables, seed_alert_state

AT = datetime(2026, 1, 2, 3, 4, 5, 123456, tzinfo=UTC)
JSON = '{"z": "车辆", "a": "é", "empty": ""}'
SETTINGS = LaneSettings(duckdb_memory_limit_mb=64, duckdb_threads=1, temp_dir_max_mb=32)


def opened(path):
    return LocalFile.open(path, provider_id="network", settings=SETTINGS)


def bundle():
    values = {
        "bigint": 41,
        "integer": 0,
        "text": "",
        "jsonb": JSON,
        "timestamp with time zone": AT.isoformat(),
        "date": "2026-01-02",
        "boolean": False,
    }
    tables = {}
    for name, schema in SCHEMAS.items():
        row = {c: values[t] for c, t in schema.items()}
        if "provider_id" in row:
            row["provider_id"] = "network"
        tables[name] = {"columns": schema, "rows": [row]}
    tables[TABLES[0]]["rows"][0].update(
        message_snapshot_id=42,
        valid_to=None,
        description_text=None,
        content_hash="hash",
    )
    raw = tables[TABLES[5]]["rows"][0]
    tables[TABLES[5]]["rows"].append(raw | {"i3_alert_snapshot_id": 42, "ingestion_run_id": 42})
    return AlertSeed(
        version=1,
        provider_id="network",
        snapshot_at=AT,
        global_max_snapshot_id=9007199254740993,
        tables=tables,
    )


def rows(conn, name, columns):
    projection = [
        f"strftime({c}, '%Y-%m-%dT%H:%M:%S.%f+00:00')" if kind == "timestamp with time zone" else c
        for c, kind in columns.items()
    ]
    result = conn.execute(
        f"SELECT {', '.join(projection)} FROM {name} ORDER BY {', '.join(KEYS[name])}"
    ).fetchall()
    return [
        tuple(v.isoformat() if isinstance(v, (datetime, date)) else v for v in r) for r in result
    ]


def test_seed_rows_and_children_equal_export(tmp_path):
    seed = AlertSeed.from_json(bundle().to_json())
    with closing(opened(tmp_path / "worker.db")) as local:
        seed_alert_state(local, seed)
        for name, table in seed.tables.items():
            assert rows(local.connection, name, table.columns) == [
                tuple(row[c] for c in table.columns) for row in table.rows
            ]
        create_alert_tables(local.connection)


def test_reopen_keeps_seed_and_id_floor(tmp_path):
    path = tmp_path / "worker.db"
    with closing(opened(path)) as local:
        seed_alert_state(local, bundle())
    with closing(opened(path)) as local:
        seed_alert_state(local, bundle())
        assert local.connection.execute(
            "SELECT provider_id, global_max_snapshot_id FROM alert_seed_checkpoint"
        ).fetchall() == [("network", 9007199254740993)]
        assert local.connection.execute(
            "SELECT i3_alert_snapshot_id, message_snapshot_id FROM silver.i3_alerts"
        ).fetchall() == [(41, 42)]


def test_equal_seed_is_noop_and_changed_seed_refused(tmp_path):
    with closing(opened(tmp_path / "worker.db")) as local:
        seed_alert_state(local, bundle())
        local.connection.execute("UPDATE silver.i3_alerts SET alert_header_text='later'")
        seed_alert_state(local, bundle())
        changed = bundle().model_copy(update={"global_max_snapshot_id": 9999999999999999})
        with pytest.raises(AlertStateConflict):
            seed_alert_state(local, changed)
        assert local.connection.execute(
            "SELECT alert_header_text FROM silver.i3_alerts"
        ).fetchall() == [("later",)]


def test_seed_failure_rolls_back_every_table(tmp_path):
    seed = bundle()
    seed.tables[TABLES[5]].rows[1]["byte_size"] = 2**100
    with closing(opened(tmp_path / "worker.db")) as local:
        with pytest.raises(AlertStateConflict):
            seed_alert_state(local, seed)
        tables = local.connection.execute(
            "SELECT schema_name, table_name FROM duckdb_tables() "
            "WHERE schema_name IN ('silver', 'raw') OR table_name='alert_seed_checkpoint'"
        ).fetchall()
        assert tables == []
        seed_alert_state(local, bundle())


@pytest.mark.parametrize("damage", ["provider", "child", "digest"])
def test_provider_or_dangling_child_mismatch_refused(tmp_path, damage):
    seed = bundle()
    if damage == "provider":
        seed = seed.model_copy(update={"provider_id": "other"})
        for table in seed.tables.values():
            for row in table.rows:
                if "provider_id" in row:
                    row["provider_id"] = "other"
    elif damage == "child":
        seed.tables[TABLES[1]].rows[0]["alert_index"] = 7
    else:
        payload = seed.to_json().replace(b'"hash"', b'"tampered"')
        with pytest.raises(AlertSeedInvalid, match="digest"):
            AlertSeed.from_json(payload)
        return
    with closing(opened(tmp_path / "worker.db")) as local:
        with pytest.raises(AlertStateConflict):
            seed_alert_state(local, seed)
        assert local.connection.execute("SELECT * FROM meta").fetchall() == [(1, "network")]


def test_jsonb_unicode_and_microseconds_survive_reopen(tmp_path):
    path = tmp_path / "worker.db"
    with closing(opened(path)) as local:
        seed_alert_state(local, bundle())
    with closing(opened(path)) as local:
        assert local.connection.execute(
            "SELECT raw_alert_json, description_text, alert_header_text, "
            "epoch_us(captured_at_utc) FROM silver.i3_alerts"
        ).fetchall() == [(JSON, None, "", 1767323045123456)]


@pytest.mark.parametrize(
    "change",
    [
        "DROP TABLE silver.i3_alert_active_periods",
        "ALTER TABLE silver.i3_alerts DROP COLUMN severity",
        "CREATE UNIQUE INDEX extra ON silver.i3_alerts(alert_header_text)",
        "DELETE FROM alert_seed_checkpoint",
    ],
)
def test_incomplete_schema_or_checkpoint_is_refused(tmp_path, change):
    with closing(opened(tmp_path / "worker.db")) as local:
        seed_alert_state(local, bundle())
        local.connection.execute(change)
        with pytest.raises(AlertStateConflict):
            seed_alert_state(local, bundle())
        assert local.connection.execute(
            "SELECT message_snapshot_id FROM silver.i3_alerts"
        ).fetchall() == [(42,)]


def test_unknown_floor_stays_missing_and_nonempty_store_is_refused(tmp_path):
    empty = bundle()
    for table in empty.tables.values():
        table.rows.clear()
    empty.global_max_snapshot_id = None
    with closing(opened(tmp_path / "worker.db")) as local:
        seed_alert_state(local, empty)
        assert local.connection.execute(
            "SELECT global_max_snapshot_id FROM alert_seed_checkpoint"
        ).fetchall() == [(None,)]
    with closing(opened(tmp_path / "occupied.db")) as local:
        create_alert_tables(local.connection)
        local.connection.execute(
            "INSERT INTO raw.alert_feed_observations VALUES ('network', '2026-01-02', 0, ?)", [AT]
        )
        with pytest.raises(AlertStateConflict):
            seed_alert_state(local, bundle())


def persisted_state(conn):
    state = []
    for schema, name, ddl in conn.execute(
        "SELECT schema_name, table_name, sql FROM duckdb_tables() "
        "WHERE database_name=current_database() AND NOT temporary ORDER BY 1, 2"
    ).fetchall():
        table = f"{schema}.{name}"
        columns = conn.execute("SELECT name FROM pragma_table_info(?)", [table]).fetchall()
        projection = ", ".join(f'CAST("{c}" AS VARCHAR)' for (c,) in columns)
        values = conn.execute(f"SELECT {projection} FROM {table}").fetchall()
        state.append((table, ddl, sorted(values, key=repr)))
    return state


@pytest.mark.parametrize("already_seeded", [False, True])
@pytest.mark.parametrize(
    "definition",
    (
        "COLLATE NOCASE|COLLATE NOACCENT|COLLATE NFC|COLLATE NOCASE.NOACCENT|"
        "DEFAULT 'changed'|CHECK(route_id <> 'blocked')|GENERATED ALWAYS AS ('generated')"
    ).split("|")
    + [None],
)
def test_column_properties_and_equivalent_checkpoint(tmp_path, already_seeded, definition):
    seed = bundle()
    seed.tables[TABLES[1]].rows[0]["route_id"] = "case-sensitive"
    path = tmp_path / "collation.db"
    table = "silver.i3_alert_informed_entities" if definition else "main.alert_seed_checkpoint"
    with closing(opened(path)) as local:
        conn = local.connection
        create_alert_tables(conn)
        if already_seeded:
            seed_alert_state(local, seed)
        ddl = conn.execute(
            "SELECT sql FROM duckdb_tables() WHERE schema_name=? AND table_name=?",
            table.split("."),
        ).fetchone()[0]
        conn.execute(f"CREATE TEMP TABLE retained AS SELECT * FROM {table}")
        conn.execute(f"DROP TABLE {table}")
        if definition:
            ddl = ddl.replace("route_id VARCHAR", f"route_id VARCHAR {definition}")
        else:
            ddl = ddl.replace("provider_id VARCHAR PRIMARY KEY", "provider_id VARCHAR").replace(
                "global_max_snapshot_id BIGINT",
                "global_max_snapshot_id BIGINT, PRIMARY KEY(provider_id)",
            )
        conn.execute(ddl)
        columns = ", ".join(c for c in SCHEMAS[TABLES[1]] if c != "route_id")
        projection = columns if definition and definition.startswith("GENERATED") else "*"
        conn.execute(f"INSERT INTO {table} SELECT {projection} FROM retained")
    with closing(opened(path)) as local:
        before = persisted_state(local.connection)
        if definition is None:
            seed_alert_state(local, seed)
            assert local.connection.execute(
                "SELECT route_id FROM silver.i3_alert_informed_entities"
            ).fetchall() == [("case-sensitive",)]
        else:
            with pytest.raises(AlertStateConflict, match=table):
                seed_alert_state(local, seed)
        if definition is not None or already_seeded:
            assert persisted_state(local.connection) == before
