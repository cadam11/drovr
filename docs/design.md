# drovr — design

## The problem

A `/project-loop` program should run for weeks, autonomously, without burning a week's Anthropic
quota in a day and without leaving no headroom for Craig's own foreground work.

Two things make that hard:

1. **A session cannot clear its own context.** A loop that runs forever in one session eventually
   fills up and degrades.
2. **Quota is multi-dimensional and shared.** Fable, general, and 5-hour buckets, across three
   teamclaude accounts, consumed concurrently by both the loop and Craig.

## The inversion

Don't build a session that clears itself. Build a supervisor that spawns **disposable cycles**.

```
launchd → drovr tick → decide() → spawn one headless cycle → cycle exits → repeat
```

Context clearing becomes process exit. Nothing accumulates. The supervisor holds no state beyond
what's on disk, so a reboot costs nothing.

The supervisor **never kills a cycle.** Cycles are hours long and self-terminating; killing one
mid-flight would strand work that hasn't been made durable. The supervisor's only decision is
*when to start the next one*.

## Capacity model

teamclaude reports per-account used-fractions and never an absolute quota size. Everything is
therefore measured in **quota-fractions**, and a cycle's cost is only ever knowable as the pool
delta it produced.

### Pooling, and why it isn't per-account

Rotation happens **per request**. The Fable runner and the Opus subagents it spawns can land on
different accounts, so "this cycle runs on account X" is not a meaningful statement. Capacity is
computed at the pool level:

```
poolFable   = Σ max(0, weeklyCeiling  - fableUsed)      over usable accounts
poolGeneral = Σ max(0, weeklyCeiling  - generalUsed)
poolSession = Σ max(0, sessionCeiling - sessionUsed)
```

An account is usable unless it is disabled, rate-limited, or paused. A `null` bucket means no
window is open — nothing used, not nothing available.

### The Fable↔general coupling

The Fable runner spawns Opus/Sonnet/Haiku subagents, so a cycle draws on **both** the Fable weekly
bucket and the general weekly bucket. teamclaude cannot know this; it sees buckets, not the
program's shape.

The consequence is a real trap. Observed 2026-08-22:

| account | fable weekly | general weekly | Opus |
|---|---|---|---|
| craig.adam | 13% | 8% | available |
| karen | 79% | **99%** | **blocked 19h** |
| memberjunction | 36% | 39% | available |

karen has 21% Fable headroom, so rotation would happily serve a runner from it — and the runner's
first Opus subagent would hit a wall. Encoding the coupling makes karen contribute nothing without
any account being disabled:

```
cyclesFundable = min(poolFable/F, poolGeneral/G, poolSession/S)
```

An earlier draft solved this by calling `teamclaude disable` on such accounts. That was wrong:
`disable` mutates global state shared with Craig's foreground sessions, and a supervisor that
crashes between disable and enable silently takes an account away from him. Model the capacity
honestly instead of manipulating the pool.

### Learning F, G, S

Since quota size is unknown, cycle cost is measured observationally: record the pool before and
after each cycle; the delta is the cost. Craig's own usage during the cycle contaminates the
measurement, but it biases the estimate **upward**, which is the conservative direction. The
estimate is a median over recent delivery cycles, seeded from config until three samples exist.

Onboarding cycles are excluded — they are read-heavy and Fable-light, and averaging them in would
skew every admission decision afterward.


## The three buckets are not a hierarchy

It is tempting to read `unified5h`, `unified7d` and `unified7dFable` as nested — 5h inside
weekly, Fable inside weekly. They are not a precedence order. **One Fable token decrements all
three counters**: they are overlapping windows on the same spend, so they bind simultaneously
and the tightest wins. That is what `min()` in `cyclesFundableFrom` expresses, and no
precedence logic is needed.

But they are not interchangeable either, and treating them as symmetric caused two defects:

**Recovery time depends on which bucket binds.** A 5h window recovers in hours; a weekly one in
days. The first version reported the soonest reset across all three, so a weekly-bound wait
would claim it recovered in two hours. `Pool` now carries a reset per bucket, `cyclesFundableFrom`
returns which bucket binds, and the WAIT reason names it: `general tightest — funds 0.40 cycles,
need 1.50, recovers in 90h`.

**The 5h bucket resets mid-cycle, which corrupts cost measurement.** Cycles run for hours, so a
5h window resetting during one is the normal case, not an edge case. The pool then *grows* over
the cycle and the delta measures the reset, not the spend. Clamping that to zero — which the
first version did — dragged the median toward nothing, and since `ratio()` treats near-zero cost
as near-infinite capacity, the tightest and most often binding constraint quietly stopped binding
at all after a few cycles.

Reset-corrupted samples are now discarded rather than recorded as zero, and each bucket keeps its
own sample count: the 5h bucket can fall back to the seed while the weekly buckets go on learning.

## Two independent gates

**Affordability** — can the pool fund a whole cycle, plus a reserve?

```
cyclesFundable >= 1 + reserveCycles
```

Admission is about *runway*, not headroom. A cycle that starts and cannot finish pays full
onboarding cost for partial delivery, then the next cycle pays it again. The reserve is what
guarantees a cycle can always land — make its work durable, publish its asks — rather than being
cut off mid-flight.

Reset-aware waiting falls out of this for free: if the pool can't fund a full cycle it waits, and
after the next reset it can. No separate "should I wait for the reset?" logic is needed.

**Pace** — is the loop ahead of its own linear weekly budget?

```
elapsed     = (168 - hoursToWeeklyReset) / 168
entitlement = weeklyCeiling × usableAccounts × elapsed
spent       = Σ cycle costs since the window opened      (drovr's ledger, not account usage)
```

Measuring against drovr's own ledger rather than total account usage means Craig's foreground work
constrains the pool (through the ceiling) without also counting against the loop's pace. Without
this gate a threshold-only policy burns Monday to Wednesday and idles Thursday to Sunday.

## Ceilings are reserves

`weeklyCeiling` caps **total** usage, not drovr's share. At `normal` (55%), Craig always has ~45%
of the week available regardless of what the loop does. Modes shift the ceiling: `low` 25%,
`normal` 55%, `away` 85%.

## Cycle boundaries

The cycle ends itself. Triggers, in the skill:

| Trigger | Threshold |
|---|---|
| Context size | ~250k tokens (wind-down reserve ~50k on top) |
| Capacity thinning | pool no longer funds the work in flight |
| Natural seam | milestone complete |
| Everything blocked | every remaining item waits on an ask |

Context is the usual one. The `/project-loop` skill already forbids the loop agent from doing work
itself — it dispatches everything and holds pointers, not payloads — so context grows slowly and
predictably, mostly from subagent verdicts.

Two reserves, not one: context (wind-down must fit) and quota (the cycle must be able to land).


## Concurrent programs

Craig runs several independent programs at once — sunnyt (live paid SaaS, calendar-bound),
aice-x (paid SaaS, pre-revenue), joinery (open source, nice to have). They share one quota pool,
which forces three things:

**Tick must not await cycles.** An earlier draft held a single global lock and awaited each
program sequentially, so one hours-long cycle blocked every other program for its whole life.
Tick now detaches `drovr run-cycle <program>` per admitted program and returns in seconds; the
child owns that program's lock and writes its own ledger entries.

**In-flight cycles must reserve capacity.** A running cycle has not yet shown up as spent quota,
so admitting against the raw pool would let every program independently claim all of it.
Admission subtracts `running × estimatedCost` before testing affordability.

**Scope of each gate differs.** Pace and reservations are global (one pool); daily caps and
stuck detection are per program (one program going quiet should not stop the others). The daily
cap doubles as the fairness mechanism — once a high-priority program exhausts its allowance, the
slot falls to the next one down, so a low-priority program is throttled but never starved.

### Deadline as priority pressure

A static priority number cannot express "needs to be done by September." Rather than a scheduler,
a program with a `deadline` inside the horizon is promoted one priority step, and keeps the
promotion while overdue. One number, legible in `drovr status`, and it decays naturally when the
date stops mattering (by the program being finished or reconfigured).

## Durability and the human interface

The aice program bundle is not a report. It is the loop's **durable state and its only human
interface** — everything else (context, terminal, session) is disposable by design.

| Page | Updated | Authored by |
|---|---|---|
| overview | when program shape changes | Sonnet subagent |
| progress | at each meaningful seam | Sonnet subagent |
| status | every tick | **drovr, mechanically** |
| asks | the moment an ask is raised | Sonnet subagent |

Pages are **per program** — aice-x is itself a program. Programs live on different aice installs
(propra vs aice-x, the latter needing `--agent claude`), so page paths and publish flags travel
with the program entry in `control.json`. Checking N pages for N programs is deliberate.

**Asks are write-through.** A cycle runs for hours; an ask discovered early and published at
wind-down blocks Craig for the whole cycle, and a cycle that dies on a wall never publishes it.

**Asks are non-blocking.** An ask parks that thread of work, not the cycle. The loop moves to the
next backlog item and only stops when everything remaining is blocked — otherwise "raise an ask"
becomes babysitting under another name.

**`aice notes` is the inbound channel.** Craig answers in the page's notes; the next cycle reads
`aice notes list <page> --json` at scan, acts, and resolves the thread. Resolve state gives the
loop a clean "has this been answered" test and Craig a record of which answers were consumed.
(Shared notes must be toggled on by the page owner — a manual prerequisite.)

### Why authoring is dispatched, not templated

An earlier draft had drovr render every page deterministically, to keep wrap-up cheap when context
is tightest. Dispatching to a subagent solves the context problem outright — the runner pays a
brief and a short result — and preserves the flexibility a fixed template can't give (per-program
structure, prose, diagrams).

Two pieces of the templating argument survive:

- The runner writes a **compact brief** of what happened this cycle, so the subagent doesn't need
  the runner's context to author accurately.
- The subagent is given the **currently published page** (`aice get`) and asked to *edit* it, not
  regenerate it. Regeneration produces restyling churn that hides what actually changed.

**status.html stays mechanical** because the supervisor must be able to render it when a cycle
dies before it could publish. It's tabular anyway, so no judgement is lost — and the status page
never silently goes stale at exactly the moment Craig would want to know.


## Visualising the allocation

Craig needs to see, at a glance, how much capacity is reserved for his own use. Each quota
bucket divides into five segments that sum to the whole pool (N usable accounts = N.0):
his spend, program spend, in-flight reservations, free-to-programs, and the slice held above
the ceiling that drovr can never reach.

The subtle part is where headroom comes from. Computing it as `ceiling × accounts - used`
looks natural and is wrong: it lets one account's overspend eat another account's headroom.
With karen at 99% general and craig.adam at 8%, that formula reported 6% free while `decide()`
admitted cycles against 21% — a visualization contradicting the decision it sits above.

Headroom is therefore taken from the same `Pool` the decision uses, which clamps each account
at its own ceiling and floors it at zero. `yoursReserved` becomes the remainder
(`total - used - headroom`), so the bar stacks exactly and stays consistent by construction.

Program spend is carved *out of* observed usage rather than added on top: what the ledger
claims is subtracted from the bucket total, and the rest is attributed to Craig. A ledger that
over-reports (an account dropped out of the pool mid-window) is clamped rather than inventing
usage that is not there.

## Onboarding

Self-detecting: no `state.json` for the program means this is an onboarding cycle. A flag would be
worse — left on it re-onboards forever, forgotten off and cycle 1 runs blind. `--reonboard` exists
for a reconstruction that turned out wrong.

An onboarding cycle harvests existing state (tickets, git, PRs, docs, memories, existing aice
pages), reconstructs, publishes, raises one ask, and **stops**. It does not roll into delivery:
reconstruction is where a fresh loop agent is most confidently wrong, and hours of delivery against
a wrong picture is the expensive failure.

This gate applies **once**. Every later cycle starts on its own — approving each cycle start would
be babysitting.

## Gates, exhaustively

The loop stops for Craig only when:

1. **Onboarding** — one time, because everything downstream rests on the reconstruction.
2. **Human-operator-only work** — prod soak, manual verification, anything it physically can't do.
3. **Expensive-if-wrong ambiguity** — irreversible or hard to unwind. Guessing is fine when being
   wrong costs a redo.
4. **Stuck detection** — N consecutive zero-yield cycles. That's a bug report, not a gate.

Everything else proceeds.

## Telemetry

Written incrementally, not at wrap-up: a cycle that dies on a quota wall is the most informative
one, and it's exactly the one that would lose its record.

`cycles.jsonl` — pool before/after, exit reason, yield, startup tokens, asks raised.
`decisions.jsonl` — every tick's verdict, reason, pool, cycles fundable.

The two signals worth most:

- **Exit reason distribution** — are cycles ending at the context ceiling, or dying on capacity
  first? Tells you whether 250k is the right number.
- **Startup tokens** — the re-onboarding tax. Sets whether cycles should be longer (high tax) or
  can be cut earlier at seams (low tax). Cycle length is the main lever on total efficiency.

Records are shapes and counts, never content — no ticket text, no diffs. Schema is versioned (`v`)
because what's collected will change.

Deliberately **not** built: trend analysis, a telemetry page, self-proposed tuning. The data is
captured; the analysis can be asked for when it's actually wanted.

## Non-goals

- **Killing cycles.** The supervisor starts them; they end themselves.
- **Pinning accounts** (`TC_ACCT`). The point is to spread across accounts.
- **Mutating teamclaude state.** No `disable`/`enable`, no `priority`, no `probe` changes.
- **Enforcing branch policy.** The `/project-loop` skill and Craig's own oversight own that.
