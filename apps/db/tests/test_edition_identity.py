import pytest

from transit_ops.lake.archive_keys import parse_copy_key, table_copy_key
from transit_ops.lake.edition_identity import edition_keys, resolve_edition


def test_repeated_content_keeps_first_key_and_distinguishes_version_rows():
    assert edition_keys([(133, None, "a" * 64), (132, None, "a" * 64)]) == {
        132: "a" * 64,
        133: "a" * 64 + ".v133",
    }


@pytest.mark.parametrize("provider", ["stm", "octranspo"])
def test_existing_provider_edition_keeps_id_and_archive_key(provider):
    class Connection:
        def execute(self, query, values):
            assert values == (provider,)
            return self

        def fetchall(self):
            return [(42, "b" * 64, "c" * 64)]

    assert edition_keys([(42, "b" * 64, "c" * 64)]) == {42: "b" * 64}
    assert resolve_edition(Connection(), provider, "b" * 64) == 42


def test_missing_or_malformed_declared_digest_refuses_by_name():
    for digest in (None, "not-a-digest"):
        with pytest.raises(ValueError, match="edition_identity"):
            edition_keys([(132, None, digest)])


def test_conflicting_version_registration_refuses_by_name():
    with pytest.raises(ValueError, match="edition_identity"):
        edition_keys([(132, None, "a" * 64), (132, None, "b" * 64)])


def test_qualified_edition_archive_key_round_trips_without_changing_legacy_keys():
    legacy = table_copy_key("silver.trips", "sto", 0, "edition", "a" * 64, 1, 1)
    assert legacy == "archive/v1/tables/silver.trips/sto/r0/editions/" + "a" * 64 + ".c1.s1.parquet"
    key = table_copy_key("silver.trips", "sto", 0, "edition", "a" * 64 + ".v133", 1, 1)
    assert parse_copy_key(key).window_key == "a" * 64 + ".v133"
