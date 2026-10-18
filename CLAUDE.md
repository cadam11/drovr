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
| `nudge.ts` | `textCraig` is called from inside the tick, so an unbounded send there means the thing whose job is to say something is wrong takes the supervisor down instead. Each HTTPS request is bounded at 15 s by `AbortSignal.timeout`, and a call is at most refresh + call + refresh + call (`toolCaller`, no other retry), best-effort on every path. |
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
| `nudge.ts` | `textCraig`'s `from` is **required, never defaulted** — the app files alerts under it, and a caller that forgets it buries every alert in one anonymous thread. Pass the program name for a cycle alert, `alertFrom(null, hostname())` for a supervisor one. The required parameter is the guard, same as `runBounded`'s timeout. |
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
| `tick.ts` | The status publish sits beside the usage sample, after admission, for the same reason: a window onto the tick must not be able to close it. It takes the decisions the pass already made and fills in disabled programs with the pure `decide()` — never a second orca probe, which would bill `IDLE_PROBE_MS` per program a second time inside the lock. `lockHolder` is `null` there on purpose: the publisher *is* the holder, so "a tick is evaluating" would be true of every row. |
| `teamclaude.ts` | A field that is only ever **exercised as null** has an untested type, and it gets its first real value at the worst possible moment. `rateLimitedUntil` and `pausedUntil` are null on every healthy status and non-null only while an account is actually throttled — so `z.number()` met its first real value on 2026-09-14, refused the whole payload, and killed five consecutive ticks (17:38 to 18:18, a one-hour hole in decisions.jsonl) while admission mattered most. `epochMs` coerces number-or-string and reads an unparseable instant as null. Coerce, never merely widen: `capacity.ts` compares these against `now`, and a string left as a string compares false and marks a throttled account **usable** — the direction that reads as free capacity. |
| `state.ts` | `collectState`'s `probeMaxAgeMs` defaults to **0 — fresh** and only `drovr watch` passes anything else. The tick and `drovr status` must never reuse a probe: quota a few seconds old is admission deciding against room that is already gone. The cheap half (control.json, cycles, locks, service) is re-read on every call whatever the window, which is what lets a keystroke that writes control.json show its effect in the very next frame — a repaint of the last state would have left a stale mode line under `m`. |
| `state.ts` | The subprocess half of a frame is the whole cost of it: 0.03ms to render, 2366ms to probe, measured 2026-09-17. `runnerIsPresent` exists because `agentStateFrom`'s tui-idle probe bills its full `IDLE_PROBE_MS` on a *working* claude, and both callers that ask only "is anything there" throw that distinction away. `cycle.ts` genuinely needs idle/working/blocked; nothing else does. |
| `watch.ts` | A failed refresh must not end the session. Every draw ran `.catch(die)`, so one throw out of `collectState` — teamclaude's proxy missing its own 5s status budget is enough — restored the terminal and exited a live watch. `drawFailed` keeps the last good frame and puts the reason on the message line; only the first frame, which has nothing to keep, is still fatal. |
| `tick.ts` | A tick that **throws** is as much an outage as one that overruns, and only the second had a watchdog. `runTick` wraps `tick()` from outside so the lock is released before a 15s hey send, and rethrows so the exit code still fails. The episode marker is cleared beside `stampTick` and nowhere else: a tick that returns early on a busy lock has completed nothing and must not end someone else's episode. |
| `keys.ts` | One writer of `control.json` now means **one code path, not one process**. `mutate` is called from the launchd tick, from `drovr watch` and from the CLI, and neither of the latter two takes the tick lock. The staged write-and-rename protects readers from a torn file; it does not order concurrent writers. The window is milliseconds and a lost update costs a re-pressed key, so do not build a lock for it — but do not claim single-writer serialization either. |
| `hey-http.ts` | A `401` is retried **once after one refresh**, and nothing else is retried. The shim answers 401 before any tool runs, so the retry cannot duplicate a send; a 502 or a timeout after the POST might have delivered, so it is one line and exit 1. `toolCaller` is the only place this rule lives; a caller that loops on it is a duplicate-message machine. |
| `hey-http.ts` | The credentials file is written through a **rename**, 0600, and two writers inside the shim's 60 s grace get the **same** pair — which is what lets a `hey --wait` poll and the tick refresh at the same hour boundary without one of them being signed out. Do not "fix" a refresh race with a lock file; the grace is the design. |
| `hey-mcp/device.ts` | `GET /mcp/device?user_code=…` **prefills and spends nothing**; only the POST spends. A link preview, a mail scanner or a prefetch would otherwise burn the code before Craig sees the page (aice's rule, kept). |
| `hey-mcp/device.ts` | **Browsers submit the device form twice.** Measured 2026-10-17: `POST /mcp/device -> 302` then, 230 ms later, `POST /mcp/device -> 400` from the prefilled page — the first press spent the code and redirected, the second found it spent and its error page *replaced* the redirect, so Craig's first real `hey login` ended "expired". Same class as plan 7's resubmitted code form. `deviceEnter` writes a `spent#<code>` pointer (`SPENT_REPLAY_SEC`) naming the login row it parked, and a resubmit inside that window replays the same 302 while the login is live and unfinished. Under the page's CSP there is no JS to disable the button, so the server has to be the one that is idempotent. |
| `hey-mcp/device.ts` | The user-code budget is a **global per-minute counter** bumped before the lookup, not a per-device try count: before the code resolves there is no device to count against. `increment` is DynamoDB `ADD`, atomic; the memory store mirrors it. |
| `hey-mcp/tools.ts` | `to` on a tool is a **self-check**, never a recipient: it must equal the session's handle and every tool still addresses the session. It exists so a box with the wrong `HEY_TO` is told so instead of silently sending to whoever signed in. |
| `nudge.ts` | `publishStatus` builds its default caller **inside** the try: `defaultCaller()` reads `~/.config/hey.json`, and a malformed file in a default-parameter position threw before the guard, out of the tick. |
| `status-accounts.ts` | `src/status-accounts.ts` imports only `zod` and `teamclaude.ts`. It is the account shape the CLI's `hey status put` validates and builds; importing `state.ts` from it (where `accountsOf` used to live) would drag orca, exec and the whole supervisor into a command meant to run where none of them exist. `state.ts` imports *it*, never the reverse. |
| `hey.ts` | `genericStatusShape` **strips** unknown keys on purpose — Hadrian pipes the one object it also writes to SSM, carrying `at`, `box` and `tickets` — and refuses a *known* key of the wrong shape with its path. Do not make it `.strict()` to "catch typos": the writer's extra fields are the contract, and a typo in a known field is already refused. |
| `profile.ts` | A sender profile is **decoration**, so both ends read it leniently — `profileFromRepo` yields nothing for a repo shape it does not know and `ProfileIcon.parse` yields nil for an icon it cannot draw — while the Lambda validates it strictly on the way in. A strict reader here would fail an inbox load over a tile. The seed runs **after** `startCycleAgent`, never before: two orca calls and an invoke are bounded, but a late launch is the wrong price for an avatar. |
| `tick.ts` | The phone's Away is applied with `applyAwayMode` to the `Control` every `decide({` caller builds and is **never written** to control.json: a pass that wrote it would make the toggle sticky after Craig turned it off. `off` is not overridden — it is a stop, not a ceiling. `state.ts` reads it in the probe half and caches it with the quota probe, or every `watch` frame would pay a 15 s-bounded hey call. |
| `handler.ts` | A `prefs` row the Lambda cannot parse reads as the defaults with a log line and the send goes out **loud**; a newer app writing a key this Lambda does not know is exactly the case, and a failed send over a setting would be worse than a sound. The app's decoder is strict the other way for the same reason: a row it cannot write back whole is one it must not overwrite. |
| `ConversationsView.swift` | A swipe button with `role: .destructive` makes SwiftUI's `List` animate the row away **before the action runs**. Put a confirmation between the swipe and the delete and the row stays while the List already counted it gone; when the real removal lands, the collection view asserts "Invalid Number Of Items In Section" and the app dies — measured 2026-10-16, three runs. Deferred destructive actions are red by `.tint(.red)` and no role. |
| `ConversationsView.swift` | A `List` hoists `.contextMenu` to the **row's cell**, so two cards in one paged row each carrying their own menu answered every long-press with the first card's actions — measured 2026-10-17 on Craig's phone, where page two's "Delete card" confirmed `drovr@mac`. That is why the card's long-press is a **gesture** (it reveals the corner x, Home-Screen style) and not a menu: a gesture belongs to the card it is on, a menu to the row. The reveal must be a `highPriorityGesture` or the header Button swallows the press; and the x overlay must be attached **before** that gesture, inside its view — a high-priority press holds the touch until it fails and re-dispatches only to its own subviews, so an x attached after it never received a tap (measured 2026-10-17, every tap reached the header beneath). A confirmation names its subject only through `presenting:` (the button says `Delete <id>`), never from state read while it is up. |
| `AppModel.swift` | Optimistic removal's rollback is a **reload**, not a saved copy: a thread delete that fails halfway has already removed some rows from the table, so restoring the old array would show rows the table no longer holds. `deleteThread` reloads on failure and the list is whatever the table says; the error rides the load banner. Since plan 10 the window is several pages and the optimistic removal took every one of them, so the rollback **forgets the window and fills again** (`forgetWindow` + `load()`): a page-1 merge would leave the survivors on older pages in the table but unreachable until a relaunch — the cursor sits below them and no refresh looks there. Caught by the plan 10 review, not live. |
| `AppModel.swift` | A refresh is **page 1 merged**, never `rows = page`. With older pages loaded, assigning page 1 drops them (the list shrinks back to 50 on every pull) and appending it doubles every row a refresh re-reads; `mergeRows` keys by `sk`, incoming wins. The cursor is set by the fill and moved only by `loadOlder` — a refresh that moved it would skip the rows between the old page 1 and the kept pages. And the three-day fill runs **once**, when `pagesLoaded == 0`: a refresh that re-ran it would pay three Queries on every pull and push. `load()` is coalesced like `start()`: a pull and a foreground push landing before page 1 returns both saw `pagesLoaded == 0` and filled twice, counting every page double, so the cap tripped at 500 real rows under a note reading 1000. And **the cap is pages fetched, not rows held**: a refresh merges new arrivals past `Paging.maxRows`, so `deleteThread` hands the store at most `maxRows` rows per batch — the real store's precondition is the invariant, not the guard; unbounded it was a crash on the one thing a flooded user does. All three predicted by plan 10's tests and its review, not yet bitten live. |
| `LoadOlderRow.swift` | **Tap only.** A one-message thread or a short list shows the paging row at once, so an `onAppear` auto-load would chain page after page to the cap on open — a 1000-row window by the back door, when the three-day fill has already decided what the window is. |
| `DynamoInboxStore.swift` | `ExclusiveStartKey` is the table's **full key** `{pk, sk}` rebuilt from the `sk` cursor, never `LastEvaluatedKey` handed back whole across the seam: `Model/` must not import the SDK, and the row behind the cursor may be gone by the next page (delete thread, TTL) — the position still holds because it is a key, not a row. DynamoDB sends a `LastEvaluatedKey` whenever the limit was hit, even with nothing older, so a trailing **empty page is normal** and must read as exhausted, not as an error; the fake mirrors it (`next` iff the page is full). |
| `hey-mcp/session.ts` | A refresh token presented twice inside 60 s must get the **same** successor pair. claude.ai double-submits refreshes at the hour boundary; strict revoke-on-replay logged users out every hour in aice. Only a replay after the window is theft. |
| `hey-mcp/oauth.ts` | Trust a redirect URI **parsed**, never by string prefix: `https://claude.ai.evil.example/…` and `https://claude.ai@evil.example/…` both start with the trusted string. Registration is open by construction (that is what DCR is); `isTrustedRedirectUri` at `/authorize` is the whole gate, and an untrusted URI gets an HTML 400, never a redirect. |
| `hey-mcp/router.ts` | The SDK's streamable transport 406s a POST whose `Accept` lacks `text/event-stream`, even in JSON-response mode where no stream is ever opened. Widen the header before `handleRequest`, or a strict client never sees a tools list. |
| `hey-mcp/tools.ts` | `wait` is bounded three ways — the poll count, `MAX_WAIT_SECONDS = 50`, and the message's own `waitUntil` — because the Lambda has 55 s and CloudFront's origin read timeout is 60 s, its ceiling without a quota ticket. A `wait` that outlives either is a 504 the agent reads as a lost message. |
| `hey-mcp/http.ts` | No `form-action` in the login page's CSP. Chrome and Safari apply it to the **redirect that answers a form POST**, and the code form's answer is a 302 to the client's own callback (`http://127.0.0.1:<port>/…` or claude.ai), which `'self'` blocks: the Lambda minted the code and the session, the browser never followed, and back/reload showed "expired or already used". Measured 2026-10-17, twice, before the cause was found. |
| `infra/mcp.tf` | A NONE-auth Function URL needs **two** statements since October 2025: the `lambda:InvokeFunctionUrl` one the provider adds **and** `lambda:InvokeFunction` conditioned on `lambda:InvokedViaFunctionUrl`, or every request is a 403 `AccessDeniedException` with the policy visibly present (measured 2026-10-17; aice's aice-ops hit the same 403 and gave up on NONE). Provider 5.100 cannot express that condition (`invoked_via_function_url` is 6.x), so `terraform_data.hey_mcp_invoke_via_url` writes it through the CLI. |
| `infra/mcp.tf` | The Function URL **remaps** `WWW-Authenticate` to `x-amzn-remapped-www-authenticate` on the way out, and a CloudFront Function cannot put it back: "CloudFront doesn't invoke edge functions for viewer response events when the origin returns HTTP status code 400 or higher", and the header rides on a 401. `lambda/hey-mcp-edge/` is a Lambda@Edge **origin-response** (run for every status) that copies it back; without it clients only find the metadata through the well-known fallback. |
| `infra/mcp.tf` | Dropping an edge function's association and deleting the function in one apply fails `FunctionInUse`: Tofu orders the delete before the distribution update. Two commits (association first), or `-target` the distribution first — measured 2026-10-17 removing the CloudFront Function above. |
| `cli/hey/help.go` | `help --json` must be the Node document byte for byte, and Go's `encoding/json` differs from `JSON.stringify` in three ways that each change the bytes: it sorts map keys (so every object is a struct in the TS literal's field order — the JSON-RPC envelope included), it HTML-escapes `<>&` by default (so everything goes through `marshalJSON` with `SetEscapeHTML(false)`), and it has no notion of JavaScript's integer-key ordering (so `exitCodes` is declared `0, 1, 2, 130`, not the `0, 2, 1, 130` the TS literal writes). `pnpm conform:cli` catches all three; `go test` catches the last two. |
| `cli/hey/args.go` | Choice length is JavaScript's `.length`, UTF-16 units, through `jsLength` — the handler's zod `.max(24)` measures the same way, so a rune count would pass a twelve-emoji choice the server then refuses as `bad_request` after a round trip. |
| `cli/hey/main.go` | Ctrl-C is a cancelled context, not a process exit: `fail` checks `ctx.Err()` before anything else, or an interrupted call prints `context canceled` and exits 1 where the Node CLI dies silently with 130. |
| `cli/hey/conformance_test.go` | **Offline rows must not be able to send.** Measured 2026-10-17: the plan's bash-shaped comparison loop, run under zsh, kept `"help nope"` as one argument — not a command name, so a send by contract — and both CLIs delivered 22 rows each to Craig's phone from the real signed-in `HOME`. Offline HOMEs hold no credentials file and point `endpoint` at `https://127.0.0.1:9/mcp`, and any offline row whose output matches `sent <id> to` fails the table on either side. Never compare the two CLIs from a real `HOME`; in zsh an unquoted `$args` does not word-split (`${=args}` does). |
| `infra/cli.tf` | The five `aws_s3_object` sources are required on purpose. A `fileset`/`fileexists` guard would turn a checkout without `dist/cli/` into a plan that proposes deleting the published binaries, which an executor told to expect "1 to change" might wave through. Failing loudly costs a `pnpm build:cli`. |
| `scripts/release-hey.sh` | The archives must be deterministic or every `tofu plan` re-uploads them: version from `VERSION` (never the commit), `touch -t` on the binary, `--uid 0 --gid 0 --uname '' --gname ''`, `gzip -n`. Build twice and diff the sums; a toolchain upgrade legitimately changes the bytes once. |

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

`cli/hey/help.go` is `src/hey-help.ts` ported data for data, and `pnpm conform:cli` compares
every help page and `help --json` byte for byte. A change to the Node registry lands in both
files in the same commit, or the table fails.

## Not yet observed working

Written and type-checked, never seen to fire. Unproven, not done:

- **A per-message mark from the phone.** "Mark unread from here" / "Mark read to here" on a
  bubble's long-press landed 2026-10-17, proven in the suites and on the Simulator (the middle
  bubble's menu moved the watermark to it, not to the first); no device has long-pressed a bubble.
- **The Go `hey` refreshing a session on the Mac.** The Mac swapped its `hey` symlink for the Go
  binary on 2026-10-17 and `hey whoami` answered on the existing credentials file; the tick's Node
  caller and the Go binary now share that file, so the first hour boundary either refreshes under
  both (the 60 s grace) or signs one of them out. Not yet seen.
- **The Go `hey` on a box.** Built and conformance-tested against the Node CLI on the Mac
  (2026-10-17: 65 offline rows byte-identical bar the Go-only `version`; 10 live rows through the
  real shim — send, `--wait 10s` exit 2, prefs, profile, status, whoami, another handle refused —
  identical after id/instant/clock normalisation), published at `https://drovr.app/cli/`. No box
  has installed it, so no `hey login`, no refresh (the live run started with a fresh token, so the
  harness's credentials write-back never fired) and no send has gone through the binary anywhere
  but the Mac.

- **The send budget refusing a real sender.** `SEND_BUDGET_PER_HOUR` landed 2026-10-17, proven
  in the handler suite (the 31st refused, another label and the next hour unaffected) and through
  the router as a tool error; no live sender has reached 30 in an hour, so the `rate#` row, the
  `ADD` on real DynamoDB and the one-line exit 1 on a box are unseen.
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
- **A cycle on a remote host.** `drovr host` landed 2026-10-15: the environment is threaded through
  every orca call, the report and transcript come back over ssh, a dark box is woken first. Proven
  only in the suite; no hosted cycle has been started, watched, reported or released yet.
- **The shadow re-forming when a rest lapses.** The un-shadowing half fired live within a
  minute of landing (2026-08-29 15:57: aice-x admitted over resting sunnyt, refused at 15:47
  by the old ranking); the reverse — a lapsed rest raising lower programs' bars again on its
  own — is proven only in the suite.
- **A TestFlight build of Hey.** Plan 4's Task 8 is deferred until the dedicated Apple developer
  account is approved; every device build so far is a Debug build signed by a temporary team
  (`TEAMID0000` in `infra/apple.tf` and `ios/Hey/project.yml`), and the plan's Task 8 preamble is
  the team-switch checklist that runs first. With it unobserved: the `APNS/hey` (production)
  platform application has never minted an endpoint, so no `production` device row exists and
  `ExportOptions.plist` has never been written.
- **A sandbox device row dying through `EndpointDisabled`.** The Lambda's disabled-endpoint
  branch has run only in the suite; the one sandbox token is still live.
- **Identity-pool credentials past their hour.** `AmplifyCredentials` asks Amplify on every
  request and caches nothing, but no Debug build has sat 65 minutes in the background and then
  refreshed (plan 4, Task 3 step 9 — the app was reinstalled too often on 2026-10-16 to run it).
- **`ALLOW_REFRESH_TOKEN_AUTH` past the refresh token's first day.** A session restore across a
  relaunch is observed (2026-10-16); one across days is not.
- **A load error from a half-answered row in the wild.** `MessageRow.decode` and the Lambda's
  `messageShape` refuse a row with `reply` but no `repliedAt`; only the suite has produced one,
  since the app's UpdateItem sets both at once.
- **A lock-screen answer through the new transport.** Plan 9's live `hey --wait 2m --choices yes,no`
  expired untapped (2026-10-17, exit 2 as designed); a `--wait` closed by a reply over the HTTPS
  caller is proven only in the suite.
- **A `slow_down` from the real shim steering the CLI's interval.** Task 4 saw the shim answer
  `slow_down` to curl; the CLI's widening of its interval is proven only in the suite.
- **A device code expiring under a waiting `hey login`.** Nobody has left one for 15 minutes.
- **The 30-a-minute user-code budget tripping live.** The 429 page is proven in the suite.
- **Two processes refreshing the same credentials file at once.** The grace is proven in plan 7's
  suite and the rename in this one; the collision has not happened live.
- **A box other than the Mac signed in with `hey login`.** The relliq dev box and the Hadrian box
  are the first candidates. **The relliq dev box is dark since Task 11's apply (2026-10-17):** its
  `hey-relliq-devbox` key is destroyed, so anything there that sent through hey fails until someone
  runs `hey login` on it (`docs/hey-mcp.md`, "Install on a box").
- **The hey Lambda is gone (plan 9, Task 12, done 2026-10-17 inside plan 12).** The Hadrian box had
  signed in and sent through `hey login`, so `infra/senders.tf`, `infra/lambda.tf` and
  `lambda/hey/index.ts` were removed (5 destroys, no Cognito change); `lambda/hey/handler.ts` and
  `aws.ts` stay as the library `hey-mcp` runs in-process. Nothing may invoke a Lambda named `hey`
  again: every sender holds a session from `hey login`.
- **A read mark written from a second phone.** Read marks are `read#<from>` rows on the server
  so two phones agree; one phone exists.
- **drovr's admission under the phone's Away.** `applyAwayMode` is tested and `drovr status`
  read `away (phone)` live on 2026-10-16 while control.json stayed `normal`; no tick has yet
  admitted a cycle that `normal` would have refused.
- **A profile seeded by a real cycle start.** `seedSenderProfile` ran by hand for drovr on
  2026-10-16 (🦾, #737373, marker written, second run silent); the call from `runInOrca` has not
  fired on a tick-launched cycle.
- **A `profile#` row with an image icon drawn on the phone.** Every seeded profile so far is an
  emoji or a colour; `AsyncImage` and the data-URL path are exercised only by `ProfileIcon.parse`.
- **A quiet-hours banner seen silent on the phone.** The Lambda set `interruption-level: passive`
  and the Mac printed the quiet note on 2026-10-16; whether the locked phone stayed dark and
  silent was not confirmed by eye.
- **A multi-choice reply from the phone.** `--multi` is tested end to end in the suites
  (`multiReply`, the Lambda's `multi` row, `--multi` args) but check 9 (`--choices "a,b,c"
  --multi` → tap a and c → Send → `a, c`) has not run on the device.
- **The message-count badge on the phone.** `unreadBadge` and `unreadCount` count messages in
  the suites; check 10 (two unread in one thread → badge 2) has not run on the device.
- **A refused lock-screen answer announcing itself.** `announceRefusal` posts a local notification
  when a yes/no action lands after the lapse; `refusalNotice` is tested, the post is not, and no
  device has shown it.
- **Full-width swipes and the growing compose field on the device.** Proven in the Simulator
  (`testSwipeTogglesReadAndDeleteRemovesTheThread`, `testComposeGrowsWithALongDraftAndTheChipsStayPut`);
  the build carrying them (b0950ee) is compiled but was not installed before Craig stepped away.
- **Paging on the device.** The three-day first-load fill, "Load older" on the list and in a
  thread, the hint for a page with nothing from that sender, the merge on a pull with older pages
  loaded, a push tap paging to an old message and the cap note are proven in the Simulator
  (`PagingTests`, `AppModelTests`, `SeedTests`, the two `-backlog` UI tests) and never on the
  phone, whose partition has yet to hold 51 rows; `DynamoInboxStore`'s `ExclusiveStartKey` round
  trip has run only against `MessageRow`'s unit tests, never against DynamoDB. The device build
  is in the plan 10 scratchpad for the coordinator to install.
- **The drovr card drawn from the live row on the phone.** The Mac's tick publishes
  (`status published to hey (8156 bytes)`, 2026-10-17) and `hey status` reads it back; the card
  is proven on the fixture in the Simulator, but the phone was unreachable when plan 6 landed, so
  no device has yet drawn the real row or opened the sheet on it.
- **The status row surviving a drovr outage into `stale`.** `cardFreshness` is proven in the
  suite; no tick has yet stopped for twenty minutes under a signed-in phone, so the orange
  `stale · Nm` has been seen only from the `-stale-drovr` seed.
- **A status row the phone could not decode, in the wild.** `StatusRow.decode` names the missing
  field and the card shows it (`DrovrMissingCard`), proven against a renamed key in the suite; no
  real payload has yet broken the shape.
- **A generic status card on the phone.** Plan 12 landed 2026-10-17 and its wire half ran live the
  same afternoon: the Hadrian box piped `teamclaude status --json | hey status put --program hadrian
  --host craig --teamclaude -` and a `lines`-only payload, both acked, both read back on the Mac by
  `hey status` with the extra fields stripped, and a row written past the CLI's guard read back as
  `? · 0 lines` without failing the list (spec amendment "Plan 12", observed). What has not been seen
  is the phone: CA-iPhone was unreachable, so the generic card beside drovr's, the error card, and
  the stale marker are proven only in the Simulator and the suite. Install the device build and look.
- **Two hosts' drovr cards.** One row per host is proven in `handler.spec.ts`; only the Mac publishes
  drovr's row today.
- **A status card deleted from the phone.** Landed 2026-10-17 (long-press reveals the corner x
  for 5 s with a light haptic → the x asks → a confirmation whose button names the card → one
  DeleteItem on the `status#` row). Craig's first two device builds were pulled on the phone (the
  wrong card named; an always-visible x) — see the `ConversationsView.swift` trap row — and the
  reveal version is proven in the Simulator UI suite and against the fake store only; the haptic,
  the 5 s timeout, the real DeleteItem under the device role and the row coming back on the
  sender's next put are unseen.
- **The publish failing without failing the tick, live.** `publishStatus` returns a reason and
  `stampTick` runs regardless (Task 3's tests); no real invoke has failed since it landed.
- **`away (phone)` on the card, from a tick that ran under it.** The mode line reads plan 5's
  `AppModel.prefs.away` the moment the toggle flips; the published row saying `mode: "away"` on
  the next tick (plan 5's `applyAwayMode`) has not yet been seen to follow it on the phone.
- **A hey-mcp session refreshing its Cognito token.** The `REFRESH_TOKEN_AUTH` call fires only
  once a session is an hour old; proven in the suite against a canned Cognito, not yet seen live.
- **A Cognito refusal revoking a hey-mcp session.** Disabling the Cognito user should 401 every
  connector within the hour; nobody has disabled it. The throttle-is-a-502 branch beside it is
  equally unseen live.
- **A wrong email code re-offering the form, live.** Cognito's acceptance of a second
  `EMAIL_OTP` answer on the same session after `CodeMismatchException` is what the page assumes;
  only the right-code path has run against the real pool.
- **A `wait` spanning two tool calls.** `listening: true` followed by a second `wait` that
  returns the reply has run only in the suite; the live `wait` lapsed unanswered.
- **The losing side of a refresh race.** Two concurrent live refreshes returned one pair, but
  which request lost — and that it deleted its unreturned pair — is proven only by reasoning,
  not by a test or a log line.

## Notifications

Every alert goes through **hey**, drovr's own channel: `textCraig` in `nudge.ts` calls
`https://hey.drovr.app/mcp` as the user who ran `hey login` on this Mac
(`~/.config/hey/credentials.json`, read from the tick's `HOME`), and the shim writes a row to the `hey` table
and publishes to every `device#` row the recipient's phones have registered, through the SNS
platform applications `APNS/hey` and `APNS_SANDBOX/hey` (hey design,
`docs/superpowers/specs/2026-10-15-notify-app-design.md`). The iOS app is `ios/Hey/`, a Debug
build on Craig's phone until TestFlight (see "Not yet observed"); it reads its own partition
straight from DynamoDB with identity-pool credentials and never calls the Lambda. Its window
(plan 10) is the newest `msg#` rows paged 50 at a time on the one partition-wide Query, the cursor
being the last `sk` carried as `ExclusiveStartKey` (`Model/Paging.swift`): the first load fills
the last `Paging.firstLoadDays` = 3 days or 50 rows, whichever is more, "Load older" pages on
tap, a refresh re-reads page 1 only and merges by `sk`, and `Paging.maxRows` = 1000 caps a
session's paging (pages fetched, not rows held: a refresh still merges what arrived since). Unread counts are of loaded rows, so unread older than the window is not counted; the
Lambda's badge on a push is the authoritative number. Read state is
the app's `read#<from>` rows, which is how the Lambda can put the unread-**message** count on
each push as `aps.badge` (Craig, 2026-10-16: messages, not threads; a thread's dot is still per
thread); the app sets the same number itself whenever its unread set changes.
Two more row kinds live on the partition: `profile#<from>` (icon, summary, colour — the tile
and the header; seeded once per program by `profile.ts` from Orca's repo icon, changed with
`hey profile`) and `prefs` (quiet hours and away, written only by the phone's settings sheet).
The Lambda reads `prefs` on every send — quiet hours make the push passive, not absent — and
drovr reads it once per tick: `away` runs the pass on the `away` ceiling without touching
control.json. A waiting send may offer `--choices`; exactly yes/no is answerable from the lock
screen, anything else is chips in the thread. The phone can mark a thread unread (deletes its
`read#` row) or, from a bubble's long-press, unread from that message on / read up to it — the same
`read#` watermark moved (`readAt` one millisecond before the pressed message, or its own instant),
and an open thread's auto-read is held until the reader leaves it; delete a thread (its `msg#` rows and `read#` row, never `profile#`) and delete a
status card — a long-press reveals its corner x for 5 s, the x asks, the confirm names the card
(its one `status#` row, which a live sender rewrites on its next put); a `hey --wait` whose message was deleted ends with one line and exit 2, like no reply.
`control.notifyTo` is the handle;
null disables alerts and leaves the log line. The `from` label is the program for a cycle alert
and `drovr on <host>` for a supervisor alert, because the app groups a thread by it. There is no
Slack app and no SMS any more: a failed send is a `console.error` line and an exit code, never a
text. A send is never retried — a retried send is a duplicate message. Every `from` label has a
send budget of 30 messages per recipient per clock hour, enforced in the handler (`rate#<from>#<hour>`
rows, atomic `ADD`, two-hour TTL) before the message row is written, so neither CLI needed new
logic: the 31st is `HeyError('rate_limited')`, a tool error the CLI prints as one line and exit 1.

hey is also an MCP server at `https://hey.drovr.app/mcp` (`lambda/hey-mcp/`, `infra/mcp.tf`,
`docs/hey-mcp.md`): a client with no shell — claude.ai — connects with no AWS credentials and signs
in with Craig's own emailed code. Every tool runs as the signed-in user through the same `handle()`,
so there is one send path and one front door: the `hey` command, drovr's tick and claude.ai all
hold a session from the same sign-in — the command and the tick through `hey login` (RFC 8628
device flow), claude.ai through its connector. There is no IAM sender, no AWS SDK in the CLI and
no AWS call in drovr since plan 9. Craig, 2026-10-17: local sessions (Claude Code, Codex) keep
using the `hey` CLI; the connector is not added to them.

The tick also publishes its state there: at the end of every completed pass, after the usage
sample and before `stampTick`, `publishStatus` sends the JSON `drovr status --json` prints
(one builder, `src/status-payload.ts`) as the row `status#drovr@<host>`, 24 h TTL, overwritten
each tick. Same rules as every send — bounded by the call's 15 s, logged and swallowed, off
when `control.notifyTo` is null — and the same position as the usage sample, because it is a
window onto the tick and must never be a gate in it. `hey status --json` reads it back; the Hey
app draws its drovr card from it, stale after two tick intervals.

The row is not drovr's alone since plan 12: any program signed in with `hey login` writes its own
with `hey status put --program <name> -` (stdin JSON `{title, intervalSeconds?, accounts?, lines?,
note?}`, unknown fields stripped) or `teamclaude status --json | hey status put --program <name>
--teamclaude -`, and the app shows it as a card beside drovr's, keyed `program@host`. The account
shape on the wire is one module, `src/status-accounts.ts`, shared by drovr's payload builder and the
CLI; `headroom` is drovr's pool figure and is optional there. The Lambda keys the row
`status#<program>@<host>` and defaults a missing `program` to `drovr`, so the tick's call never
changed. The Go CLI (`cli/hey/status_put.go`) carries the same command: its pre-send behaviour (help,
usage and shape errors, not signed in) byte for byte against the Node one in 18 conformance rows, the
payload bytes in its unit tests against zod's output — no row yet compares a real ack. The Hadrian box
is the first other writer (spec amendment "Plan 12").

`hey --wait 30m "text"` from any session blocks for a reply; `drovr notify` is fire and forget.
Every machine, the Mac included (since 2026-10-17), runs the **Go port** in `cli/hey/` — one
static binary, standard library only, installed at `/opt/homebrew/bin/hey` on the Mac. `src/hey-cli.ts`
is the **oracle**, not a command: it is no longer in `package.json` `bin`, it exists so `pnpm
conform:cli` can compare the Go binary against it byte for byte (`src/hey.ts` the library,
`src/hey-http.ts` the caller and the credentials file, which drovr's tick still uses in-process). Install on a
box: `curl -fsSL https://drovr.app/cli/hey_linux_amd64.tar.gz | tar xz && sudo install hey
/usr/local/bin/hey && rm hey && hey version && hey login` (`hey_linux_arm64`, `hey_darwin_arm64`
likewise; `https://drovr.app/cli/manifest.json` carries the version and sha256s), then
`HEY_TO=craig` (`docs/hey-mcp.md`, "Install on a box"). Release: bump `cli/hey/VERSION`,
`pnpm build:cli`, `tofu apply` (`infra/cli.tf`). `hey version` exists only in the Go binary and
is kept out of `hey help` so the list matches.

The infrastructure is the Tofu root in `infra/`, state in S3 (`drovr-tfstate-000000000000`,
created once by `infra/bootstrap`, whose own state is local and gitignored). `pnpm build:lambda`
and `pnpm build:cli` must run before any `tofu plan` there: the function's zip and the CLI
archives are built from gitignored bundles (`infra/cli.tf`'s five sources are required, like the
Lambda's `archive_file`: without `dist/cli/` the plan fails naming the file instead of proposing
to delete the published binaries).

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

**The one publisher since, priced:** from 2026-10-16 the tick sends `drovr status --json` to hey
as one row (`status#drovr@<host>`, `src/status-payload.ts` → `publishStatus` in `nudge.ts`) for
the Hey app's drovr card. One Lambda invoke and one PutItem per tick, nothing cached and nothing
invalidated: at a 10-minute tick that is about 4,300 invokes a month inside the Lambda free tier
and, for a payload of a few KB (8 KB measured with 13 programs), a few thousand DynamoDB write
units — cents, and under a dollar a month however the payload grows inside its 64 KB bound. The
removed aice publisher cost $22-26 a *day*. It stays acceptable only on those terms: one row,
overwritten, no fan-out, no second surface. A web page reading that row would be a new billing
decision, not a free extension.

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
- `cli/hey/` is Go 1.26, one flat `package main`, standard library only, no cobra (the usage
  strings are the contract). `pnpm test:cli` is its gate: `gofmt -l` empty, `go vet`,
  `go test ./...`, `staticcheck` when installed. `version` is the only package-level variable.
- Comments explain *why*, never *what*. Most functions should not have one.

## Interfaces to other tools

- **orca** — via the `orca` CLI with `--json`: `worktree show`, and `terminal create / show /
  wait / send / read / close` on drovr's own cycle terminals only. Orca must be open; when it is
  not, every runner state reads as unknown and admission is left alone. Programs whose cwd is not
  an Orca worktree are refused with the `orca repo add --path <cwd>` that fixes it.
- **teamclaude** — read-only, via `teamclaude status --json`, plus `teamclaude run` as the launch
  command of every cycle.
- **hey** — **HTTPS to `https://hey.drovr.app/mcp`** through `src/hey-http.ts` — one JSON-RPC
  `tools/call` per alert (`send`), prefs read (`prefs`), profile seed (`profile`) and the
  once-a-tick status row (`putStatus`), as the user in `~/.config/hey/credentials.json`. **drovr
  makes no AWS call.** Sign-in is Cognito pool "hey" (passkey, email code), custom domain
  auth.drovr.app; devices get credentials from identity pool "hey" under role hey-device, confined
  to their own partition by dynamodb:LeadingKeys.
  The MCP front door is Lambda `hey-mcp` behind CloudFront `hey.drovr.app` (its own distribution;
  nothing cached, nothing invalidated), its own OAuth 2.1 shim ported from aice, sessions under
  `pk = mcp` in the same table, and Cognito's `USER_AUTH`/`EMAIL_OTP` on the `hey-ios` client over
  the public `cognito-idp` endpoint — the only Cognito API drovr's code calls.
  APNs goes through SNS platform applications `APNS/hey` and `APNS_SANDBOX/hey` (token key from
  the Apple developer portal, reaching Tofu as `TF_VAR_apns_key_id` and `TF_VAR_apns_p8` from the
  dotenvx-encrypted, committed `infra/.env` — every plan and apply is
  `dotenvx run -f infra/.env -- tofu ...`, the private key is the gitignored `infra/.env.keys`,
  and a lost key file means a new APNs key from the portal); the passkey association file is
  `https://drovr.app/.well-known/apple-app-site-association` (`infra/apple.tf`). The app's own
  dependencies are Amplify Swift 2.62.1 (Auth and AWSPluginsCore) and AWS SDK for Swift 1.7.60
  (DynamoDB, SNS; the version Amplify pins), in `ios/Hey/project.yml`. Every `xcodebuild` on it
  needs `-skipPackagePluginValidation` for smithy-swift's code-generator plugin.
  The device role may also `DeleteItem` on its own partition (sign-out removes the phone's
  `device#` rows first; mark-unread and delete-thread remove `read#` and `msg#` rows). `hey help`,
  `hey help <cmd>`, `hey <cmd> --help`, `hey help --json` and `hey guide` render from
  `src/hey-help.ts`; a command exists there iff it is dispatched.
- **ssh** — only for a program with a `host`: `ssh -o BatchMode=yes <target> cat|rm -f|true`
  through `runSsh`, bounded, to read a hosted cycle's report and transcript back and to probe the
  box before waking it. drovr never runs a cycle's work over ssh; the terminal is orca's.
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
