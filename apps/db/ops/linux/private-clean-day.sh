#!/usr/bin/env bash
set -euo pipefail
umask 022
if [[ $# != 4 || $EUID != 0 || $(uname -s) != Linux ]]; then
  echo 'On the Linux VM, from the repo: sudo bash private-clean-day.sh <full SHA> <city> <date> <MemoryMax>' >&2
  exit 2
fi
sha=$1 city=$2 day=$3 cap=$4
[[ $sha =~ ^[0-9a-f]{40}$ && $city =~ ^[a-z0-9][a-z0-9_-]{0,63}$ && $day =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]
[[ $sha == "$(git rev-parse --verify --end-of-options "$sha^{commit}")" ]]
[[ $cap =~ ^[1-9][0-9]*[MG]$ ]]
check_space() { [[ $(df -PB1 /var/lib | awk 'NR == 2 { print $4 }') -ge $((33 * 1024**3)) ]]; }
check_space || { echo 'Need 33 GiB free in /var/lib to leave room above the 32 GiB reserve' >&2; exit 1; }

root=/opt/transit-live
release=$(mktemp -d "$root/releases/private-${sha:0:12}.XXXXXX")
git archive "$sha" .python-version apps/db | tar -x --no-same-owner -C "$release"
UV_PYTHON_INSTALL_DIR="$root/python" UV_LINK_MODE=copy /opt/transit-engine/bin/uv sync \
  --directory "$release/apps/db" --managed-python --locked --no-dev --no-editable
HOME="$release/duckdb-home" "$release/apps/db/.venv/bin/python" \
  -c 'import duckdb; duckdb.connect().install_extension("icu")'
chmod -R a+rX "$release/duckdb-home"
chmod 0755 "$release"
check_space || { echo 'Release preparation left less than 33 GiB free in /var/lib' >&2; exit 1; }
unit=transit-private-clean-${release##*.}
printf 'Verified revision %s\nPrivate local result /var/lib/private/%s\n' "$sha" "$unit"
systemd-run --pipe --wait --collect --expand-environment=no --unit="$unit" \
  -p EnvironmentFile=/etc/transit-live/r2-read.env -p DynamicUser=yes -p PrivateTmp=yes \
  -p ProtectHome=yes -p ProtectSystem=strict -p UMask=0077 -p "MemoryMax=$cap" -p MemoryAccounting=yes \
  -p "StateDirectory=$unit" -p StateDirectoryMode=0700 \
  --setenv="PYTHONPATH=$release/apps/db/src" --setenv="TRANSIT_CLEAN_BUILDER_COMMIT=$sha" \
  --setenv="HOME=$release/duckdb-home" \
  bash -ec '
    if [[ -n ${!CLEAN_DEST_S3_*} ]]; then echo "Destination environment is forbidden" >&2; exit 1; fi
    export TMPDIR="$STATE_DIRECTORY"
    python=$1 city=$2 day=$3
    "$python" -m transit_ops.cli clean-days --provider "$city" --from "$day" --to "$day" \
      --source s3://transit-raw --dest "$STATE_DIRECTORY"
    "$python" -m transit_ops.clean_day_summary --root "$STATE_DIRECTORY" --provider "$city" \
      --day "$day" --details --source s3://transit-raw
  ' bash "$release/apps/db/.venv/bin/python" "$city" "$day"
