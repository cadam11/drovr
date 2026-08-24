# drovr panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish drovr's live state to the drovr aice install as a single-pane web panel, readable on a phone, with controls that queue rather than execute.

**Architecture:** `buildState()` assembles one `DrovrState` from already-read inputs; `collectState()` does the I/O. Both `frame()` (ANSI) and `payload()` (JSON) render from that one value, so the TUI and the panel can never disagree. A `drovr snapshot` launchd agent publishes the JSON into the aice install under `assets/`, where aice's own Cognito gate protects it; the panel page fetches it same-origin. Controls are written as aice notes and drained by `tick` through `keys.ts`.

**Tech Stack:** Node >= 24, TypeScript run directly (no build step), zod for process boundaries, `node --test`, Tailwind (CDN) for the page, aice CLI >= 0.16.0, launchd.

**Spec:** `docs/superpowers/specs/2026-08-24-drovr-panel-design.md`

## Global Constraints

- **Erasable syntax only** — no enums, no parameter properties. TypeScript runs directly.
- **zod for anything crossing a process boundary.** Never cast external data.
- **`pnpm check-types` is the gate.** Editor diagnostics lag; trust `tsc`.
- **Tests:** `node --test test/*.spec.ts`. No mocks, no spies. Test pure functions.
- **Comments explain *why*, never *what*.** Most functions should not have one.
- **One function, one job.** 40–60 lines hard limit. No nesting deeper than two levels.
- **Bound every loop.** Explicit maximum, and handle hitting it.
- **Never swallow errors.** Logged, raised, or explicitly returned.
- **aice CLI floor: 0.16.0** (`--ttl` does not exist in 0.11.0).
- **Data path is exactly `assets/snapshot.json`.** Anything else is rejected `BAD_PATH`.
- **Publish always passes `--ttl 1d` and `--force`.** Omitting `--ttl` leaves a version that never expires; omitting `--force` fails every publish after the first.
- **Publishes run through drovr's own direnv** (`direnv exec /Users/cadam/code/drovr`), never a program's cwd.
- **`decide()` stays pure.** The panel derives no verdicts of its own.
- **Never mutate teamclaude state.** Read-only, via `teamclaude status --json`.
- **`render.ts:renderStatus()` is untouched.** It stays the mechanical per-program fallback.
- **Naming:** the spec says `snapshot()`; use `collectState()` in `src/state.ts`. `ledger.ts:46` already exports `snapshot(pool)`.

**Shippable milestone:** Task 8 completes the read-only panel. Tasks 9–10 add the intent queue and can be deferred without leaving anything half-built.

---

### Task 1: teamclaude schema extension

The accounts section needs fields the current zod shape drops.

**Files:**
- Modify: `src/teamclaude.ts:12-30`
- Test: `test/teamclaude.spec.ts` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `TeamclaudeAccount` gains `type: string`, `orgName: string | null`, `status: string | null`, `sessions: number`, `usage: { lastUsed: string | null }`, and `quota.unifiedStatus: string | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/teamclaude.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseStatus } from '../src/teamclaude.ts';

const raw = {
  currentAccount: 'fourth@example.com',
  accounts: [
    {
      name: 'fourth@example.com',
      type: 'oauth',
      orgName: "fourth@example.com's Organization",
      status: 'active',
      sessions: 4,
      disabled: false,
      quota: {
        unified5h: 0.23, unified5hReset: 1787596200000,
        unified7d: 0.87, unified7dReset: 1787778000000,
        unified7dFable: 0.94, unified7dFableReset: 1787778000000,
        unifiedStatus: 'allowed_warning',
      },
      usage: { lastUsed: '2026-08-24T15:22:59.091Z' },
      rateLimitedUntil: null,
      pausedUntil: null,
    },
  ],
};

test('parseStatus keeps the fields the panel renders', () => {
  const parsed = parseStatus(raw);
  const account = parsed.accounts[0]!;
  assert.equal(account.type, 'oauth');
  assert.equal(account.status, 'active');
  assert.equal(account.sessions, 4);
  assert.equal(account.usage.lastUsed, '2026-08-24T15:22:59.091Z');
  assert.equal(account.quota.unifiedStatus, 'allowed_warning');
});

test('parseStatus tolerates an account that has never been used', () => {
  const parsed = parseStatus({
    currentAccount: null,
    accounts: [{
      name: 'second@example.com',
      type: 'oauth', orgName: 'Propra', status: 'active', sessions: 0, disabled: false,
      quota: {
        unified5h: null, unified5hReset: null, unified7d: null, unified7dReset: null,
        unified7dFable: null, unified7dFableReset: null, unifiedStatus: null,
      },
      usage: { lastUsed: null },
      rateLimitedUntil: null, pausedUntil: null,
    }],
  });
  assert.equal(parsed.accounts[0]!.quota.unifiedStatus, null);
  assert.equal(parsed.accounts[0]!.usage.lastUsed, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/teamclaude.spec.ts`
Expected: FAIL — the parsed account has no `type` / `sessions` / `usage` property.

- [ ] **Step 3: Extend the zod shapes**

In `src/teamclaude.ts`, add to `bucketFields`:

```ts
  unifiedStatus: z.string().nullable().default(null),
```

and replace `accountShape` with:

```ts
const accountShape = z.object({
  name: z.string(),
  type: z.string().default('oauth'),
  orgName: z.string().nullable().default(null),
  status: z.string().nullable().default(null),
  sessions: z.number().default(0),
  disabled: z.boolean(),
  quota: bucketFields,
  usage: z.object({ lastUsed: z.string().nullable().default(null) }).default({ lastUsed: null }),
  rateLimitedUntil: z.number().nullable(),
  pausedUntil: z.number().nullable(),
});
```

Defaults rather than required fields: teamclaude omits these on accounts it has never routed to, and a hard failure there would take the whole tick down.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/teamclaude.spec.ts && node --test test/*.spec.ts && pnpm check-types`
Expected: PASS. `test/fixtures.ts:account` builds accounts without the new keys, which is why they carry defaults.

- [ ] **Step 5: Commit**

```bash
git add src/teamclaude.ts test/teamclaude.spec.ts
git commit -m "feat: parse the teamclaude account fields the panel renders"
```

---

### Task 2: the preview parser

Reads what a runner last said. A scrape, so it parses leniently — the opposite of the `agent_status` rule.

**Files:**
- Create: `src/preview.ts`
- Test: `test/preview.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Preview = { lines: string[]; contextPercent: number | null; contextTokens: number | null; subagents: number | null }` and `parsePreview(raw: string, maxLines?: number): Preview | null`.

- [ ] **Step 1: Write the failing test**

```ts
// test/preview.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePreview } from '../src/preview.ts';

const REAL = `⏺ Agent "Promotion train + S-123 close" finished · 30m 42s

⏺ Poll 7, ~8 min. Waiting.

✻ Cooked for 5s · 1 monitor still running

──────────────── sunnyt program runner ─
❯
────────────────────────────────────────
  Propra@Craigs-MacBook-Pro in sunnyt on stage
  using Fable 5 | ctx:18% (176k)
  ⏵⏵ auto mode on · 1 monitor · ← for agents
`;

test('parsePreview takes the trailing assistant lines', () => {
  const preview = parsePreview(REAL)!;
  assert.equal(preview.lines.length, 3);
  assert.match(preview.lines[0]!, /^Agent "Promotion train/);
  assert.equal(preview.lines[2]!, 'Cooked for 5s · 1 monitor still running');
});

test('parsePreview reads the context gauge', () => {
  const preview = parsePreview(REAL)!;
  assert.equal(preview.contextPercent, 18);
  assert.equal(preview.contextTokens, 176_000);
  assert.equal(preview.subagents, 1);
});

test('parsePreview is bounded by maxLines and truncates long lines', () => {
  const raw = Array.from({ length: 40 }, (_, i) => `⏺ line ${i} ${'x'.repeat(400)}`).join('\n');
  const preview = parsePreview(raw, 6)!;
  assert.equal(preview.lines.length, 6);
  assert.ok(preview.lines.every((line) => line.length <= 200));
  assert.match(preview.lines[5]!, /^line 39/);
});

test('parsePreview caps the whole preview at 2KB of UTF-8', () => {
  const raw = Array.from({ length: 10 }, (_, i) => `⏺ ${'✻'.repeat(190)} ${i}`).join('\n');
  const preview = parsePreview(raw)!;
  assert.ok(Buffer.byteLength(preview.lines.join('\n'), 'utf8') <= 2048);
});

test('parsePreview returns null rather than throwing on an unrecognised shape', () => {
  assert.equal(parsePreview(''), null);
  assert.equal(parsePreview('claude: command not found'), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/preview.spec.ts`
Expected: FAIL — `Cannot find module '../src/preview.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/preview.ts

/** claude marks each assistant turn with one of these glyphs. */
const TURN_GLYPHS = ['⏺', '✻', '✦', '·'];

const MAX_LINE = 200;
const MAX_SCAN = 400;

export type Preview = {
  lines: string[];
  contextPercent: number | null;
  contextTokens: number | null;
  subagents: number | null;
};

const isTurn = (line: string): boolean => TURN_GLYPHS.some((glyph) => line.startsWith(glyph));

const strip = (line: string): string =>
  line.slice(1).trim().slice(0, MAX_LINE);

const gauge = (raw: string): { percent: number | null; tokens: number | null } => {
  const match = /ctx:\s*(\d+)%\s*\(([\d.]+)([km])\)/i.exec(raw);
  if (match === null) return { percent: null, tokens: null };
  const scale = match[3]!.toLowerCase() === 'm' ? 1_000_000 : 1_000;
  return { percent: Number(match[1]), tokens: Math.round(Number(match[2]) * scale) };
};

/** Line truncation is by character; this enforces the byte budget the panel ships. */
const capBytes = (lines: string[], budget = 2048): string[] => {
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const size = Buffer.byteLength(line, 'utf8') + 1;
    if (used + size > budget) break;
    kept.push(line);
    used += size;
  }
  return kept;
};

const monitors = (raw: string): number | null => {
  const match = /(\d+)\s+monitor/.exec(raw);
  return match === null ? null : Number(match[1]);
};

/**
 * A scrape of claude's TUI, not a declared interface: the format changes between
 * releases, so an unrecognised shape yields null and the panel simply shows no
 * preview. This must never be able to fail a tick.
 */
export const parsePreview = (raw: string, maxLines = 6): Preview | null => {
  if (raw.trim() === '') return null;

  const all = raw.split('\n');
  const scanned = all.slice(Math.max(0, all.length - MAX_SCAN));
  const turns = scanned.filter(isTurn).map(strip).filter((line) => line !== '');
  if (turns.length === 0) return null;

  const { percent, tokens } = gauge(raw);
  return {
    lines: capBytes(turns.slice(-maxLines)),
    contextPercent: percent,
    contextTokens: tokens,
    subagents: monitors(raw),
  };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/preview.spec.ts && pnpm check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/preview.ts test/preview.spec.ts
git commit -m "feat: parse a runner's latest output and context gauge"
```

---

### Task 3: reading a runner's output through herdr

Wires `parsePreview` to the live agent. Isolated from Task 2 so the parser stays pure.

**Files:**
- Modify: `src/herdr.ts` (append)
- Test: none — this is I/O; the parsing it delegates to is covered by Task 2.

**Interfaces:**
- Consumes: `parsePreview` from `src/preview.ts`.
- Produces: `readPreview(agentName: string): Promise<Preview | null>` exported from `src/herdr.ts`.

- [ ] **Step 1: Read the existing exec helper**

Run: `grep -n "execFile\|promisify\|const run" src/herdr.ts | head`
Use whatever runner `herdr.ts` already uses; do not introduce a second one.

- [ ] **Step 2: Append the reader**

```ts
/**
 * Best-effort by design: a program with no live pane, a herdr that is down, or a
 * claude whose TUI changed all mean "no preview", never a failed tick.
 */
export const readPreview = async (agentName: string): Promise<Preview | null> => {
  try {
    const { stdout } = await run('herdr', [
      'agent', 'read', agentName,
      '--source', 'recent-unwrapped',
      '--lines', '40',
      '--format', 'text',
    ], { maxBuffer: 1024 * 1024 });
    return parsePreview(stdout);
  } catch (error) {
    console.error(`preview unavailable for ${agentName}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
};
```

Add the import at the top: `import { parsePreview, type Preview } from './preview.ts';`

- [ ] **Step 3: Verify against the live agent**

Run: `node -e "import('./src/herdr.ts').then(async m => console.log(await m.readPreview('drovr-sunnyt')))"`
Expected: either a `Preview` object with `lines` populated, or `null` with a logged reason. Both are correct outcomes.

- [ ] **Step 4: Typecheck**

Run: `pnpm check-types`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add src/herdr.ts
git commit -m "feat: read a live runner's latest output"
```

---

### Task 4: the state contract

The keystone. One value that both renderers consume.

**Files:**
- Create: `src/state.ts`
- Test: `test/state.spec.ts`

**Interfaces:**
- Consumes: `Pool`/`poolFrom` (`capacity.ts`), `allocationFor`/`Allocation`/`BucketName` (`allocation.ts`), `decide`/`cyclesFundableFrom` (`decide.ts`), `Control`/`Program`/`byPriority`/`effectivePriority`/`ceilingsFor` (`control.ts`), `CycleRecord`/`inFlight`/`estimateCycleCost`/`spentSince`/`readCycles` (`ledger.ts`), `TeamclaudeStatus` (`teamclaude.ts`), `Preview` (`preview.ts`).
- Produces: `type DrovrState`, `type StateInput`, `buildState(input: StateInput): DrovrState` (pure), `collectState(): Promise<DrovrState>` (I/O).

- [ ] **Step 1: Write the failing test**

```ts
// test/state.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { control, healthy, NOW } from './fixtures.ts';

const input = () => ({
  status: healthy(),
  control: control({ programs: [{ name: 'demo', cwd: '/tmp/demo' }] }),
  cycles: [],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 60_000 },
  previews: new Map(),
  locks: new Map(),
  asksUrls: new Map(),
  queuedIntents: [],
});

test('buildState stamps a versioned, ISO-timestamped envelope', () => {
  const state = buildState(input());
  assert.equal(state.schemaVersion, 1);
  assert.equal(state.generatedAt, new Date(NOW).toISOString());
});

test('buildState reports the binding bucket, not the soonest reset', () => {
  const state = buildState(input());
  assert.ok(['fable', 'general', 'session'].includes(state.bindingBucket));
});

test('buildState rounds floats so the JSON carries no float noise', () => {
  const state = buildState(input());
  const digits = (value: number) => (String(value).split('.')[1] ?? '').length;
  assert.ok(digits(state.pool.fable) <= 4);
  assert.ok(digits(state.cyclesFundable) <= 2);
});

test('buildState allocation segments sum to the bucket total', () => {
  const state = buildState(input());
  for (const bucket of ['fable', 'general', 'session'] as const) {
    const a = state.allocation[bucket];
    const sum = a.yoursSpent + a.programsSpent + a.programsReserved
      + a.programsAvailable + a.yoursReserved;
    assert.ok(Math.abs(sum - a.total) < 0.01, `${bucket} segments ${sum} != total ${a.total}`);
  }
});

test('buildState carries one entry per configured program, with a verdict', () => {
  const state = buildState(input());
  assert.equal(state.programs.length, 1);
  assert.equal(state.programs[0]!.name, 'demo');
  assert.ok(['GO', 'WAIT', 'STOP', 'RUN'].includes(state.programs[0]!.verdict));
});

test('buildState marks the service overdue past three intervals', () => {
  const stale = { ...input(), service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW - 4 * 600_000 } };
  assert.equal(buildState(stale).service.overdue, true);
  assert.equal(buildState(input()).service.overdue, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/state.spec.ts`
Expected: FAIL — `Cannot find module '../src/state.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/state.ts
import { allocationFor, type Allocation, type BucketName } from './allocation.ts';
import { hoursToWeeklyReset, poolFrom } from './capacity.ts';
import { byPriority, ceilingsFor, effectivePriority, readControl, type Control } from './control.ts';
import { cyclesFundableFrom, decide, type Verdict } from './decide.ts';
import {
  estimateCycleCost, inFlight, lastDecisionAt, readCycles, spentSince, type CycleRecord,
} from './ledger.ts';
import { aiceBaseUrl, readPreview } from './herdr.ts';
import { holder } from './lock.ts';
import { paths } from './paths.ts';
import type { Preview } from './preview.ts';
import { serviceState } from './service.ts';
import { readStatus, type TeamclaudeStatus } from './teamclaude.ts';

const BUCKETS: BucketName[] = ['fable', 'general', 'session'];
const SEED_COST = { fable: 0.1, general: 0.08, session: 0.25 };
const OVERDUE_INTERVALS = 3;

/** Rounded at the edge so the JSON carries meanings, not float noise. */
const r = (value: number, places = 4): number => Number(value.toFixed(places));

export type ProgramState = {
  name: string;
  enabled: boolean;
  priority: number;
  verdict: Verdict | 'RUN';
  reason: string;
  kind: string | null;
  startedAt: string | null;
  pid: number | null;
  asksUrl: string | null;
  context: { percent: number | null; tokens: number | null; subagents: number | null } | null;
  preview: string[] | null;
};

export type DrovrState = {
  schemaVersion: 1;
  generatedAt: string;
  mode: string;
  pauseUntil: string | null;
  maxConcurrentCycles: number;
  service: { loaded: boolean; intervalSeconds: number | null; lastTickAt: string | null; overdue: boolean };
  pool: { usableAccounts: number; fable: number; general: number; session: number };
  bindingBucket: BucketName;
  cyclesFundable: number;
  hoursToWeeklyReset: number | null;
  allocation: Record<BucketName, Allocation>;
  programs: ProgramState[];
  accounts: {
    name: string; org: string | null; status: string | null; sessions: number;
    current: boolean; lastUsedAt: string | null;
    buckets: Record<'session' | 'general' | 'fable', { usedFraction: number | null; resetsAt: string | null }>;
  }[];
  recentCycles: { startedAt: string; program: string; kind: string; exit: string; asksRaised: number }[];
  queuedIntents: { id: string; action: string; requestedAt: string; expiresAt: string }[];
};

export type StateInput = {
  status: TeamclaudeStatus;
  control: Control;
  cycles: CycleRecord[];
  now: number;
  service: { loaded: boolean; intervalSeconds: number | null; lastTickAt: number | null };
  previews: Map<string, Preview>;
  locks: Map<string, number>;
  asksUrls: Map<string, string>;
  queuedIntents: DrovrState['queuedIntents'];
};

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());

const isOverdue = (service: StateInput['service'], now: number): boolean => {
  if (service.intervalSeconds === null || service.lastTickAt === null) return false;
  return now - service.lastTickAt > service.intervalSeconds * 1000 * OVERDUE_INTERVALS;
};

const accountsOf = (status: TeamclaudeStatus): DrovrState['accounts'] =>
  status.accounts.map((account) => ({
    name: account.name,
    org: account.orgName,
    status: account.status,
    sessions: account.sessions,
    current: account.name === status.currentAccount,
    lastUsedAt: account.usage.lastUsed,
    buckets: {
      session: { usedFraction: account.quota.unified5h, resetsAt: iso(account.quota.unified5hReset) },
      general: { usedFraction: account.quota.unified7d, resetsAt: iso(account.quota.unified7dReset) },
      fable: { usedFraction: account.quota.unified7dFable, resetsAt: iso(account.quota.unified7dFableReset) },
    },
  }));

const programsOf = (input: StateInput): ProgramState[] => {
  const { control, cycles, now, previews, locks, asksUrls } = input;
  const running = inFlight(cycles);
  const ordered = byPriority(control.programs, now, control.deadlineHorizonDays);

  return ordered.map((program) => {
    const live = running.find((cycle) => cycle.program === program.name);
    const decision = decide({ status: input.status, control, cycles, program: program.name, now });
    const preview = previews.get(program.name) ?? null;
    return {
      name: program.name,
      enabled: program.enabled,
      priority: effectivePriority(program, now, control.deadlineHorizonDays),
      verdict: live === undefined ? decision.verdict : 'RUN',
      reason: decision.reason,
      kind: live?.kind ?? null,
      startedAt: live?.startedAt ?? null,
      pid: locks.get(program.name) ?? null,
      asksUrl: asksUrls.get(program.name) ?? null,
      context: preview === null ? null : {
        percent: preview.contextPercent,
        tokens: preview.contextTokens,
        subagents: preview.subagents,
      },
      preview: preview?.lines ?? null,
    };
  });
};

/** Pure: every read already happened in collectState. */
export const buildState = (input: StateInput): DrovrState => {
  const { status, control, cycles, now } = input;
  const ceilings = ceilingsFor(control) ?? { weekly: 0, session: 0 };
  const pool = poolFrom(status, ceilings, now);
  const cost = estimateCycleCost(cycles, SEED_COST);
  const funding = cyclesFundableFrom(pool, cost);
  const hoursLeft = hoursToWeeklyReset(status, now);
  const windowStart = hoursLeft === null ? now : now - (168 - hoursLeft) * 3_600_000;
  const spent = spentSince(cycles, windowStart);
  const running = inFlight(cycles).length;

  const allocation = Object.fromEntries(
    BUCKETS.map((bucket) => [bucket, allocationFor({
      status, pool, bucket,
      spentByPrograms: spent[bucket],
      runningCycles: running,
      cycleCost: cost,
      now,
    })]),
  ) as Record<BucketName, Allocation>;

  return {
    schemaVersion: 1,
    generatedAt: new Date(now).toISOString(),
    mode: control.mode,
    pauseUntil: control.pauseUntil,
    maxConcurrentCycles: control.maxConcurrentCycles,
    service: {
      loaded: input.service.loaded,
      intervalSeconds: input.service.intervalSeconds,
      lastTickAt: iso(input.service.lastTickAt),
      overdue: isOverdue(input.service, now),
    },
    pool: {
      usableAccounts: pool.usableAccounts,
      fable: r(pool.fable), general: r(pool.general), session: r(pool.session),
    },
    bindingBucket: funding.binding,
    cyclesFundable: r(funding.cycles, 2),
    hoursToWeeklyReset: hoursLeft === null ? null : r(hoursLeft, 1),
    allocation,
    programs: programsOf(input),
    accounts: accountsOf(status),
    recentCycles: cycles
      .filter((cycle) => cycle.endedAt !== null)
      .slice(-8).reverse()
      .map((cycle) => ({
        startedAt: cycle.startedAt, program: cycle.program,
        kind: cycle.kind, exit: cycle.exit, asksRaised: cycle.asksRaised,
      })),
    queuedIntents: input.queuedIntents,
  };
};

/** The only I/O. Previews are read concurrently and never allowed to reject. */
export const collectState = async (
  queuedIntents: DrovrState['queuedIntents'] = [],
): Promise<DrovrState> => {
  const p = paths();
  const now = Date.now();
  const status = await readStatus();
  const control = readControl(p.control);
  const cycles = readCycles(p.cycles);
  const running = inFlight(cycles);

  const previews = new Map<string, Preview>();
  const asksUrls = new Map<string, string>();
  const locks = new Map<string, number>();

  for (const program of control.programs) {
    const pid = holder(p.programLock(program.name));
    if (pid !== null) locks.set(program.name, pid);
  }

  await Promise.all(control.programs.map(async (program) => {
    if (program.aice?.asksPage != null) {
      const base = await aiceBaseUrl(program);
      if (base !== null) asksUrls.set(program.name, `${base}/${program.aice.asksPage}`);
    }
    if (!running.some((cycle) => cycle.program === program.name)) return;
    const preview = await readPreview(`drovr-${program.name}`.toLowerCase());
    if (preview !== null) previews.set(program.name, preview);
  }));

  const service = serviceState();
  return buildState({
    status, control, cycles, now,
    service: {
      loaded: service.loaded ?? false,
      intervalSeconds: service.intervalSeconds,
      lastTickAt: lastDecisionAt(p.decisions),
    },
    previews, locks, asksUrls, queuedIntents,
  });
};
```

- [ ] **Step 4: Reconcile against the real modules**

`serviceState()`'s return shape and `lock.ts`'s export name were read at plan time but verify before assuming:

Run: `grep -n "export const serviceState" -A 12 src/service.ts; grep -n "^export " src/lock.ts`
Adjust the `service` destructuring and `holder` import to match exactly. Do not add a compatibility shim.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/state.spec.ts && pnpm check-types`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/state.ts test/state.spec.ts
git commit -m "feat: assemble one DrovrState for every renderer to read"
```

---

### Task 5: point the TUI at the shared state

Without this the panel and the TUI read different values and `allocation.ts`'s
contradiction trap comes back. This is the task that makes the contract real.

**Files:**
- Modify: `src/watch.ts` — `frame()` and every helper it calls
- Test: `test/watch-state.spec.ts`

**Interfaces:**
- Consumes: `DrovrState`, `buildState`, `collectState`, `ProgramState` (`src/state.ts`).
- Produces: `frame(state: DrovrState, view: ViewState): string` — pure. `ViewState` is the existing
  `State` type (selection, message, confirmStop, help) renamed to free the name.

- [ ] **Step 1: Write the failing anti-drift test**

```ts
// test/watch-state.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { frame } from '../src/watch.ts';
import { payload } from '../src/panel.ts';
import { control, healthy, NOW } from './fixtures.ts';

const fixture = () => buildState({
  status: healthy(), control: control(), cycles: [], now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(), queuedIntents: [],
});

const view = { selected: 0, message: '', confirmStop: false, help: false };

test('frame renders from a DrovrState without touching the filesystem', () => {
  const text = frame(fixture(), view);
  assert.match(text, /drovr/);
  assert.match(text, /demo/);
});

test('both renderers agree on the verdict for every program', () => {
  const state = fixture();
  const text = frame(state, view);
  const json = JSON.parse(payload(state));
  for (const program of json.programs) {
    assert.match(text, new RegExp(program.verdict), `TUI is missing ${program.verdict}`);
  }
});

test('both renderers agree on the binding bucket', () => {
  const state = fixture();
  const json = JSON.parse(payload(state));
  assert.equal(json.bindingBucket, state.bindingBucket);
  assert.match(frame(state, view), new RegExp(state.bindingBucket));
});

test('frame is pure — the same state twice gives byte-identical output', () => {
  const state = fixture();
  assert.equal(frame(state, view), frame(state, view));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/watch-state.spec.ts`
Expected: FAIL — `frame` is not exported, and its current signature takes only `State`.

- [ ] **Step 3: Refactor `frame` to take state**

Mechanical, and nothing about the drawing changes:

- Rename the local `type State` to `ViewState`; it holds only view concerns.
- Change the signature to `export const frame = (state: DrovrState, view: ViewState): string` and
  delete the `readStatus` / `readControl` / `readCycles` / `serviceState` / `aiceBaseUrl` calls from
  its body — they now live in `collectState`.
- `allocationLines` takes `state.allocation` and `state.pool` instead of recomputing from `status`.
  Delete its `poolFrom` / `allocationFor` / `estimateCycleCost` / `spentSince` calls.
- `programLines` takes `state.programs` instead of calling `decide()` itself. The `RUNNING_PLACEHOLDER`
  projection moves into `state.ts:programsOf` if it is still needed for lookahead; if not, drop it.
- `asksLinks`, the module-level `Map`, is deleted. `state.programs[].asksUrl` replaces it — this
  removes module-global state, per the narrow-your-state rule.

- [ ] **Step 4: Update the watch loop's draw**

```ts
  const draw = async (): Promise<void> => {
    const rows = Math.max(6, process.stdout.rows ?? 40);
    const state = await collectState();
    const lines = frame(state, view).split('\n').slice(0, rows - 1);
    const painted = lines.map((line) => `${line}${ESC}K`).join('\r\n');
    process.stdout.write(`${ESC}H${painted}${ESC}0J`);
  };
```

Every alternate-screen rule in `watch.ts` still applies unchanged: home-and-clear per line, clamp to
`stdout.rows`, no trailing newline, clip to `stdout.columns` by visible length.

- [ ] **Step 5: Run the whole suite**

Run: `node --test test/*.spec.ts && pnpm check-types`
Expected: PASS. `test/layout.spec.ts` covers `clip`/`visibleLength`/`keybarLines`, which this must not disturb.

- [ ] **Step 6: Verify the TUI still draws**

Run: `node src/cli.ts watch 5`
Expected: a frame identical to before the refactor. Press `j`/`k`, `?`, then `q`. Confirm the cursor
returns and the shell scrollback is clean.

- [ ] **Step 7: Commit**

```bash
git add src/watch.ts test/watch-state.spec.ts
git commit -m "refactor: draw the watch view from the shared DrovrState"
```

---

### Task 6: the JSON payload

**Files:**
- Create: `src/panel.ts`
- Test: `test/panel.spec.ts`

**Interfaces:**
- Consumes: `DrovrState`, `buildState` (`src/state.ts`).
- Produces: `payload(state: DrovrState): string`, `payloadHash(json: string): string`, `shouldPublish(input: { previousHash, nextHash, cycleRunning, lastPublishedAt, now }): boolean`, and `CADENCE = { activeSeconds: 20, quietSeconds: 300 }`.

- [ ] **Step 1: Write the failing test**

```ts
// test/panel.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildState } from '../src/state.ts';
import { CADENCE, payload, payloadHash, shouldPublish } from '../src/panel.ts';
import { control, healthy, NOW } from './fixtures.ts';

const state = () => buildState({
  status: healthy(),
  control: control(),
  cycles: [],
  now: NOW,
  service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
  previews: new Map(), locks: new Map(), asksUrls: new Map(), queuedIntents: [],
});

test('payload is parseable JSON carrying the version and ISO stamp', () => {
  const parsed = JSON.parse(payload(state()));
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.generatedAt, new Date(NOW).toISOString());
});

test('payload never emits epoch millis where a timestamp is meant', () => {
  const json = payload(state());
  assert.equal(/"(generatedAt|lastTickAt|resetsAt)":\s*\d{10,}/.test(json), false);
});

test('payloadHash ignores generatedAt so an unchanged pool does not republish', () => {
  const a = payload(state());
  const later = buildState({
    status: healthy(), control: control(), cycles: [], now: NOW + 60_000,
    service: { loaded: true, intervalSeconds: 600, lastTickAt: NOW },
    previews: new Map(), locks: new Map(), asksUrls: new Map(), queuedIntents: [],
  });
  assert.equal(payloadHash(a), payloadHash(payload(later)));
});

test('shouldPublish skips an unchanged payload', () => {
  assert.equal(shouldPublish({
    previousHash: 'abc', nextHash: 'abc', cycleRunning: true,
    lastPublishedAt: NOW - 60_000, now: NOW,
  }), false);
});

test('shouldPublish honours the active cadence while a cycle runs', () => {
  const base = { previousHash: 'a', nextHash: 'b', cycleRunning: true, now: NOW };
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 5_000 }), false);
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 25_000 }), true);
});

test('shouldPublish backs off to the quiet cadence when nothing is in flight', () => {
  const base = { previousHash: 'a', nextHash: 'b', cycleRunning: false, now: NOW };
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - 60_000 }), false);
  assert.equal(shouldPublish({ ...base, lastPublishedAt: NOW - (CADENCE.quietSeconds + 1) * 1000 }), true);
});

test('shouldPublish always publishes when nothing has been published yet', () => {
  assert.equal(shouldPublish({
    previousHash: null, nextHash: 'b', cycleRunning: false, lastPublishedAt: null, now: NOW,
  }), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/panel.spec.ts`
Expected: FAIL — `Cannot find module '../src/panel.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/panel.ts
import { createHash } from 'node:crypto';
import type { DrovrState } from './state.ts';

export const CADENCE = { activeSeconds: 20, quietSeconds: 300 };

export const payload = (state: DrovrState): string => `${JSON.stringify(state, null, 2)}\n`;

/**
 * generatedAt changes every tick and would defeat the skip, so the hash covers
 * everything except it. A payload that differs only by its clock is not news.
 */
export const payloadHash = (json: string): string => {
  const parsed: Record<string, unknown> = JSON.parse(json);
  delete parsed.generatedAt;
  return createHash('sha256').update(JSON.stringify(parsed)).digest('hex').slice(0, 32);
};

export const shouldPublish = (input: {
  previousHash: string | null;
  nextHash: string;
  cycleRunning: boolean;
  lastPublishedAt: number | null;
  now: number;
}): boolean => {
  if (input.lastPublishedAt === null || input.previousHash === null) return true;
  if (input.previousHash === input.nextHash) return false;
  const floor = input.cycleRunning ? CADENCE.activeSeconds : CADENCE.quietSeconds;
  return input.now - input.lastPublishedAt >= floor * 1000;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/panel.spec.ts && pnpm check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/panel.ts test/panel.spec.ts
git commit -m "feat: render the panel payload and decide when it is worth publishing"
```

---

### Task 7: publishing the snapshot, and the `drovr snapshot` command

**Files:**
- Create: `src/publish-snapshot.ts`
- Modify: `src/paths.ts` (add `snapshotState`), `src/cli.ts` (dispatch), `src/help.ts` (registry entry)
- Test: `test/publish-snapshot.spec.ts`

**Interfaces:**
- Consumes: `payload`, `payloadHash`, `shouldPublish` (`src/panel.ts`), `collectState` (`src/state.ts`).
- Produces: `publishArgs(file: string): string[]`, `assertAiceVersion(reported: string): void`, `publishSnapshot(): Promise<'published' | 'skipped'>`.

- [ ] **Step 1: Write the failing test**

```ts
// test/publish-snapshot.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertAiceVersion, publishArgs } from '../src/publish-snapshot.ts';

test('publishArgs pins the only path aice accepts, with ttl and force', () => {
  const args = publishArgs('/tmp/snapshot.json');
  assert.deepEqual(args, [
    'exec', '/Users/cadam/code/drovr',
    'aice', 'publish', '/tmp/snapshot.json',
    '--as', 'assets/snapshot.json',
    '--ttl', '1d',
    '--force',
    '--agent', 'drovr',
  ]);
});

test('assertAiceVersion rejects a CLI without --ttl and names the fix', () => {
  assert.throws(() => assertAiceVersion('aice 0.11.0'), /aice update/);
  assert.throws(() => assertAiceVersion('aice 0.15.9'), /0\.16\.0/);
});

test('assertAiceVersion accepts the floor and anything above it', () => {
  assertAiceVersion('aice 0.16.0');
  assertAiceVersion('aice 0.21.3');
  assertAiceVersion('aice 1.0.0');
});

test('assertAiceVersion refuses to guess at unparseable output', () => {
  assert.throws(() => assertAiceVersion('command not found'), /could not read/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/publish-snapshot.spec.ts`
Expected: FAIL — `Cannot find module '../src/publish-snapshot.ts'`.

- [ ] **Step 3: Write the implementation**

```ts
// src/publish-snapshot.ts
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { inFlight, readCycles } from './ledger.ts';
import { payload, payloadHash, shouldPublish } from './panel.ts';
import { paths } from './paths.ts';
import { collectState } from './state.ts';

const run = promisify(execFile);

/** aice rejects any JSON outside assets/, and only 0.16.0+ knows --ttl. */
const DATA_PATH = 'assets/snapshot.json';
const AICE_FLOOR = [0, 16, 0];
const DROVR_REPO = '/Users/cadam/code/drovr';

export const publishArgs = (file: string): string[] => [
  'exec', DROVR_REPO,
  'aice', 'publish', file,
  '--as', DATA_PATH,
  '--ttl', '1d',
  '--force',
  '--agent', 'drovr',
];

export const assertAiceVersion = (reported: string): void => {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(reported);
  if (match === null) throw new Error(`could not read the aice version from "${reported.trim()}"`);
  const found = [Number(match[1]), Number(match[2]), Number(match[3])];
  const behind = found.some((part, index) => {
    const floor = AICE_FLOOR[index]!;
    return part !== floor ? part < floor : false;
  }) && found.findIndex((part, index) => part !== AICE_FLOOR[index]!) !== -1;
  if (!behind) return;
  throw new Error(
    `aice ${found.join('.')} has no --ttl; drovr needs >= ${AICE_FLOOR.join('.')}. Run: aice update`,
  );
};

type Marker = { hash: string; publishedAt: number };

const readMarker = (path: string): Marker | null => {
  try {
    const parsed: Marker = JSON.parse(readFileSync(path, 'utf8'));
    return typeof parsed.hash === 'string' && typeof parsed.publishedAt === 'number' ? parsed : null;
  } catch {
    return null;
  }
};

const writeMarker = (path: string, marker: Marker): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(marker)}\n`, 'utf8');
};

/**
 * Fails soft on every path: a panel that stops updating must never stop a cycle
 * from starting. The 1d ttl turns a prolonged outage into a 404, which the page
 * reports honestly, rather than a convincing dead frame.
 */
export const publishSnapshot = async (): Promise<'published' | 'skipped'> => {
  const { stdout: version } = await run('aice', ['version']);
  assertAiceVersion(version);

  const p = paths();
  const state = await collectState();
  const json = payload(state);
  const nextHash = payloadHash(json);
  const marker = readMarker(p.snapshotState);
  const cycleRunning = inFlight(readCycles(p.cycles)).length > 0;

  const go = shouldPublish({
    previousHash: marker?.hash ?? null,
    nextHash,
    cycleRunning,
    lastPublishedAt: marker?.publishedAt ?? null,
    now: Date.now(),
  });
  if (!go) return 'skipped';

  const file = join(p.base, 'snapshot.json');
  writeFileSync(file, json, 'utf8');
  await run('direnv', publishArgs(file), { cwd: DROVR_REPO });
  writeMarker(p.snapshotState, { hash: nextHash, publishedAt: Date.now() });
  return 'published';
};
```

Add to `src/paths.ts` inside the returned object:

```ts
    snapshotState: join(base, 'snapshot-state.json'),
```

- [ ] **Step 4: Simplify `assertAiceVersion`**

The `behind` expression above is convoluted — replace it with a plain comparison before moving on:

```ts
const behind = (found: number[], floor: number[]): boolean => {
  for (let index = 0; index < floor.length; index += 1) {
    if (found[index]! !== floor[index]!) return found[index]! < floor[index]!;
  }
  return false;
};
```

and call `if (!behind(found, AICE_FLOOR)) return;`. One layer of magic, readable top to bottom.

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/publish-snapshot.spec.ts && pnpm check-types`
Expected: PASS.

- [ ] **Step 6: Wire the CLI command**

In `src/cli.ts`, beside the other dispatches (near line 388):

```ts
  if (command === 'snapshot') {
    const outcome = await publishSnapshot();
    console.log(outcome === 'published' ? 'snapshot published' : 'snapshot unchanged — not published');
    return;
  }
```

In `src/help.ts`, add to the command registry:

```ts
  {
    name: 'snapshot',
    usage: 'drovr snapshot',
    summary: 'Publish current state to the drovr aice panel.',
    details: [
      'Assembles one DrovrState and publishes it as assets/snapshot.json on the drovr aice',
      'install, where the panel page reads it same-origin behind aice\'s own sign-in.',
      'Skips the publish when nothing changed, and backs off from 20s to 5m when no cycle',
      'is in flight. Requires aice >= 0.16.0 for --ttl.',
    ],
    writes: '~/.drovr/snapshot.json, ~/.drovr/snapshot-state.json, and assets/snapshot.json on the aice install',
  },
```

- [ ] **Step 7: Verify end to end**

Run: `node src/cli.ts snapshot && node src/cli.ts snapshot`
Expected: first prints `snapshot published`; second prints `snapshot unchanged — not published`.
Then: `curl -sI https://drovr.aicex.app/craig/assets/snapshot.json | head -2` → `302` (auth gate is working).

- [ ] **Step 8: Commit**

```bash
git add src/publish-snapshot.ts src/paths.ts src/cli.ts src/help.ts test/publish-snapshot.spec.ts
git commit -m "feat: publish the snapshot to the drovr aice install"
```

---

### Task 8: the panel page, and its launchd agent

Completes the read-only panel. Shippable milestone.

**Files:**
- Create: `panel/index.html` (from `mock/panel.html`)
- Modify: `src/service.ts` (second agent), `src/help.ts` (service entry)
- Test: manual, plus `pnpm check-types`

**Interfaces:**
- Consumes: `assets/snapshot.json` published by Task 7.
- Produces: a published page, and `tech.propra.drovr.snapshot.plist`.

- [ ] **Step 1: Copy the mock and strip its fixture data**

```bash
mkdir -p panel && cp mock/panel.html panel/index.html
```

Remove every hardcoded program, account and cycle row, leaving one commented template of each. The renderer builds them.

- [ ] **Step 2: Add the fetch loop**

Insert before `</body>`. The cache-buster is mandatory — aice sets no `Cache-Control`, so CloudFront would otherwise serve a stale snapshot forever.

```html
<script>
  const DATA = '/craig/assets/snapshot.json';
  const FAST_MS = 5000, SLOW_MS = 30000, STALE_MS = 120000;
  let lastStamp = null, unchanged = 0, timer = null;

  const setBanner = (kind, headline, detail) => {
    const el = document.getElementById('banner');
    el.hidden = kind === null;
    if (kind === null) return;
    el.dataset.kind = kind;
    el.querySelector('[data-headline]').textContent = headline;
    el.querySelector('[data-detail]').textContent = detail;
  };

  const poll = async () => {
    try {
      const res = await fetch(`${DATA}?t=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' });
      if (res.status === 404) {
        setBanner('gone', 'No data.', 'The supervisor has been down for over a day.');
      } else if (res.redirected || !(res.headers.get('content-type') ?? '').includes('application/json')) {
        setBanner('auth', 'Session expired.', 'Reload to sign in again.');
      } else {
        const state = await res.json();
        unchanged = state.generatedAt === lastStamp ? unchanged + 1 : 0;
        lastStamp = state.generatedAt;
        render(state);
        const age = Date.now() - Date.parse(state.generatedAt);
        setBanner(age > STALE_MS ? 'stale' : null,
          `Showing state from ${Math.round(age / 60000)} minutes ago.`,
          'The Mac stopped pushing. Nothing below is live.');
      }
    } catch (error) {
      setBanner('offline', 'Cannot reach the supervisor data.', String(error && error.message));
    }
    clearTimeout(timer);
    timer = setTimeout(poll, unchanged >= 3 ? SLOW_MS : FAST_MS);
  };
  poll();
</script>
```

- [ ] **Step 3: Write `render(state)`**

One function per section. Two rules are not optional: preview text goes in via `textContent` (aice
sends no CSP, so this is the only escaping there is), and rows are keyed by program name so a
re-render preserves scroll position and `<details>` open state.

```html
<script>
  const VERDICT_RAIL = { RUN: 'border-teal-500', GO: 'border-emerald-500',
                         WAIT: 'border-amber-500', STOP: 'border-red-500', OFF: 'border-zinc-950/10' };

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;   // never innerHTML
    return node;
  };

  const programRow = (program) => {
    const key = `program-${program.name}`;
    const verdict = program.enabled ? program.verdict : 'OFF';
    const row = document.getElementById(key) ?? el('li', '');
    row.id = key;
    row.className = `rounded-xl border-l-2 py-1 pl-4 ${VERDICT_RAIL[verdict] ?? VERDICT_RAIL.OFF}`;
    row.replaceChildren();

    const head = el('div', 'flex flex-wrap items-center gap-x-2');
    head.append(
      el('h3', 'truncate text-lg font-semibold tracking-tight', program.name),
      el('span', 'eyebrow rounded px-1.5 py-0.5 text-sm font-medium', verdict.toLowerCase()),
      el('span', 'font-mono text-sm text-zinc-400', `p${program.priority}`),
    );
    row.append(head, el('p', 'mt-1 max-w-[60ch] text-base text-pretty text-zinc-500 sm:text-sm', program.reason));

    if (program.context && program.context.percent !== null) {
      row.append(el('p', 'mt-2 font-mono text-sm tabular-nums text-zinc-500',
        `ctx ${program.context.percent}% · ${program.context.tokens ?? '?'} · ${program.context.subagents ?? 0} subagent`));
    }
    if (program.preview && program.preview.length > 0) {
      row.append(el('pre',
        'mt-3 max-h-32 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-sm/6 ' +
        'whitespace-pre-wrap wrap-anywhere text-zinc-600 ring-1 ring-zinc-950/5 ' +
        'sm:text-[0.8125rem]/5 sm:whitespace-pre dark:bg-white/5 dark:text-zinc-300',
        program.preview.join('\n')));
    }
    return row;
  };

  const render = (state) => {
    document.getElementById('mode').textContent = state.mode;
    document.getElementById('fundable').textContent = state.cyclesFundable.toFixed(1);
    document.getElementById('binding').textContent = state.bindingBucket;
    document.getElementById('running').textContent =
      `${state.programs.filter((p) => p.verdict === 'RUN').length} / ${state.maxConcurrentCycles}`;

    const list = document.getElementById('programs');
    // Reuse nodes by id so scroll offset and <details> state survive the re-render.
    for (const program of state.programs) list.append(programRow(program));
  };
</script>
```

- [ ] **Step 4: Publish and verify in a real browser**

```bash
direnv exec /Users/cadam/code/drovr aice publish panel/index.html --as panel.html --agent drovr
```

Open `https://drovr.aicex.app/craig/panel.html`. Confirm: programs render, the poll shows 200s in the network panel, and killing the launchd agent for three minutes produces the stale banner rather than a frozen frame.

- [ ] **Step 5: Add the snapshot launchd agent**

`service.ts:plist()` hardcodes the label and the `tick` argument. Parameterise both:

```ts
const AGENTS = [
  { label: 'tech.propra.drovr',          command: 'tick',     intervalSeconds: 600 },
  { label: 'tech.propra.drovr.snapshot', command: 'snapshot', intervalSeconds: 20 },
];

const plist = (input: {
  label: string; command: string; intervalSeconds: number;
  nodeBin: string; cliPath: string; logDir: string; path: string;
}): string => `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
  <key>Label</key><string>${input.label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${input.nodeBin}</string><string>${input.cliPath}</string><string>${input.command}</string>
  </array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${input.path}</string></dict>
  <key>StartInterval</key><integer>${input.intervalSeconds}</integer>
  <key>StandardOutPath</key><string>${input.logDir}/${input.command}.log</string>
  <key>StandardErrorPath</key><string>${input.logDir}/${input.command}.err</string>
</dict></plist>
`;
```

`installService` writes and reloads **both**, and `describeService` reports both. The existing trap
is unchanged and now applies twice: **launchd holds the plist it loaded, not the file on disk**, so
each label must be `bootout`ed and `bootstrap`ped, not merely rewritten.

Keep the existing `<key>Label</key>` value for the tick agent exactly as it is — renaming it would
orphan the currently-loaded agent.

- [ ] **Step 6: Verify the agent is actually running**

Run: `launchctl list | grep drovr && sleep 45 && node -e "console.log(require('fs').readFileSync(process.env.HOME + '/.drovr/snapshot-state.json','utf8'))"`
Expected: both agents listed, and a `publishedAt` within the last minute.

- [ ] **Step 7: Commit**

```bash
git add panel/index.html src/service.ts src/help.ts
git commit -m "feat: serve the drovr panel and keep it fed"
```

---

### Task 9: parsing intents

**Files:**
- Create: `src/intents.ts`
- Test: `test/intents.spec.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Intent = { id: string; action: Action; requestedAt: number; expiresAt: number }`, `type Action` (a discriminated union of `{ kind: 'mode', value: string } | { kind: 'pause', hours: number } | { kind: 'reserve', delta: number } | { kind: 'concurrency', delta: number } | { kind: 'enable', program: string, enabled: boolean } | { kind: 'priority', program: string, delta: number }`), `parseIntent(text: string, id: string, now: number): Intent | { rejected: string }`, `MAX_INTENTS_PER_TICK = 20`.

- [ ] **Step 1: Write the failing test**

```ts
// test/intents.spec.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_INTENTS_PER_TICK, parseIntent } from '../src/intents.ts';

const NOW = Date.parse('2026-08-24T12:00:00.000Z');
const at = (offsetMinutes: number) => new Date(NOW + offsetMinutes * 60_000).toISOString();

test('parseIntent reads the documented vocabulary', () => {
  const intent = parseIntent(`drovr-intent v1 pause 3h expires=${at(30)}`, 'n-1', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'pause', hours: 3 });
});

test('parseIntent reads a per-program action', () => {
  const intent = parseIntent(`drovr-intent v1 disable joinery expires=${at(30)}`, 'n-2', NOW);
  assert.deepEqual('action' in intent && intent.action, { kind: 'enable', program: 'joinery', enabled: false });
});

test('parseIntent rejects an expired intent rather than applying it late', () => {
  const intent = parseIntent(`drovr-intent v1 pause 1h expires=${at(-5)}`, 'n-3', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /expired/);
});

test('parseIntent rejects an unknown action instead of guessing', () => {
  const intent = parseIntent(`drovr-intent v1 detonate expires=${at(30)}`, 'n-4', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /unknown action/);
});

test('parseIntent ignores an ordinary human note', () => {
  const intent = parseIntent('can we bump joinery up the queue?', 'n-5', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /not an intent/);
});

test('interrupt is deliberately not an intent in v1', () => {
  const intent = parseIntent(`drovr-intent v1 interrupt sunnyt expires=${at(5)}`, 'n-6', NOW);
  assert.match('rejected' in intent ? intent.rejected : '', /not available/);
});

test('the per-tick cap is explicit', () => {
  assert.equal(MAX_INTENTS_PER_TICK, 20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/intents.spec.ts`
Expected: FAIL — `Cannot find module '../src/intents.ts'`.

- [ ] **Step 3: Write the implementation**

Guard-clause style, one level deep. `interrupt` is matched explicitly so it gets an honest refusal rather than falling through to "unknown action".

```ts
// src/intents.ts
export const MAX_INTENTS_PER_TICK = 20;

const PREFIX = 'drovr-intent v1';

export type Action =
  | { kind: 'mode'; value: string }
  | { kind: 'pause'; hours: number }
  | { kind: 'reserve'; delta: number }
  | { kind: 'concurrency'; delta: number }
  | { kind: 'enable'; program: string; enabled: boolean }
  | { kind: 'priority'; program: string; delta: number };

export type Intent = { id: string; action: Action; requestedAt: number; expiresAt: number };

const MODES = ['off', 'low', 'normal', 'away'];

const toAction = (words: string[]): Action | string => {
  const [verb, argument] = words;
  if (verb === 'mode' && argument !== undefined && MODES.includes(argument)) {
    return { kind: 'mode', value: argument };
  }
  if (verb === 'pause') {
    const hours = Number(/^(\d+)h$/.exec(argument ?? '')?.[1]);
    return Number.isFinite(hours) ? { kind: 'pause', hours } : 'pause needs a duration like 3h';
  }
  if (verb === 'reserve') {
    const delta = Number(argument);
    return Number.isFinite(delta) ? { kind: 'reserve', delta } : 'reserve needs a signed number';
  }
  if (verb === 'concurrency') {
    const delta = Number(argument);
    return Number.isFinite(delta) ? { kind: 'concurrency', delta } : 'concurrency needs a signed number';
  }
  if ((verb === 'enable' || verb === 'disable') && argument !== undefined) {
    return { kind: 'enable', program: argument, enabled: verb === 'enable' };
  }
  if (verb === 'priority' && argument !== undefined && words[2] !== undefined) {
    const delta = Number(words[2]);
    return Number.isFinite(delta) ? { kind: 'priority', program: argument, delta } : 'priority needs a signed number';
  }
  if (verb === 'interrupt') return 'interrupt is not available from the panel — use drovr watch';
  return `unknown action "${verb ?? ''}"`;
};

export const parseIntent = (
  text: string,
  id: string,
  now: number,
): Intent | { rejected: string } => {
  const trimmed = text.trim();
  if (!trimmed.startsWith(PREFIX)) return { rejected: 'not an intent' };

  const body = trimmed.slice(PREFIX.length).trim();
  const expiresMatch = /expires=(\S+)/.exec(body);
  if (expiresMatch === null) return { rejected: 'no expires= stamp' };

  const expiresAt = Date.parse(expiresMatch[1]!);
  if (Number.isNaN(expiresAt)) return { rejected: 'unparseable expires= stamp' };
  if (expiresAt <= now) return { rejected: 'expired before it was drained' };

  const action = toAction(body.replace(/expires=\S+/, '').trim().split(/\s+/));
  if (typeof action === 'string') return { rejected: action };
  return { id, action, requestedAt: now, expiresAt };
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/intents.spec.ts && pnpm check-types`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/intents.ts test/intents.spec.ts
git commit -m "feat: parse panel intents, refusing expired and unknown ones"
```

---

### Task 10: draining intents on the tick

**Files:**
- Modify: `src/tick.ts`, `src/asks.ts` (reuse its notes reader), `src/help.ts`
- Test: covered by Task 9 for parsing; this task is I/O and is verified live.

**Interfaces:**
- Consumes: `parseIntent`, `MAX_INTENTS_PER_TICK`, `Action` (`src/intents.ts`); `setReserve`, `adjustConcurrency`, `nudgePriority` (existing, `src/keys.ts`).
- Produces: `setMode`, `pauseForHours`, `setEnabled`, `nudgeReserve` (new, `src/keys.ts`), and
  `drainIntents(): Promise<{ applied: number; rejected: number; capped: boolean }>` (`src/tick.ts`).

- [ ] **Step 1: Read how asks.ts lists and replies to notes**

Run: `grep -n "notes" src/asks.ts`
Reuse that reader and its `--json` handling. Do not add a second notes client.

- [ ] **Step 2: Add target-setting helpers to `keys.ts`**

`keys.ts` today exposes *cycling* helpers — `cycleMode` advances to the next mode, `toggleEnabled`
flips, `cyclePause` steps through durations. An intent names a **target**, so it needs setters. They
go through the same private `mutate` so `control.json` keeps exactly one writer.

```ts
export const setMode = (path: string, mode: string): Action => {
  if (!MODES.includes(mode as (typeof MODES)[number])) throw new Error(`unknown mode "${mode}"`);
  mutate(path, (raw) => { raw.mode = mode; });
  return { message: `mode → ${mode}`, redraw: true };
};

export const pauseForHours = (path: string, hours: number): Action => {
  if (!Number.isFinite(hours) || hours <= 0 || hours > 72) {
    throw new Error(`pause hours out of range: ${hours}`);
  }
  const until = new Date(Date.now() + hours * 3_600_000).toISOString();
  mutate(path, (raw) => { raw.pauseUntil = until; });
  return { message: `paused ${hours}h`, redraw: true };
};

export const setEnabled = (path: string, name: string, enabled: boolean): Action => {
  mutate(path, (raw) => { programAt(raw, name).enabled = enabled; });
  return { message: `${name} ${enabled ? 'enabled' : 'disabled'}`, redraw: true };
};

/** The panel sends a delta; setReserve takes an absolute reserve, so read then write. */
export const nudgeReserve = (path: string, delta: number): Action => {
  const control = readControl(path);
  const weekly = control.ceilings[control.mode]?.weekly ?? 0.55;
  return setReserve(path, control.mode, 1 - weekly + delta);
};
```

`MODES` and `programAt` already exist in `keys.ts` but are module-private — export `MODES` or move
the guard inside; do not duplicate the list.

- [ ] **Step 3: Write the drainer**

Bounded, one level deep, and every action routes through `keys.ts`. Hitting the cap is reported.

```ts
// src/tick.ts
import { MAX_INTENTS_PER_TICK, parseIntent, type Action as IntentAction } from './intents.ts';
import { adjustConcurrency, nudgePriority, nudgeReserve, pauseForHours, setEnabled, setMode } from './keys.ts';

const applyIntent = (controlPath: string, action: IntentAction): string => {
  if (action.kind === 'mode') return setMode(controlPath, action.value).message;
  if (action.kind === 'pause') return pauseForHours(controlPath, action.hours).message;
  if (action.kind === 'reserve') return nudgeReserve(controlPath, action.delta).message;
  if (action.kind === 'concurrency') return adjustConcurrency(controlPath, action.delta).message;
  if (action.kind === 'enable') return setEnabled(controlPath, action.program, action.enabled).message;
  return nudgePriority(controlPath, action.program, action.delta).message;
};

/**
 * Every drained thread is replied to and resolved, rejections included — an
 * unparseable note left open is retried on every tick forever.
 */
export const drainIntents = async (): Promise<{ applied: number; rejected: number; capped: boolean }> => {
  const controlPath = paths().control;
  const threads = await listNotes(PANEL_PAGE);
  const open = threads.filter((thread) => !thread.resolved).slice(0, MAX_INTENTS_PER_TICK);
  const capped = threads.filter((thread) => !thread.resolved).length > open.length;
  let applied = 0;
  let rejected = 0;

  for (const thread of open) {
    const parsed = parseIntent(thread.text, thread.id, Date.now());
    if ('rejected' in parsed) {
      if (parsed.rejected !== 'not an intent') {
        await replyAndResolve(PANEL_PAGE, thread.id, `not applied: ${parsed.rejected}`);
        rejected += 1;
      }
      continue;
    }
    try {
      const message = applyIntent(controlPath, parsed.action);
      await replyAndResolve(PANEL_PAGE, thread.id, `applied: ${message}`);
      applied += 1;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await replyAndResolve(PANEL_PAGE, thread.id, `not applied: ${detail}`);
      rejected += 1;
    }
  }

  if (capped) console.error(`intent cap hit: ${MAX_INTENTS_PER_TICK} drained, more left for the next tick`);
  return { applied, rejected, capped };
};
```

`listNotes` and `replyAndResolve` wrap the notes client `asks.ts` already uses — reuse it, do not add
a second one. A thread that is merely human conversation (`not an intent`) is left untouched and
unresolved: resolving Craig's own comments would be wrong.

- [ ] **Step 4: Call it from tick, before admission**

Intents change admission inputs, so drain first. Wrap in try/catch: a notes outage logs and the tick proceeds. Notes require sharing enabled on the page, and `asks.ts` already records that unreadable and unanswered are different things — the log must say which.

- [ ] **Step 5: Verify live**

Post a note on the panel page reading `drovr-intent v1 pause 1h expires=<ISO 30 minutes out>`, then:

Run: `node src/cli.ts tick && node -e "console.log(JSON.parse(require('fs').readFileSync(process.env.HOME+'/.drovr/control.json','utf8')).pauseUntil)"`
Expected: `pauseUntil` about an hour out, and a reply plus resolution visible on the thread.

- [ ] **Step 6: Add the CLAUDE.md traps this task earned**

Append to the traps table: the `assets/`-only data path, `--ttl`/`--force` on every publish, the aice 0.16.0 floor, the cache-buster requirement, and that the preview parser is lenient *because* it is a scrape — the inverse of the `agent_status` rule.

- [ ] **Step 7: Commit**

```bash
git add src/tick.ts src/keys.ts src/asks.ts src/help.ts CLAUDE.md
git commit -m "feat: drain panel intents through the same writer the TUI uses"
```
