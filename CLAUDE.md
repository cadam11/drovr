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
is per-request, so the Fable runner and its Opus subagents can land on different accounts; usage is
therefore pooled across accounts. But each request is served by *one* account and decrements *its*
three buckets, so an account is spendable only where it has room in all three at once: fundability
is `Σ_accounts min_bucket(headroom/cost)`, never the min of the per-bucket sums. Admission requires funding a *whole* cycle plus a reserve,
because a truncated cycle pays full onboarding cost for partial delivery. And an account only
counts if teamclaude's fable route will actually route to it — eligibility there tracks usage
against its own `switchThreshold`, so an ineligible account usually returns at its next reset.

## Traps that have already bitten

Each of these was a real bug. Re-read before touching the relevant file.

| Area | Trap |
|---|---|
| `capacity.ts` | Headroom must clamp per account (`max(0, ceiling - used)`) before summing. Computing `ceiling × N - totalUsed` lets one blown account eat another's headroom. |
| `capacity.ts` | The per-bucket sums are a display figure, never fundability. **Min-of-sums is not sum-of-mins**: summing a bucket across accounts lets an account donate headroom it cannot spend because it is exhausted in another bucket, and a later `min` does not put it back. One Fable token decrements all three buckets *on the one account that served the request*, so capacity is `Σ_accounts min_bucket(headroom/cost)`. Live 2026-08-24 this offered 6.3 cycles while every account was pinned and nothing could run. |
| `decide.ts` | With capacity summed per account there is a binding bucket per account. Above zero report the one pinning the account that would serve next (most fundable); at zero report the one whose reset comes soonest, since that account unblocks first. Getting this backwards turns a two-hour session hold into an apparent week-long write-off. |
| `ledger.ts` | The 5h window resets *during* a multi-hour cycle, so `poolAfter > poolBefore` is normal. Recording that as zero cost drags the median to nothing until session stops constraining admission. Discard the sample instead. |
| `decide.ts` | Report *which* bucket binds. A 5h hold recovers in hours, a weekly one in days; reporting the soonest reset across all three is actively misleading. |
| `decide.ts` | In-flight cycles have not shown up as spent quota yet, or N concurrent programs each claim the whole pool. Subtract them from the **cycle count** — `cyclesFundableFrom`'s `running` argument. Not `running × cost` off a per-bucket pool: that was `lessReserved`, and it models nothing now that fundability is summed per account. |
| `allocation.ts` | Bar segments must derive headroom from the same `Pool` `decide()` uses, or the picture contradicts the verdict printed beneath it. The bars answer *how much of each bucket is spent* and the verdict answers *can a cycle run* — those legitimately differ, so the reason string has to name the coupling when it is what refuses. |
| `tick.ts` | Pace and reservations are **global** (one shared pool); daily caps and stuck detection are **per program**. |
| `watch.ts` | Draw on the **alternate screen** (`?1049h`), home-and-clear-per-line rather than clearing the whole screen, clamp to `stdout.rows`, and never end a frame with a newline. Any one of those missing and the frame scrolls or pollutes shell scrollback. |
| `watch.ts` | Clip every line to `stdout.columns` using visible length, not string length — a soft-wrapped line shoves the whole frame upward. Wrap the keybar rather than clipping it: a key you cannot see is a key you do not have. |
| `watch.ts` | Clamping to `stdout.rows` must **reserve the tail**, not slice it off. The message line, the preview warning and the keybar are appended last, so a plain `slice(0, rows - 1)` takes exactly those three first. At Craig's real configuration the body alone is 28-33 rows at every width, so a 24-row terminal lost all of them — and `x` then armed `confirmStop` with no visible prompt, making the next keystroke either an interrupt or a silent cancel. `frame` owns the clamp and keeps the tail whole; test it by passing a rows budget, since calling `frame(state, view, width)` with no rows exercises a path `watch()` never takes. |
| `asks.ts` | Reading notes needs shared notes enabled on the page by its owner. When it is off the call succeeds and returns nothing, so treat unreadable and unanswered as different things and say which. |
| `asks.ts` | Every `aice` call carries an execFile `timeout`. `tick.ts`'s `DRAIN_BUDGET_MS` is checked only *between* threads, so a hung `aice` inside one holds the tick lock forever and every later launchd firing logs `another tick is still evaluating` while admission stops silently. Notes I/O is unconditional and runs first, which is what makes that reachable. Still unbounded: `teamclaude.ts`'s `readStatus` and `herdr.ts`'s `herdr()` and preview-reading `run('herdr', ['agent', 'read', ...])` all pass no `timeout`, and `readStatus()` runs first in both `tick()` and `collectState()` — at least as reachable as the notes path — with no time-based staleness in `lock.ts` to bound the hold. Not fixed here; a separate change. |
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
| `nudge.ts` | Never conclude a send worked from its exit code. `aws sns publish` returns a MessageId and exit 0 for messages that fail at delivery a minute later; the reason appears only in the `DirectPublishToPhoneNumber/Failure` log group. `notify` waits for the real verdict — keep it that way. |
| `publish-snapshot.ts` | aice refuses any JSON published outside `assets/`. The panel's data path is `assets/snapshot.json` and nothing else — a snapshot published to a bare path is rejected, and the page then reads a 404 it has no way to distinguish from a dead Mac. |
| `publish-snapshot.ts` | Every panel publish carries `--ttl` **and** `--force`. Without `--force` a republish to the same path is refused and the panel silently freezes at the last accepted payload; without `--ttl` a prolonged outage leaves a convincing dead frame up forever instead of turning into the 404 the page reports honestly. |
| `publish-snapshot.ts` | aice must be >= 0.16.0 — earlier builds have no `--ttl`, so the publish fails on an unknown flag rather than on anything about the payload. `assertAiceVersion` names the floor and the fix (`aice update`); keep the check ahead of the publish, not after it. |
| `panel/index.html` | The snapshot fetch needs a cache-buster (`?t=${Date.now()}`) alongside `cache: 'no-store'`. CloudFront happily serves a stale object to a plain URL, and a panel showing minute-old capacity as current is worse than one showing nothing. |
| `preview.ts` | The preview parser is lenient **because it is a scrape** of claude's TUI — an undeclared format that changes between releases, where an unrecognised shape must yield `null` and cost the panel a preview, never fail a tick. This is the exact inverse of `herdr.ts`'s `agent_status` rule: parse a declared interface strictly and let a surprise throw, parse a scrape leniently and let it return nothing. Know which one you are reading before choosing. |
| `asks.ts` | Two note shapes on purpose. `readAsks` parses leniently for a liveness heuristic; `listNotes` parses strictly because what it returns is applied to `control.json`. Do not merge them into one tolerant shape — that would make an unrecognised payload look like a page with no intents on it. |
| `asks.ts` | A zero exit from an `aice notes` **write** is not proof the note exists. Measured 2026-08-24 against drovr.aicex.app: `notes add` to a page whose notes are not shared exits 0 and prints `added: true` — with **no `id`**, which is the tell, since a persisted entry comes back carrying a server-minted one. Reproduced twice with an explicit `--prefix` on both calls, each naming the identical resolved page, so it is not the path-ambiguity asymmetry it first looks like. aice's source *does* gate writes (`aice-manage/src/notes.ts` returns 403 `sharing_off`, and the client maps that to `SHARING_OFF`), so the deployed install appears to be behind that tree — inferred, not confirmed. Either way: to know a page is writable read it and check `shared: true`, never the write's exit code. |
| `panel/index.html` | A page of custom HTML has no notes widget. The affordance ships inside `<aice-page>`, which loads `/_aice/widgets.js`; a hand-rolled page never loads it, so it has no comment control and — the part that actually bites — **no Share control**, which is the only place sharing can be switched on. That is why intents live on `intents.html` (shell-wrapped) rather than on the panel, which stays custom. |
| `tick.ts` | A drained intent goes **resolve → apply → reply**, and the order is the whole guarantee. Resolving first is what makes it at-most-once: the process can die, or the reply can fail, and the cost is an instruction lost with a line in the log. Apply first and every later failure leaves the thread open, so the next tick rewrites `pause 3h` to another three hours from *then* — a supervisor paused indefinitely with nothing but `tick.err` to say so. For a file that governs autonomous work, losing an instruction loudly beats repeating one quietly. |
| `tick.ts` | That guarantee rests on an assumption the row above about `notes add` says not to make: that a resolve which did not throw actually persisted. `confirmResolved` re-lists once after a batch and logs any thread still open, so the assumption is observable rather than silent. Do not delete it as a redundant call — it is the only thing standing between a lying write and a replayed `pause`. |
| `tick.ts` | `--reopen` is **bounded, not closed**. Resolved state is the latest resolve across all participants' blobs with no authority gate, so anyone who can read the page can reopen a thread once sharing is on, and a replay inside the stamp's life re-applies. Saturating actions (priority, concurrency, mode, enable) are harmless; `pause` re-extends, which the parser's 24h `expires=` ceiling caps at roughly a day rather than forever. |
| `tick.ts` | Filter threads to the `drovr-intent v1` prefix **before** taking the batch, not after. Ordinary comments are deliberately never resolved and aice lists oldest first, so counting them toward the cap lets twenty of them fill it permanently and starve every intent behind them — while the log repeats a cap message that is a lie, since the next tick makes identical non-progress. On a page that invites conversation about itself, any reader can silence the control channel with twenty innocuous notes. |
| `state.ts` | A diagnostic's sink is the **caller's** choice, not the producer's. `collectState`'s `onWarning` has three correct answers — fold it into the frame (`watch.ts` can never print mid-frame), `console.error` it (`publish-snapshot.ts`, unattended under launchd), or drop it — and omitting the argument silently picks the third. Three defects on the panel branch came from that one shape, including a `console.error` that was right in one caller and corrupted a terminal frame in the other. Pass the sink deliberately at every call site. |
| `panel/index.html` | It is a **third renderer** — fourth counting `cli.ts`'s `status` text — and the only one outside both `tsc` and the suite. The anti-drift test guards `frame()` against `payload()`; nothing guards this page, so every divergence found on the panel branch was of the form "`watch.ts` guards it, `panel/index.html` doesn't" — a lapsed `pauseUntil` shown as an active pause, a `mode: off` payload rendered as fable refusing cycles. The lapsed pause was in `cli.ts:status` too, for the same reason: `control.pauseUntil !== null` is not a pause, `isPaused(control, now)` is. When you add a guard to `watch.ts`, go and add it to every other renderer too, by hand. |
| `panel/index.html` | In `mode: off`, `ceilingsFor` returns null and the `{weekly: 0}` fallback zeroes every account's headroom, so the payload comes back `bindingBucket: 'fable'`, `cyclesFundable: 0` and three fully-reserved bars. Those are artefacts of the mode, not readings of the pool. `watch.ts` suppresses the whole allocation block and says the mode is off; anything that renders them instead asserts a false cause for the stop. |
| `keys.ts` | Mode ceilings must stay ordered `low <= normal <= away`, enforced on every write. `setReserve` clamps each mode only against itself, so repeated keypresses drifted `low` to session 0.65 against `away`'s 0.60 — measured live 2026-08-25, which made the mode Craig reaches for when nervous the **most permissive of the three**. The mode just edited wins and the others move around it; never silently override the number he asked for. |
| `teamclaude.ts` | Parse `routes[].accounts[].eligible`. The runner is always Fable, so an account that route refuses will never serve one of its requests and its headroom is not drovr's to spend however healthy the three buckets look. A missing route means *no restriction known*, not *nothing eligible* — refusing every account over absent information would stop the loop dead. |
| `capacity.ts` | An unroutable account stays in `perAccount` with its real headroom and `routable: false`. It is not filtered out: it still owns the resets that say when the pool recovers, and dropping it would hide both that and the reason its headroom is ignored. `decide.ts` zeroes its *fundability*, not its headroom — the bars still answer how much of each bucket is spent pool-wide. |
| `decide.ts` | Report how many accounts *carry* the total, not how many exist. "across 3 accounts" read as a healthy pool on 2026-08-25 while two were spent and the third — the only fable-routable one — was also serving Craig's own foreground sessions. A pool resting on one account has no fallback, and the headline number cannot say so. |
| `ledger.ts` | `lastDecisionAt` is not a liveness signal. It only advances when an **enabled** program is evaluated, so disabling every program made drovr accuse its own launchd agent of being stalled while ticks fired normally. Every completed tick stamps `last-tick.json` instead; read that for health and keep the decision log for decisions. |
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
- **`headless` runner mode** — a fallback, exercised once early, untouched since the herdr runner
  landed.
- **A panel intent applied end to end.** Every piece is tested against a real control file, but no
  intent has been read off the live page, because shared notes are **off** on `craig/intents.html`
  and only Craig can turn them on, from the notes widget on the page itself. Until he does, every
  tick logs the page as unreadable and nothing can be sent from the panel.

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
