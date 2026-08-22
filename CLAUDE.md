# drovr

Capacity-aware supervisor deciding **when** a `/project-loop` cycle may start, based on pooled
Anthropic quota across Craig's teamclaude accounts. Read `docs/design.md` before changing any
decision logic — it records why several obvious-looking approaches are wrong.

## Non-negotiables

- **drovr never kills a cycle.** Cycles run for hours and end themselves (context ceiling,
  thinning capacity, a natural seam, everything blocked). The supervisor only decides when to
  *start* one. The single exception is the operator pressing `x` in the watch view.
- **drovr never mutates teamclaude state.** No `disable`/`enable`, no `priority`, no `probe`
  changes. Those are global and shared with Craig's own foreground sessions; a supervisor that
  crashes mid-change would silently take an account away from him. Model capacity honestly
  instead of manipulating the pool.
- **Tick must return in seconds.** It detaches `drovr run-cycle <program>` per admitted program.
  Never `await` a cycle inside `tick` — one hours-long cycle would block every other program.
- **`decide()` stays pure.** All I/O happens in the caller. It is the only place judgement lives
  and it must remain testable against recorded status JSON.

## The capacity model, in one paragraph

teamclaude reports used-*fractions* and never an absolute quota size, so everything is measured in
account-units (N usable accounts = N.0) and a cycle's cost is only knowable as the pool delta it
produced. The three buckets (`unified7dFable`, `unified7d`, `unified5h`) are **not a hierarchy** —
one Fable token decrements all three, so they bind simultaneously and the tightest wins. Rotation
is per-request, so the Fable runner and its Opus subagents can land on different accounts; capacity
is therefore pooled, never per-account. Admission requires funding a *whole* cycle plus a reserve,
because a truncated cycle pays full onboarding cost for partial delivery.

## Traps that have already bitten

Each of these was a real bug. Re-read before touching the relevant file.

| Area | Trap |
|---|---|
| `capacity.ts` | Headroom must clamp per account (`max(0, ceiling - used)`) before summing. Computing `ceiling × N - totalUsed` lets one blown account eat another's headroom. |
| `ledger.ts` | The 5h window resets *during* a multi-hour cycle, so `poolAfter > poolBefore` is normal. Recording that as zero cost drags the median to nothing until session stops constraining admission. Discard the sample instead. |
| `decide.ts` | Report *which* bucket binds. A 5h hold recovers in hours, a weekly one in days; reporting the soonest reset across all three is actively misleading. |
| `decide.ts` | In-flight cycles have not shown up as spent quota yet. Subtract `running × cost` or N concurrent programs each claim the whole pool. |
| `allocation.ts` | Bar segments must derive headroom from the same `Pool` `decide()` uses, or the picture contradicts the verdict printed beneath it. |
| `tick.ts` | Pace and reservations are **global** (one shared pool); daily caps and stuck detection are **per program**. |
| `watch.ts` | `setInterval` keeps the event loop alive — do not `unref()` it, and restore the cursor and raw mode on every exit path. |

## The CLI is read by agents

Help lives in `help.ts` as a command registry, not scattered strings. When adding or changing a
command, update its entry there — `drovr help`, `drovr help <cmd>`, `<cmd> --help` and
`help --json` all render from it, so they cannot drift apart.

Two rules for anything the CLI prints:

- **Name the fix, not a reference to it.** "run the launchctl bootstrap line" is useless to a
  reader who never saw it printed. Emit the literal command.
- **Structured output is not minimal output.** The consumer interprets rather than deserializes,
  so JSON carries units and meanings inline, ISO timestamps rather than epoch millis, and
  rounded floats. `AGENT_NOTES` in `help.ts` holds the shared vocabulary.

Never document a flag before implementing it — a help page that lies is worse than a missing one.

## Conventions

- Node >= 24, TypeScript run directly (no build step). Erasable syntax only — no enums, no
  parameter properties.
- Zod for anything crossing a process boundary (teamclaude JSON, control file, cycle reports).
  Never cast external data.
- `node --test test/*.spec.ts`. Test pure functions; no mocks or spies. The `keys.spec.ts` suite
  uses real temp files because those functions write Craig's live config.
- `pnpm check-types` is the gate. Editor diagnostics lag behind edits — trust `tsc`.
- Comments explain *why*, never *what*. Most functions should not have one.

## Interfaces to other tools

- **teamclaude** — read-only, via `teamclaude status --json`.
- **direnv** — cycles and publishes run through `direnv exec <cwd>` so each program repo's own
  `.envrc` supplies its aice install and tokens. Do not duplicate that into `control.json`.
- **aice** — one install per program (`sunnyt.aicex.app`, `joinery.aicex.app`, `aice.aice-x.com`).
  drovr only ever publishes `status.html`; the loop agent owns the other pages.
- **`~/.claude/skills/project-loop/SKILL.md`** — the other half of this system. It owns cycle-end
  triggers, the `last-cycle.json` report contract, onboarding, and the aice pages. Changes to the
  report shape must land in both places.
