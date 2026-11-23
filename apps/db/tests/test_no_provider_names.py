"""Keep city-specific decisions in declarations, including for future cities."""

import re
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[3]
PROVIDERS = ROOT / "apps/db/config/providers"

# R5.6 removal: delete each entry with its public v1 compatibility path.
# Match complete source lines so these exceptions cannot cover a new branch.
LEGACY = {
    "apps/data-proxy/src/worker.js": (
        "Retired v1 public path for historic links.",
        (r'const RETIRED_STO_PREFIX = "/data/v1/sto/";',),
    ),
    "apps/web/src/routes/api/geocode/montreal/+server.ts": (
        "Old Montréal-only geocode URL forwards to the generic route.",
        (r"params\.set\('provider', 'stm'\);",),
    ),
    "apps/web/src/lib/v1/config.ts": (
        "Default for legacy snapshot URLs.",
        (r"const DEFAULT_PROVIDER = 'stm';",),
    ),
    "apps/web/src/lib/v1/providers.ts": (
        "Fallback for pre-catalogue v1 route gaps.",
        (
            r"// Mirrors lines_without_live_data in "
            r"apps/db/config/providers/\{stm,octranspo\}\.yaml",
            r"stm: \{ routeTypes: \[1\], gap: 'metro_realtime' \},",
            r"octranspo: \{ routeTypes: \[0\], gap: 'otrain_realtime' \},",
        ),
    ),
    "apps/web/src/lib/i18n/providerAttribution.ts": (
        "Translated attribution for legacy snapshots with a single published string.",
        (
            r"stm: 'Contient des données de la Société de transport de Montréal .*',",
            r"stm: 'Contains STM data made available under CC BY 4\.0\.',",
            r"octranspo:",
            r"octranspo: 'Contains information licensed under the Open Government Licence .*',",
        ),
    ),
    "apps/web/src/lib/features/network/reliability/network-reliability.copy.ts": (
        "Exclusion labels for the v1 snapshot Network view.",
        (
            r"stm: \{ en: 'Metro is excluded\.', fr: 'Le métro est exclu\.' \},",
            r"octranspo: \{ en: 'O-Train is excluded\.', fr: 'L’O-Train est exclu\.' \},",
        ),
    ),
    "apps/web/src/lib/features/metrics/easterWords.ts": (
        "Decorative terms used by the archived v1 metrics explainer.",
        (r"'(?:stm|octranspo|sto)',",),
    ),
}

LEGAL_COPY = (
    r"'To choose the initial transit network, [^']+',",
    r"'Transit is not affiliated with, [^']+',",
    r"'STM data is credited to [^']+',",
    r"'Pour choisir le réseau de transport initial, [^']+',",
    r"'Transit n’est ni affilié, [^']+',",
    r"'Les données de la STM sont attribuées à [^']+',",
)
EXCLUDED_PARTS = {"test", "tests", "__tests__", "fixtures", "__fixtures__"}
SOURCE_TYPES = {".py", ".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".tsx", ".jsx", ".svelte"}


def _agency_names(directory: Path) -> set[str]:
    names = set()
    for path in directory.glob("*.yaml"):
        config = yaml.safe_load(path.read_text(encoding="utf-8"))
        identity = config.get("provider", config)
        public = config.get("public", config)
        names.update(
            {
                path.stem,
                identity.get("name"),
                identity.get("display_name"),
                identity.get("short_name"),
                *(label.get("operator") for label in public.get("labels", {}).values()),
            }
            - {None, ""}
        )
    return names


def _name_pattern(names: set[str]) -> re.Pattern[str]:
    return re.compile(
        r"(?<!\w)(?:" + "|".join(re.escape(name) for name in sorted(names)) + r")(?!\w)",
        re.IGNORECASE,
    )


def _sources():
    for app in ("engine", "data-proxy", "web"):
        for path in (ROOT / "apps" / app / "src").rglob("*"):
            relative = path.relative_to(ROOT)
            if (
                path.suffix in SOURCE_TYPES
                and not EXCLUDED_PARTS.intersection(relative.parts)
                and not re.search(r"\.(?:test|spec|fixture|fixtures)\.", path.name)
            ):
                yield path
    yield from (ROOT / "apps/db/src/transit_ops").glob("clean_day*.py")


def test_product_uses_declarations_instead_of_provider_names():
    names = _agency_names(PROVIDERS)
    assert names, "No provider declarations found"
    provider_name = _name_pattern(names)
    violations = []
    for path in sorted(_sources()):
        name = path.relative_to(ROOT).as_posix()
        patterns = LEGACY.get(name, ("", ()))[1]
        if name == "apps/web/src/lib/features/legal/legal.copy.ts":
            patterns = LEGAL_COPY
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            if provider_name.search(line) and not any(
                re.fullmatch(pattern, line.strip()) for pattern in patterns
            ):
                violations.append(f"{name}:{number}: {line.strip()}")
    assert not violations, "Use a declaration capability instead of a provider name:\n" + "\n".join(
        violations
    )


def test_guard_knows_names_from_new_declarations(tmp_path):
    (tmp_path / "new_city.yaml").write_text(
        "name: Example Transit\nlabels: {en: {operator: Example Transit}}\n", encoding="utf-8"
    )
    pattern = _name_pattern(_agency_names(tmp_path))
    assert pattern.search("if city == 'new_city':")
    assert pattern.search("case 'EXAMPLE TRANSIT':")
    assert not pattern.search("const new_city_ids = [];")
