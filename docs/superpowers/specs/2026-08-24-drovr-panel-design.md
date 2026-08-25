# drovr panel — design

A single-pane web view of every program drovr supervises, served from the drovr aice install,
readable on a phone, with a bounded set of controls that queue rather than execute.

Status: design approved 2026-08-24, implemented on branch `drovr-panel`.

**This document has been corrected against what shipped.** Sections marked *(shipped:)* record
where the implementation diverged and why; the surrounding prose is the design as approved. Read
the corrections — three of them describe behaviour that would be a regression to "restore".

## Why this exists

`drovr watch` is the only view of the supervisor, and it only exists where the terminal is. The
panel makes the same state readable from anywhere Craig can sign in to aice, and adds one thing
the TUI never had: a preview of what each runner is actually saying.

The panel is a **second renderer, never a second brain**. Every judgement stays in `decide()`.

## What was proven before designing

Recorded because each answer eliminated an approach, and re-deriving them is expensive.

| Question | Answer | How |
|---|---|---|
| Does an aice page allow inline `<script>`? | Yes | Craig confirmed |
| Does CSP allow an off-origin `fetch`? | No CSP header is sent at all | Measured on `sunnyt.aicex.app`: `fetch('https://api.github.com/zen')` → 200 |
| Is the aice install auth-gated? | Yes, everything except `/_aice/*` | `curl` on 5 paths: `.json`, `.ico`, `_pages.json`, prefix index all 302 to Cognito |
| Can a browser page read a published `.json` same-origin? | Yes | From an authenticated tab: 200, `application/json`, not redirected, 204ms |
| Can drovr publish JSON through aice? | Only under `assets/` | Top-level `snapshot.json` → `BAD_PATH`; paths must end `.html/.css/.js` or live under `assets/` |
| Does `--ttl` tag every version? | Yes | 3 publishes → 4 versions, all tagged `aice-ttl=1d` |
| Is version growth bounded? | Yes, to ~1 day | Lifecycle `NoncurrentVersionExpiration: 1d` filters on that tag |
| Can the runner's output be read? | Yes | `herdr agent read drovr-sunnyt --source recent-unwrapped --lines 30 --format text` |

**Consequence: there is no new infrastructure.** An earlier draft proposed a tofu-managed S3
bucket, CloudFront distribution and a rotating capability URL. The aice install already *is* that,
with Cognito/Google auth in front. That draft is abandoned — the capability URL was the weakest
part of the design and it no longer exists.

## Architecture

```
drovr snapshot   (launchd, adaptive cadence)
  │
  ├─ snapshot()             all I/O, one shot
  │    ├─ teamclaude status --json
  │    ├─ control.json, ledger, locks, service state
  │    └─ herdr agent read   (per running program)
  │
  ├─ payload(state)          pure  → JSON
  └─ aice publish --as assets/snapshot.json --ttl 1d --force
                              │
                              ▼
                     s3://aice-t-drovr  →  CloudFront  →  Cognito gate
                                                            │
   panel (index.html, published once) ─── same-origin fetch ┘
                                          credentials: same-origin
                                          cache-buster query param

intents:  panel → aice note → drovr tick drains → keys.ts → control.json
```

`drovr watch` keeps working exactly as it does today, from the same `snapshot()`.

## 1. The snapshot contract

New `src/snapshot.ts`. `watch.ts:frame()` currently interleaves I/O and rendering; split it:

*(shipped: as two files, not one — `src/state.ts` holds `collectState()`/`buildState()` and the
`DrovrState` shape, `src/panel.ts` holds `payload()`, `payloadHash()` and the publish cadence.
There is no `src/snapshot.ts`. The split follows the I/O boundary: state.ts is the only reader,
panel.ts is pure.)*

```
snapshot(): Promise<DrovrState>     // every read the frame does today, plus previews
frame(state: DrovrState): string    // ANSI      — pure
payload(state: DrovrState): string  // JSON      — pure
```

Rules:

- **One `Pool`, one allocation, one verdict.** The panel derives nothing. `allocation.ts` already
  carries a trap for a picture that contradicts the verdict beneath it; a second renderer is the
  obvious way to reintroduce it. If the panel needs a number it comes from the snapshot.
- **`snapshot()` is the only I/O.** Both renderers are pure and testable against a recorded
  `DrovrState` fixture, with no mocks — matching how `decide()` is tested.
- **Self-describing**, per `AGENT_NOTES`: `schemaVersion` at the root, ISO timestamps not epoch
  millis, units in field names, floats rounded at the edge.
- `renderStatus()` in `render.ts` is **untouched**. It stays the mechanical fallback for a cycle
  that dies before publishing and must keep working without any of this.

Shape (abbreviated):

```
DrovrState {
  schemaVersion: 1
  generatedAt: ISO
  mode, pauseUntil, maxConcurrentCycles, ceilings
  service: { loaded, intervalSeconds, lastTickAt, overdue }
  pool: { usableAccounts, fable, general, session }
  bindingBucket: 'fable' | 'general' | 'session'
  cyclesFundable, bindingRecoveryAt, hoursToWeeklyReset
  allocation: { bucket → { yoursSpent, programsSpent, programsReserved,
                           programsAvailable, yoursReserved, total } }
  programs: [{ name, enabled, priority, verdict, reason, elapsed, kind, pid,
               asksUrl, context: { percent, tokens, subagents } | null,
               preview: string[] | null }]
  accounts: [{ name, org, status, sessions, buckets: { … }, lastUsedAt }]
  recentCycles: [ … ]
  queuedIntents: [{ id, action, requestedAt, expiresAt }]
}
```

*(shipped: `earliestRecoveryAt` became `bindingRecoveryAt`, and it is `pool.resetAt[bindingBucket]`
— when the bucket that is actually refusing recovers — not `pool.earliestRecoveryAt`, which is the
soonest across all three and would reintroduce decide.ts's own trap in the payload. `reserve` and
`cyclesInFlight` were added; both have doc comments in `state.ts` saying which near-identical field
they are deliberately not. `queuedIntents` shipped with no producer — the tick applies an intent
within the same tick rather than queuing it — and is documented in `state.ts` as reserved.)*

## 2. The publisher

New `drovr snapshot` command plus a second launchd agent.

**Cadence is adaptive, not fixed.** The concern is write volume, not correctness:

- 20s while any cycle is in flight
- 5 minutes when the pool is quiet
- **skip the publish entirely when the payload hash is unchanged**

Overnight with nothing running this is near-zero writes. At worst it is ~4,320 publishes/day
(~$0.65/month in PUTs, ~20MB of self-expiring versions).

*(shipped, and this is the correction that matters most — **do not "restore" the quiet cadence**:*

- *`quietSeconds` was **deleted**, not tuned. `CADENCE` in `panel.ts` is `{activeSeconds: 20,
  heartbeatSeconds: 40}` and nothing else. A 5-minute quiet cadence sits behind the page's own
  120s staleness threshold, so a healthy, unchanged supervisor would raise a false "the Mac
  stopped pushing" banner. The 40s heartbeat exists precisely to keep publishing when nothing
  has changed, and it is checked **above** the hash comparison, never inside it.*
- *The hash skip is real code but almost never fires. Account telemetry —`lastUsedAt`,
  `sessions`, `current`, the 5h bucket — moves on nearly every `collectState()`, so the payload
  differs on nearly every poll. A heartbeat nested inside the unchanged branch would have been a
  branch that never runs.*
- *The cost framing above is backwards. Measured: ~2,160 publishes/day idle (the 40s heartbeat
  floor) and ~3,900/day steady with the hash almost always changing — near the "at worst" figure,
  not near zero. The dollar cost is unchanged and still negligible; the sentence about overnight
  writes is simply wrong.)*

**Publish invariants:**

- Path must be `assets/snapshot.json` — anything else is rejected `BAD_PATH`.
- `--ttl 1d` on **every** publish. It re-stamps the clock and keeps the lifecycle tag on the new
  version. Omit it once and that version never expires.
- `--force` is required once the object has stored versions. The first publish to a fresh path
  succeeds without it; every one after that fails loudly. Pass it unconditionally.
- Requires aice CLI **>= 0.16.0** (`--ttl` landed after 0.11.0). Assert the version and refuse
  with the literal upgrade command rather than failing obscurely.
- Runs through **drovr's own** direnv (`direnv exec /Users/cadam/code/drovr`), not a program's
  cwd. `publish.ts:wrap` takes `program.cwd`; the panel is not a program, and reusing that helper
  would publish drovr's state into sunnyt's install.

**Failure is soft, always.** A failed publish logs one warning and the tick continues. The panel
going stale must never be able to stop a cycle starting. The TTL turns a prolonged outage into a
404 rather than a convincing dead frame.

## 3. The panel page

Published once to the drovr install; the data arrives over the wire. It never reloads itself.

- Tailwind, authored as the install's page. Reference implementation: `mock/panel.html`.
- Poll `<slug>/assets/snapshot.json?t=<epoch>` with `credentials: 'same-origin'`. The slug comes
  from the install (`craig`), and the data path is fixed regardless of where the page itself lives.
  The cache-buster is **required** — aice sets no `Cache-Control`, so CloudFront would otherwise
  serve a stale snapshot indefinitely.
- Poll cadence mirrors the publisher: 5s, backing off to 30s once `generatedAt` has been unchanged
  for several polls. Polling every 5s against a 5-minute publish is wasted round trips.
  *(shipped as written — 5s/30s after 3 unchanged polls — but the reason no longer holds: there is
  no 5-minute publish. The backoff is now just politeness against a 20s/40s publisher.)*
- Render order: status line → programs → capacity → controls → recent cycles → accounts.
- Preview text is inserted with `textContent`, never `innerHTML`. aice sends no CSP, so the page's
  own escaping is the only thing between agent output and the DOM.
- Every list is keyed by program name so a poll re-render does not lose scroll or disclosure state.

**Two failure states the page must distinguish, because they need different actions:**

| Condition | Display |
|---|---|
| Snapshot older than **2 minutes** | "Showing state from N minutes ago. The Mac stopped pushing." |
| Fetch returns non-JSON or redirects | "Session expired — reload to sign in." |
| Fetch returns 404 | "No data. The supervisor has been down over a day." |

Silently continuing to show the last good frame is the one behaviour that is not acceptable.

## 4. Intents

The panel never reaches into the Mac. It writes an intent; the tick drains it.

- Written as an **aice note** on the panel page. The server stamps the author from the verified
  session, so attribution is enforced rather than conventional — a stronger guarantee than any
  token embedded in the page.

  *(shipped: on `craig/intents.html`, a separate shell-wrapped page, **not** the panel. The panel
  is custom markup with no `<aice-page>` wrapper, so `/_aice/widgets.js` never loads and it has no
  notes widget — and therefore no comment control and no **Share** control, which is the only
  place shared notes can be switched on. A control channel on the panel would have been a channel
  nobody could write to or enable. The panel links to `intents.html` instead.)*
- `tick` reads notes, applies each through **`keys.ts`** — the same mutate path the TUI uses, so
  there is exactly one writer of `control.json` — then replies with the outcome and resolves.
- Every intent carries `expiresAt` and a nonce. An expired intent is resolved with "expired, not
  applied". A queued "pause 1h" that drains three hours late is wrong.
- Draining is **bounded**: at most 20 intents per tick, and an unparseable note is replied to and
  resolved rather than retried forever. Hitting the cap is logged, never silently truncated.

**In scope:** mode, pause/extend, reserve ±, concurrency cap ±, per-program enable/disable,
priority ±.

**Out of scope for v1:** `interrupt`. It is the highest-blast-radius action and the one that wants
immediacy the queue cannot give. It stays TUI-only until the queue has proven itself.

Requires shared notes enabled on the page. Craig owns the install, so he can set a space-level
policy — but `asks.ts` already records that unreadable and unanswered are different things, and
the drainer must say which.

## 5. Previews

`herdr agent read drovr-<program> --source recent-unwrapped --lines 30 --format text`, parsed for
the trailing assistant lines plus the status line's context reading.

- **Parse leniently.** This inverts the rule for `agent_status`. That field is *declared*, so
  `herdr.ts` parses it strictly and throws on an unrecognised shape. This is a **scrape of
  claude's TUI**, whose format changes between releases. On any surprise, return `null` and render
  no preview. A cosmetic feature must never be able to break a tick.
- Bounded: last 6 lines, each truncated to 200 chars, whole preview capped at 2KB.
- Only for programs with a live cycle. One subprocess per running program per snapshot.
- `context.percent` is surfaced because it is nearly free and tells you a cycle is approaching the
  ceiling where it ends itself — something drovr has never had visibility into.

**Deliberately not done:** feeding subagent activity or context into stall detection. `cycle.ts`
already has debugged logic there; changing it is a separate change with its own risk.

**Accepted exposure:** verbatim agent output leaves the machine. Craig chose this over the
redacted alternatives on 2026-08-24. It is bounded by the install's `adam11.ca` gate.

## 6. teamclaude schema extension

The accounts section needs fields `teamclaude.ts` does not currently parse: `orgName`, `status`,
`sessions`, `usage.lastUsed`, and `unifiedStatus`. Add them to the zod shape. Everything crossing
the process boundary stays validated; nothing is cast.

## 7. Testing

`node --test test/*.spec.ts`, no mocks or spies.

- `payload()` against a recorded `DrovrState` fixture — asserts units, ISO timestamps, rounding.
- `frame()` against the **same** fixture — the anti-drift test.
- Preview parser against captured `herdr agent read` output, including a malformed sample that
  must yield `null` rather than throw.
- Intent parser: valid, expired, unparseable, duplicate nonce.
- Cadence decision: unchanged hash → no publish; past the heartbeat → publish regardless.
  *(shipped: `shouldPublish` takes no `cycleRunning`; the 20s/5m split by whether a cycle was in
  flight went with `quietSeconds`.)*
- The panel is a **third renderer** and is outside both `tsc` and this suite. `panel.spec.ts`
  checks the one contract that is machine-checkable — that the page's `SCHEMA_VERSION` matches
  `DrovrState.schemaVersion`. Every other guard on that page has to be added by hand.

`pnpm check-types` is the gate.

## Open questions

- ~~**Where the panel lives.**~~ **Resolved: `--as index.html`**, so `drovr.aicex.app/craig/` *is*
  the panel. This was never decided before publishing and defaulted to `craig/panel.html`; Craig
  caught it live and the page was republished, with `panel.html` removed so no stale copy carries
  the pre-fix fiction. Verified first that `aice reindex` rebuilds a slug's landing **card** in the
  bucket-root `_pages.json`, not the prefix `index.html` page, and that the authoring guide's
  "never overwrite a prefix index" is convention rather than a technical block — the server seeds
  `index.html` only when absent. Not done: `s3://aice-t-drovr/index.html`, the bare-domain front
  door, which is outside aice's publish surface and would need a direct S3 write.
- ~~**Publish rate limits.**~~ **No longer a question — it is the permanent operating point.** With
  `quietSeconds` deleted, the floor is one publish per 40s forever, and the steady rate is roughly
  one per 20s. Nothing has been refused. The evidence is ~200 seconds of observed publishing, not a
  day: a rate limit that only bites after sustained hours would not have shown up yet.
