# drovr

Capacity-aware supervisor deciding **when** a `/project-loop` cycle may start, based on pooled
Anthropic quota across Craig's teamclaude accounts. Read `docs/design.md` before changing any
decision logic — it records why several obvious-looking approaches are wrong.

## Non-negotiables

- **drovr never kills a cycle.** Cycles run for hours and end themselves (context ceiling,
  thinning capacity, a natural seam, everything blocked). The supervisor only decides when to
  *start* one, then watches. `x` in the watch view sends an interrupt, not a kill, so the runner
  still winds down and makes its work durable.
- **A cycle is an interactive Orca terminal session, not a background process.** Craig has to be
  able to read it and talk to it mid-cycle. drovr opens an unfocused terminal in the program's own
  Orca worktree running `teamclaude run -- --model fable`, waits for claude to come up idle, and
  prompts it. The proxy comes from `teamclaude run`, exactly as Craig's own `claude` alias does.
  Because drovr does not own the process, completion is detected from the report file or from the
  agent vanishing — never from an exit code it waited on.
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
is per-request, so the Fable runner and its Opus subagents can land on different accounts; usage is
therefore pooled across accounts. But each request is served by *one* account and decrements *its*
three buckets, so an account is spendable only where it has room in all three at once: fundability
is `Σ_accounts min_bucket(headroom/cost)`, never the min of the per-bucket sums. Admission requires funding a *whole* cycle plus a reserve,
because a truncated cycle pays full onboarding cost for partial delivery. Since admission is
the only lever — the ceiling is checked when a cycle starts and never again — a cycle is priced
at a high percentile of what cycles have actually cost, and one already in flight is charged
whatever it has really drained. Priority is a drain order, not a tiebreak: each distinct step
down raises a program's admission bar by `priorityStepCycles`, so as the pool thins the
lowest-priority programs pause first and the last fundable cycle goes to the top one
(design.md, "The contract"). And an account only
counts if teamclaude's fable route will actually route to it — eligibility there tracks usage
against its own `switchThreshold`, so an ineligible account usually returns at its next reset.

## Traps that have already bitten

Each of these was a real bug. Re-read before touching the relevant file.

| Area | Trap |
|---|---|
| `capacity.ts` | Headroom must clamp per account (`max(0, ceiling - used)`) before summing. Computing `ceiling × N - totalUsed` lets one blown account eat another's headroom. |
| `capacity.ts` | The per-bucket sums are a display figure, never fundability. **Min-of-sums is not sum-of-mins**: summing a bucket across accounts lets an account donate headroom it cannot spend because it is exhausted in another bucket, and a later `min` does not put it back. One Fable token decrements all three buckets *on the one account that served the request*, so capacity is `Σ_accounts min_bucket(headroom/cost)`. Live 2026-08-24 this offered 6.3 cycles while every account was pinned and nothing could run. |
| `decide.ts` | With capacity summed per account there is a binding bucket per account. Above zero report the one pinning the account that would serve next (most fundable); at zero report the one whose reset comes soonest, since that account unblocks first. Getting this backwards turns a two-hour session hold into an apparent week-long write-off. |
| `ledger.ts` | Price a cycle at a **high percentile** of observed cost, never the median. Cost is badly right-skewed — measured 2026-08-26 over 33 samples: median 0.10 session, mean 0.16, max 0.58 — so a median under-prices half of all cycles *by construction* and the tail by six times. This number is what the reserve is denominated in; sized for the typical cycle it is not a reserve. |
| `ledger.ts` | Charge an in-flight cycle whichever is worse: its price, or what the pool has actually lost since it started. A flat estimate per running cycle is how three cycles pinned three accounts on 2026-08-25 — each billed 0.085 session while draining 0.23 to 0.58, so drovr kept admitting against room already gone. Floor each at one cycle: one that started seconds ago has drained nothing and is about to drain plenty. |
| `decide.ts` | `reserveCycles` applies to the **weekly** buckets only. A dry weekly bucket is days of nothing and can genuinely kill a cycle mid-flight; a dry 5h window refills four or five times a day, is documented as resetting mid-cycle, and only makes a runner wait. Requiring `1 + reserveCycles` of a rate limit was also unsatisfiable in practice: measured 2026-08-26, p90 session cost 0.390 against a `normal` session ceiling of 0.400 demanded 0.585 of a window holding 0.400, so no single account could clear admission whatever its weekly buckets held. Harmless while session was priced at the median 0.10 (0.15 fits inside 0.40) — the high-percentile change was right for weekly and collided here. Session still needs a full 1.0, or a cycle starts and idles on a held pane. |
| `decide.ts` | Do not explain the session/weekly threshold asymmetry on the WAIT line. `requiredCycles` and design.md carry the why; a question asked once does not belong on a line printed every tick. The one raise that *is* explained is the priority waterline ("held back for …"), because a reader who sees room needs to know who it is kept for. Reason and note each stay inside `drovr watch`'s 200-character `REASON_BUDGET` — they are drawn as separate wrapped blocks. |
| `decide.ts` | `reason` is the per-program half only; the pool context (binding bucket, recovery, coupling) lives in `note`, identical for every program in a pass. A single-decision surface (decisions.jsonl, a program's status page) must recombine with `fullReason()` or it silently drops the coupling warning; a multi-program surface must print `DrovrState.capacityNote` once beside the bars, or it either shows the warning nowhere or rewrites it for every program row — the duplication the split exists to stop. |
| `decide.ts` | `requiredCycles` takes a rank. A renderer that calls it with a hardcoded 0 shows a lower bar than admission uses — the `state.ts` drift failure again, in the direction that reads as free capacity. `priorityRank` counts **startable** programs and **distinct** effective priorities: count raw entries and a disabled program deepens everyone's bar, or two equal-priority programs get different bars by name sort. |
| `control.ts` | Startable means enabled **and not held for time**: a program resting (`pauseUntil`) or inside a shut cadence window has declared it will not start, and holding room below the waterline for it is the disabled-program failure with a timer on it — measured 2026-08-29, sunnyt resting 20h shadowed aice-x out of a pool whose session bucket refilled four times before the wake. `blocked` still shadows: an answer can arrive any second. `priorityRank` takes `lastStartFor` because judging *other* programs' cadence windows needs ledger data control.ts must not read itself. |
| `decide.ts` | **A ceiling is a starting gate, not a budget.** Headroom is evaluated at admission and drovr never kills a cycle, so a cycle admitted just under `session 0.40` can run to 0.99 and there is nothing downstream to stop it. Admission is the only lever there is, which is exactly why the price has to cover the expensive case rather than the typical one. |
| `ledger.ts` | The 5h window resets *during* a multi-hour cycle, so `poolAfter > poolBefore` is normal. Recording that as zero cost drags the median to nothing until session stops constraining admission. Discard the sample instead. |
| `decide.ts` | Report *which* bucket binds. A 5h hold recovers in hours, a weekly one in days; reporting the soonest reset across all three is actively misleading. |
| `decide.ts` | In-flight cycles have not shown up as spent quota yet, or N concurrent programs each claim the whole pool. Subtract them from the **cycle count** — `cyclesFundableFrom`'s `running` argument. Not `running × cost` off a per-bucket pool: that was `lessReserved`, and it models nothing now that fundability is summed per account. |
| `allocation.ts` | Bar segments must derive headroom from the same `Pool` `decide()` uses, or the picture contradicts the verdict printed beneath it. The bars answer *how much of each bucket is spent* and the verdict answers *can a cycle run* — those legitimately differ, so the reason string has to name the coupling when it is what refuses. |
| `tick.ts` | Pace and reservations are **global** (one shared pool); daily caps and stuck detection are **per program**. |
| `decide.ts` | Programs may share a `cwd` but never a moment: `admissionLimits` holds a program while any sibling program's cycle runs in the same directory — two interactive runners in one checkout race the git index and commit each other's half-done work. A **disabled** sibling's running cycle still holds it (the runner is real either way), and tick folding same-pass launches into `running` is what serializes two same-cwd admissions inside one tick. Everything else about a program is keyed by **name**; nothing dedupes on cwd. |
| `watch.ts` | Draw on the **alternate screen** (`?1049h`), home-and-clear-per-line rather than clearing the whole screen, clamp to `stdout.rows`, and never end a frame with a newline. Any one of those missing and the frame scrolls or pollutes shell scrollback. |
| `watch.ts` | Clip every line to `stdout.columns` using visible length, not string length — a soft-wrapped line shoves the whole frame upward. Wrap the keybar rather than clipping it: a key you cannot see is a key you do not have. |
| `watch.ts` | Clamping to `stdout.rows` must **reserve the tail**, not slice it off. The message line, the preview warning and the keybar are appended last, so a plain `slice(0, rows - 1)` takes exactly those three first. At Craig's real configuration the body alone is 28-33 rows at every width, so a 24-row terminal lost all of them — and `x` then armed `confirmStop` with no visible prompt, making the next keystroke either an interrupt or a silent cancel. `frame` owns the clamp and keeps the tail whole; test it by passing a rows budget, since calling `frame(state, view, width)` with no rows exercises a path `watch()` never takes. |
| `asks.ts` | Reading notes needs shared notes enabled on the page by its owner. When it is off the call succeeds and returns nothing, so treat unreadable and unanswered as different things and say which. |
| `exec.ts` | **Never spawn a subprocess except through `runBounded`.** `execFile` has no default timeout, so one hung child holds the tick lock — and `lock.ts` will not reclaim a lock from a live holder, so admission stops with nothing but `another tick is still evaluating` to say why. The ceiling is a required parameter of the only spawn helper rather than per-call-site discipline, because it was already forgotten seven times. Timeouts stay named constants next to the module that uses them: the right number depends on whether the call is a local socket read or a network upload, and a reviewer has to see which. |
| `exec.ts` | `runBounded` must keep returning the **original** error object for non-ENOENT failures. `asks.ts` and others lift a reason out of the child's own stdout (aice prints its error there, not on stderr), and wrapping it in a fresh Error loses that. Only a timeout and an ENOENT become new errors. |
| `tick.ts` | The watchdog is the only thing that clears a wedged tick lock, and it clears it by the holder killing *itself*. Do not make `lock.ts` steal a lock from a live holder to "fix" this: two concurrent ticks race the ledger and double-launch cycles, and a supervisor that quietly does a thing twice is worse than one that has stopped and said so. |
| `tick.ts` | In the watchdog, `release` comes first and everything after it is separately guarded. An earlier draft read `control.json` for the phone number *before* releasing, so a malformed control file threw inside the timer and left the lock held — exactly the state the watchdog exists to end. `process.exit` also skips `finally`, so the release cannot be left to it. |
| `lock.ts` | A bare pid **is valid JSON**, so the legacy format cannot be handled in a `catch`: `JSON.parse('76410')` succeeds and returns a number. Branch on the shape of what came back. Getting this wrong makes every pre-timestamp lock parse as unheld, which means `acquire` succeeds against a live holder and two ticks run at once — caught by a test, not by review. |
| `lock.ts` | An unknown hold age is `null`, never `0`. A legacy bare-pid lock has no timestamp, and reading that as "taken just now" would make a wedged lock look freshly acquired forever. |
| `asks.ts` | Every `aice` call carries an execFile `timeout`. `readAsks` runs inside the tick's per-program loop, so a hung `aice` there holds the tick lock and every later launchd firing logs `another tick is still evaluating` while admission stops silently. Every other spawner goes through `runBounded`; this file predates it and keeps its own bespoke error handling, which is why it is the one exception — and it is now the only `aice` call drovr makes at all. |
| `nudge.ts` | `textCraig` is called from inside the tick, so an unbounded `aws` there means the thing whose job is to say something is wrong takes the supervisor down instead. Bounded at 30s, and best-effort on every path. |
| `decide.ts` | `blocked` means waiting on a human, not broken. Never count it toward the zero-yield stuck streak, and back off rather than re-running every tick to rediscover the same unanswered ask. |
| `watch.ts` | `setInterval` keeps the event loop alive — do not `unref()` it, and restore the cursor and raw mode on every exit path. |
| `cycle.ts` | An interactive claude session cannot end itself — it finishes its turn and idles at the prompt forever. Once the report exists the cycle has declared itself done, so releasing the pane is cleanup, not a kill. Skip it and the pane stays occupied and the next cycle is refused. |
| `service.ts` | launchd holds the plist it loaded, not the file on disk. Rewriting the plist changes nothing until the agent is booted out and back in — that is how a stale PATH survived being fixed. `service install` reloads. |
| `orca.ts` | One terminal per program. The previous cycle's leftover — an idle claude, or the bare shell left once it exited — is released and closed **before** the new terminal is created. A terminal per cycle buries the worktree within days, and reusing a shell by typing a command into it is the send-text trap below. |
| `orca.ts` | Handles are runtime-scoped and every one goes stale on an Orca restart; the **tab id** survives, and Orca resumes the claude session into the restored tab. `runnerTerminal` re-resolves a stale handle through `terminal list` by tab id and rewrites `cycle-terminal.json`. Lose that and a live runner is un-watched while its program is admitted again on top of it — herdr's `resume_agents_on_restore` failure under a new name. |
| `orca.ts` | A refusal is an `ok: false` envelope on stdout **and** a non-zero exit, so `runBounded` throws and the envelope has to be read back out of the error's stdout. Branch on the envelope's `code`, never on the exit code or message: `terminal_handle_stale` / `selector_not_found` mean gone, `timeout` on a tui-idle probe means working, anything else throws. Measured 2026-09-10: from an interactive zsh the exit looked like 0 — that was the shell's, not orca's. |
| `orca.ts` | `terminal show` **omits** `agentIdentity` for a terminal with no agent where `terminal list` sends an explicit null — measured 2026-09-11 on three live terminals of one runtime (two bare shells absent, one claude `"claude"`). Absent is orca saying *no agent*, so both spellings are `gone`. Requiring the field threw on exactly the bare shell every cycle starts as, and `waitForClaude`'s `!== null` would then have read the absence as claude being up: no sunnyt cycle could start. A non-string value still throws. `title` is **null** on a terminal restored by an Orca restart that nothing has written to yet — measured 2026-09-12, when `z.string().optional()` rejected it and nine sunnyt cycles crashed in 300ms each before any terminal existed, all recorded as `crash`. The shape error names the failing field path; a payload prefix hid `title: null` past its 300-character cut for a whole day. The herdr `agent_status` caution survives for `agentWait` only: non-null is `blocked`, null means orca looked and found no wait, absent means it never looked — evidence of nothing. |
| `orca.ts` | `tui-idle` settles on a trust dialog too, and a fresh terminal is a plain shell — idle by definition — for the seconds `teamclaude run` takes to start. So `startCycleAgent` first waits for `agentIdentity` to appear, then for idle, then requires `agentState` to answer exactly `idle` before the prompt is sent. Anything else is `PaneBusy`: live, remembered, prompted by the next tick once Craig answers. |
| `orca.ts` | `show` keeps naming the claude that *was* in a terminal after its pty has exited (measured 2026-09-15: `agentIdentity: "claude"` on a terminal `read` reported `exited`, absent from `terminal list`). A tui-idle probe on that pty just times out, which read as `working` — so `release` refused, `clearLeftover` threw `PaneBusy` every tick, and sunnyt could never be admitted again. `agentState` asks `wait --for exit` (instant either way) before the idle probe; `exitCause` on `show` is not the signal, since live restored terminals carry one from a previous incarnation. |
| `orca.ts` | drovr never types into a shell. The launch command goes through `terminal create --command`, and the only text ever sent to a terminal is a prompt or `/exit` to a claude that `agentState` has just read as settled. Measured 2026-09-01 under herdr: `eval "$(teamclaude env)"` sent into a live claude prompt, eight times, each one a question Craig had to answer. |
| `orca.ts` | The runner must be Fable, but Craig's default model must not change. `--model fable` goes in the launch argv (per session) — never `/model`, a settings file, or an env default. Orca's own claude launcher (`agentCmdOverrides: claude → tcr`) is not used, so its arguments do not matter. |
| `orca.ts` | `PaneBusy` means precisely "the cycle did not start and nothing is wrong": a leftover still working or blocked, one that would not exit, or a new runner that came up behind a dialog. Recorded as a crash it wrote eight 0.2s cycles into aice-x's ledger, feeding the failure latch and the zero-yield streak for a healthy program. |
| `orca.ts` | Only send `/exit` to a **settled** agent. A runner keeps working after writing its report; `/exit` typed into that turn is swallowed by it, and the terminal is held forever. Return false instead and let the next tick retry — the release has to be retryable, not one-shot. |
| everywhere | A terminal handle is drovr's grip, not an address a human can follow: `term_844e…` names no place and no way to get there, which is the "name the fix, not a reference to it" rule failing in six messages at once. `runnerAddress` resolves it to the tab and the command that opens it (`orca terminal switch --terminal <handle>`); the handle survives only as that command's argument. It is best-effort — orca being unreachable costs the message its address, never the message. |
| `cycle.ts` | An idle runner with no report is **stalled**, not finished — an interactive session that lost its turn to a 529, or answered Craig and stopped, sits at the prompt forever. The watch loop only ever asked *report yet?* and *agent gone?*, so both held a slot until `maxCycleHours`. Nudge the live session (cheap, keeps its context), bounded, then give up and free the pane. |
| `cycle.ts` | `maxCycleHours` bounds how long drovr **watches**, not how long a cycle may live — drovr never kills one, so at the deadline the watch exits and the runner keeps going. Recording that as `crash` asserted that a cycle which often *had* delivered produced nothing, and discarded the quota sample of the longest and most expensive cycles there are. It is `abandoned`: a statement about drovr having stopped looking, not about the cycle. |
| `ledger.ts` | `abandoned` is a **cost sample** but not a daily-cap spend. It really drained the quota, and `poolBefore - poolAfter` is a real (if understated) reading of it, so excluding it from pricing threw away the tail. Whether it *delivered* is genuinely unknown, so it must not burn a program's day on a guess either way. That is why `DELIVERY_UNKNOWN` is separate from `DID_NOT_DELIVER` rather than folded into it. |
| `ledger.ts` | Every measurement reads through `latestEnds`. Reconciliation **appends** the real outcome rather than rewriting history, so one cycle can have two end records — and counting both prices that cycle twice, once at its understated abandonment cost and once at its real one. `cyclesStartedSince` needs it most subtly: matching an idle exit on *any* record would keep a reconciled cycle out of the daily cap after drovr had learned it delivered. |
| `tick.ts` | **The runner outlives its watcher.** A cycle is an Orca session drovr does not own, so a dead `run-cycle` — killed, OOM'd, or run in the foreground of a shell that closed — leaves a live runner with an open ledger record and a lock held by a dead pid. `reconcileAbandoned` used to close that as `crash`, which latched a healthy program, discarded its report and asserted nothing was delivered while the runner was still working (measured 2026-09-12: a `run-cycle` run through the Claude Code `!` prompt was killed 37 minutes into a healthy cycle). Now it asks orca: runner present → `launchDetached`, and the worker resumes the **open record** (no start record, no `clearReport`, no new terminal) by reading `startedAt`/`kind`/`poolBefore` back out of the ledger; runner gone → `abandoned` with the current pool as `poolAfter`, so `reconcileLateReports` picks up a report on the same tick; orca unreachable → left open, since a watcher attached blind could not see the runner either. `drovr start` re-attaches the same way. Launch out-of-turn cycles with `drovr start`, never a foreground `run-cycle`. |
| `tick.ts` | `reconcileLateReports` runs **before admission**, and that ordering is the whole window. `runCycle` calls `clearReport` before every attempt, so the next admitted cycle deletes the very report this reads — a late outcome has exactly one tick in which to be recovered. It is also what makes the guard safe: a report sitting beside an `abandoned` record can only have been written by that cycle. |
| `cycle.ts` | **One failed poll must not end the watch.** `watchCycle`'s `runnerState` threw straight out of the loop, so a single orca call over its 20s budget recorded a live, working cycle as `crash` and orphaned its runner — six times 2026-10-01 to 10-05, three in the same second at 03:42. A crash is never reconciled by a late report and feeds the failure latch. Failed polls are now logged and counted; `MAX_POLL_FAILURES` in a row ends the watch as `abandoned`, a statement about drovr, not the cycle. |
| `tick.ts` | **Idle is not done.** A runner sits idle at its prompt while its background shells and monitors run — measured 2026-10-05: relliq idle mid-cycle with an e2e run going. An auto-release of "idle leftovers with no cycle in flight" sent it `/exit` within minutes of landing, and claude answered with an "exit and stop background tasks?" dialog; it was reverted the same hour. Only a runner whose cycle **reported** has declared itself done, and `/exit` to one with background work still opens that dialog, so a retried release must not type into it again. `leftoverAction` is the whole rule — exited: close; idle and `lastCycleReported`: `/exit` once, tracked as `exitSent` in `cycle-terminal.json` by every `/exit` that was ignored, `releaseFinished`'s included; anything else holds for Craig. The dialog is fixed at the source, not answered: the project-loop skill requires a runner to wait for or stop every background task, handing it off in the bootstrap block, before `drovr report`. Answering it from drovr is a bad choice either way — "stop tasks" can leave a half-created worktree, "move to background" orphans a monitor forever. |
| `cycle.ts` | A `blocked` agent is never nudged **and never silent**. "Not nudged" was implemented as every non-idle state falling through to `wait`, so the one state that *requires* a human was the one drovr never told one about. Measured 2026-08-27: sunnyt sat at a bash-permission prompt for most of a 12.8h run, holding its pane and a concurrency slot, and was then recorded as a crash — while an unanswered *ask*, a softer asynchronous question, texts Craig after 240 minutes. Alert (`blockedAlertMinutes`, once per block), never give up: a blocked runner's work is intact, merely paused. |
| `decide.ts` | A leftover runner is a readiness gate, checked **before** anything computes funding. The pane check used to live inside `runCycle`, after admission, so each tick admitted a cycle, booked it as launched, then failed on `PaneBusy` — 38 times on 2026-08-27. The wasted launch was not the cost: an admitted program is charged a full cycle against the pool for the rest of the pass, which took two other programs from 1.35 fundable to 0.35 and refused them both, every ten minutes, invisibly. |
| `decide.ts` | `runnerPresent` is passed by every caller — `tick.ts`, `state.ts`, `cli.ts`'s own `evaluateAll` — because each calls `decide()` itself. Wiring it into only the tick printed GO on other surfaces for a program the tick refuses. When you add an input to `decide()`, grep for every `decide({` and feed it by hand. |
| `decide.ts` | `undefined` for `runnerPresent` means *unknown*, never *absent*. orca being unreachable must not refuse every cycle, and a `headless` program has no agent to find. Only an affirmative `true` holds a program. |
| `cycle.ts` | Never nudge a `blocked` agent. It is waiting on a dialog only Craig can answer, and a prompt queues up behind it rather than clearing it. |
| `ledger.ts` | `stalled` counts toward the failure latch alongside `crash`, and toward nothing else. Leave it out and a program that stalls every cycle loops start → nudge×3 → stalled → start forever, paying full onboarding each round. |
| `nudge.ts` | `textCraig`'s `originationNumber` is **required, never defaulted**. It was optional-defaulting-to-null once, and four of five call sites forgot it — so every tick-driven alert (blocked-asks nudge, stall text, watchdog overrun, blocked-runner alert) went out via bare SNS, which picks one of **sunnyt's** numbers: measured 2026-08-27 when the blocked-asks nudge arrived from the product's number. Null means "let SNS pick", and only `drovr notify` had it right. Pass `control.originationNumber` at every new call site; the required parameter is the guard, same as `runBounded`'s timeout. |
| `nudge.ts` | SMS sends on the **default** aws profile, with no `--profile`. The named profiles are SSO-backed and their sessions expire — exactly the state an unattended overnight supervisor finds them in, which is how the alert path sat broken. The default profile is a static IAM user and still works at 4am. |
| `nudge.ts` | SNS accepting a message is not proof a handset got it. Say "accepted", never "delivered", and never build anything that assumes the text arrived — `textCraig` is best-effort on every path. |
| `nudge.ts` | Never conclude a send worked from its exit code. `aws sns publish` returns a MessageId and exit 0 for messages that fail at delivery a minute later; the reason appears only in the `DirectPublishToPhoneNumber/Failure` log group. `notify` waits for the real verdict — keep it that way. |
| `cycle.ts` | `last-cycle.json` has one blessed writer: `drovr report`, which validates against `reportShape` before anything touches disk and stages through a rename. A runner writing the file directly can be caught **mid-write by the watch's poll**, so `pollReport` reads unparseable bytes as "not yet" (the next poll sees the whole file) while a complete report with the wrong shape still throws — it is a declared interface, not a scrape. Everywhere the file is settled (`readReport`) stays strict. |
| `tick.ts` | Neither tick-side read of `last-cycle.json` may throw. In `reconcileLateReports` a malformed leftover file would stop everything after it — admission included — every tick until hand-deleted; after `runCycle` a throw skips `record()`, so the cycle stays open in the ledger and is charged as running forever. `readReportOrWarn` logs and reads it as absent; the cost is one program's reconciliation or an `unreportedExit`, never the pass. |
| `decide.ts` | Self-rest (`--pause-until`) and cadence are **readiness gates inside `decide()`**, not renderer state, so all four renderers inherit the hold and its reason without hand-syncing. `programPausedUntil` reads a lapsed timestamp as no pause — the `isPaused` trap at program level — and `nextCadenceStart` measures from the last *start* (a cycle in flight opens its window; measuring from the end would drift the schedule by the cycle's own length) and never holds a program that has not run. Both are waiting on the *world*; waiting on *Craig* stays `blocked` + asks, which nudges him. |
| `ledger.ts` | A cycle that declared a rest is excluded from `consecutiveZeroYield`, like `blocked`: it said why it produced nothing. Count it and a program that waits well latches as stuck after `stuckCycleThreshold` waits. |
| `preview.ts` | The preview parser is lenient **because it is a scrape** of claude's TUI — an undeclared format that changes between releases, where an unrecognised shape must yield `null` and cost the panel a preview, never fail a tick. This is the exact inverse of `orca.ts`'s `agentIdentity` rule: parse a declared interface strictly and let a surprise throw, parse a scrape leniently and let it return nothing. Know which one you are reading before choosing. |
| `asks.ts` | `readAsks` parses **leniently** — it backs a liveness heuristic where a missing field costs a timestamp, not a decision. It is the only note reader left (the strict `listNotes` went with intents); if you add another that feeds a *write*, give it its own strict shape rather than widening this one. |
| `asks.ts` | A zero exit from an `aice notes` **write** is not proof the note exists. Measured 2026-08-24 against drovr.aicex.app: `notes add` to a page whose notes are not shared exits 0 and prints `added: true` — with **no `id`**, which is the tell, since a persisted entry comes back carrying a server-minted one. Reproduced twice with an explicit `--prefix` on both calls, each naming the identical resolved page, so it is not the path-ambiguity asymmetry it first looks like. aice's source *does* gate writes (`aice-manage/src/notes.ts` returns 403 `sharing_off`, and the client maps that to `SHARING_OFF`), so the deployed install appears to be behind that tree — inferred, not confirmed. Either way: to know a page is writable read it and check `shared: true`, never the write's exit code. |
| `state.ts` | A diagnostic's sink is the **caller's** choice, not the producer's. `collectState`'s `onWarning` has three correct answers — fold it into the frame (`watch.ts` can never print mid-frame), `console.error` it (any caller running unattended under launchd), or drop it — and omitting the argument silently picks the third. Three defects came from that one shape, including a `console.error` that was right in one caller and corrupted a terminal frame in the other. Pass the sink deliberately at every call site. |
| `keys.ts` | Mode ceilings must stay ordered `low <= normal <= away`, enforced on every write. `setReserve` clamps each mode only against itself, so repeated keypresses drifted `low` to session 0.65 against `away`'s 0.60 — measured live 2026-08-25, which made the mode Craig reaches for when nervous the **most permissive of the three**. The mode just edited wins and the others move around it; never silently override the number he asked for. |
| `teamclaude.ts` | Parse `routes[].accounts[].eligible`. The runner is always Fable, so an account that route refuses will never serve one of its requests and its headroom is not drovr's to spend however healthy the three buckets look. A missing route means *no restriction known*, not *nothing eligible* — refusing every account over absent information would stop the loop dead. |
| `capacity.ts` | An unroutable account stays in `perAccount` with its real headroom and `routable: false`. It is not filtered out: it still owns the resets that say when the pool recovers, and dropping it would hide both that and the reason its headroom is ignored. `decide.ts` zeroes its *fundability*, not its headroom — the bars still answer how much of each bucket is spent pool-wide. |
| `decide.ts` | Report how many accounts *carry* the total, not how many exist. "across 3 accounts" read as a healthy pool on 2026-08-25 while two were spent and the third — the only fable-routable one — was also serving Craig's own foreground sessions. A pool resting on one account has no fallback, and the headline number cannot say so. |
| `ledger.ts` | `lastDecisionAt` is not a liveness signal. It only advances when an **enabled** program is evaluated, so disabling every program made drovr accuse its own launchd agent of being stalled while ticks fired normally. Every completed tick stamps `last-tick.json` instead; read that for health and keep the decision log for decisions. |
| `decide.ts` | The pace allowance comes from the **pool**, never the ceiling. Granting `weeklyCeiling × usableAccounts × elapsed` while measuring spend from drovr's ledger alone puts Craig's usage on neither side, so the entitlement is always too large — measured across 1008 decisions to 2026-08-26 the gate fired **zero** times while the daily cap refused 267 cycles doing its job. `pool[bucket] + spent` puts both sides on what drovr can actually reach, and inherits capacity.ts's per-account clamp rather than re-deriving it. It reduces to the old formula when Craig has spent nothing, so it is a generalisation, not a new policy. |
| `decide.ts` | The pace line needs a burst floor (`cycleCost × 2`). Linear entitlement from zero refuses the first cycle of every window — at 1% elapsed the line is near zero and one finished cycle is already above it — turning a gate meant to smooth the week into one that never lets it start. Bursting after a reset is legitimate; sustained over-spend is the target. |
| `decide.ts` | Three layers, and the seam is testable: `programReadiness` reads no pool, `admissionLimits` takes one only to attach to the hold, `capacityVerdict` is the only one that reads quota or can return GO. Adding a gate to the wrong layer is how eleven of them ended up in one function. A readiness check that needs the pool is a sign it belongs one layer down. |
| `state.ts` | `cyclesFundableFrom`'s third argument must be `chargeForRunning(...)`, matching `decide()`. It was the raw `running` count here while decide charged observed drain, so every renderer over-reported fundability against the verdict printed beside it — the anti-drift rule failing in the one direction that reads as free capacity. `cli.ts`'s `status` capacity line re-made the same mistake and was fixed 2026-08-27; grep every `cyclesFundableFrom(` when touching this. |
| `watch.ts` | Mouse clicks resolve against `lastHits` — the hit map of the frame actually on screen — never against a layout recomputed at click time: a resize between draw and click would otherwise select the wrong row. `keybarLayout` is the single source for both rendering and hit-testing the keybar, so a click can never land on a different key than the one drawn. A click while the `x` or `s` confirmation is armed cancels it, exactly like any keystroke but `y` — a stray click must never confirm an interrupt or spend a cycle's worth of quota. |
| `watch.ts` | Enabling mouse reporting (`?1000h`) takes plain clicks away from the terminal, so anything that used to work *because the terminal handled it* silently stops — bitten within hours by the asks link, an OSC 8 hyperlink the terminal opened on click until the click started arriving as an SGR report instead. Any clickable affordance drawn on the frame needs its own entry in the hit map and its own handler; the terminal is no longer doing any of it for free. |
| `usage.ts` | It records and reads; it feeds **no gate**. teamclaude reports total usage and the ledger reports drovr's, so Craig's share is the difference — but only at the instant it is taken, because both are fractions of a window that resets, and nothing reconstructs it afterwards. Hence a sample per tick. An admission decision that moved with his measured behaviour would be a feedback loop nobody asked for. |
| `usage.ts` | The log is bounded by **bytes**, not age: a tick fires on a schedule that can change, so a line-count bound would drift with it. Pruning keeps the newest half — the recent behaviour is the part the reserve question is about — and stages the rewrite through a rename so a reader never catches a half-pruned log. |
| `tick.ts` | The usage sample is logged-and-swallowed on purpose, and it is the last thing a pass does. A full disk must cost the measurement, never the tick; admission has already happened by then. This is the one place in the file where swallowing is right. |
| `teamclaude.ts` | A field that is only ever **exercised as null** has an untested type, and it gets its first real value at the worst possible moment. `rateLimitedUntil` and `pausedUntil` are null on every healthy status and non-null only while an account is actually throttled — so `z.number()` met its first real value on 2026-09-14, refused the whole payload, and killed five consecutive ticks (17:38 to 18:18, a one-hour hole in decisions.jsonl) while admission mattered most. `epochMs` coerces number-or-string and reads an unparseable instant as null. Coerce, never merely widen: `capacity.ts` compares these against `now`, and a string left as a string compares false and marks a throttled account **usable** — the direction that reads as free capacity. |
| `state.ts` | `collectState`'s `probeMaxAgeMs` defaults to **0 — fresh** and only `drovr watch` passes anything else. The tick and `drovr status` must never reuse a probe: quota a few seconds old is admission deciding against room that is already gone. The cheap half (control.json, cycles, locks, service) is re-read on every call whatever the window, which is what lets a keystroke that writes control.json show its effect in the very next frame — a repaint of the last state would have left a stale mode line under `m`. |
| `state.ts` | The subprocess half of a frame is the whole cost of it: 0.03ms to render, 2366ms to probe, measured 2026-09-17. `runnerIsPresent` exists because `agentStateFrom`'s tui-idle probe bills its full `IDLE_PROBE_MS` on a *working* claude, and both callers that ask only "is anything there" throw that distinction away. `cycle.ts` genuinely needs idle/working/blocked; nothing else does. |
| `watch.ts` | A failed refresh must not end the session. Every draw ran `.catch(die)`, so one throw out of `collectState` — teamclaude's proxy missing its own 5s status budget is enough — restored the terminal and exited a live watch. `drawFailed` keeps the last good frame and puts the reason on the message line; only the first frame, which has nothing to keep, is still fatal. |
| `tick.ts` | A tick that **throws** is as much an outage as one that overruns, and only the second had a watchdog. `runTick` wraps `tick()` from outside so the lock is released before a 30s SMS, and rethrows so the exit code still fails. The episode marker is cleared beside `stampTick` and nowhere else: a tick that returns early on a busy lock has completed nothing and must not end someone else's episode. |
| `keys.ts` | One writer of `control.json` now means **one code path, not one process**. `mutate` is called from the launchd tick, from `drovr watch` and from the CLI, and neither of the latter two takes the tick lock. The staged write-and-rename protects readers from a torn file; it does not order concurrent writers. The window is milliseconds and a lost update costs a re-pressed key, so do not build a lock for it — but do not claim single-writer serialization either. |

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
- **`headless` runner mode** — a fallback, exercised once early, untouched since the interactive
  runner landed.
- **An Orca cycle end to end.** The adapter landed 2026-09-10. On 2026-09-12 a sunnyt cycle was
  started through it — terminal created, `teamclaude run` came up, prompt sent, runner seen `working`
  with subagents — but that cycle's watcher was killed, so no runner has yet been seen to report and
  be released through the adapter.
- **A resumed watch seeing its cycle out.** The re-attach itself fired live at 16:21 on 2026-09-12 — the
  tick found the orphaned record, saw the runner `working`, launched a worker that picked up the open
  record without a start record or a prompt — but that watcher has not yet seen a report and released
  the terminal, which is the same open question as the line above.
- **`agentWait` populated for a blocked runner.** Documented by orca on supervised workers and present
  as a field on plain terminals, but only ever seen null. Until a runner blocks, `blocked` is unproven
  and the blocked-runner alert with it.
- **Stale-handle adoption by tab id after an Orca restart.** Proven only in the suite; no Orca has
  restarted under a remembered terminal since it landed.
- **A late report superseding an abandoned cycle in the wild.** Proven end to end against a
  seeded ledger on 2026-08-27 — superseded once, idempotent on the next two ticks — but no real
  cycle has outlived its watch and then reported since it landed.
- **A blocked-runner alert reaching Craig.** The `stallAction` branch is tested and the send
  path is the proven `textCraig`, but no runner has blocked since it landed.
- **`drovr release` actually releasing.** Verified refusing a live `working` runner on 2026-08-27,
  which is the branch that matters most; the settled path has not been exercised.
- **A watch surviving an orca stall.** `MAX_POLL_FAILURES` landed 2026-10-05; the relliq and
  infra-on-actions cycles started at 04:47 that day were the first watched by it. No poll has
  been seen to fail and recover, nor a watch end as `abandoned` for lost sight.
- **The tick releasing a reported leftover.** `leftoverAction` is proven only in the suite; no
  tick has yet sent `/exit` to an idle reported runner, nor held one on `exitSent`.
- **The tick watchdog firing in anger.** Proven against a `teamclaude` that ignores SIGTERM —
  it released the lock and exited at the budget, to the tenth of a second — but never on a real
  wedge, because there has not been one since the timeouts landed.
- **The pace gate firing.** Re-based 2026-08-26 so that it can; it never could before, and it has
  not been seen to since. Live at 97% through the window it reads on-pace with a line 24% tighter
  than the old one (1.216 against 1.593), which is the right answer but not a firing.
- **A reserve argued from `drovr usage`.** The sampler is live and the numbers cross-check against
  the review's hand-computed figures, but p90 needs 24 samples — four hours of ticks — and no
  reserve has been changed on its evidence yet.
- **The priority waterline holding a lower-priority program in the wild.** Landed 2026-08-27
  and visible immediately in `drovr status` (staggered bars: 1.00/1.50/1.75), but no tick has
  yet refused a low-priority program over room a higher one then used.
- **A drovr cycle delivering an improvement that was merged back to main.** The program is
  registered and its worktree exists; no cycle has run against it yet.
- **A closing message captured through `--session-id`.** `closingMessage` reads a recorded
  transcript correctly, and 180 historical records were backfilled on 2026-09-15 by matching
  each cycle's `startedAt` to the transcript that began within 10s of it (backup:
  `~/.drovr/cycles.jsonl.bak-20260915`) — but every cycle in flight when the flag landed predates
  it, so no record has yet been filled in by the live path. `drovr ledger --closing` shows them.
- **A failed-tick text reaching Craig.** `runTick` was verified against a failing `teamclaude`
  in an isolated `DROVR_HOME` — three failed ticks wrote one marker and logged one alert
  attempt, a healthy tick cleared it — but with no `phoneNumber` configured there, so the
  send itself has not run and no real tick has failed since it landed.
- **`epochMs` coercing a real teamclaude value.** Proven against the recorded 2026-09-14 shape
  and against the live payload with one account rewritten, but teamclaude 1.1.14 assigns
  numbers to both fields, so which string form actually arrived that day is still unknown.
- **The same-directory gate holding a program.** Landed 2026-08-30 as future-proofing; no two
  registered programs share a cwd today, so by construction it has never fired outside the suite.
- **The shadow re-forming when a rest lapses.** The un-shadowing half fired live within a
  minute of landing (2026-08-29 15:57: aice-x admitted over resting sunnyt, refused at 15:47
  by the old ranking); the reverse — a lapsed rest raising lower programs' bars again on its
  own — is proven only in the suite.

## Notifications

`drovr notify` texts Craig. It waits for the delivery status rather than reporting the exit
code, because acceptance and delivery are different events a minute or so apart — `aws sns
publish` returns a MessageId and exit 0 for messages that never leave.

drovr sends from its own Canadian long code, **+1 506 906 8159**
(`phone-dceeb0a0acc6439dbdd0a08ebc73cb98`, $1/month, `pool-8a85c8fb`), set as
`originationNumber` in `control.json`.

**A configured `originationNumber` must be sent via `pinpoint-sms-voice-v2 send-text-message`,
not `sns publish`.** SNS cannot resolve an explicit origination identity: it accepts the call
and then fails at delivery with "The provided number does not exist or does not belong to the
account". End User Messaging sends from the same number without complaint. Measured 2026-08-24
to a live handset — SNS failed from that number three times, End User Messaging delivered three
times. Pool membership and number age were both investigated and neither was the cause; the
transport was.

Leaving `originationNumber` null is *not* the safe fallback it looks like. SNS then picks a
number itself, and it picks one of sunnyt's — so drovr's alerts arrive from the product's
number and any reply lands in sunnyt's inbound topics, which its cycles poll.

Delivery status is only readable on the SNS path, from the `DirectPublishToPhoneNumber` and
`.../Failure` log groups. End User Messaging reports through a configuration set that drovr
does not have, so `notify` says `unknown` there and names the two commands that would create
one. Sending is unaffected.

## drovr is also a program

drovr supervises a program named `drovr` that works on this codebase — but never in this
checkout. Its cycles run in the `~/code/drovr-loop` worktree on the `loop` branch, because
launchd executes TypeScript straight from this working tree: a cycle editing `tick.ts` here
would rewrite the supervisor mid-flight. Merging `loop` into `main` is Craig's manual act,
followed by `drovr service install` when the merge touches the service. Its hub and asks pages
live on drovr's own install (drovr.aicex.app, supplied by the worktree's `.envrc`) and are
created by the loop agent at onboarding. Its mechanical status page, `craig/loop-status.html`,
is gone with every other drovr publisher.

## There is no web panel and no intents channel — do not rebuild either

Removed 2026-09-04. A launchd agent published `assets/snapshot.json` to drovr.aicex.app every
20 seconds; from 2026-09-02, when aice granted its publisher the tenant-invalidation permission,
each publish fired a 3-path CloudFront invalidation. At $0.005/path past the 1,000 free monthly
paths that ran **$22-26/day** — and the invalidations bought nothing: the objects carry
`Cache-Control: max-age=60` and the pooled cache policy ignores query strings, so the page's own
`?t=` cache-buster was already a no-op.

The **intents** channel went the same day, at Craig's word: he never used it, and its one page
(`craig/intents.html`) never had shared notes turned on, so no intent was ever read off it in
the wild. With it went `src/intents.ts`, the tick's whole resolve → apply → reply drain, and
`listNotes`/`replyToNote`/`resolveNote` in `asks.ts`. `readAsks` is the only note reader left.
The setters in `keys.ts` stay — the TUI keys and the CLI are their callers now.

The **status page** went the same day, and with it every publisher drovr had. It was briefly
consolidated to one page for all programs before Craig cut it too. Gone: `src/render.ts`,
`src/publish.ts`, per-program `aice.statusPage`/`publishArgs` config, and the crash-path
publish in `runProgramCycle`. `wrap()` moved into `cycle.ts`, its one remaining caller.

**drovr now publishes nothing.** It reads asks pages, and that is the whole of its aice
surface. The pages it had already published were deleted from the install the same day
(`aice rm`), leaving only the auto-seeded `craig/index.html` landing card. `drovr watch`, `drovr status` and `decisions.jsonl` are how you see what it is doing.
Before adding a publisher back, price it: a publish costs three invalidated CloudFront paths
whatever it contains, billed per path past 1,000 a month, and on a tick cadence that is real
money. **A publisher is a billing decision, not a feature decision.**

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

- **orca** — via the `orca` CLI with `--json`: `worktree show`, and `terminal create / show /
  wait / send / read / close` on drovr's own cycle terminals only. Orca must be open; when it is
  not, every runner state reads as unknown and admission is left alone. Programs whose cwd is not
  an Orca worktree are refused with the `orca repo add --path <cwd>` that fixes it.
- **teamclaude** — read-only, via `teamclaude status --json`, plus `teamclaude run` as the launch
  command of every cycle.
- **direnv** — cycles run through `direnv exec <cwd>` so each program repo's own `.envrc`
  supplies its aice install and tokens. Do not duplicate that into `control.json`.
- **aice** — **read-only**, and only ever `notes list` against a program's asks page
  (`asks.ts`, the one aice caller left). One install per program (`sunnyt.aicex.app`,
  `joinery.aicex.app`, `aice.aice-x.com`). drovr publishes nothing anywhere; every page on
  every install belongs to the loop agent.
- **`~/.claude/skills/project-loop/SKILL.md`** — the other half of this system. It owns cycle-end
  triggers, onboarding, and the aice pages. The cycle report's shape lives only in `cycle.ts`'s
  `reportShape`, because the skill now tells agents to run `drovr report`, which validates against
  it — but the *meaning* of the fields and the write-it-last semantics are stated in both, so a
  semantic change still lands in both places.
