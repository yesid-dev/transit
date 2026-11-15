from __future__ import annotations

import pathlib

import pytest

_REPO_ROOT = pathlib.Path(__file__).resolve().parents[3]
_DB_SCHEMAS = _REPO_ROOT / "apps/db/src/transit_ops/snapshots/schemas"
_WEB_MIRROR = _REPO_ROOT / "apps/web/src/lib/v1/schemas/json"
_R3_FAMILIES = {"historic_receipt.schema.json", "historic_network_trend.schema.json"}
_R3_DB = _DB_SCHEMAS / "r3"
_R3_WEB = _WEB_MIRROR.parent / "r3/json"

pytestmark = pytest.mark.skipif(
    not _WEB_MIRROR.is_dir(),
    reason="web mirror dir not present (apps/web not checked out alongside apps/db)",
)


def _schema_basenames(directory: pathlib.Path) -> set[str]:
    return {path.name for path in directory.glob("*.schema.json")}


def test_revision_three_web_mirror_has_exact_family_set() -> None:
    assert _schema_basenames(_R3_DB) == _R3_FAMILIES
    assert _schema_basenames(_R3_WEB) == _R3_FAMILIES


@pytest.mark.parametrize("name", sorted(_R3_FAMILIES))
def test_revision_three_web_mirror_is_byte_identical(name: str) -> None:
    assert (_R3_WEB / name).read_bytes() == (_R3_DB / name).read_bytes(), name


def test_web_mirror_has_same_schema_files_as_db_export() -> None:
    db_names = _schema_basenames(_DB_SCHEMAS)
    web_names = _schema_basenames(_WEB_MIRROR)

    missing_in_web = db_names - web_names
    extra_in_web = web_names - db_names
    assert not missing_in_web, (
        f"web JSON mirror is missing {sorted(missing_in_web)} — copy them from "
        "apps/db/.../snapshots/schemas/ to apps/web/.../v1/schemas/json/"
    )
    assert not extra_in_web, (
        f"web JSON mirror carries stale files {sorted(extra_in_web)} that are no "
        "longer in the DB export — delete them"
    )

    assert {
        "historic_collection_index.schema.json",
        "historic_availability_index.schema.json",
        "historic_hotspots_day.schema.json",
        "historic_repeat_offenders_day.schema.json",
    } <= web_names


@pytest.mark.parametrize("name", sorted(_schema_basenames(_DB_SCHEMAS)))
def test_web_mirror_is_byte_identical_to_db_export(name: str) -> None:
    db_bytes = (_DB_SCHEMAS / name).read_bytes()
    web_bytes = (_WEB_MIRROR / name).read_bytes()
    assert web_bytes == db_bytes, (
        f"{name}: the web JSON mirror has drifted from the DB-generated schema. "
        "Re-run scripts/export_snapshot_schemas.py and copy the result into "
        "apps/web/src/lib/v1/schemas/json/."
    )
