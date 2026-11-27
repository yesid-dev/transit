#!/usr/bin/env bash
# Production smoke for the public v2 data contract and web Worker.
set -euo pipefail
node "$(dirname "${BASH_SOURCE[0]}")/scripts/probe-v2.mjs" "$@"
