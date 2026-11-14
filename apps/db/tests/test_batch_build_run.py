from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from hashlib import sha256
from pathlib import Path

import duckdb
import pytest
from sqlalchemy import text

from transit_ops.batch.build import BuildRequest, FamilyOutput, InputNeed, TableRows
from transit_ops.batch.engine import InputRefused
from transit_ops.batch.manifest import BuildManifest, ManifestInput
from transit_ops.batch.run import InputChanged, OutputRefused, run_family
from transit_ops.sql_registry import named_query

STAMP = datetime(2026, 11, 4, 12, tzinfo=UTC)
COMMIT = "abcdef0123456789abcdef0123456789abcdef01"


def test_manifest_identity_is_stable_and_input_sensitive():
    manifest = BuildManifest(
        family_id="toy",
        provider_id="test",
        code_commit=COMMIT,
        as_of_utc=STAMP,
        local_dates=(date(2026, 11, 3),),
        timezone="America/Toronto",
        fact_retention_days=14,
        open_window_days=10,
        inputs=(
            ManifestInput("gold.b", "all", "bbb", 2),
            ManifestInput("gold.a", "2026-11-03", "aaa", 1),
        ),
    )
    expected = (
        b'{"as_of_utc":"2026-11-04T12:00:00.000000Z","code_commit":"' + COMMIT.encode() + b'",'
        b'"engine":"duckdb","engine_version":"'
        + duckdb.__version__.encode()
        + b'","fact_retention_days":14,"family_id":"toy","inputs":['
        b'{"byte_size":1,"relation":"gold.a",'
        b'"sha256":"aaa","window":"2026-11-03"},{"byte_size":2,"relation":"gold.b",'
        b'"sha256":"bbb","window":"all"}],"local_dates":["2026-11-03"],'
        b'"open_window_days":10,"provider_id":"test","revision":2,"timezone":"America/Toronto"}'
    )
    same = replace(manifest, inputs=tuple(reversed(manifest.inputs)))
    assert manifest.canonical_json() == same.canonical_json() == expected
    assert manifest.build_id == same.build_id
    assert manifest.build_id == sha256(expected).hexdigest()
    assert (
        replace(
            manifest, inputs=(replace(manifest.inputs[0], sha256="ccc"), manifest.inputs[1])
        ).build_id
        != manifest.build_id
    )
    assert (
        replace(manifest, as_of_utc=manifest.as_of_utc + timedelta(microseconds=1)).build_id
        != manifest.build_id
    )
    assert replace(manifest, timezone="UTC").build_id != manifest.build_id


class ToyBuilder:
    family_id = "toy"
    tables = ("gold.toy_daily",)
    published_keys = ("historic/toy/*.json",)
    variants = {"toy.read": text("-- q:toy.read\nSELECT id FROM gold.source ORDER BY id")}

    def inputs(self, request):
        return (InputNeed("gold.source", "2026-11-03"), InputNeed("gold.source", "2026-11-02"))

    def build(self, session, request):
        rows = session.execute(named_query("toy.read", "SELECT missing FROM gold.source"))
        table = TableRows(self.tables[0], ("id",), ("id",), tuple(tuple(r) for r in rows))
        return FamilyOutput({table.relation: table}, {"historic/toy/day.json": b'{"id":7}'})


@pytest.fixture
def build_case(tmp_path):
    root = tmp_path / "inputs"
    folder = root / "gold.source"
    folder.mkdir(parents=True)
    for day, value in [("2026-11-02", 3), ("2026-11-03", 7)]:
        with duckdb.connect() as conn:
            conn.execute(
                f"COPY (SELECT {value} AS id) TO ? (FORMAT PARQUET)",
                [str(folder / f"{day}.parquet")],
            )
    request = BuildRequest("test", (date(2026, 11, 3),), STAMP, 14, 10, "America/Toronto")
    return request, dict(inputs_root=root, workdir=tmp_path / "work", code_commit=COMMIT)


def test_a_toy_builder_runs_end_to_end(build_case):
    request, kwargs = build_case
    result = run_family(ToyBuilder(), request, **kwargs)
    assert result.output.tables["gold.toy_daily"].rows == ((3,), (7,))
    assert result.output.bodies == {"historic/toy/day.json": b'{"id":7}'}
    assert result.manifest.timezone == request.timezone
    assert result.manifest.inputs == tuple(
        ManifestInput(
            "gold.source", day, sha256(path.read_bytes()).hexdigest(), path.stat().st_size
        )
        for day in ("2026-11-02", "2026-11-03")
        for path in [kwargs["inputs_root"] / "gold.source" / f"{day}.parquet"]
    )
    assert run_family(ToyBuilder(), request, **kwargs).manifest == result.manifest
    path = kwargs["inputs_root"] / "gold.source" / "2026-11-03.parquet"
    with duckdb.connect() as conn:
        conn.execute("COPY (SELECT 8 AS id) TO ? (FORMAT PARQUET)", [str(path)])
    changed = run_family(ToyBuilder(), request, **kwargs)
    assert changed.output.tables["gold.toy_daily"].rows == ((3,), (8,))
    assert changed.manifest.build_id != result.manifest.build_id


@pytest.mark.parametrize("case", ["extra", "missing", "outside", "nested", "case"])
def test_undeclared_outputs_are_refused(build_case, case):
    class BadBuilder(ToyBuilder):
        def build(self, session, request):
            output = super().build(session, request)
            tables, bodies = dict(output.tables), dict(output.bodies)
            if case == "extra":
                tables["gold.other"] = TableRows("gold.other", ("id",), ("id",), ())
            elif case == "missing":
                tables.clear()
            else:
                key = {
                    "outside": "other/day.json",
                    "nested": "historic/toy/sub/day.json",
                    "case": "Historic/toy/day.json",
                }[case]
                bodies[key] = b"{}"
            return FamilyOutput(tables, bodies)

    request, kwargs = build_case
    with pytest.raises(OutputRefused, match="gold.other|gold.toy_daily|other/day|sub/day|Historic"):
        run_family(BadBuilder(), request, **kwargs)


@pytest.mark.parametrize(
    "pattern", ["historic/**/day.json", "/toy/*.json", "historic//*.json", "historic/../*.json"]
)
def test_invalid_patterns_are_refused_by_name(build_case, pattern):
    builder = ToyBuilder()
    builder.published_keys = (pattern,)
    request, kwargs = build_case
    with pytest.raises(OutputRefused) as error:
        run_family(builder, request, **kwargs)
    assert pattern in str(error.value)


@pytest.mark.parametrize(
    "key", ["historic\\toy\\a.json", "historic//a.json", "historic/./a.json", "historic/../a.json"]
)
def test_invalid_body_keys_are_refused_by_name(build_case, key):
    class BadKey(ToyBuilder):
        def build(self, session, request):
            return FamilyOutput({}, {key: b"{}"})

    builder = BadKey()
    builder.tables = ()
    request, kwargs = build_case
    with pytest.raises(OutputRefused) as error:
        run_family(builder, request, **kwargs)
    assert key in str(error.value)


@pytest.mark.parametrize(
    "mutation, when",
    [
        ("same_size", "after"),
        ("append", "after"),
        ("delete", "after"),
        ("delete", "before_session"),
        ("delete", "before_query"),
        ("truncate", "before_query"),
        ("truncate", "entry"),
    ],
)
def test_changed_inputs_are_refused_after_build(build_case, mutation, when, monkeypatch):
    import transit_ops.batch.run as runner

    request, kwargs = build_case
    path = kwargs["inputs_root"] / "gold.source" / "2026-11-02.parquet"
    monkeypatch.chdir(kwargs["inputs_root"].parent)
    kwargs["inputs_root"] = Path("inputs")

    def mutate():
        if mutation == "delete":
            path.unlink()
        else:
            data = path.read_bytes()
            changed = bytes([data[0] ^ 1]) + data[1:] if mutation == "same_size" else data + b"x"
            path.write_bytes(data[:-10] if mutation == "truncate" else changed)

    opener = runner.open_batch_session

    def opening(*args, **options):
        if when == "before_session":
            mutate()
        return opener(*args, **options)

    monkeypatch.setattr(runner, "open_batch_session", opening)
    if when == "entry":
        mutate()

    class ChangingBuilder(ToyBuilder):
        def build(self, session, request):
            if when == "before_query":
                mutate()
            output = super().build(session, request)
            if when == "after":
                mutate()
            return output

    with pytest.raises(InputRefused if when == "entry" else InputChanged) as error:
        run_family(ChangingBuilder(), request, **kwargs)
    assert all(label in str(error.value) for label in ("gold.source", "2026-11-02", str(path)))
    assert not list(kwargs["workdir"].iterdir())
    if when in {"before_session", "before_query"}:
        assert error.value.__cause__ is not None
        assert isinstance(
            error.value.__cause__, InputRefused if when == "before_session" else duckdb.Error
        )
    if when == "entry":
        assert isinstance(error.value.__cause__, duckdb.Error)


def test_overlapping_builds_keep_staged_rows_private(build_case):
    request, kwargs = build_case
    areas = {}

    class Staged(ToyBuilder):
        def __init__(self, day):
            self.day = day

        def inputs(self, request):
            return (InputNeed("gold.source", self.day),)

        def build(self, session, request):
            area = Path(
                session.execute(
                    text("-- q:toy.area\nSELECT current_setting('temp_directory')")
                ).scalar_one()
            ).parent
            path = str(area / "stage.parquet")
            areas[self.day] = area
            session.execute(
                text("-- q:toy.copy\nCOPY gold.source TO :p (FORMAT PARQUET)"), {"p": path}
            )
            if self.day == "2026-11-02":
                inner = run_family(Staged("2026-11-03"), request, **kwargs)
                assert inner.output.tables[self.tables[0]].rows == ((7,),)
                assert area.is_dir()
            else:
                with pytest.raises(duckdb.PermissionException):
                    session.execute(
                        text("-- q:toy.private\nSELECT * FROM read_parquet(:p)"),
                        {"p": str(areas["2026-11-02"] / "stage.parquet")},
                    )
            rows = session.execute(
                text("-- q:toy.staged\nSELECT id FROM read_parquet(:p)"), {"p": path}
            )
            table = TableRows(self.tables[0], ("id",), ("id",), tuple(tuple(r) for r in rows))
            return FamilyOutput({table.relation: table}, {})

    assert run_family(Staged("2026-11-02"), request, **kwargs).output.tables[
        "gold.toy_daily"
    ].rows == ((3,),)
    assert not areas["2026-11-03"].exists()
    assert not list(kwargs["workdir"].iterdir())


@pytest.mark.parametrize("case", ["plain", "sql"])
def test_unchanged_inputs_preserve_builder_errors_and_clean_up(build_case, case):
    request, kwargs = build_case
    failure = ValueError("builder failed")

    class Failing(ToyBuilder):
        def build(self, session, request):
            if case == "sql":
                session.execute(text("-- q:toy.bad\nSELECT absent FROM gold.source"))
            raise failure

    with pytest.raises(duckdb.Error if case == "sql" else ValueError) as error:
        run_family(Failing(), request, **kwargs)
    if case == "plain":
        assert error.value is failure
    assert error.value.__cause__ is None
    assert not list(kwargs["workdir"].iterdir())
    assert run_family(ToyBuilder(), request, **kwargs).output.tables["gold.toy_daily"].rows == (
        (3,),
        (7,),
    )
    assert not list(kwargs["workdir"].iterdir())


@pytest.mark.parametrize("field", ["fact_retention_days", "open_window_days"])
def test_request_settings_change_identity(build_case, field):
    request, kwargs = build_case
    result = run_family(ToyBuilder(), request, **kwargs)
    altered = replace(request, **{field: getattr(request, field) + 1})
    assert run_family(ToyBuilder(), altered, **kwargs).manifest.build_id != result.manifest.build_id


@pytest.mark.parametrize("commit", [None, "", "HEAD", "abc", "A" * 40, "g" * 40, "a" * 41])
def test_code_commit_requires_full_lowercase_hex(build_case, commit):
    request, kwargs = build_case
    kwargs["code_commit"] = commit
    with pytest.raises(ValueError, match="code_commit"):
        run_family(ToyBuilder(), request, **kwargs)


def test_public_key_matching():
    from transit_ops.batch.run import key_matches

    assert key_matches("historic/toy/day.json", ("historic/toy/*.json",))
    assert not key_matches("historic/toy/sub/day.json", ("historic/toy/*.json",))
    assert not key_matches("Historic/toy/day.json", ("historic/toy/*.json",))
