# Review: drovr against the multi-timescale fair-allocation brief

Written 2026-08-26 against an outside brief that reframes drovr as a *reserve-aware weighted
fair scheduler over a heterogeneous worker pool*. The brief's layering is the right lens and
most of it is already how drovr is built. Its central recommendation is not, and the evidence
says it should not be.

Everything below is measured against `~/.drovr/cycles.jsonl` and `decisions.jsonl` over the
seven days to 2026-08-26 — 1008 decisions, 143 cycle starts across three programs.

## The headline

The brief's central proposal is **weighted max-min fairness among managed consumers** (§7, §11),
and it explicitly defers modelling **unmanaged demand** to "longer-term" (§16). For drovr that is
exactly backwards.

Contention between programs is not a thing that happens here:

| gate that refused a cycle | 7-day count |
|---|---|
| its own cycle already running | 467 |
| daily cap reached | 267 |
| capacity (`… tightest — funds N`) | 26 |
| **concurrency cap (`N ahead of it`)** | **1** |
| **pace (`ahead of pace on …`)** | **0** |

The concurrency cap — the only place where one program can displace another — bound **once in
1008 decisions**. Whatever weighted fair queuing would decide, it would decide it about one
tick per week. A `λ`-solver, deficit counters, or service-history accounting would be machinery
for a contention that does not occur.

Meanwhile the unmanaged consumer is the *larger* consumer. Over the same window drovr's ledger
records **1.02 account-units** of weekly Fable spend against a live pool reading of **2.19 units
consumed** — Craig's own foreground sessions took **~1.17**, more than all three programs
combined. The one thing drovr models with a hand-set constant is the majority of the load.

> The pool is not contested between programs. It is contested between drovr and Craig.

## Layer scorecard

The brief's five layers (§17), mapped to files:

| Layer | Where | Verdict |
|---|---|---|
| Physical capacity and constraints | `teamclaude.ts` → `capacity.ts:poolFrom` | **Sound.** Three simultaneous buckets, per-account, never averaged. |
| Reserve / headroom policy | `capacity.ts:headroom` | **Sound and correctly placed.** `max(0, ceiling - used)` per account, provider-side — the brief's §3 verbatim, including that external usage counts against `used`. |
| Effective allocatable capacity | `decide.ts:fundingFor` → `AccountFunding` | **Sound, arguably ahead of the brief.** §6 proposes `R = Σ_w r_w`; drovr already computes `Σ_accounts min_bucket(headroom/cost)` and knows *which* bucket binds *whom*. |
| Fair allocation among consumers | `control.ts:byPriority` | **Absent.** Strict priority ordinal, no weights, no service history. See below — this is fine. |
| Assignment of work to workers | — | **Not drovr's.** teamclaude rotates per request. Read-only on teamclaude state is a non-negotiable. §9 — the brief's longest section — is inapplicable. |

Against the brief's own list of failure modes (§13), drovr avoids every one that applies:
it never averages constraint utilization, never treats remaining capacity without a horizon,
never fixed-partitions, and never chases 100% managed utilization. "Strict priority queues by
default" is the only hit, and finding 3 shows it is inert rather than harmful.

Observability (§14F) is the strongest part of the system and needs nothing: `AccountFunding[]`,
`couplingNote`, `concentrationNote` and the decision log already emit per-worker safe capacity,
binding constraint, and an accept/reject reason in prose.

## Findings, ranked by evidence

### 1. The pace gate has never fired, because its two sides are measured on different bases

`paceExceeded` compares

```
entitlement = weeklyCeiling × usableAccounts × elapsed     ← total-pool basis
spent       = Σ drovr's own cycle costs                     ← drovr-only basis
```

`design.md` argues for the drovr-only numerator deliberately, so Craig's foreground work
constrains the pool through the ceiling without also counting against the loop's pace. That
reasoning is sound — but the *denominator* was never moved to match. Entitlement is still
computed as though drovr owns 55% of all three accounts for the whole week (1.65 units); drovr
actually spent 1.02, so the gate cannot fire, and it hasn't: **0 of 1008**.

This is the brief's §3 caution — *be precise about whether externally consumed capacity counts
against `consumed`* — landing on a real inconsistency. Either side is defensible; mixing them
grants a systematic over-entitlement.

Two honest resolutions:

- **Delete it.** The daily cap already does the throttling it was written for (267 refusals),
  and a gate that has never fired is a gate nobody has tested.
- **Re-base the entitlement** on what drovr can actually reach: entitlement should be the
  headroom that existed under the ceiling, integrated over the window, not `ceiling × accounts`.

Deleting is the smaller lie. Re-basing is the better model. Not both.

### 2. Unmanaged demand is the majority of load and is modelled by a constant

`ceilings.weekly` is a fixed fraction chosen by mode. The consumer it exists to protect took
1.17 units last week against drovr's 1.02, and its variance is what actually pins accounts —
live right now, `craig` sits at 0.97 weekly and `craig.adam` at 0.90, both above every mode
ceiling, leaving a three-account pool resting on one.

The brief defers this to §16 as "longer-term chance-constrained planning". It should be
promoted, but not to that. Chance-constrained allocation is far more than this needs. The cheap
version is already sitting in `allocation.ts`: `yoursSpent = usedTotal − programsSpent` is
computed on every render and thrown away. Recording it per tick would give a directly observed
distribution of Craig's burn rate — enough to answer "is 45% a reserve or a wish?" with a number
instead of a mode name.

That is a **measurement** change, not a policy change, and it is the one place in this brief
where established art would materially improve outcomes.

### 3. `priority` is decorative — evidence, not opinion

`control.ts` documents it as "lower wins the next capacity slot". It is used in exactly one
place: as a sort key in `byPriority`. Sort order only changes an outcome when two programs both
say GO and the concurrency cap binds — which happened **once in seven days**.

The observed shares agree. joinery at `priority: 9` (lowest) received **39 GO verdicts**;
aice-x at `priority: 3` received **31**. The ordinal did not merely fail to allocate
proportionally — it did not correlate at all. What determined each program's share was which
one happened to be free at each tick.

`deadline` inherits the same fate: it promotes by one step within a knob that has never
mattered.

The brief (§2) asks for `priority`'s operational semantics to be documented before being
converted into a weight. Documented honestly, they are: *a deterministic tiebreak, exercised
once a week*. That does not justify a fairness layer on top of it. It does justify saying so in
`design.md`, whose current claim — "the daily cap doubles as the fairness mechanism … a
low-priority program is throttled but never starved" — describes a mechanism that has never
been under load.

### 4. The daily cap is the real budget, and it is unrelated to quota

267 of 1008 refusals were `daily cap reached`; both active programs hit 8/8 on 2026-08-24. The
cap is the dominant limiter in the system, and it is a count of cycles with no relationship to
what a cycle costs or what the pool holds.

That is not automatically wrong — a count cap is a legible, bounded, easily-reasoned throttle,
which is worth a lot. But it means the capacity model that the rest of this codebase is built
around is refusing cycles roughly one time in ten, while a hand-set integer refuses them ten
times as often. Worth deciding whether the cap is policy ("no program should do more than eight
cycles a day regardless") or a proxy for capacity that the capacity model should now be trusted
to handle itself, since it is priced honestly as of `65dbf05`.

### 5. `decide()` is eleven gates in one function

Mode, enabled, zero-yield, failure latch, pause, blocked-backoff, in-flight, concurrency, daily
cap, unanswered asks, pace, affordability — ~130 lines, against this repo's own 40–60 line rule.
Two unrelated concerns are fused: **program readiness** (is this program in a fit state to run?)
and **capacity** (can the pool afford it?). The brief's closing principle (§17) is precisely
this: *capacity feasibility, reserve policy, consumer fairness and worker selection should not
be one algorithm.*

Splitting `programReadiness()` from `capacityVerdict()` keeps `decide()` pure, makes each half
independently testable against recorded status JSON, and costs nothing at the call site. It is
the one refactor here that is worth doing on the code-discipline argument alone.

### 6. Two different things are called "reserve"

`ceilings.weekly` is a provider-side capacity reserve (brief §3). `reserveCycles` is an
admission-control safety margin denominated in cycles (brief §4 pacing/queueing headroom). They
are different concepts at different layers and the shared word makes `drovr status` harder to
read than it needs to be.

### 7. Not an allocation problem, but the loudest thing in the ledger

joinery: **31 crashes in 39 starts**. It has produced two delivering cycles in seven days and
27 of its refusals were the failure latch. Whatever fairness policy sits above it, joinery is
not being starved of capacity — it is failing to run.

## What to reject

- **§7 / §11 weighted fair queuing, deficit round robin, service-history accounting.** Solving
  contention measured at 1 event per 1008 decisions. Also a poor fit in kind: drovr's unit of
  allocation is one indivisible cycle lasting hours, so GPS-style proportional sharing has no
  quantum to divide.
- **§9 worker assignment and the whole bipartite-matching family.** teamclaude routes per
  request; drovr cannot choose an account and must not try to.
- **§8 hierarchical classes.** There are three programs and one of them is broken.
- **§16 chance-constrained optimization as stated.** The *measurement* underneath it is finding
  2 and is worth doing. The optimizer on top of it is not.

## Recommendation

Three changes, in order, none of them a scheduler:

1. **Record `yoursSpent` per tick** so the reserve can eventually be argued from Craig's observed
   burn rate rather than a mode name. Cheapest, and it addresses the only genuinely unmodelled
   consumer.
2. **Resolve the pace gate** — delete it or re-base its entitlement. It currently reads as an
   active safeguard and is not one.
3. **Split `decide()`** into readiness and capacity.

## Addendum, 2026-08-26

All three landed, and finding 1's fix exposed a fourth. Re-basing the pace gate and pricing
cycles at p90 made the *session* requirement `1.5 x 0.390 = 0.585` against a `normal` session
ceiling of `0.400` — unsatisfiable by any single account. The reserve had been applied to a
bucket where it means nothing: the 5h window refills four or five times a day and only makes a
runner wait, while a dry weekly bucket is days and can genuinely kill a cycle. `reserveCycles`
now applies to the weekly buckets only; session must still cover one whole cycle.

Craig spotted this from the account bars alone — one account a third through its week with three
days left, one fresh, one nearly reset — and read it as "plenty of capacity, crack on", against
drovr saying WAIT. He was right, which is worth recording: the brief's feasibility-versus-pacing
distinction (its section 4) is the same observation, and drovr had collapsed the two.

Still unhandled, and his second point: **capacity is perishable and nothing notices underspend.**
The pace gate is a ceiling with no floor, so roughly 12 cycles of weekly capacity can evaporate
unused with drovr reporting itself perfectly healthy.

And one documentation correction: `design.md`'s fairness claim should say what the ledger says,
which is that program fairness has never been tested because programs have never competed.
