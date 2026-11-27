#!/usr/bin/env bash
set -euo pipefail
umask 022

enable_clean_days=false
if [[ ${1:-} == --with-clean-days ]]; then
  enable_clean_days=true
  shift
fi
if [[ $# -lt 2 || $EUID != 0 || $(uname -s) != Linux ]]; then
  echo "Usage on the Linux VM, from a clean Git checkout: sudo bash update-live.sh [--with-clean-days] <git ref> <city> [<city> ...]" >&2
  exit 2
fi

root=/opt/transit-live
current=$root/current
uv=${TRANSIT_LIVE_UV:-/opt/transit-engine/bin/uv}
ref=$1
shift
for city in "$@"; do
  if [[ ! $city =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]]; then
    echo "Invalid live city identifier" >&2
    exit 2
  fi
done
if [[ ! -x $uv || -n $(git status --porcelain) ]]; then
  echo "A clean checkout and the VM's pinned uv executable are required" >&2
  exit 1
fi

install -d -m 0755 "$root" "$root/releases"
exec 9>"$root/.update.lock"
flock -n 9 || { echo "A live publisher update is already running" >&2; exit 1; }
commit=$(git rev-parse --verify --end-of-options "$ref^{commit}")
previous=
if [[ -L $current ]]; then
  previous=$(readlink -e -- "$current")
  [[ $previous == "$root/releases/"* ]] || { echo "Invalid current live release" >&2; exit 1; }
elif [[ -e $current ]]; then
  echo "$current must be a symlink" >&2
  exit 1
fi

release=$(mktemp -d "$root/releases/$commit.XXXXXX")
next=$root/.current.${release##*/}
switch_attempted=false
running=()
for city in "$@"; do
  service="transit-live@$city.service"
  if systemctl is-active --quiet "$service"; then
    running+=("$service")
  fi
done

activate() {
  ln -sfn -- "$1" "$next"
  mv -Tf -- "$next" "$current"
}

cleanup() {
  local result=$?
  trap - EXIT
  if (( result == 0 )); then return; fi
  if $switch_attempted; then
    if [[ -n $previous ]]; then
      if activate "$previous"; then
        if (( ${#running[@]} )) && ! systemctl restart "${running[@]}"; then
          echo "Could not restart the previous live publishers" >&2
        fi
      else
        echo "Could not restore the previous live release pointer" >&2
      fi
    elif [[ -L $current && $(readlink -- "$current") == "$release" ]]; then
      rm -f -- "$current"
    fi
  fi
  rm -f -- "$next"
  echo "Live publisher candidate remains at $release" >&2
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

git archive "$commit" .python-version apps/db |
  tar --extract --directory "$release" --no-same-owner --no-same-permissions
UV_PYTHON_INSTALL_DIR="$root/python" UV_LINK_MODE=copy "$uv" sync \
  --directory "$release/apps/db" --managed-python --locked --no-dev --no-editable
printf '%s\n' "$commit" >"$release/.revision"
chmod 0755 "$release"

unit_dir=/etc/systemd/system
clean_units=(transit-clean-days.service transit-clean-days.timer transit-stretch-days.service)
update_clean_days=false
if $enable_clean_days || [[ -e $unit_dir/transit-clean-days.timer ]]; then
  update_clean_days=true
  ops=$release/apps/db/ops/linux
  systemd-analyze verify "${clean_units[@]/#/$ops/}"
  install -d -m 0755 "$release/duckdb-home"
  HOME="$release/duckdb-home" "$release/apps/db/.venv/bin/python" \
    -c 'import duckdb; duckdb.connect().install_extension("icu")'
  chmod -R a+rX "$release/duckdb-home"
fi

for city in "$@"; do
  unit="transit-live-check-$$-$city"
  systemd-run --quiet --pipe --wait --collect --unit="$unit" \
    -p EnvironmentFile=/etc/transit-live/r2-read.env \
    -p DynamicUser=yes -p ProtectHome=yes -p ProtectSystem=strict \
    -p MemoryMax=512M -p CPUWeight=25 -p RuntimeMaxSec=180 \
    -p RuntimeDirectory="$unit" \
    "$release/apps/db/.venv/bin/python" -m transit_ops.live.playback "$city" \
    --provider-dir "$release/apps/db/config/providers" --source s3://transit-raw \
    --dest "/run/$unit" --once --require-captures
done

switch_attempted=true
activate "$release"
if (( ${#running[@]} )); then systemctl restart "${running[@]}"; fi
printf 'Installed Transit1 live publisher commit %s\n' "$commit"
switch_attempted=false

if $update_clean_days; then
  install -m 0644 "${clean_units[@]/#/$ops/}" "$unit_dir/"
  systemctl daemon-reload
  if $enable_clean_days; then
    systemctl enable --now transit-clean-days.timer
  fi
fi
