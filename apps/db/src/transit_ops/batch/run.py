"""Run one family against declared inputs and refuse undeclared outputs."""

import hashlib
from dataclasses import dataclass, fields
from fnmatch import fnmatchcase
from pathlib import Path

from transit_ops.batch.build import BuildRequest, FamilyBuilder, FamilyOutput, InputNeed
from transit_ops.batch.engine import (
    BatchEngineError,
    InputRefused,
    ParquetInputRefused,
    open_batch_session,
)
from transit_ops.batch.inputs import resolve_inputs
from transit_ops.batch.manifest import BuildManifest, ManifestInput
from transit_ops.batch.private_area import private_area


class InputChanged(InputRefused):
    pass


class OutputRefused(BatchEngineError):
    pass


@dataclass(frozen=True)
class BuildResult:
    manifest: BuildManifest
    output: FamilyOutput


def _hash_inputs(
    inputs: dict[Path, InputNeed], *, after_build: bool = False
) -> dict[Path, ManifestInput]:
    result = {}
    for path, need in inputs.items():
        try:
            digest = hashlib.sha256()
            size = 0
            with path.open("rb") as stream:
                while chunk := stream.read(1024 * 1024):
                    digest.update(chunk)
                    size += len(chunk)
        except OSError as error:
            refusal = InputChanged if after_build else InputRefused
            raise refusal(f"{need.relation} window {need.window}: {path}: {error}") from error
        result[path] = ManifestInput(need.relation, need.window, digest.hexdigest(), size)
    return result


def _check_inputs(captured: dict[Path, InputNeed], before: dict[Path, ManifestInput]) -> None:
    after = _hash_inputs(captured, after_build=True)
    for path, previous in before.items():
        if previous != after[path]:
            raise InputChanged(f"{previous.relation} window {previous.window}: {path}")


def _refuse_invalid_input(error: Exception, captured: dict[Path, InputNeed]) -> None:
    if isinstance(error, ParquetInputRefused):
        need = captured[error.path]
        raise InputRefused(
            f"{need.relation} window {need.window}: {error.path}"
        ) from error.__cause__


def _patterns(patterns: tuple[str, ...]) -> tuple[tuple[str, ...], ...]:
    for pattern in patterns:
        if "**" in pattern or any(s in {"", ".."} for s in pattern.split("/")):
            raise OutputRefused(f"invalid published_keys pattern: {pattern}")
    return tuple(tuple(pattern.split("/")) for pattern in patterns)


def key_matches(key: str, patterns: tuple[str, ...]) -> bool:
    """Case-sensitive glob matching within equal numbers of slash-separated segments."""
    parsed = _patterns(patterns)
    segments = key.split("/")
    if "\\" in key or any(s in {"", ".", ".."} for s in segments):
        raise OutputRefused(f"invalid body key: {key}")
    return any(
        len(segments) == len(pattern)
        and all(fnmatchcase(s, p) for s, p in zip(segments, pattern, strict=True))
        for pattern in parsed
    )


def _check_output(builder: FamilyBuilder, output: FamilyOutput) -> None:
    if set(output.tables) != set(builder.tables):
        raise OutputRefused(
            f"declared tables {builder.tables}; returned tables {tuple(output.tables)}"
        )
    for key in output.bodies:
        if not key_matches(key, builder.published_keys):
            raise OutputRefused(f"undeclared body key: {key}")


def run_family(
    builder: FamilyBuilder,
    request: BuildRequest,
    *,
    inputs_root: Path,
    workdir: Path,
    code_commit: str,
) -> BuildResult:
    _patterns(builder.published_keys)
    needs = sorted(builder.inputs(request), key=lambda need: (need.relation, need.window))
    inputs = resolve_inputs(needs, inputs_root)
    captured = {resolve_inputs((need,), inputs_root)[0].files[0]: need for need in needs}
    if captured.keys() != {path for item in inputs for path in item.files}:
        raise InputRefused("resolved input keys differ from declared needs")
    before = _hash_inputs(captured)
    manifest = BuildManifest(
        **{field.name: getattr(request, field.name) for field in fields(BuildRequest)},
        family_id=builder.family_id,
        code_commit=code_commit,
        inputs=tuple(before.values()),
    )
    with private_area(workdir) as area:
        opened = False
        try:
            with open_batch_session(inputs, workdir=area, variants=builder.variants) as session:
                opened = True
                output = builder.build(session, request)
        except Exception as error:
            try:
                _check_inputs(captured, before)
            except InputChanged as changed:
                raise changed from error
            if not opened:
                _refuse_invalid_input(error, captured)
            raise
        _check_inputs(captured, before)
        _check_output(builder, output)
    return BuildResult(manifest, output)
