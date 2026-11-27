#!/usr/bin/env bash
set -euo pipefail

# Keep the private cleaner's 32 GiB reserve with room for the measured STM spill.
reserve_mib=$((32 * 1024))
scratch_mib=4608
minimum_free_bytes=$(((reserve_mib + scratch_mib) * 1024**2))
if [[ $(df -PB1 "$STATE_DIRECTORY" | awk 'NR == 2 { print $4 }') -lt $minimum_free_bytes ]]; then
  echo 'Need 36.5 GiB free in /var/lib to leave room above the 32 GiB reserve' >&2
  exit 1
fi

app_dir=$(pwd -P)
release=$(cd ../.. && pwd -P)
export HOME="$release/duckdb-home"
export PYTHONPATH="$app_dir/src"
export TMPDIR="$STATE_DIRECTORY"
export TRANSIT_CLEAN_BUILDER_COMMIT
TRANSIT_CLEAN_BUILDER_COMMIT=$(< "$release/.revision")
exec "$app_dir/.venv/bin/python" -m transit_ops.clean_days_plan --run-scheduled
