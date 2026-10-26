#!/bin/sh
# Replays the TS suite with the recorder on, so testdata/recorded holds every case the Go
# suite must match. Re-run whenever a TS test changes; commit the result.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/testdata/recorded"
rm -rf "$out"
DROVR_RECORD="$out" TZ=UTC node --test "$root"/test/*.spec.ts > /dev/null
for fn in "$out"/*/; do printf '%s %s\n' "$(ls "$fn" | wc -l | tr -d ' ')" "$(basename "$fn")"; done
