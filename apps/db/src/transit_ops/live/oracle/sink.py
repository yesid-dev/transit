import json
from collections.abc import Mapping

from transit_ops.snapshots.protocols import SnapshotPayload
from transit_ops.snapshots.serialization import snapshot_json_bytes


class RecordingSink:
    def __init__(self, initial: Mapping[str, bytes] = {}) -> None:
        self.objects = dict(initial)
        self.written: list[str] = []

    def put_json(self, rel_key: str, payload: SnapshotPayload, *, tier: str) -> str:
        self.objects[rel_key] = snapshot_json_bytes(payload)
        self.written.append(rel_key)
        return rel_key

    def get_json(self, rel_key: str) -> object:
        return json.loads(self.objects[rel_key]) if rel_key in self.objects else None

    def take_written(self) -> list[str]:
        written, self.written = self.written, []
        return written
