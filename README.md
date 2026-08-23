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

Each cycle is a **fresh interactive Claude session** in that program's herdr workspace — one you can
read and talk to while it runs. Context clearing is session exit, so nothing accumulates across
cycles. The cycle decides its own end (context ceiling, thinning capacity, a natural seam, or
everything blocked) and writes a report, which is the signal that tells drovr it has finished.

## Install

```bash
cd ~/code/drovr && pnpm install
node src/cli.ts init
$EDITOR ~/.drovr/control.json     # add a program
node src/cli.ts service install   # writes the launchd plist and loads it
```

Requires Node >= 24 (runs TypeScript directly, no build step), `teamclaude` on PATH, and `aice`
if a program publishes pages.

`service install` bakes in the PATH of the shell that runs it, since launchd starts with a bare
one that lacks `~/Library/pnpm` and similar. It also **reloads** an already-loaded agent —
launchd holds the plist it loaded, not the file, so rewriting alone would keep running the old
definition.

> The plist also pins the absolute `node` path from `process.execPath`. Re-run `service install`
> after switching Node versions with nvm, or after any change to your PATH that matters.



## Help, for agents

Help is progressively disclosed, since the usual reader is an LLM working out how to drive this:

```bash
drovr help                  # overview + one line per command
drovr help status           # detail for one command
drovr status --help         # same page
drovr help --json           # the whole tree, plus vocabulary and state-file locations
```

Every command page states what it **writes** (or that it is read-only) and whether it **blocks**
for hours — the two things an agent most needs before calling something.

Every read command accepts `--json`. That output is deliberately *not* minimal: values carry
their units and meanings next to them, timestamps are ISO rather than epoch millis, and floats
are rounded, because the consumer has to interpret it rather than just deserialize it.

```json
{
  "service": {
    "health": "not-loaded",
    "explanation": "the launchd agent file exists but launchd has not loaded it, so no tick will ever fire. Fix: launchctl bootstrap gui/501 ..."
  },
  "pool": {
    "general": 0.6,
    "resetAt": { "general": "2026-08-23T10:59:59.685Z" },
    "units": "account-fractions of headroom; one usable account contributes at most 1.0"
  },
  "programs": [{
    "verdict": "WAIT",
    "verdictMeaning": "transient — a later tick will retry, no action needed",
    "reason": "session tightest — funds 0.40 cycles, need 1.50, recovers in 2h",
    "bindingBucket": "session"
  }]
}
```

Every failure message names the fix rather than referring to one printed elsewhere: an unloaded
service reports the literal `launchctl bootstrap` line, not "run the bootstrap line".

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

| mode | held for you | programs may use | when |
|---|---|---|---|
| `off` | everything | — | stopped |
| `low` | 75% | 25% weekly, 25% per 5h | you need the quota |
| `normal` | 45% | 55% weekly, 40% per 5h | default |
| `away` | 15% | 85% weekly, 60% per 5h | you're gone for a few days |

Ceilings cap **total** usage, so the reserve is what's left for you no matter what programs do.

### Adjusting your reserve

```bash
drovr reserve          # 45% of each account's weekly quota is held for you in mode "normal"
drovr reserve 60       # normal: 60% held for you — programs up to 40% weekly, 29% per 5h
```

`reserve` and `mode` are the same setting from opposite ends: a mode is a named reserve level, and
`reserve` sets it directly. It applies to the **current mode**, so switching modes switches reserve
levels with it — set `away` to 15% once and `drovr mode away` gets you that every time.

The 5h burst ceiling keeps its ratio to the weekly one, so tightening your reserve can't silently
widen how hard a single 5-hour window gets hit.

In `drovr watch`, `<` and `>` nudge the reserve by 5%.

The watch view runs on the alternate screen and adapts to the terminal width, so it stays readable
over mosh on a phone: short bucket labels, the reason on its own line, and a wrapped keybar below
~72 columns.

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


## Where a cycle actually runs

A cycle is **an interactive claude session in that program's own herdr workspace**, not a headless
background process. drovr starts a `claude` agent named `drovr-<program>` in that program's cycle
tab and prompts it with `/project-loop <program>`. You can read it, interrupt it, and chat with it
like any other session — and the loop agent creates its own herdr worktrees from there, which
project-loop already knows how to do.

**One cycle tab per program, reused.** Workspaces are long-lived, so a tab per cycle would bury the
workspace in hundreds of them. drovr creates the tab once (unfocused, so it never steals your
cursor), remembers its pane, and reuses it: when a cycle ends the agent exits and leaves the pane at
a shell prompt, which is exactly what the next `agent start` needs. The scrollback carries prior
cycles with it. If the tab is closed, the next cycle makes a new one.

The proxy is applied via `teamclaude env`, teamclaude's own documented path for "agent multiplexers
that spawn claude themselves", so the pane runs a normal interactive `claude` while still rotating
across accounts.

**The runner is always Fable.** drovr passes `--model fable` to that session only — claude's
`--model` is documented as "model for the current session", so your default is untouched and every
other `claude` you start is unaffected. The coordinator being Fable is the point: it spawns
Opus/Sonnet/Haiku subagents itself, which is why the Fable and general quota buckets are tracked
separately. Override per program with `"model"` if a program should run on something else.

The workspace is matched by label, then by checkout path, and **created if neither matches** —
drovr knows the program directory, so closing a workspace should not strand a program. Pin it with
`herdrWorkspace` to override.

Each session is named `<program> program runner` (`sessionName`, via claude `--name`), so it is
obvious in the prompt box and in `/resume` which program a session belongs to.

**A finished cycle is released, not killed.** An interactive claude session cannot exit itself, so
once the report file appears drovr waits for the agent to settle, sends it `/exit`, and frees the
pane for the next cycle. If it will not go, the cycle is still recorded and the next one refuses
rather than stacking a second agent on the pane.

**drovr never kills a cycle.** It watches for the runner's own report file, or for the agent to
disappear. `x` in the watch view sends an interrupt, not a kill, so the runner still gets to wind
down and make its work durable. After `maxCycleHours` (default 12) drovr stops watching and records
the cycle, leaving the tab in place for you to inspect.

Set `"runner": "headless"` on a program for the old behaviour — `claude -p` to a log file, with
nothing to talk to.

### Tidying up

A cycle whose pane was lost leaves its old tab behind. Cycle starts clean those up
automatically, and `drovr tidy` does it on demand when nothing is running:

```bash
drovr tidy
# sunnyt: closed w64:t7
# aice-x: no empty cycle tabs
```

It only touches tabs drovr itself labelled (`<program> cycles`), only in that program own
workspace, and only when every pane in them is free of an agent. A program with a cycle in
flight is skipped entirely — a stray empty tab is untidy, a closed live one is lost work.

### After a herdr restart

Snapshot restore brings panes back as **fresh shells** — workspace, tab, pane, cwd, layout and
focus survive, environment variables do not. Herdr's native agent restore is on by default and
re-runs `claude --resume <id>`, so a restored cycle pane would otherwise be a raw, un-proxied
`claude` billing your quota with no rotation.

drovr handles both halves:

- Before starting an agent in a **reused** pane it re-asserts `eval "$(teamclaude env)"` in that
  shell, so the environment does not depend on having survived.
- If the pane already has an **occupant** — a cycle herdr resumed on its own — drovr refuses to
  start and says so, rather than stacking a second agent on top or killing the first.

For everything outside drovr, install the alias so a bare `claude` can never run un-proxied:

```bash
teamclaude alias --install     # alias claude='teamclaude run --'
```

That covers what you type interactively. It does not cover herdr's own resume command, which is
why drovr re-asserts the environment itself.

## The daily cap

```bash
drovr cap                    # global cap and any per-program overrides
drovr cap 12                 # raise the global
drovr cap aice-x 20          # override one program
drovr cap aice-x global      # drop the override
```

Only cycles that **did work** count against it. Crashes never ran, deferrals never started, and
a cycle that came back blocked only rediscovered an unanswered ask — none of those should cost a
program its day. The blocked backoff is what bounds those instead.

## When a program is waiting on you

A cycle that exits `blocked` has nothing left it can do without an answer. drovr then:

- **Backs off** rather than burning a cycle every tick to rediscover the same question.
- **Polls the asks page** for a reply. Any note newer than the blocked cycle ends the wait at
  once — no command needed.
- **Texts you** (`phoneNumber`) once the asks have gone unanswered for `nudgeAfterMinutes`
  (default 4h). One text per ask, never one per tick.

> Polling needs **shared notes turned on** for that page — it is owner-only, from the page own
> notes widget. Until it is on, `aice notes list` returns nothing whatever you write, and the
> status line says so. Answer and run `drovr start <program>` in the meantime.

## Kicking one off by hand

```bash
drovr start <program>        # ignores every capacity check, returns immediately
```

Use it to clear a crash latch once the cause is fixed, or to run something out of turn. Unlike
`run-cycle`, which blocks for the whole cycle, `start` detaches like a tick would.

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
| `<` / `>` | reserve held for you, in 5% steps |
| `r` | redraw now instead of waiting for the timer |
| `o` | open the selected program asks page in a browser |
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
