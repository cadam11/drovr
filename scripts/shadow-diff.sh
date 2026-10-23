#!/bin/sh
# Pairs the live tick's decisions with the shadow tick's and prints every difference.
# Exit 0 over a whole day is the cut-over gate:
#   scripts/shadow-diff.sh --since 2026-10-24T00:00:00Z
# Defaults: $DROVR_HOME (or ~/.drovr)/decisions.jsonl and decisions-shadow.jsonl.
# Exit 3 (shown as 1 through go run) is "nothing to compare": no live decision was paired.
# Only live decisions are judged. A program the live tick skipped writes no live line, so a
# decision only the shadow made is never reported.
# A shadow pass overlapping a live one by a few seconds can read half-appended records and
# produce a noisy mismatch; that can only fail the gate, never pass it.
set -eu
cd "$(dirname "$0")/.."
exec go run ./scripts/shadowdiff "$@"
