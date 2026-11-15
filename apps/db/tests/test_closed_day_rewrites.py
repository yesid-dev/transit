from copy import deepcopy
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from transit_ops.history.closed_day_rewrites import WindowTrimmed, begin_rewrite
from transit_ops.history.ledger_store import WindowIdentity

ID = WindowIdentity("capture.trip_updates", "network", "2026-11-01")
ARGS = dict(
    command="replay-realtime-silver",
    operation_id="rewrite-17",
    capture_ids=(17,),
    provenance=dict(
        command="replay-realtime-silver",
        mode="gold",
        capture_ids=[17],
        source_hashes={"17": None},
        code_revision=None,
        code_revision_unknown_reason="not supplied",
    ),
)


def store_for(state):
    store = MagicMock()
    window = store.session.return_value.__enter__.return_value
    window.state.return_value = SimpleNamespace(working_state=state)
    window.now.return_value = datetime(2026, 11, 2, 5, 59, tzinfo=UTC)
    return store, window


@pytest.mark.parametrize("state", ["partial", "trimmed"])
def test_trimmed_and_partial_rewrite_refuse_before_mark_changed_or_hold(state):
    store, window = store_for(state)
    with pytest.raises(WindowTrimmed, match="window_trimmed.*network.*trip_updates.*2026-11-01"):
        begin_rewrite(store, ID, **ARGS)
    window.mark_changed.assert_not_called()
    window.hold.assert_not_called()
    store.record_audit.assert_not_called()


def test_open_capture_day_creates_no_rewrite_audit():
    store, window = store_for("present")
    assert begin_rewrite(store, ID, **ARGS) is None
    window.mark_changed.assert_not_called()
    window.hold.assert_not_called()
    store.record_audit.assert_not_called()


@pytest.mark.parametrize("field", ["operation_id", "command", "actor", "mode"])
def test_nul_is_refused_before_writes(field):
    store, window = store_for("present")
    args = deepcopy(ARGS)
    target = args["provenance"] if field == "mode" else args
    target[field] = "bad\0text"
    with pytest.raises(ValueError, match="control character"):
        begin_rewrite(store, ID, **args)
    window.mark_changed.assert_not_called()
    window.hold.assert_not_called()
    store.record_audit.assert_not_called()
