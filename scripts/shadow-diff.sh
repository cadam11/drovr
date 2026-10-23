#!/bin/sh
# Pairs the live tick's decisions with the shadow tick's and prints every difference.
# Exit 0 over a whole day is the cut-over gate:
#   scripts/shadow-diff.sh --since 2026-10-24T00:00:00Z
# Defaults: $DROVR_HOME (or ~/.drovr)/decisions.jsonl and decisions-shadow.jsonl.
set -eu
cd "$(dirname "$0")/.."
exec go run ./scripts/shadowdiff "$@"
