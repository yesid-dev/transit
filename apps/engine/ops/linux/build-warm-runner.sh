#!/usr/bin/env bash
set -euo pipefail

# Run from the Git checkout. Publish only the bundle to the release directory.
commit=$1
bun=$2
output=$3
build=$(mktemp -d)
trap 'rm -rf -- "$build"' EXIT

git archive "$commit" .bun-version .npmrc bun.lock package.json patches \
  'apps/*/package.json' apps/web/scripts/warm-default-views.ts apps/web/src/lib |
  tar --extract --directory "$build" --no-same-owner --no-same-permissions

if [[ $("$bun" --version) != $(tr -d '\r\n' < "$build/.bun-version") ]]; then
  echo 'The warm runner build requires the Bun version pinned in .bun-version' >&2
  exit 1
fi
(
  cd "$build"
  "$bun" install --frozen-lockfile --filter @transit/web --ignore-scripts
  "$bun" build --target=bun apps/web/scripts/warm-default-views.ts --outfile warm-default-views.js
)
install -D -m 0644 "$build/warm-default-views.js" "$output"
