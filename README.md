# drovr

Capacity-aware supervisor for long-horizon autonomous delivery loops.

A drover moves a herd over long distances at a pace the animals can sustain. drovr does the same
for a `/project-loop` program: it decides *when* a cycle may start, based on how much Anthropic
quota is left across your teamclaude accounts and how much of your own weekly budget the loop has
already spent. It never kills a cycle — cycles end themselves — and it never touches the accounts
themselves.

Companion to Orca (which manages many parallel sessions right now); drovr drives one program
over weeks.

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

Each cycle is a **fresh interactive Claude session** in that program's Orca worktree — one you can
read and talk to while it runs. Context clearing is session exit, so nothing accumulates across
cycles. The cycle decides its own end (context ceiling, thinning capacity, a natural seam, or
everything blocked) and writes a report, which is the signal that tells drovr it has finished.

## Install

```bash
brew install cadam11/tap/drovr
drovr init
$EDITOR ~/.drovr/control.json     # add a program
drovr service install             # writes the launchd plist and loads it
```

Upgrade with `brew upgrade drovr && drovr service install`. The second half is not optional: launchd holds the plist it loaded, and the plist bakes in the path of the binary and your PATH, so an upgrade keeps running the old definition until the agent is reloaded.

Without Homebrew, download `https://drovr.app/cli/drovr_darwin_arm64.tar.gz` (checksums beside it at `/cli/drovr-sha256sums.txt`), extract it, put `drovr` on your PATH and run `xattr -d com.apple.quarantine drovr`. The binary is unsigned, so macOS quarantines a browser download; Homebrew installs skip that. Apple Silicon only.

## What you need

- **[teamclaude](https://github.com/KarpelesLab/teamclaude)** on PATH. drovr reads
  `teamclaude status --json` once a tick for the pooled quota and launches every cycle through
  `teamclaude run`. It never changes a teamclaude setting.
- **[Orca](https://www.onorca.dev/)**, open. Each cycle is an interactive terminal in the program's
  own Orca worktree, which is how you can read and talk to a cycle while it runs.
- **The [`project-loop` skill](skill/project-loop.SKILL.md)** in the runner's Claude Code. It is the other half of this system:
  it owns what a cycle does and ends the cycle with `drovr report`. Install it with
  `mkdir -p ~/.claude/skills/project-loop && cp skill/project-loop.SKILL.md ~/.claude/skills/project-loop/SKILL.md`.

Two more things are optional, and both are paid products that add to the free base:

- **[hey](https://hey.drovr.app)** carries drovr's alerts to your phone and waits for your answer.
  Without it, alerts are log lines. With it, run `hey login` once on this Mac and set
  `control.notifyTo` to your handle.
- **[aice](https://aice-x.com)** hosts a program's pages and its asks page. Without it, asks live
  in a markdown file in the program's checkout (below), and nothing else changes.

`service install` bakes in the PATH of the shell that runs it, since launchd starts with a bare
one that lacks `/opt/homebrew/bin` and similar. It also **reloads** an already-loaded agent —
launchd holds the plist it loaded, not the file, so rewriting alone would keep running the old
definition.



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
  "capacity": {
    "cyclesFundable": 0,
    "bindingBucket": "session",
    "perAccount": [{ "name": "karen@…", "cyclesFundable": 0, "bindingBucket": "session" }],
    "units": "whole delivery cycles, net of cycles already in flight; the total is the sum over accounts of each account's own tightest bucket, never the min of the pool sums"
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
                        [--asks <page> | --asks-file <path> | --no-aice] [--no-direnv]
drovr rm <name>          # stops tracking; ledger history is kept
drovr host <name> --environment <id> --ssh <user@host> --cwd </path/on/box> [--wake '<cmd>']
                         # run its cycles on a paired remote Orca runtime (see Remote hosts)
drovr host <name> --clear
```

Example:

```bash
drovr add mrr ~/code/mrr --priority 3 --no-aice            # asks in ~/code/mrr/.drovr/asks.md
drovr add mrr ~/code/mrr --priority 3 --asks craig/asks.html   # asks on the repo's aice install
```

The path must exist and the name must be unique; the whole control file is validated before the
change lands. `--no-aice` puts the program's asks in `.drovr/asks.md` under its path
(`--asks-file` names another file). With aice, the install comes from the repo's own `.envrc`, so
a program usually needs nothing else; `--asks` names its asks page once it has one (leave it
unset and onboarding creates one).

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
      "aice": { "asksPage": "craig/loop-asks.html" }
    },
    {
      "name": "mrr",
      "cwd": "/Users/cadam/code/mrr",
      "aice": null,
      "asksFile": ".drovr/asks.md"
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
drovr host <name> ...     # run a program's cycles on a remote Orca runtime
drovr service print       # plist to stdout, writes nothing
```


## Where a cycle actually runs

A cycle is **an interactive claude session in a terminal of that program's own Orca worktree**, not
a headless background process. drovr opens the terminal with `teamclaude run -- --model fable`,
waits for claude to come up idle, and prompts it with `/project-loop <program>`. You can read it,
interrupt it, and chat with it like any other session — and the loop agent creates its own
worktrees from there, which project-loop already knows how to do.

**One cycle terminal per program.** Worktrees are long-lived, so a terminal per cycle would bury
them in hundreds. drovr remembers the terminal it opened (handle, tab and worktree, in
`cycle-terminal.json`); when a cycle ends the claude is released and the terminal closed, and the
next cycle opens a fresh one. Orca handles do not survive an Orca restart but the tab does, so a
stale handle is re-resolved through the tab before it is given up on — that is the case where Orca
has resumed the claude session into the restored tab, and losing track of it would mean a live
runner nobody is watching.

The proxy comes from `teamclaude run` itself — the same thing your `claude` alias does — so the
terminal runs a normal interactive session that still rotates across accounts. drovr never types a
command into a shell: the launch goes through `orca terminal create --command`, and the only text
it ever sends to a terminal is a prompt, or `/exit` to a claude it has just read as idle.

**The runner is always Fable.** drovr passes `--model fable` to that session only — claude's
`--model` is documented as "model for the current session", so your default is untouched and every
other `claude` you start is unaffected. The coordinator being Fable is the point: it spawns
Opus/Sonnet/Haiku subagents itself, which is why the Fable and general quota buckets are tracked
separately. Override per program with `"model"` if a program should run on something else.

The worktree is Orca's worktree whose checkout is the program's `cwd`. Orca only opens terminals
in worktrees it knows, and registering one is a decision about your workspace, so a program whose
`cwd` is not registered is refused with the command that fixes it:

```bash
orca repo add --path /Users/cadam/code/joinery
```

Each session is named `<program> program runner` (`sessionName`, via claude `--name`), so it is
obvious in the prompt box and in `/resume` which program a session belongs to.

**A finished cycle is released, not killed.** An interactive claude session cannot exit itself, so
once the report file appears drovr waits for the agent to settle, sends it `/exit`, and closes the
terminal. If it will not go, the cycle is still recorded and the next one refuses rather than
stacking a second agent on the terminal.

**drovr never kills a cycle.** It watches for the runner's own report file, or for the agent to
disappear. `x` in the watch view sends an interrupt, not a kill, so the runner still gets to wind
down and make its work durable. After `maxCycleHours` (default 12) drovr stops watching and records
the cycle, leaving the terminal in place for you to inspect.

Set `"runner": "headless"` on a program for the old behaviour — `claude -p` to a log file, with
nothing to talk to.

### Tidying up

A cycle whose claude exited without being released leaves a bare shell in its terminal. Cycle
starts clean that up automatically, and `drovr tidy` does it on demand when nothing is running:

```bash
drovr tidy
# sunnyt: closed term_6eca3f20-bcbb-45a1-a3cb-d4aca40487b6
# aice-x: no empty cycle terminal
```

It only touches the terminal drovr itself opened for a program, and only when no claude is in it.
A program with a cycle in flight is skipped entirely — a stray shell is untidy, a closed live
session is lost work.

### After an Orca restart

Orca restores tabs and resumes the agent sessions in them, but every terminal *handle* drovr
remembered is invalidated. drovr re-finds its terminal through the tab id, so a resumed runner is
still watched and its program is not admitted a second time on top of it. If the tab is gone too,
the program simply has no runner and the next cycle opens a fresh terminal.

For everything outside drovr, install the alias so a bare `claude` can never run un-proxied:

```bash
teamclaude alias --install     # alias claude='teamclaude run --'
```

### Remote hosts

A program can run its cycles on a **paired remote Orca runtime** — a dev box — while drovr itself
stays on the Mac. The Mac remains the default; a host is opt-in per program:

```bash
drovr host relliq --environment a7a12606-e7eb-4c62-bdfc-efd0a73a5f51 \
  --ssh ubuntu@relliq-devbox --cwd /home/ubuntu/code/propra/relliq \
  --wake 'cd ~/code/propra/relliq && pnpm devbox:start'
drovr host relliq --clear      # back to the Mac
```

What moves is the cycle terminal: it is created on the remote runtime (`--environment`, from
`orca environment list`) in the worktree at `--cwd` there, and every later orca call on it carries
the same environment, because a remote handle is stale to a call without one. The runner on the
box ends its cycle with its own `drovr report`, which writes `last-cycle.json` under the box's
`DROVR_HOME` (`--drovr-home`, default `~/.drovr`); drovr reads it back with `ssh ... cat` on the
same 30s poll, and the closing message from the box's `~/.claude`. The ledger — control.json,
cycles.jsonl, usage, decisions — never leaves the Mac. Before a cycle, an unreachable box is woken
with `--wake` (a *local* command that returns once ssh answers, up to six minutes); without one, an
unreachable box is a failed cycle.

Two things to set up on the box first: `drovr` on its PATH with a program of the **same name** in
its own `control.json` (the runner's `drovr report` checks the name), and `claude` at `--claude`
(default `~/.local/bin/claude`). The launch there calls that binary directly rather than
`teamclaude run`, because the teamclaude pool is Mac-local and has no server on the box. The
program's `<path>` from `drovr add` stays the local checkout: direnv and the asks page still read
it here.

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
- **Polls the asks** for a reply. Any answer newer than the blocked cycle ends the wait at once,
  no command needed.
- **Messages you** through hey once the asks have gone unanswered for `nudgeAfterMinutes`
  (default 4h), when `notifyTo` is set. One message per ask, never one per tick.

**The asks file.** Without aice, a program's asks are a markdown file in its checkout,
`.drovr/asks.md` by default: one task item per ask, `- [ ]` while open, with the agent's context
indented beneath. You answer by writing under the item and ticking it `- [x]`. drovr counts the
unchecked items as open and reads the file's modification time as your latest activity. The
bundled project-loop skill writes the file (see `skill/`). A program with a `host` has its
checkout on the box, so the file is not read for it.

**The asks page.** With aice, polling needs **shared notes turned on** for that page (owner-only,
from the page's own notes widget). Until it is on, `aice notes list` returns nothing whatever you
write, and the status line says so. Answer and run `drovr start <program>` in the meantime.

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

Under the bars, **ACCOUNTS** is teamclaude's own dashboard folded in, so you do not need both
screens open: one row per account with its session, weekly and Fable buckets as used-fraction bars,
each with its own reset countdown. `►` marks the account the fable route will serve next — where
the runner's next request actually lands — and `✗` an account the route refuses, whose headroom
shows in the bars above but funds nothing.

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

## aice installs (optional)

[aice](https://aice-x.com) hosts a program's pages and its asks page. Each program targets its
own install, selected by `AICE_BASE_URL` in the repo's `.envrc`, which direnv supplies to the
cycle. Token caches must not share a directory, since a login to one install would clobber the
others, so `.envrc` sets `AICE_CONFIG_DIR` per program too. drovr itself only ever reads an asks
page's notes; it publishes nothing.

```json
"aice": { "asksPage": "craig/asks.html" }
```

`asksPage` may be null for a program that has no asks page yet; onboarding creates one. Each
install needs a one-time login:

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
