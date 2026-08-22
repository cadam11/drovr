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
  └─ drovr tick                        returns in seconds; never blocks
       ├─ teamclaude status --json     → pooled capacity
       ├─ ~/.drovr/control.json        → mode / pause / ceilings / programs
       ├─ ~/.drovr/cycles.jsonl        → what past cycles cost, what is in flight
       └─ for each program, in priority order:
            decide() → GO  → detach `drovr run-cycle <program>` (hours)
                       WAIT → log why, render status
                       STOP → mode off, or this program is stuck
```

Programs run **concurrently**, each in its own detached process holding its own lock. Every
in-flight cycle reserves its estimated cost from the shared pool, so N programs cannot each
claim the whole budget.

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


## Adding a program

```bash
drovr add <name> <path> [--priority n] [--deadline YYYY-MM-DD]
                        [--asks <page>] [--status-page <page>]
                        [--no-aice] [--no-direnv]
drovr rm <name>          # stops tracking; ledger history is kept
```

Example:

```bash
drovr add mrr ~/code/mrr --priority 3 --asks craig/asks.html
```

The path must exist and the name must be unique; the whole control file is validated before the
change lands. Since the aice install comes from the repo's own `.envrc`, a new program usually
needs nothing else — use `--no-aice` for one with no aice install at all, and `--asks` only once
the program has an asks page (leave it unset and onboarding creates one).

The first tick after adding runs an **onboarding cycle**: it reconstructs state from tickets,
git, docs and any existing aice pages, publishes the program bundle, raises one ask describing
what it found and what it could not determine, then stops. It does not roll into delivery —
confirm or correct the reconstruction in the page notes and the next cycle proceeds on its own.

You can also edit `~/.drovr/control.json` directly; every tick re-reads it.

## Is it running?

```bash
drovr service status
```

```
loaded every 600s, last tick 4m ago
```

launchd being loaded only proves it is *scheduled*. Ticks are short-lived, so the honest liveness
signal is when one last actually ran — read from `decisions.jsonl`. A gap of more than a few
intervals is reported as `overdue`, and a non-zero exit from the last tick is shown too.

`drovr watch` carries the same line in its header with a green or red dot, so a dead service is
visible at a glance rather than looking like a quiet one.

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


## Multiple programs

Programs are independent and run concurrently, up to `maxConcurrentCycles` (default 2). Each
gets its own working directory, its own aice pages, its own daily cap, and its own stuck
detection — but they all draw on **one shared quota pool**, so:

- **Every in-flight cycle reserves its estimated cost** before another program is admitted.
  Without this, three programs would each see the full pool and all start at once.
- **Pace is global.** The weekly entitlement covers every program together, since they spend
  the same quota.
- **Daily caps and stuck streaks are per program.** One program hitting its cap frees the slot
  for a lower-priority one — that is the fairness mechanism, no separate scheduler needed.

### Priority

`priority` orders who claims the next slot; lower wins, matching teamclaude's convention.
Ties break alphabetically so ordering is deterministic.

`deadline` (ISO date) promotes a program one priority step once it is within
`deadlineHorizonDays` (default 21), and **keeps the promotion while overdue** — a missed date
is more urgent, not less.

```json
{ "name": "sunnyt",  "cwd": "~/code/sunnyt",      "priority": 0, "deadline": "2026-09-01" },
{ "name": "aice-x",  "cwd": "~/code/aice-x/aice", "priority": 0 },
{ "name": "joinery", "cwd": "~/code/joinery",     "priority": 2 }
```

`drovr status` previews the ordering with reservations applied, so it shows what a tick would
actually do rather than evaluating each program against an empty pool:

```
in flight: 0/2
  [p-1] sunnyt:  GO   — pool funds 3.60 more cycles (0 in flight)
  [p0]  aice-x:  GO   — pool funds 2.60 more cycles (1 in flight)
  [p2]  joinery: WAIT — 2 cycles in flight, cap is 2
```


## Watching it

```bash
drovr watch          # live view, redraws every 15s
drovr watch 5        # faster
```

The allocation bars answer "how much is left for me?" directly. Each bucket is one stacked bar
across all usable accounts, and the five segments always sum to the whole pool:

| Segment | Meaning |
|---|---|
| `▓` you spent | usage not attributable to drovr — your own foreground work |
| `█` programs spent | completed drovr cycles this window, from the ledger |
| `▒` in flight | claimed by running cycles, not yet visible as usage |
| `░` free to programs | still spendable before the ceiling |
| `·` held for you | above the ceiling; drovr never touches it |

Headroom is taken from the same clamped pool `decide()` uses, so the bar can never disagree
with the verdict printed under it. One account over its ceiling contributes zero — it cannot
borrow headroom from another account.

```
  fable   7d ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░···························  you 81%
  general 7d ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░······················  you 80%
  session 5h ▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░···········································  you 70%
```


### Controls

Everything is editable from the watch view — no exiting, no file editing. Every change writes
through `control.json`, so a launchd tick seconds later sees it even if you close the window.

| Key | Does |
|---|---|
| `j` / `k` (or ↑↓) | select a program |
| `space` / `e` | enable/disable the selected program |
| `[` `]` | nudge its priority (clamped ±9) |
| `m` | cycle mode: off → low → normal → away |
| `p` | pause 1h, or clear an active pause |
| `P` | extend the pause to the next step (1h → 3h → 8h → 24h) |
| `+` / `-` | concurrency cap (1–8) |
| `t` | run a tick now, launching cycles if capacity allows |
| `x` | stop the selected program's cycle (`y` to confirm) |
| `q` / ctrl-c | quit |

Every write is validated before it lands, so a mistyped edit is refused rather than leaving a
control file the next tick cannot parse. `x` signals the worker's whole process group, so the
cycle goes down with it instead of being orphaned.

## aice installs

Each program targets its own aice install, selected by `AICE_BASE_URL`. Token caches must not
share a directory — a login to one install would clobber the others — so `configDir` sets
`AICE_CONFIG_DIR` per program. Both are exported into the cycle process too, so the loop agent
publishes to the right place without knowing any of this.

```json
"aice": {
  "baseUrl": "https://sunnyt.aicex.app",
  "configDir": "~/.config/aice-sunnyt",
  "asksPage": "craig/asks.html",
  "statusPage": "craig/drovr-status.html",
  "publishArgs": ["--agent", "claude"]
}
```

`asksPage` may be null for a program that has no asks page yet; onboarding creates one.
Each install needs a one-time login:

```bash
AICE_BASE_URL=https://joinery.aicex.app AICE_CONFIG_DIR=~/.config/aice-joinery aice login
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
