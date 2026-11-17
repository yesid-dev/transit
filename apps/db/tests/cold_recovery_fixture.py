"""Generate complete cold inputs from a tiny real owner, never production state."""

import json
from contextlib import closing
from dataclasses import asdict, replace
from datetime import timedelta
from hashlib import sha256

from test_live_captures import AT
from test_live_facts import seed_fact_edition, trip_message, vehicle_message
from test_live_local_file import CAPTURE, POLL, RECORD, SETTINGS
from test_local_alert_apply import ALERT
from test_local_alert_seed import bundle

from transit_ops.ingestion.storage import LocalBronzeStorage
from transit_ops.live.captures import CaptureRef, ParsePolicy, parse_capture
from transit_ops.live.edition import EDITION_TABLES
from transit_ops.live.facts import apply_capture
from transit_ops.live.local_file import SCHEMA_VERSION, LocalFile
from transit_ops.live.recording import Recorder
from transit_ops.live.recovery import (
    CHECKPOINT_TABLES,
    ColdInputs,
    ReplayStep,
    _json,
    _read_frame,
    _replay_digest,
    _state,
    frames_sha256,
)
from transit_ops.live.segments import export_segment
from transit_ops.silver.i3 import RawI3AlertSnapshot
from transit_ops.static.alert_apply import apply_alert_snapshot
from transit_ops.static.alert_state import seed_alert_state


def seal(inputs, state_digest, **overrides):
    cut = (
        dict(
            version=1,
            schema_version=SCHEMA_VERSION,
            provider_id=inputs.provider_id,
            inventory=[asdict(s) for s in inputs.inventory],
            last_seq=inputs.inventory[-1].last_seq,
            window_start=AT.isoformat(),
            window_end=(AT + timedelta(seconds=10)).isoformat(),
            edition_sha256=frames_sha256(inputs.edition_source),
            checkpoint_sha256=frames_sha256(inputs.checkpoint),
            alert_seed_sha256=sha256(inputs.alert_seed).hexdigest(),
            alert_history_sha256=sha256(_json(inputs.alert_history)).hexdigest(),
            context_sha256=sha256(_json((inputs.timezone, asdict(inputs.policy)))).hexdigest(),
            replay_sha256=_replay_digest(inputs),
            state_sha256=state_digest,
        )
        | overrides
    )
    payload = _json(cut)
    return replace(inputs, cut=payload, cut_sha256=sha256(payload).hexdigest())


def capture_record(endpoint, identity, run, payload, seconds):
    at = AT + timedelta(seconds=seconds)
    family = (
        "realtime_snapshot"
        if endpoint in ("vehicle_positions", "trip_updates")
        else "alert_snapshot"
    )
    capture = replace(
        CAPTURE,
        index_family=family,
        capture_row_id=identity,
        ingestion_run_id=run,
        packed=False,
        stream=None,
        offset=None,
        storage_path=f"{family}/{identity}",
        byte_size=len(payload),
        sha256=sha256(payload).hexdigest(),
        captured_at_utc=at,
        feed_timestamp_utc=AT,
        started_at_utc=at,
        object_created_at_utc=at,
    )
    poll = replace(
        POLL,
        index_family=family,
        ingestion_run_id=run,
        capture_row_id=identity,
        started_at_utc=at,
        time_utc=at,
        completed_at_utc=at,
    )
    return replace(
        RECORD,
        feed_day=replace(RECORD.feed_day, endpoint_key=endpoint, index_family=family),
        polls=(poll,),
        captures=(capture,),
        processing=(),
    )


def generate(tmp_path, historical=False):
    storage = LocalBronzeStorage("local", tmp_path / "segments")
    storage.root.mkdir()
    payloads = {}
    seed = bundle()
    with closing(
        LocalFile.open(tmp_path / "source.duckdb", provider_id="network", settings=SETTINGS)
    ) as local:
        seed_alert_state(local, seed)
        seed_fact_edition(local)
        local.connection.execute("INSERT INTO edition_trips VALUES ('行程', '路线', 'weekday')")
        recorder = Recorder(local, provider_id="network")
        recorder.initialize(initial_run_id=0, seed_sha256=sha256(seed.to_json()).hexdigest())
        inventory, applications = generate_applications(
            local, recorder, storage, payloads, historical
        )
        inputs = ColdInputs(
            "network",
            "America/Toronto",
            ParsePolicy(None, 100),
            tuple(inventory),
            b"",
            "",
            tuple(_read_frame(local, n) for n in EDITION_TABLES),
            seed.to_json(),
            (("i3_alerts", 101), ("i3_alerts", 102)),
            tuple(_read_frame(local, n) for n in CHECKPOINT_TABLES),
            tuple(applications),
        )
        state = _state(local)
    return seal(inputs, frames_sha256(state)), storage, payloads, state


def generate_applications(local, recorder, storage, payloads, historical):
    inventory, applications = [], []
    captures = (
        ("vehicle_positions", 101, vehicle_message().SerializeToString()),
        ("trip_updates", 102, trip_message().SerializeToString()),
        ("i3_alerts", 101, json.dumps([ALERT]).encode()),
        (
            "i3_alerts",
            102,
            json.dumps([ALERT | {"header": {"fr": "Avis é雪", "en": "Updated"}}]).encode(),
        ),
    )
    if historical:
        captures += (("trip_updates", 103, trip_message().SerializeToString()),)
    for run, (endpoint, identity, payload) in enumerate(captures, 1):
        if historical and run == 5:
            local.connection.execute("UPDATE edition_stop_times SET arrival_time='07:00:00'")
            local.connection.execute("UPDATE edition_meta SET dataset_version_id=8")
        record = capture_record(endpoint, identity, run, payload, run)
        entry = record.captures[0]
        payloads[(entry.index_family, identity)] = payload
        recorder._commit_page((record,), [run, 99], 0, 99)
        apply_source(local, recorder, endpoint, entry, payload)
        applications.append(
            ReplayStep(
                endpoint,
                identity,
                tuple(_read_frame(local, n) for n in EDITION_TABLES)
                if endpoint == "trip_updates"
                else None,
            )
        )
        if run in (1, len(captures)):
            inventory.append(export_segment(local, storage))
    return inventory, applications


def apply_source(local, recorder, endpoint, entry, payload):
    if endpoint in ("vehicle_positions", "trip_updates"):
        parsed = parse_capture(
            payload,
            CaptureRef.from_entry(entry, provider_id="network", endpoint_key=endpoint),
            ParsePolicy(None, 100),
        )
        recorder.apply(
            endpoint,
            entry.capture_row_id,
            lambda: apply_capture(local, parsed, provider_timezone="America/Toronto"),
            capture=entry,
        )
    else:
        snapshot = RawI3AlertSnapshot(
            entry.capture_row_id,
            "network",
            "America/Toronto",
            entry.captured_at_utc,
            json.loads(payload),
        )
        recorder.apply(
            endpoint,
            entry.capture_row_id,
            lambda: apply_alert_snapshot(local, snapshot, loaded_at_utc=entry.captured_at_utc),
            capture=entry,
        )
