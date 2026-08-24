# drovr

Capacity-aware supervisor deciding **when** a `/project-loop` cycle may start, based on pooled
Anthropic quota across Craig's teamclaude accounts. Read `docs/design.md` before changing any
decision logic — it records why several obvious-looking approaches are wrong.

## Non-negotiables

- **drovr never kills a cycle.** Cycles run for hours and end themselves (context ceiling,
  thinning capacity, a natural seam, everything blocked). The supervisor only decides when to
  *start* one, then watches. `x` in the watch view sends an interrupt, not a kill, so the runner
  still winds down and makes its work durable.
- **A cycle is an interactive herdr session, not a background process.** Craig has to be able to
  read it and talk to it mid-cycle. drovr creates an unfocused tab in the program's own workspace
  and starts a `claude` agent in it; the proxy comes from `teamclaude env`, not from wrapping the
  command in `teamclaude run`. Because drovr does not own the process, completion is detected from
  the report file or from the agent vanishing — never from an exit code it waited on.
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
| `watch.ts` | Draw on the **alternate screen** (`?1049h`), home-and-clear-per-line rather than clearing the whole screen, clamp to `stdout.rows`, and never end a frame with a newline. Any one of those missing and the frame scrolls or pollutes shell scrollback. |
| `watch.ts` | Clip every line to `stdout.columns` using visible length, not string length — a soft-wrapped line shoves the whole frame upward. Wrap the keybar rather than clipping it: a key you cannot see is a key you do not have. |
| `asks.ts` | Reading notes needs shared notes enabled on the page by its owner. When it is off the call succeeds and returns nothing, so treat unreadable and unanswered as different things and say which. |
| `decide.ts` | `blocked` means waiting on a human, not broken. Never count it toward the zero-yield stuck streak, and back off rather than re-running every tick to rediscover the same unanswered ask. |
| `watch.ts` | `setInterval` keeps the event loop alive — do not `unref()` it, and restore the cursor and raw mode on every exit path. |
| `cycle.ts` | An interactive claude session cannot end itself — it finishes its turn and idles at the prompt forever. Once the report exists the cycle has declared itself done, so releasing the pane is cleanup, not a kill. Skip it and the pane stays occupied and the next cycle is refused. |
| `service.ts` | launchd holds the plist it loaded, not the file on disk. Rewriting the plist changes nothing until the agent is booted out and back in — that is how a stale PATH survived being fixed. `service install` reloads. |
| `herdr.ts` | Workspaces are long-lived. One tab per program, reused across cycles — a tab per cycle buries the workspace within days. |
| `herdr.ts` | If `teamclaude env` yields no proxy settings, refuse to start. Otherwise the pane runs a raw `claude` against Craig's quota with no rotation and no accounting — silent and expensive. |
| `herdr.ts` | A herdr server restart restores panes as **fresh shells** — cwd and layout survive, environment does not. `resume_agents_on_restore` is on by default and re-runs `claude --resume`, so a restored cycle is un-proxied. Re-assert the env in any reused pane, and refuse to start into a pane that already has an occupant. |
| `herdr.ts` | `agent start` exits non-zero with `agent_not_ready` when claude comes up behind a dialog (a trust prompt, a malformed settings.json). The agent is live and named — wait for idle and prompt it, never treat it as fatal, or a session sits there forever having never been told what to do. |
| `herdr.ts` | Only ever close a tab drovr labelled, in that program own workspace, with no agent in any of its panes. A stray empty tab is untidy; a closed live one is lost work. |
| `herdr.ts` | The runner must be Fable, but Craig's default model must not change. Pass `-- --model fable` to `agent start` (per-session) — never `/model`, a settings file, or an env default. |
| `herdr.ts` | herdr names the agent state field `agent_status`, not `state`. Reading the wrong name parses clean and answers `unknown` — a real herdr status — for every agent, so a finished runner never looks releasable and every tick defers against drovr's own leftover. Parse it strictly and let an unrecognised shape throw. |
| `herdr.ts` | Only send `/exit` to a **settled** agent. A runner keeps working after writing its report; `/exit` typed into that turn is swallowed by it, and the pane is held forever. Return false instead and let the next tick retry — the release has to be retryable, not one-shot. |
| `cycle.ts` | An idle runner with no report is **stalled**, not finished — an interactive session that lost its turn to a 529, or answered Craig and stopped, sits at the prompt forever. The watch loop only ever asked *report yet?* and *agent gone?*, so both held a slot until `maxCycleHours`. Nudge the live session (cheap, keeps its context), bounded, then give up and free the pane. |
| `cycle.ts` | Never nudge a `blocked` agent. It is waiting on a dialog only Craig can answer, and a prompt queues up behind it rather than clearing it. |
| `ledger.ts` | `stalled` counts toward the failure latch alongside `crash`, and toward nothing else. Leave it out and a program that stalls every cycle loops start → nudge×3 → stalled → start forever, paying full onboarding each round. |
| `nudge.ts` | SMS sends on the **default** aws profile, with no `--profile`. The named profiles are SSO-backed and their sessions expire — exactly the state an unattended overnight supervisor finds them in, which is how the alert path sat broken. The default profile is a static IAM user and still works at 4am. |
| `nudge.ts` | SNS accepting a message is not proof a handset got it. Say "accepted", never "delivered", and never build anything that assumes the text arrived — `textCraig` is best-effort on every path. |
| `nudge.ts` | A rejected `originationNumber` fails at *delivery* time, long after `sns publish` returned a MessageId and exit 0. Nothing in the CLI response says so — the reason appears only in the `DirectPublishToPhoneNumber/Failure` CloudWatch log group. Never conclude a send worked from its exit code; read the log. |

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

## Not yet observed working

Written and type-checked, never seen to fire. Unproven, not done:

- **A full ask → answer → auto-resume round trip.** Both halves have been seen separately.
- **`headless` runner mode** — a fallback, exercised once early, untouched since the herdr runner
  landed.

## Notifications

`drovr notify` texts Craig and is the way to prove the alert path before trusting it. Verified
end to end on 2026-08-24.

drovr has its own dedicated Canadian long code, **+1 506 906 8159**
(`phone-dceeb0a0acc6439dbdd0a08ebc73cb98`, $1/month). Every other number in the account belongs
to sunnyt — never borrow one, because their two-way channels route replies into sunnyt's own
inbound topics, which its cycles poll.

**`originationNumber` is null, and null is the working state — not an unfinished one.** Left
null, SNS picks a number itself and every message delivers. Setting it to drovr's own number
makes every message fail *after* `sns publish` has returned a MessageId and exit 0, with the
reason visible only in the `DirectPublishToPhoneNumber/Failure` log group: "The provided number
does not exist or does not belong to the account".

Measured on 2026-08-24, sending to the same handset:

| origination | age | pooled | delivered |
|---|---|---|---|
| `+12362058605` | 11 months | yes | **yes** |
| `+14313415075` | months | no | no |
| `+15069068159` (drovr's) | minutes | no, then yes | no, and still no |

Pooling the new number changed nothing, so pool membership is **not** the discriminator —
an earlier version of this file claimed it was, on two data points, and was wrong. The
remaining untested variable is the number's age: explicit origination may need a
newly-acquired number to settle on AWS's side for longer than a few minutes. Retry
`drovr notify` with it set, a day after 2026-08-24, and record the result here either way.

That number also has no two-way (a reply goes nowhere) and no deletion protection.

## The repo is local-only

There is no git remote, so losing the disk loses drovr. Craig has not asked for it to be pushed
anywhere; do not create one unprompted, but say so if the subject arises.

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
