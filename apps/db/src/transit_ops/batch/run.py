"""Run one family against declared inputs and refuse undeclared outputs."""

import hashlib
from dataclasses import dataclass
from fnmatch import fnmatchcase
from pathlib import Path

from transit_ops.batch.build import BuildRequest, FamilyBuilder, FamilyOutput
from transit_ops.batch.engine import BatchEngineError, BatchInput, InputRefused, open_batch_session
from transit_ops.batch.inputs import resolve_inputs
from transit_ops.batch.manifest import BuildManifest, ManifestInput


class InputChanged(InputRefused):
    pass


class OutputRefused(BatchEngineError):
    pass


@dataclass(frozen=True)
class BuildResult:
    manifest: BuildManifest
    output: FamilyOutput


def _hash_inputs(
    inputs: tuple[BatchInput, ...], *, after_build: bool = False
) -> tuple[ManifestInput, ...]:
    result = []
    for item in inputs:
        for path in item.files:
            window = path.stem.replace("=", ":", 1)
            try:
                digest = hashlib.sha256()
                size = 0
                with path.open("rb") as stream:
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                        size += len(chunk)
            except OSError as error:
                refusal = InputChanged if after_build else InputRefused
                raise refusal(f"{item.relation} window {window}: {path}: {error}") from error
            result.append(ManifestInput(item.relation, window, digest.hexdigest(), size))
    return tuple(sorted(result))


def _patterns(patterns: tuple[str, ...]) -> tuple[tuple[str, ...], ...]:
    for pattern in patterns:
        if "**" in pattern or any(s in {"", ".."} for s in pattern.split("/")):
            raise OutputRefused(f"invalid published_keys pattern: {pattern}")
    return tuple(tuple(pattern.split("/")) for pattern in patterns)


def _check_output(
    builder: FamilyBuilder, output: FamilyOutput, patterns: tuple[tuple[str, ...], ...]
) -> None:
    if set(output.tables) != set(builder.tables):
        raise OutputRefused(
            f"declared tables {builder.tables}; returned tables {tuple(output.tables)}"
        )
    for key in output.bodies:
        segments = key.split("/")
        if "\\" in key or any(s in {"", ".", ".."} for s in segments):
            raise OutputRefused(f"invalid body key: {key}")
        if not any(
            len(segments) == len(pattern)
            and all(fnmatchcase(s, p) for s, p in zip(segments, pattern, strict=True))
            for pattern in patterns
        ):
            raise OutputRefused(f"undeclared body key: {key}")


def run_family(
    builder: FamilyBuilder,
    request: BuildRequest,
    *,
    inputs_root: Path,
    workdir: Path,
    code_commit: str,
) -> BuildResult:
    patterns = _patterns(builder.published_keys)
    inputs = resolve_inputs(builder.inputs(request), inputs_root)
    manifest = BuildManifest(
        family_id=builder.family_id,
        provider_id=request.provider_id,
        code_commit=code_commit,
        as_of_utc=request.as_of_utc,
        local_dates=request.local_dates,
        timezone=request.timezone,
        inputs=_hash_inputs(inputs),
    )
    with open_batch_session(inputs, workdir=workdir, variants=builder.variants) as session:
        output = builder.build(session, request)
        after = _hash_inputs(inputs, after_build=True)
        for before, current in zip(manifest.inputs, after, strict=True):
            if before != current:
                path = (
                    inputs_root
                    / before.relation
                    / (before.window.replace(":", "=", 1) + ".parquet")
                )
                raise InputChanged(f"{before.relation} window {before.window}: {path}")
        _check_output(builder, output, patterns)
    return BuildResult(manifest, output)
