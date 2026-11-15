import base64
import hashlib
import json
import zlib
from contextlib import nullcontext
from datetime import UTC, date, datetime

import pytest
from typer.testing import CliRunner

from transit_ops.batch.build import BuildRequest
from transit_ops.batch.editions import current_edition_for_days, with_editions

DAYS = (date(2026, 11, 1), date(2026, 11, 2))
REQUEST = BuildRequest("sample", DAYS, datetime(2026, 11, 3, 7, tzinfo=UTC), 30, 7, "UTC")


def test_current_maps_all_days_and_ignores_other_kinds():
    rows = [(7, "static_schedule", False), (8, "static_schedule", True), (9, "other", True)]
    assert current_edition_for_days(rows, DAYS) == dict.fromkeys(DAYS, 8)


@pytest.mark.parametrize(
    "rows",
    [
        [],
        [(7, "static_schedule", False)],
        [(7, "static_schedule", True), (8, "static_schedule", True)],
    ],
)
def test_unresolved_current_refuses(rows):
    with pytest.raises(ValueError, match="edition_unresolved"):
        current_edition_for_days(rows, DAYS)


def test_edition_request_is_labelled():
    wired = with_editions(
        REQUEST, ("cancellations_service_states",), [(8, "static_schedule", True)]
    )
    assert wired.edition_by_day == dict.fromkeys(DAYS, 8)
    assert wired.edition_source == "current_at_build"


# Captured on main f5d6c5da with code_commit="a" * 40 (review bytes_probe.py).
MAIN_MANIFEST = (
    b'{"as_of_utc":"2026-11-04T12:00:00.123456Z","code_commit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    b'aaaaaaaaaa","engine":"duckdb","engine_version":"2.0.0","fact_retention_days":14,"family_'
    b'id":"occupancy_crowding","inputs":[{"byte_size":392,"relation":"core.providers","sha256"'
    b':"00f3cf2767b21b39030bcd59da6cc7f5aa20c82cadc84122a086f18af8cd813d","window":"all"},{"by'
    b'te_size":1707,"relation":"gold.fact_trip_delay_snapshot","sha256":"ed4daf8e01ae5d00f1281'
    b'b759a97f8cddd072247a357c84944db567b0f9142cb","window":"2026-11-01"},{"byte_size":1158,"r'
    b'elation":"gold.fact_trip_delay_snapshot","sha256":"5be5d1b2c09d35f8dcbad423717c3fbf9ad8d'
    b'eb91bea189fe86ca56aa34f356a","window":"2026-11-02"},{"byte_size":304,"relation":"gold.fa'
    b'ct_vehicle_snapshot","sha256":"ddac13a07fb86f234366073ecc2efdbac1ec9f81863d84faaba4bdd8e'
    b'b80aa57","window":"2026-10-31"},{"byte_size":1707,"relation":"gold.fact_vehicle_snapshot'
    b'","sha256":"ed4daf8e01ae5d00f1281b759a97f8cddd072247a357c84944db567b0f9142cb","window":"'
    b'2026-11-01"},{"byte_size":1158,"relation":"gold.fact_vehicle_snapshot","sha256":"5be5d1b'
    b'2c09d35f8dcbad423717c3fbf9ad8deb91bea189fe86ca56aa34f356a","window":"2026-11-02"},{"byte'
    b'_size":304,"relation":"gold.fact_vehicle_snapshot","sha256":"2d3a5c95c3232c630506d719b4c'
    b'ddfdad3ef94f1ff20dd5545f755813044bbc6","window":"2026-11-03"},{"byte_size":304,"relation'
    b'":"gold.fact_vehicle_snapshot","sha256":"ddac13a07fb86f234366073ecc2efdbac1ec9f81863d84f'
    b'aaba4bdd8eb80aa57","window":"2026-11-04"}],"local_dates":["2026-11-01"],"open_window_day'
    b's":10,"provider_id":"seed","revision":2,"timezone":"America/Toronto"}'
)
MAIN_BUILD_ID = "bf835f2db2b0b1af01b88fb2d903b24eb80317a0d6be95bb12b5173b06d8bcbb"
MAIN_TABLE_DIGESTS = {
    "gold.route_delay_by_crowding_daily": (
        "9a01f39d592eb19361dedec6b5cf47e6a9a6c1b3a39ff802ffbdec4bded1cb50"
    ),
    "gold.route_occupancy_band_daily": (
        "b22cf9fcea3b27684858c0d605a9e29e844c2d395540ab7675d3777fc0c746c3"
    ),
    "gold.route_occupancy_band_hourly": (
        "388d4ceef4f37f11c91713979ae8a001cfc6c3eba494c2cee648ad65685a050f"
    ),
    "gold.stop_occupancy_band_daily": (
        "aa30131ad0d795f942f95d85dfdfea9fd0a0578f12cfe5b7ca8938f865af99f9"
    ),
}
MAIN_OUTPUTS_SHA256 = "4ca29b0f0f14ae7e3d9d36f4f9235de01cd29e2b4913fde8b82eaefe3f9d5d64"
MAIN_INPUTS = {
    "core.providers/all.parquet": (
        "eJyFUcFKw0AQfV1CCVipRWfJQg65NEQJtVbrxSBUeujBQxHvpcmuuGiysmlz6NEvd7WgrR6EYZh5M7z3mJlPHi4I"
        "dEQnKTFXtKkN+KEHoFZKOiSms53R8azrRpNSWV0szx+NNdXKEBPZGMGhXBcvMl/UxbMql+SBOn0EB2/WNFoqu9Cy"
        "jy3mr3SpNqZSDuBMhCKNEVJHEMTePjHO+Ihfx34WeJ9+tpkj2el6PYjQ+QMxZ+2H6Fvki2XG7+PbLOj+sv4HcNz/"
        "7uwr8g1nsc/fW0iSqbvA9C5qlK21qaJmNBgOhlGSr/WrjOT4qshzdSmfTkUaAi5w0wLm7gcf+OtX6A=="
    ),
    "gold.fact_trip_delay_snapshot/2026-11-01.parquet": (
        "eJy9Vc9rG1cQnnl+kp8d2ZVSv9e3ZROWGC9bMKnixCUEH6xiSiCCGBty8CGKtLvGamxLSCtBoNAeQijGh0Kgh1IK"
        "vaQN9C8oPZQmh1BoG3ruOQSHtO61h7rzdrXpRtYphyx6P2Z2vm/mzbxZrVbWzkkui3KmKpkEAGFzmrthGEiQeTk5"
        "LzW9z8s8wJhADaR9iDIwakjUDWfW4LDyL/QRikhC5VIOcGGG0fbBfbRgA3OnZp0cie1Os9UhwpNSVWkhzYRjEOs0"
        "DPfnKBcyLq+k3J2EW0AF+7OJ6T2Um5kw1mPTaaychjsIq4Z0jIY5jXFsYslP8XnIPAT9CuV2huRqSvK28Vc4ogfP"
        "fIQDvOE6/PvoqDSdcP9F+8mE50eU32GG6EYVP5heK9fywA6+9s7RCuWwmhOi77Vp/uHZ3ZwoPC4X30WncOPjDxdQ"
        "FPiblfO0fHvvrQsoRPXSnzlx8fCXh4uEPfqNLGlNK8WTSj33FvEbGuR0Uk5n0pYrogKGry+uZdsGSAcUTXI/gcHO"
        "AVhOkmckk8shc7J0qLLmPWVZFOGygRrMMmFhZcj8clK82zy2BSYSB7QVnBG9ZNaXi6Cngp5/M2jUuv5WuFOXRZCF"
        "OdAn2p1WvxmEnVozmAOjY1p0Wr0ozCjGu1GrPZAZycWW7/fa9V3/Vq0b1aNed+5M8mIqCLfrpAz91m4Qazn5eMOv"
        "t6NeJwxq9ajWi/y5mep+yU5uHsFAl7q79XZ3qxXVgjo5vhneSqEnN6nxalFzJyRHO+1htNKWbe27YMuCJbn10mkk"
        "U1qtqQ33PVfYmpsOTmYFimXlUgmseXOFJDM3l9Oi9ifkdYABMVj/pyRmfYrqU3QbS5o9uO8yj2YNhsWWELO8QFJI"
        "ae5i4BNUd9D9grkHaGtcd4XitCTg4RAOXoTA4hCOJT1m/BnVHrqHbElzurqgeZwW5mWk45ElhC8XK2b7CdVn6P4z"
        "RmympzU3Ha24l5GOs/GYbbjI6Xl/R3cvt6QFDFpEi7RJFHgjtCOjpTwevyOxh2vqurs37v6RpxKb9tfcfACoxDwr"
        "j8rvo8k0v8kBRly1zBm+H3/lM6hfTyhNpb49AZ63Qk248r7TDzvdZmvX6S+cLZ8tO16j19wOnGDxgt9ohOeDzXes"
        "fdPeo37wmD61q/Q39R8GuTcC"
    ),
    "gold.fact_trip_delay_snapshot/2026-11-02.parquet": (
        "eJydVM1u00AQHm9MsKgLSZVd2ciHCBHLoChqC6lQZVUC5cih4gUsx7tVozax5Z9I5Rly4F7EvRIPwIlLH4E34M6F"
        "F4BZu4ndJOaAZY935tP37ezM2KdvPxxQoC3a6VOCiyZtAmiWCgCJEBwjjD6tQDsOQYgoClofgwa1KqjeL1Bpb28w"
        "2qFGBX70vIAfoK0FW49zcD2jPz+u1ZHXlJBG9Qqk6r+cofIvBjE/D8HY5VlwwcdeEpyLqU9bQPUeGDtRHM4nXMTe"
        "hPdAxoihxWGWikrgYZKG0Z1P0G+FQZBF/iy48pLUT7Ok96wAdrm49DEognDG86iKezwJ/CjNYsE9P/WyNOh13i/a"
        "Vh/khTQw2snMj5LzMPW4jxtfiKslde8Mm+Clk6nAjabROpsR0zIXNlhUNymY905DCSPskB3ZmmuospeFZeBUvHYb"
        "TIvKosril0KrEuQqb5hrn7iG4uON/Pxdx1zWKicesxP7o2uQ2xv5IPVutUkmOXmjsLnKETu2vyl4Cjk3hZWnKL06"
        "ufvtWGn9llpyzAortUpvU0vNtdabuCrvV+Ia2nLWyhWqbonWZbo5Abn+Szawf6K+Kke8sDLb0qvLdsvcrBL+1Pjv"
        "hNmXBiO2xr43wHFG+D2N3nXnIk4m4aw7PxzsD/a7zjibXPIuH74OxmPxip+9MBcWwNYbrhsAp/gH+gsRBddf"
    ),
    "gold.fact_vehicle_snapshot/2026-10-31.parquet": (
        "eJxtkOFKAkEQx8dDKEhJowsP/HBIByeEWOkDFH7sg/QCy97OiIve7bI7e+A7+Ag9bJsWRDTMl/9v+DHMrF/eH9Mk"
        "+1jCqI9B7bASXm2plukA0l6RjK6sM61GckJjAWd26Uxg+gUuPBv7nZOYB0apYGWjDsKz5OCLyXnQR9rLCEmZBk+0"
        "G+m1kpaDIxSSRWBV3L4dh+MH+KqTNvSNtH5rWKCMi3d0+FFvNhQ11jXFRbX9a99B1ivLVTxs9Zq35Lw2Td4+zeaz"
        "eV5WQe8xx+VCVRU942aaHccA/zbcdwDW8VefJ81Krg=="
    ),
    "gold.fact_vehicle_snapshot/2026-11-01.parquet": (
        "eJy9Vc9rG1cQnnl+kp8d2ZVSv9e3ZROWGC9bMKnixCUEH6xiSiCCGBty8CGKtLvGamxLSCtBoNAeQijGh0Kgh1IK"
        "vaQN9C8oPZQmh1BoG3ruOQSHtO61h7rzdrXpRtYphyx6P2Z2vm/mzbxZrVbWzkkui3KmKpkEAGFzmrthGEiQeTk5"
        "LzW9z8s8wJhADaR9iDIwakjUDWfW4LDyL/QRikhC5VIOcGGG0fbBfbRgA3OnZp0cie1Os9UhwpNSVWkhzYRjEOs0"
        "DPfnKBcyLq+k3J2EW0AF+7OJ6T2Um5kw1mPTaaychjsIq4Z0jIY5jXFsYslP8XnIPAT9CuV2huRqSvK28Vc4ogfP"
        "fIQDvOE6/PvoqDSdcP9F+8mE50eU32GG6EYVP5heK9fywA6+9s7RCuWwmhOi77Vp/uHZ3ZwoPC4X30WncOPjDxdQ"
        "FPiblfO0fHvvrQsoRPXSnzlx8fCXh4uEPfqNLGlNK8WTSj33FvEbGuR0Uk5n0pYrogKGry+uZdsGSAcUTXI/gcHO"
        "AVhOkmckk8shc7J0qLLmPWVZFOGygRrMMmFhZcj8clK82zy2BSYSB7QVnBG9ZNaXi6Cngp5/M2jUuv5WuFOXRZCF"
        "OdAn2p1WvxmEnVozmAOjY1p0Wr0ozCjGu1GrPZAZycWW7/fa9V3/Vq0b1aNed+5M8mIqCLfrpAz91m4Qazn5eMOv"
        "t6NeJwxq9ajWi/y5mep+yU5uHsFAl7q79XZ3qxXVgjo5vhneSqEnN6nxalFzJyRHO+1htNKWbe27YMuCJbn10mkk"
        "U1qtqQ33PVfYmpsOTmYFimXlUgmseXOFJDM3l9Oi9ifkdYABMVj/pyRmfYrqU3QbS5o9uO8yj2YNhsWWELO8QFJI"
        "ae5i4BNUd9D9grkHaGtcd4XitCTg4RAOXoTA4hCOJT1m/BnVHrqHbElzurqgeZwW5mWk45ElhC8XK2b7CdVn6P4z"
        "RmympzU3Ha24l5GOs/GYbbjI6Xl/R3cvt6QFDFpEi7RJFHgjtCOjpTwevyOxh2vqurs37v6RpxKb9tfcfACoxDwr"
        "j8rvo8k0v8kBRly1zBm+H3/lM6hfTyhNpb49AZ63Qk248r7TDzvdZmvX6S+cLZ8tO16j19wOnGDxgt9ohOeDzXes"
        "fdPeo37wmD61q/Q39R8GuTcC"
    ),
    "gold.fact_vehicle_snapshot/2026-11-02.parquet": (
        "eJydVM1u00AQHm9MsKgLSZVd2ciHCBHLoChqC6lQZVUC5cih4gUsx7tVozax5Z9I5Rly4F7EvRIPwIlLH4E34M6F"
        "F4BZu4ndJOaAZY935tP37ezM2KdvPxxQoC3a6VOCiyZtAmiWCgCJEBwjjD6tQDsOQYgoClofgwa1KqjeL1Bpb28w"
        "2qFGBX70vIAfoK0FW49zcD2jPz+u1ZHXlJBG9Qqk6r+cofIvBjE/D8HY5VlwwcdeEpyLqU9bQPUeGDtRHM4nXMTe"
        "hPdAxoihxWGWikrgYZKG0Z1P0G+FQZBF/iy48pLUT7Ok96wAdrm49DEognDG86iKezwJ/CjNYsE9P/WyNOh13i/a"
        "Vh/khTQw2snMj5LzMPW4jxtfiKslde8Mm+Clk6nAjabROpsR0zIXNlhUNymY905DCSPskB3ZmmuospeFZeBUvHYb"
        "TIvKosril0KrEuQqb5hrn7iG4uON/Pxdx1zWKicesxP7o2uQ2xv5IPVutUkmOXmjsLnKETu2vyl4Cjk3hZWnKL06"
        "ufvtWGn9llpyzAortUpvU0vNtdabuCrvV+Ia2nLWyhWqbonWZbo5Abn+Szawf6K+Kke8sDLb0qvLdsvcrBL+1Pjv"
        "hNmXBiO2xr43wHFG+D2N3nXnIk4m4aw7PxzsD/a7zjibXPIuH74OxmPxip+9MBcWwNYbrhsAp/gH+gsRBddf"
    ),
    "gold.fact_vehicle_snapshot/2026-11-03.parquet": (
        "eJxtkNtqwkAQhqdBaKFKtTSSgBdBGkihiD34ABYveyF9gWWzM+KiyS67swHfwUfow3btAUrpMDfzDR8/M+vl20Oa"
        "5O8LyAYY1A5r4dWWGpkOIe2XkF1aZzqN5ITGEk4syS6cCUy/wLlnY7/nJM5Do1SwslUH4Vly8OX0azFA2ssISZkW"
        "P2kvZlwpaTk4QiFZBFblzetxNLmHU0UNspFvpfVbwwJlDN7R4Ue93lDUWDcUgxr71x5D3q+qVTxs9VJ05Lw2bdE9"
        "zuazeVHVQe+xwMWzqmt6ws1dfpwA/Ntwewawjr/6ACJVSqY="
    ),
    "gold.fact_vehicle_snapshot/2026-11-04.parquet": (
        "eJxtkOFKAkEQx8dDKEhJowsP/HBIByeEWOkDFH7sg/QCy97OiIve7bI7e+A7+Ag9bJsWRDTMl/9v+DHMrF/eH9Mk"
        "+1jCqI9B7bASXm2plukA0l6RjK6sM61GckJjAWd26Uxg+gUuPBv7nZOYB0apYGWjDsKz5OCLyXnQR9rLCEmZBk+0"
        "G+m1kpaDIxSSRWBV3L4dh+MH+KqTNvSNtH5rWKCMi3d0+FFvNhQ11jXFRbX9a99B1ivLVTxs9Zq35Lw2Td4+zeaz"
        "eV5WQe8xx+VCVRU942aaHccA/zbcdwDW8VefJ81Krg=="
    ),
}


@pytest.mark.parametrize("mixed", [False, True])
def test_non_edition_public_shadow_reproduces_main_bytes(tmp_path, monkeypatch, mixed):
    from transit_ops.batch.build import FamilyOutput
    from transit_ops.batch.families import registry
    from transit_ops.commands import batch
    from transit_ops.db import connection

    inputs = tmp_path / "inputs"
    for name, encoded in MAIN_INPUTS.items():
        path = inputs / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(zlib.decompress(base64.b64decode(encoded)))
    monkeypatch.setattr(batch, "_code_commit", lambda: "a" * 40)
    observed = []

    class Cancellation:
        family_id = "cancellations_service_states"
        tables = ()
        published_keys = ()
        variants = {}

        def inputs(self, request):
            assert request.edition_by_day == {date(2026, 11, 1): 7}
            assert request.edition_source == "current_at_build"
            observed.append("inputs")
            return ()

        def build(self, session, request):
            assert request.edition_by_day == {date(2026, 11, 1): 7}
            assert request.edition_source == "current_at_build"
            observed.append("build")
            return FamilyOutput({}, {})

    class Connection:
        def begin(self):
            return nullcontext()

        def execute(self, sql, *args):
            if str(sql) == "SET TRANSACTION READ ONLY":
                observed.append("read_only")
                return ()
            assert "read_only" in observed
            return [(7, "static_schedule", True)]

    class Engine:
        def connect(self):
            return nullcontext(Connection())

        def dispose(self):
            pass

    def unexpected_database(*args, **kwargs):
        pytest.fail("non-edition shadow must not query PostgreSQL")

    monkeypatch.setattr(
        connection, "make_engine", (lambda *a: Engine()) if mixed else unexpected_database
    )
    resolve = registry.resolve_builder
    if mixed:
        monkeypatch.setattr(
            registry,
            "resolve_builder",
            lambda name: Cancellation() if name == Cancellation.family_id else resolve(name),
        )
    monkeypatch.setenv("BRONZE_STORAGE_BACKEND", "local")
    (tmp_path / "objects").mkdir()
    monkeypatch.setenv("BRONZE_LOCAL_ROOT", str(tmp_path / "objects"))
    monkeypatch.setenv("GOLD_FACT_RETENTION_DAYS", "14")
    monkeypatch.setenv("GOLD_REPORTING_OPEN_WINDOW_DAYS", "10")
    args = [
        "shadow-build",
        "--provider",
        "seed",
        "--date",
        "2026-11-01",
        "--as-of",
        "2026-11-04T12:00:00.123456Z",
        "--inputs",
        str(inputs),
        "--workdir",
        str(tmp_path / "work"),
        "--family",
        "occupancy_crowding",
    ]
    if mixed:
        args += ["--family", "cancellations_service_states"]
    response = CliRunner().invoke(batch.app, args)
    assert response.exit_code == 0, response.output + str(response.exception)
    checkpoint = next(
        (tmp_path / "work" / "checkpoints" / "occupancy_crowding").rglob("manifest.json")
    )
    assert checkpoint.read_bytes() == MAIN_MANIFEST
    assert checkpoint.parent.name == MAIN_BUILD_ID
    output_bytes = checkpoint.with_name("outputs.json").read_bytes()
    assert hashlib.sha256(output_bytes).hexdigest() == MAIN_OUTPUTS_SHA256
    assert {
        name: table["sha256"] for name, table in json.loads(output_bytes)["tables"].items()
    } == MAIN_TABLE_DIGESTS
    if mixed:
        assert "inputs" in observed and "build" in observed
