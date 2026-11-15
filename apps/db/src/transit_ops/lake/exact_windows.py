"""Validate exact selectors and reuse closed receipts before source discovery."""

from collections.abc import Sequence
from datetime import datetime
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from transit_ops.lake.migration import PlannedWindow

from transit_ops.history.datasets import HISTORY_DATASETS, TableSource, get_dataset, window_start
from transit_ops.ingestion.storage import BronzeStorage
from transit_ops.lake.archive_keys import parse_proof_key, validate_provider_id
from transit_ops.lake.table_copy import _closed, _proven_closed
from transit_ops.lake.table_export import WindowSpec


def select_exact(
    windows: Sequence[str],
    datasets: Sequence[str] | None,
    providers: Sequence[str] | None,
    now: datetime,
    storage: BronzeStorage | None,
) -> tuple[set[tuple[str, str, str]], set[str], list["PlannedWindow"]]:
    from transit_ops.lake.migration import MigrationRefused, PlannedWindow

    selected = set()
    for value in windows:
        try:
            name, provider, key = value.split(":")
            declaration = get_dataset(name)
            if not isinstance(declaration.source, TableSource):
                raise ValueError("not a table")
            validate_provider_id(provider)
            window_start(declaration, key)
        except (ValueError, LookupError) as error:
            raise MigrationRefused("window", value) from error
        if (datasets is None or name in datasets) and (
            providers is None
            or provider in providers
            or (provider == "_shared" and declaration.copy_group)
        ):
            selected.add((name, provider, key))
    cached = []
    if storage is not None:
        for name, provider, key in sorted(selected):
            declaration = get_dataset(name)
            if declaration.copy_group:
                continue
            versions = {
                parts.revision
                for path in storage.list_keys(f"archive/v1/tables/{name}/{provider}/")
                if (parts := parse_proof_key(path)) is not None and parts.window_key == key
            }
            for revision in sorted(versions, reverse=True):
                spec = WindowSpec(name, provider, key, revision)
                if _closed(spec, now) and (copy := _proven_closed(storage, spec)) is not None:
                    cached.append(PlannedWindow(spec, "closed", archive_copy=copy))
                    break
    pending = selected - {
        (w.spec.dataset_id, w.spec.provider_id, w.spec.window_key) for w in cached
    }
    names = {name for name, _, _ in pending}
    if any(get_dataset(name).copy_group for name in names):
        names |= {
            name for name, d in HISTORY_DATASETS.items() if d.copy_group == "silver_alert_state"
        }
    return pending, names, cached
