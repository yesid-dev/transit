#!/usr/bin/env bash
set -euo pipefail
umask 022

if [[ $# != 1 || $EUID != 0 || $(uname -s) != Linux ]]; then
  echo "Usage on the Linux VM, from a clean Git checkout: sudo bash update-engine.sh <git ref>" >&2
  exit 2
fi

root=/opt/transit-engine
current=$root/current
service=transit-engine.service

exec 9>"$root/.update.lock"
flock -n 9 || { echo "An engine update is already running" >&2; exit 1; }

status=$(git status --porcelain)
if [[ -n $status ]]; then
  echo "The deployment checkout must be clean" >&2
  exit 1
fi
commit=$(git rev-parse --verify --end-of-options "$1^{commit}")
previous=
if [[ -L $current ]]; then
  previous=$(readlink -e -- "$current")
elif [[ -e $current ]]; then
  echo "$current must be a symlink" >&2
  exit 1
fi

healthy() {
  python3 - <<'PY'
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from time import monotonic, sleep

token = Path("/etc/transit-engine/engine-token").read_text().strip()
deadline = monotonic() + 15
while monotonic() < deadline:
    connection = HTTPConnection("127.0.0.1", 8081, timeout=1)
    try:
        connection.request("GET", "/healthz", headers={"Authorization": f"Bearer {token}"})
        if connection.getresponse().status == 200:
            raise SystemExit(0)
    except (OSError, HTTPException):
        pass
    finally:
        connection.close()
    sleep(0.5)
raise SystemExit("Engine did not pass its authenticated health check")
PY
}

install -d -m 0755 "$root/releases"
release=$(mktemp -d "$root/releases/$commit.XXXXXX")
next=$root/.current.${release##*/}
switch_attempted=false

activate() {
  ln -sfn -- "$1" "$next"
  mv -Tf -- "$next" "$current"
}

cleanup() {
  local result=$?
  trap - EXIT
  if (( result == 0 )); then
    return
  fi
  if $switch_attempted; then
    echo "Activation failed. Restoring the previous engine." >&2
    if [[ -n $previous ]]; then
      if ! (activate "$previous" && systemctl restart "$service" && healthy); then
        echo "The previous engine could not be restored and verified" >&2
      fi
    else
      rm -f -- "$current"
      systemctl stop "$service"
    fi
  fi
  if [[ $(readlink -- "$current" || true) != "$release" ]]; then
    rm -rf -- "$release"
  fi
  rm -f -- "$next"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

git archive "$commit" .python-version apps/engine apps/db/config/providers |
  tar --extract --directory "$release" --no-same-owner --no-same-permissions
UV_PYTHON_INSTALL_DIR="$root/python" UV_LINK_MODE=copy "$root/bin/uv" sync \
  --directory "$release/apps/engine" --managed-python --locked --no-dev --no-editable
printf '%s\n' "$commit" >"$release/.revision"
chmod 0755 "$release"

switch_attempted=true
activate "$release"
systemctl restart "$service"
healthy
printf 'Installed Transit engine commit %s\n' "$commit"
