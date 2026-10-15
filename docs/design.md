# drovr — design

## The contract

Craig's allocation policy, in his own terms. Every mechanism below serves one of these three
sentences; when observed behaviour surprises him, check it against them before reaching for a
new mechanism — this intent has been re-derived from scratch by enough sessions that it now
lives here.

1. **When the pooled accounts have capacity, programs run.**
2. **As capacity drains, lower-priority programs pause first.** The last fundable cycle always
   goes to the most important program (the priority waterline, below).
3. **The mode ceiling is Craig's reserve.** He uses the same accounts by hand, so drovr never
   pushes total usage past the ceiling — at `normal`, ~45% of every window stays his whatever
   the programs do. (`reserveCycles` is a different thing despite the name: runway so an
   admitted cycle can land, not Craig's share.)

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

Those three sums are a **display figure** — how much of each bucket is spent pool-wide, which is
what the allocation bars draw. They are not what admission may spend; see the next section.

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
any account being disabled.

**The coupling is per account, and pooling cannot express it.** Rotation is per request, but a
single request is served by one account, and that one account's Fable token decrements all three
of its buckets. An account is therefore spendable only where it has room in **all three at once**:

```
cyclesFundable = Σ_accounts min(fableHeadroom/F, generalHeadroom/G, sessionHeadroom/S)
```

The first version of this instead wrote `min(poolFable/F, poolGeneral/G, poolSession/S)` and a
comment in `capacity.ts` claiming the min-at-the-decision-point encoded the coupling. It does not:
**min-of-sums is not sum-of-mins.** Summing a bucket across accounts lets an account donate
headroom it can never spend because it is exhausted in another bucket, and the later min does not
put it back. Observed live 2026-08-24, ceilings 0.55/0.40:

| account | fable | general | 5h | that account alone funds |
|---|---|---|---|---|
| craig.adam | 0.22 | 0.20 | 0.98 | min(13.2, 17.5, 0) = **0** |
| karen.adam | 0.07 | 0.08 | 0.66 | min(19.2, 23.5, 0) = **0** |
| memberjunction | 0.98 | 0.90 | 0.00 | min(0, 0, 6.3) = **0** |

Per-bucket sums: fable 0.81, general 0.82, session 0.40. `min(0.81/F, 0.82/G, 0.40/S)` at the
measured cost is **6.3 cycles**, and drovr offered exactly that while nothing could run. Summed
per account it is **0**.

The bars still draw the per-bucket sums, deliberately: they answer *how much of each bucket is
spent*, which is a real question. The verdict answers *can a cycle run*. When those two disagree
the reason string says so and names which bucket pins which accounts, because free-looking bars
beside a healthy-looking verdict is exactly what got misread as capacity.

An earlier draft solved the original coupling by calling `teamclaude disable` on such accounts. That was wrong:
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
and the tightest wins. That is what the inner `min()` in `cyclesFundableFrom` expresses — per
account, over that account's own three buckets — and no precedence logic is needed.

But they are not interchangeable either, and treating them as symmetric caused two defects:

**Recovery time depends on which bucket binds.** A 5h window recovers in hours; a weekly one in
days. The first version reported the soonest reset across all three, so a weekly-bound wait
would claim it recovered in two hours. `Pool` now carries a reset per bucket, `cyclesFundableFrom`
returns which bucket binds, and every capacity verdict names it in its pool-level `note`:
`general is tightest, more room in 90h`.

The note is a separate field from the reason on purpose. One pool means one context, so a
reason that carried the whole picture was rewritten near-identically for every program row on
`drovr status` and `drovr watch` — with four programs, the same coupling sentence four times.
The reason now keeps to the program's own numbers (`a start needs 1.50 and the pool has room
for 0.40 cycles`); multi-program surfaces print the note once, beside the bars it exists to
explain, and single-decision surfaces — the decision log, a program's status page — recombine
the two with `fullReason` so each line still stands alone.

With capacity summed per account there is a bucket per account to choose between. Above zero the
reported bucket is the one pinning the account that would serve next — the one with the most to
give. At zero no account serves anything, so the reported bucket is the one whose reset comes
soonest: that is the account that unblocks first, and it is the difference between a two-hour wait
and writing the week off.

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
cyclesFundable - cyclesInFlight >= 1 + reserveCycles
```

In-flight cycles are subtracted from the **cycle count**, not from the pool. They have not shown
up as spent quota yet, so without the subtraction N concurrent programs each claim the whole pool.
Deducting a per-bucket cost from a per-bucket pool no longer models anything once fundability is
summed per account, so the reservation is counted in cycles, where it belongs.

Admission is about *runway*, not headroom. A cycle that starts and cannot finish pays full
onboarding cost for partial delivery, then the next cycle pays it again. The reserve is what
guarantees a cycle can always land — make its work durable, publish its asks — rather than being
cut off mid-flight.

**The reserve does not apply to the 5h bucket**, because that bucket cannot cut a cycle off. It
refills four or five times a day, the ledger's own rule treats it resetting *mid-cycle* as the
normal case for an hours-long cycle, and a runner that reaches its limit waits and continues. A
dry weekly bucket is days of nothing and a cycle admitted into one really can die there; that is
what `reserveCycles` is for. Requiring a whole cycle plus a reserve of a rate limit is the brief's
exact confusion between feasibility and budget.

It was also unsatisfiable. Measured 2026-08-26: p90 session cost 0.390 against a `normal` session
ceiling of 0.400, so `1 + reserveCycles` demanded 0.585 of a window that holds 0.400 — **no single
account could ever clear admission**, whatever its weekly buckets held. That went unnoticed while
session was priced at the median 0.10, because 0.15 fitted comfortably inside 0.40. Moving to a
high percentile was right for the weekly buckets, where a cycle genuinely can eat a week, and
collided here with a reserve that should never have applied. So:

```
binding is fable or general  ->  need 1 + reserveCycles
binding is session           ->  need 1
```

Session still has to cover one whole cycle. Below that a cycle starts and immediately idles
waiting for the window, which holds a pane and a concurrency slot, gets nudged as a stall, and
pays full onboarding for nothing.

Reset-aware waiting falls out of this for free: if the pool can't fund a full cycle it waits, and
after the next reset it can. No separate "should I wait for the reset?" logic is needed.

**Pace** — is the loop ahead of a linear burn of its own weekly allowance?

```
elapsed     = (168 - hoursToWeeklyReset) / 168
spent       = Σ cycle costs since the window opened      (drovr's ledger, not account usage)
allowance   = pool[bucket] + spent                       (what drovr could reach, plus what it took)
line        = max(allowance × elapsed, cycleCost × 2)
off-pace if   spent > line
```

Without this gate a threshold-only policy burns Monday to Wednesday and idles Thursday to Sunday.

The allowance is derived from the **pool**, not from the ceiling. An earlier version granted
`weeklyCeiling × usableAccounts × elapsed` while measuring spend from drovr's ledger alone, so
Craig's foreground work counted on neither side. That made the entitlement systematically too
large and the gate could not fire: measured across 1008 decisions in the seven days to
2026-08-26 it fired **zero** times, while the daily cap refused 267 cycles doing its job for it.

Deriving the allowance from `pool + spent` puts both sides on the same basis — what drovr can
actually reach. Craig's usage is already deducted per account by `capacity.ts`, so this gate
inherits that clamp instead of re-deriving it, and inherits the min-of-sums rule with it. It also
needs neither `weeklyCeiling` nor `usableAccounts`, because the pool encodes both. When Craig has
spent nothing the two formulations are identical, so the change is a generalisation rather than a
different policy: it diverges exactly as far as he is actually consuming the pool.

The `cycleCost × 2` floor is the burst allowance. Linear entitlement from zero refuses the first
cycle of every window — at 1% elapsed the line sits near zero while one finished cycle is already
above it — which would turn a gate meant to smooth the week into one that never lets it start.
Short-term bursting is legitimate; sustained over-spending is what the gate is for.

Session is deliberately absent. It is a five-hour window, so there is no week to pace it across,
and affordability already refuses when it binds.

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
Admission subtracts the count of running cycles from `cyclesFundable` before testing
affordability — see "Two independent gates" above. An earlier version deducted
`running × estimatedCost` from each bucket of the pool instead; that stopped modelling anything
once fundability became a per-account sum, and the helper that did it is gone.

**Scope of each gate differs.** Pace and reservations are global (one pool); daily caps and
stuck detection are per program (one program going quiet should not stop the others). The daily
cap is intended as the fairness mechanism — once a program exhausts its allowance the slot falls
to the next one down, so a program is throttled but never starved.

That intent has never been tested, because the programs have never competed. Over the seven days
to 2026-08-26 the concurrency cap — the only gate where one program can displace another — bound
**once in 1008 decisions**; 467 refusals were a program waiting on its own cycle and 267 were the
daily cap. `priority` is used in exactly one place, as the sort key in `byPriority`, and sort order
only changes an outcome when two programs both say GO into a full slot. The observed shares agree
it is inert: joinery at `priority: 9` received 39 GO verdicts against aice-x's 31 at `priority: 3`.
What determines a program's share is which one happens to be free at each tick.

So `priority` as a *sort key* is a deterministic tiebreak, exercised about once a week, not an
entitlement. `docs/allocation-review.md` argues at length why a weighted fair-queuing layer over
it would be machinery for contention that does not occur — the pool is not contested between
programs, it is contested between drovr and Craig. That is what `usage.jsonl` exists to measure.

### The priority waterline

What the sort key could not do is order the *drain*: with one admission bar for everyone, the
last fundable cycle went to whichever program happened to be free at that tick. Measured
2026-08-27: aice-x (priority 3) took the pool's final cycle at 13:37 while sunnyt (priority 1)
was held for ten minutes by its own leftover pane; sunnyt then waited five hours on the session
reset. That inverts the contract's second sentence.

So each priority step down raises the admission bar by `priorityStepCycles` (default 0.25):

```
required = base(binding) + rank × priorityStepCycles
```

`rank` counts *distinct* effective priorities above the program among enabled programs
(`control.ts:priorityRank`), so ties share a bar and a disabled program deepens nobody's.
A flush pool clears every bar and all programs run; as it drains they pause bottom-up, and
resets bring them back in priority order for free. When the waterline alone is what refuses —
the pool clears the rank-0 bar but not this program's — the reason says who the room is being
kept for: `room for 1.08 cycles, held back for sunnyt — joinery starts above 1.50`.

This is not the fair-queuing the review rejected: no weights, no service history, no quantum.
It is still admission-only — one more term in the bar a program must clear — and it converts
`priority` from a knob that measured inert into the drain order Craig always meant by it.

### Deadline as priority pressure

A static priority number cannot express "needs to be done by September." Rather than a scheduler,
a program with a `deadline` inside the horizon is promoted one priority step, and keeps the
promotion while overdue. One number, legible in `drovr status`, and it decays naturally when the
date stops mattering (by the program being finished or reconfigured).

## When only a human can help

Two states stop a cycle dead and neither is a malfunction, so neither had any escalation.

A runner **blocked on a dialog** — a bash-permission prompt, a trust question — is waiting on
something only Craig can answer. It must never be nudged, because a prompt typed into a dialog
queues up behind it. That was correctly implemented as "do not nudge" and incorrectly implemented
as "do nothing": every non-idle state fell through to `wait`. On 2026-08-27 sunnyt sat at a
permission prompt for most of a 12.8-hour run, holding its pane and a concurrency slot, and was
recorded as a crash at the end of it. Meanwhile an unanswered *ask* — the loop's softer,
asynchronous question channel — had been texting him after 240 minutes for months. The hard
blocker was the silent one.

It now texts after `blockedAlertMinutes` (default 20), once per block, re-armed if the runner
moves and blocks again. It is still never nudged and never given up on: the work is intact, merely
paused, and abandoning it would throw away a cycle that needs only an answer.

### The watch is not the cycle

`maxCycleHours` bounds how long drovr *watches*. It cannot bound the cycle, because drovr never
kills one. So at the deadline the watch loop exits and the runner carries on — leaving drovr
holding a verdict about something it has stopped observing. It recorded `crash`, which is a lie in
the one direction that matters: it says the cycle delivered nothing, and it drops the quota sample
of the longest and most expensive cycles there are.

That is now `abandoned` — a statement about drovr having stopped looking, not about the cycle. It
counts as a **cost sample**, because the spend was real and measured, and it counts toward the
**daily cap not at all**, because delivery is genuinely unknown. Those are different questions and
`DELIVERY_UNKNOWN` exists to keep them apart from the never-ran exits.

The outcome usually arrives minutes later. A runner given up on at 12h that finishes at 12h20m
writes `last-cycle.json` to a file nothing is reading any more. So the next tick **supersedes** the
abandoned record with the report — appended, never rewritten, so history stays append-only and
`latestEnds` is what makes the later record operative. That is why every measurement in
`ledger.ts` reads through it: two end records for one cycle would otherwise price it twice.

It runs before admission, and that ordering is the entire window: `runCycle` clears the report file
before every attempt, so the next admitted cycle would delete the evidence. A late outcome has
exactly one tick in which to be recovered. The same fact makes the guard sound — a report sitting
beside an `abandoned` record can only have been written by that cycle.

A **leftover runner** is the other. When a cycle outlives `maxCycleHours` the watch loop exits and
nothing releases the pane, because `releaseAgent` is only ever called from inside that loop. Every
later cycle for the program then failed on `PaneBusy` — and the real damage was upstream of that:
admission had already booked the program as launched, so `chargeForRunning` charged a whole cycle
against the pool for the rest of the pass. Two other programs went from 1.35 fundable to 0.35 and
were refused, every ten minutes, with `deferred` counting toward no gate at all.

Pane occupancy is now a readiness input, refused before any funding is computed, so an unstartable
program neither takes a slot nor spends anyone else's capacity. Freeing the pane stays manual —
`drovr release <program>` — because an idle runner with no report may hold unsaved work, and
ending it is the one kind of kill the design refuses to make on its own. It declines to touch a
runner that is working or blocked, since `/exit` into a live turn is swallowed and the pane stays
held.

## Staying up unattended

drovr runs from launchd every 600s with nobody watching, so the failure that matters most is not
a wrong decision — it is a silent stop. There were two ways to get one, and they compounded.

**`execFile` has no default timeout.** Every subprocess drovr spawned could hang forever: the
`teamclaude status --json` that runs *first* in both `tick()` and `collectState()`, every `orca`
socket call, `teamclaude env`, the direnv probe, the preview read, `aws` on the alerting path, and
— least documented and most reachable — the `aice publish` inside the tick loop, once per program,
over the network. All of them now go through `runBounded` in `exec.ts`, which takes the ceiling as
a required parameter. Making it a parameter rather than a convention is the point: it had been
forgotten seven times.

**A lock is only reclaimed from a dead holder.** `lock.ts` checks `process.kill(pid, 0)`, which
says nothing about a live process blocked forever on a pipe. So a hung child did not just fail one
tick, it held the tick lock permanently, and every later firing logged `another tick is still
evaluating` while admission stopped with no other symptom.

The fix is not to steal the lock. Two concurrent ticks double-apply panel intents and race the
ledger, and a supervisor that quietly does a thing twice is worse than one that has stopped and
said so. Instead the holder bounds *itself*: `tick()` arms a watchdog for
`control.tickBudgetMinutes` (default 8, against a measured healthy pass of about 8 seconds), and a
pass that overruns releases its own lock, texts Craig, and exits non-zero. The next firing then
finds a free lock.

`process.exit` from a timer rather than a flag some later `await` checks, because an overrun is by
definition a pass that is not reaching its next check — and the timer still fires, since a pass
blocked on a subprocess is blocked on I/O, not on the event loop.

Three layers, in the order they engage:

| Layer | Catches | Cost when it fires |
|---|---|---|
| `runBounded` ceilings | a hung child | that one call fails, the tick ends cleanly |
| tick watchdog | a pass wedged for any other reason | one tick lost, lock freed, Craig texted |
| lock age in `service status` | a holder whose own watchdog did not fire | reported with the pid and `kill` command |

The third is reporting rather than recovery, deliberately. Nothing left can resolve that state
automatically without risking concurrent ticks, so `drovr service status` names the pid and the
command instead of guessing.

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

## Remote hosts

A program may name a `host`: a paired remote Orca runtime, an ssh target, the checkout on the box.
When it does, drovr still runs on the Mac and the cycle runs on the box. The split is deliberate.

**The ledger stays on the Mac.** Admission is one decision over one pool for every program, and
every input to it — control.json, cycles.jsonl, the usage samples, the decision log — is read on
the Mac by one tick under one lock. Moving any of it to a box would either split the ledger (two
supervisors disagreeing about the same quota) or make the Mac's tick depend on a machine that is
*supposed* to be switched off between cycles. So only two things move: the terminal the runner
lives in, and the file it writes when it is done.

**The report comes back over ssh, not a shared folder.** The runner ends its cycle with its own
`drovr report`, on the box, into the box's `DROVR_HOME`. A synced folder would make the report's
appearance on the Mac depend on a sync agent's schedule and could show a half-copied file — the
exact torn-read the staged rename exists to prevent. `ssh <target> cat <path>` on the existing 30s
poll reads whole files only, and it fails *loudly*: cat's own "No such file" is "not yet", and
anything else — a dark box, a refused key — is a failed poll counted toward `MAX_POLL_FAILURES`
like an orca stall, so a flaky link ends the watch as `abandoned` rather than being swallowed or
recorded as a crash. The path is built as a shell word, not resolved locally, because `~` there is
the box's home and only the box knows it. The remote `drovr report` validates the program name
against the box's own control.json, which is the one operational precondition: the box needs
drovr on PATH with the same program name registered.

**The box's state is the box's own.** Claude's `~/.claude` (transcripts, project memory) and Aven
on the box are written there and read there — the closing message is lifted with the same `cat`
over ssh, failing to "no closing" exactly as an unreadable local transcript does. Nothing syncs
them to the Mac. A program that alternates between hosts will have two memories, and that is a
sync problem to solve on purpose, not something drovr should paper over on a poll.

**Every orca call carries the environment.** A handle issued by a remote runtime answers
`terminal_handle_stale` to any call without `--environment <id>` (measured 2026-10-15), so the
remembered terminal records which runtime issued it and `envArgs` is appended to every create,
show, wait, send, read, close and list. Empty on the Mac: a local cycle issues the same calls it
always did.

**Wake is a step, not a gate.** A stopped box is the normal state between cycles, so before the
worktree is resolved drovr probes `ssh <target> true`; if that fails and the program has a `wake`
command, it runs it locally (bounded, six minutes — an EC2 instance from stopped) and probes once
more. Still dark is an ordinary error through the existing crash path; no new exit reason, because
"the box did not come up" is a thing that went wrong, not a verdict about capacity.

**The teamclaude exception.** The Mac launch is `teamclaude run -- …`, which is where the proxy
and the account rotation come from. The box has no teamclaude server — the pool is Mac-local —
and its `claude` alias routes through one anyway, so the host launch names the configured binary
(`host.claude`, default `~/.local/bin/claude`) with the same `--model`, `--name` and
`--session-id`. The box's claude logs in with its own subscription; drovr's capacity model prices
that cycle like any other, from the pool delta it observes, which is honest only insofar as the
box's requests land on the same accounts. If they do not, the cycle reads as nearly free.

## Non-goals

- **Killing cycles.** The supervisor starts them; they end themselves.
- **Pinning accounts** (`TC_ACCT`). The point is to spread across accounts.
- **Mutating teamclaude state.** No `disable`/`enable`, no `priority`, no `probe` changes.
- **Enforcing branch policy.** The `/project-loop` skill and Craig's own oversight own that.
