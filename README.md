# drovr

Capacity-aware supervisor for long-horizon autonomous delivery loops.

A drover moves a herd over long distances at a pace the animals can sustain. drovr does the same
for a `/project-loop` program: it decides *when* a cycle may start, based on how much Anthropic
quota is left across your teamclaude accounts and how much of your own weekly budget the loop has
already spent. It never kills a cycle — cycles end themselves — and it never touches the accounts
themselves.

Companion to [herdr](https://github.com/) (which manages many parallel sessions right now);
drovr drives one program over weeks.

## How it works

```
launchd (every 10 min)
  └─ drovr tick
       ├─ teamclaude status --json      → pool capacity
       ├─ ~/.drovr/control.json         → your mode / pause / ceilings
       ├─ ~/.drovr/cycles.jsonl         → what past cycles actually cost
       └─ decide() → GO  → spawn one cycle (hours), record the result
                     WAIT → log why, render status, try again next tick
                     STOP → mode is off, or the loop is stuck
```

Each cycle is a **fresh headless Claude process**. Context clearing is process exit, so nothing
accumulates across cycles. The cycle decides its own end (context ceiling, thinning capacity, a
natural seam, or everything blocked) and writes a report before exiting.

## Install

```bash
cd ~/code/drovr && pnpm install
node src/cli.ts init
$EDITOR ~/.drovr/control.json     # add a program
node src/cli.ts service install   # writes ~/Library/LaunchAgents/tech.propra.drovr.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/tech.propra.drovr.plist
```

Requires Node >= 24 (runs TypeScript directly, no build step), `teamclaude` on PATH, and `aice`
if a program publishes pages.

> The generated plist pins the absolute `node` path from `process.execPath`. If you switch Node
> versions with nvm, re-run `service install`.

## Control

`~/.drovr/control.json` is re-read every tick — edits take effect immediately, and never interrupt
a cycle already in flight.

```json
{
  "mode": "normal",
  "pauseUntil": null,
  "reserveCycles": 0.5,
  "maxCyclesPerDay": 8,
  "contextCeilingTokens": 250000,
  "stuckCycleThreshold": 3,
  "programs": [
    {
      "name": "aice-x",
      "cwd": "/Users/cadam/code/aice-x/aice",
      "aice": {
        "asksPage": "craig/loop-asks.html",
        "statusPage": "craig/drovr-aice-x.html",
        "publishArgs": ["--agent", "claude"]
      }
    }
  ]
}
```

| mode | weekly ceiling | session ceiling | when |
|---|---|---|---|
| `off` | — | — | stopped |
| `low` | 25% | 25% | you need the quota |
| `normal` | 55% | 40% | default |
| `away` | 85% | 60% | you're gone for a few days |

Ceilings cap **total** usage, so `normal` always leaves you ~45% of the week.

## Commands

```bash
drovr status              # pool, cost estimate, per-program verdict
drovr tick                # evaluate once (what launchd runs)
drovr pause 3h            # hold cycles; edits take effect next tick
drovr resume
drovr mode away
drovr ledger 20           # last 20 cycles
drovr service print       # plist to stdout, writes nothing
```

## Telemetry

Two append-only files, written as events happen so a cycle that dies on a quota wall still leaves
a record:

- `~/.drovr/cycles.jsonl` — one record at cycle start, one at end: pool before/after, exit reason,
  yield, startup tokens, asks raised.
- `~/.drovr/decisions.jsonl` — every tick: verdict, reason, pool, cycles fundable.

Cycle cost is measured as the **pool delta**, since teamclaude never exposes an absolute quota
size. Onboarding and crashed cycles are excluded from the estimate.

## Design

See [docs/design.md](docs/design.md).
