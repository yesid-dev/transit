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
  python3 - "${1:-15}" <<'PY'
from http.client import HTTPConnection, HTTPException
from pathlib import Path
from sys import argv
from time import monotonic, sleep

token = Path("/etc/transit-engine/engine-token").read_text().strip()
deadline = monotonic() + int(argv[1])
while True:
    connection = HTTPConnection("127.0.0.1", 8081, timeout=1)
    try:
        connection.request("GET", "/healthz", headers={"Authorization": f"Bearer {token}"})
        response = connection.getresponse()
        if response.status == 200:
            print(response.getheader("X-Transit-Answer-Revision", ""))
            raise SystemExit(0)
    except (OSError, HTTPException):
        pass
    finally:
        connection.close()
    if monotonic() >= deadline:
        break
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
      if ! (activate "$previous" && systemctl restart "$service" && healthy >/dev/null); then
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

release_paths=(.python-version apps/engine apps/db/config/providers)
git archive "$commit" "${release_paths[@]}" |
  tar --extract --directory "$release" --no-same-owner --no-same-permissions
warm_runner=apps/web/scripts/warm-default-views.ts
if [[ -f $release/apps/engine/ops/linux/build-warm-runner.sh ]]; then
  # Keep the entry point used by the installed systemd unit across releases.
  bash "$release/apps/engine/ops/linux/build-warm-runner.sh" \
    "$commit" "$root/bin/bun" "$release/$warm_runner"
elif git cat-file -e "$commit:$warm_runner" 2>/dev/null; then
  # Historical releases retain their original layout for rollback.
  git archive "$commit" .bun-version apps/web/package.json "$warm_runner" apps/web/src/lib |
    tar --extract --directory "$release" --no-same-owner --no-same-permissions
fi
# The r2 extra carries the locked httpfs wheel: stretch questions read older days from R2.
UV_PYTHON_INSTALL_DIR="$root/python" UV_LINK_MODE=copy "$root/bin/uv" sync \
  --directory "$release/apps/engine" --managed-python --locked --no-dev --no-editable --extra r2
printf '%s\n' "$commit" >"$release/.revision"
chmod 0755 "$release"

previous_revision=
if [[ -n $previous ]]; then
  previous_revision=$(healthy 0 2>/dev/null || true)
fi
switch_attempted=true
activate "$release"
systemctl restart "$service"
revision=$(healthy)
switch_attempted=false
printf 'Installed Transit engine commit %s\n' "$commit"
if [[ -f $release/$warm_runner && ( -f $release/apps/engine/ops/linux/build-warm-runner.sh || \
  ( -n $revision && $revision != "$previous_revision" ) ) ]]; then
  # Let the public proxy's 30-second city catalog expire before warming answers.
  sleep 30
  systemctl restart --no-block transit-engine-warm.service
fi
