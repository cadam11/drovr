# Go port E1: skeleton, recorder, decision core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go `drovr` binary that reads `~/.drovr`, parses `teamclaude status --json`, reaches the same verdict as the TypeScript on every recorded case, and prints a byte-identical `drovr status --json` and `drovr help --json`.

**Architecture:** One Go package per TS module under `internal/`, same names (spec, "Shape"). The pure core is proven against JSON fixtures recorded from the TS suite by a one-line hook in each pure function; the CLI surface is proven against the Node CLI run on the same `DROVR_HOME`. Nothing in this plan spawns orca, hey or ssh; those are E2. The TS tree is untouched except for the recorder hook.

**Tech Stack:** Go 1.26, standard library only (`encoding/json`, `os/exec`, `testing`). No `x/term` until E3.

**Spec:** `docs/superpowers/specs/2026-10-22-go-port-design.md`

## Global Constraints

- A port, not a rewrite: no behaviour change, however small. Where the TS is odd, the Go is odd the same way, and the fixture proves it.
- Every TS zod boundary becomes `Parse<Name>(data []byte) (T, error)`: **strip** unknown keys (zod's default — `control.json`, teamclaude status, cycle records all strip), apply the same defaults, refuse the same shapes with an error that names the field path.
- Epoch milliseconds are `int64` everywhere the TS had `number` ms (`internal/epoch.Millis`). Never `time.Time` in a struct that a fixture compares; convert at the edges.
- Timestamps print as `Date.prototype.toISOString` does: `2006-01-02T15:04:05.000Z`, always UTC, always three decimals.
- `toFixed(n)` is `jsnum.ToFixed`; `Math.round(v*1e4)/1e4` is `jsnum.Round4`. No `fmt.Sprintf("%.2f")` in anything a fixture or the oracle compares.
- JSON out: `json.Encoder` with `SetEscapeHTML(false)` and `SetIndent("", "  ")`, struct field order equal to the TS object-literal order. Go's encoder appends a trailing newline, which matches `console.log`.
- Tests are `testing` tables, no mocks, no test frameworks. Fixture-driven tests fail loudly when the fixture directory is empty — an empty directory passing is the failure mode.
- `go vet ./...` clean and `gofmt -l .` empty are the gate, like `pnpm check-types`.
- `main.go` refuses a command it has not ported yet with one line on stderr and exit 1: `drovr <cmd> is not ported to Go yet — run: node src/cli.ts <cmd> …`. The help registry carries the whole command tree from day one because `help --json` is an oracle target; the refusal is what keeps "a help page that lies" from being true of the binary.
- The recorder hook in `src/` is gated on `DROVR_RECORD` and is the only TS change this plan makes.

## Review Focus

1. `control.json` with `"pauseUntil": null` on a program, `"host": null`, and a program missing optional keys — every default must equal the zod default, including `host.drovrHome` and `host.claude` when a host is present (Task 3 tests).
2. A teamclaude account whose `rateLimitedUntil` is a string, an ISO string, or garbage — coerced to ms or null, never left unparsed (Task 4 tests).
3. A ledger line with an unknown `exit` value, and a start record with `poolAfter: null` — the first throws naming the line, the second is a valid start record (Task 5 tests).
4. A pool where every account is pinned (cycles 0) — `bindingOf` picks the soonest reset, and `cyclesFundable` is `0`, not negative, with `running > gross` (Task 7 fixtures plus a hand test).
5. `help --json` and `status --json` with a `÷` and a `’` in the strings — no `\u` escapes, no `<`; and a `<` in a reason string stays `<` (Task 10 and 11 oracle diffs).

---

### Task 1: Module skeleton, paths, epoch

**Files:**
- Create: `go.mod`, `VERSION`, `main.go`, `internal/paths/paths.go`, `internal/paths/paths_test.go`, `internal/epoch/epoch.go`, `internal/epoch/epoch_test.go`, `internal/jsnum/jsnum.go`, `internal/jsnum/jsnum_test.go`
- Modify: `.gitignore` (add `/drovr` the built binary, `/dist/`)

**Interfaces:**
- Produces:
  ```go
  package paths
  type Paths struct{ Base, Control, Cycles, Decisions, Usage, LastTick, TickFailure, TickLock, Logs string }
  func Root() string                       // $DROVR_HOME or ~/.drovr
  func New() Paths
  func (p Paths) ProgramState(program string) string   // <base>/programs/<program>
  func (p Paths) ProgramLock(program string) string    // …/cycle.lock
  func (p Paths) LastCycle(program string) string      // …/last-cycle.json
  func (p Paths) StateFile(program string) string      // …/state.json
  func EnsureDirs(p Paths, program string) error       // program "" means logs only

  package epoch
  type Millis = int64
  func Parse(s string) (Millis, bool)     // Date.parse subset: RFC3339 with or without fraction, "2006-01-02"
  func MustParse(s string) Millis         // panics; tests only
  func ISO(ms Millis) string              // toISOString
  func Now() Millis

  package jsnum
  func ToFixed(v float64, digits int) string   // JS Number.prototype.toFixed
  func Round4(v float64) float64               // Math.round(v*1e4)/1e4
  func RoundHalfUp(v float64) float64          // JS Math.round
  ```

- [ ] **Step 1: Write the failing tests**

`internal/paths/paths_test.go`:
```go
package paths

import (
	"path/filepath"
	"testing"
)

func TestRootHonoursDrovrHome(t *testing.T) {
	t.Setenv("DROVR_HOME", "/tmp/x")
	if got := Root(); got != "/tmp/x" {
		t.Fatalf("Root() = %q", got)
	}
	p := New()
	want := map[string]string{
		p.Control: "/tmp/x/control.json", p.Cycles: "/tmp/x/cycles.jsonl", p.Decisions: "/tmp/x/decisions.jsonl",
		p.Usage: "/tmp/x/usage.jsonl", p.LastTick: "/tmp/x/last-tick.json", p.TickFailure: "/tmp/x/tick-failure.json",
		p.TickLock: "/tmp/x/tick.lock", p.Logs: "/tmp/x/logs",
		p.ProgramLock("demo"): "/tmp/x/programs/demo/cycle.lock", p.LastCycle("demo"): "/tmp/x/programs/demo/last-cycle.json",
		p.StateFile("demo"): "/tmp/x/programs/demo/state.json", p.ProgramState("demo"): "/tmp/x/programs/demo",
	}
	for got, exp := range want {
		if got != exp {
			t.Errorf("got %q want %q", got, exp)
		}
	}
}

func TestRootDefaultsToHome(t *testing.T) {
	t.Setenv("DROVR_HOME", "")
	t.Setenv("HOME", "/Users/nobody")
	if got := Root(); got != filepath.Join("/Users/nobody", ".drovr") {
		t.Fatalf("Root() = %q", got)
	}
}

func TestEnsureDirs(t *testing.T) {
	t.Setenv("DROVR_HOME", t.TempDir())
	p := New()
	if err := EnsureDirs(p, "demo"); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{p.Logs, p.ProgramState("demo")} {
		if _, err := osStat(dir); err != nil {
			t.Errorf("%s: %v", dir, err)
		}
	}
}
```
(`osStat` is `os.Stat` imported in the test file; `DROVR_HOME=""` must read as unset, matching `process.env.DROVR_HOME ?? …` — an empty string in Node is *set*, so copy that: empty means empty. Make the second test set `DROVR_HOME` to unset via `os.Unsetenv` after `t.Setenv` registers the restore.)

`internal/epoch/epoch_test.go`:
```go
package epoch

import "testing"

func TestParseAndISO(t *testing.T) {
	cases := []struct {
		in   string
		ms   Millis
		ok   bool
	}{
		{"2026-08-22T12:00:00.000Z", 1787400000000, true},
		{"2026-08-22T12:00:00Z", 1787400000000, true},
		{"2026-08-22T12:00:00.123456Z", 1787400000123, true},
		{"2026-08-22T07:00:00-05:00", 1787400000000, true},
		{"2026-08-22", 1787356800000, true},
		{"not a date", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := Parse(c.in)
		if ok != c.ok || got != c.ms {
			t.Errorf("Parse(%q) = %d,%v want %d,%v", c.in, got, ok, c.ms, c.ok)
		}
	}
	if got := ISO(1787400000123); got != "2026-08-22T12:00:00.123Z" {
		t.Errorf("ISO = %q", got)
	}
	if got := ISO(1787400000000); got != "2026-08-22T12:00:00.000Z" {
		t.Errorf("ISO whole second = %q", got)
	}
}
```

`internal/jsnum/jsnum_test.go`:
```go
package jsnum

import "testing"

func TestToFixed(t *testing.T) {
	cases := []struct {
		v    float64
		d    int
		want string
	}{
		{1.005, 2, "1.00"}, {0.125, 2, "0.13"}, {2.5, 0, "3"}, {0.1 + 0.2, 2, "0.30"},
		{1.35, 2, "1.35"}, {0.39, 3, "0.390"}, {0, 2, "0.00"}, {12.34567, 2, "12.35"},
	}
	for _, c := range cases {
		if got := ToFixed(c.v, c.d); got != c.want {
			t.Errorf("ToFixed(%v,%d) = %q want %q", c.v, c.d, got, c.want)
		}
	}
}

func TestRound4AndHalfUp(t *testing.T) {
	if got := Round4(0.5700000000000001); got != 0.57 {
		t.Errorf("Round4 = %v", got)
	}
	if got := RoundHalfUp(-2.5); got != -2 { // JS Math.round(-2.5) === -2
		t.Errorf("RoundHalfUp(-2.5) = %v", got)
	}
	if got := RoundHalfUp(2.5); got != 3 {
		t.Errorf("RoundHalfUp(2.5) = %v", got)
	}
}
```
`1.005.toFixed(2)` is `"1.00"` in JS because 1.005 is below the half in binary; `0.125.toFixed(2)` is `"0.13"` because 0.125 is exact and JS rounds that half up. `ToFixed` must therefore work from the exact decimal expansion (`strconv.FormatFloat(v, 'f', -1, 64)` gives the shortest round-trip, **not** the exact value — use `big.Float` with `SetFloat64` then `Text('f', 40)` and round the digit string half-up), not from `%.2f`, which rounds half-even on the binary value and gives `"0.12"`.

- [ ] **Step 2: Run them, watch them fail**

Run: `cd ~/code/drovr && go mod init github.com/cadam11/drovr && go test ./internal/...`
Expected: build failures, `undefined: Root`, `undefined: Parse`, `undefined: ToFixed`.

- [ ] **Step 3: Implement**

`go.mod`: `module github.com/cadam11/drovr` / `go 1.26`. `VERSION`: `0.2.0`.

`internal/paths/paths.go`: port of `src/paths.ts`. `Root()` reads `os.LookupEnv("DROVR_HOME")`; present (even empty) wins; else `os.UserHomeDir()` joined with `.drovr`. `EnsureDirs` is `os.MkdirAll(0o755)` on logs and, when `program != ""`, on `ProgramState(program)`.

`internal/epoch/epoch.go`: `Parse` tries layouts in order `time.RFC3339Nano`, `"2006-01-02T15:04:05Z07:00"`, `"2006-01-02"` (the last in UTC); returns `t.UnixMilli()` truncating sub-ms. `ISO` is `time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z")`. `Now` is `time.Now().UnixMilli()`.

`internal/jsnum/jsnum.go`: `ToFixed` via `math/big` exact expansion and manual half-up on the digit string, sign handled, `digits` 0..20. `Round4(v) = RoundHalfUp(v*10000)/10000`. `RoundHalfUp(v) = math.Floor(v + 0.5)`.

`main.go`:
```go
// Command drovr is the Go port of src/cli.ts. The TypeScript is the oracle until cut-over:
// conformance_test.go diffs the two on the same DROVR_HOME.
package main

import (
	"fmt"
	"os"
)

// version is stamped by scripts/release.sh with -ldflags "-X main.version=<VERSION>".
var version = "dev"

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		return notPorted("help", args)
	}
	switch args[0] {
	case "version", "--version":
		fmt.Fprintln(stdout, version)
		return nil
	}
	return notPorted(args[0], args[1:])
}

func notPorted(cmd string, rest []string) error {
	return fmt.Errorf("drovr %s is not ported to Go yet — run: node src/cli.ts %s", cmd, strings.Join(append([]string{cmd}, rest...), " "))
}
```

- [ ] **Step 4: Run the tests, vet, fmt**

Run: `go test ./... && go vet ./... && gofmt -l .`
Expected: `ok` for paths, epoch, jsnum; no vet output; no files listed.

- [ ] **Step 5: Commit**

```bash
git add go.mod VERSION main.go internal .gitignore
git commit -m "feat(go): module skeleton — paths, epoch millis, JS number formatting; drovr version"
```

---

### Task 2: Recorder hook and the fixture corpus

**Files:**
- Create: `src/record.ts`, `scripts/record-fixtures.sh`, `internal/fixtures/fixtures.go`, `internal/fixtures/fixtures_test.go`, `testdata/recorded/<fn>/<sha>.json` (generated)
- Modify: `src/decide.ts` (`decide`, `cyclesFundableFrom`, `requiredCycles`, `poolContext`), `src/capacity.ts` (`poolFrom`), `src/ledger.ts` (`estimateCycleCost`, `chargeForRunning`, `cyclesStartedSince`, `consecutiveFailures`, `consecutiveZeroYield`, `unansweredAsks`, `spentSince`, `inFlight`), `src/allocation.ts` (`allocationSegments`), `src/control.ts` (`priorityRank`, `orderCeilings`, `effectivePriority`), `src/status-payload.ts` (`buildStatusPayload`), `src/status-accounts.ts` (`accountsFromTeamclaude`), `src/service.ts` (`describeService`, `serviceHealth`)

**Interfaces:**
- Produces (TS): `record<T>(fn: string, input: unknown, output: T): T` — returns `output` unchanged; when `process.env.DROVR_RECORD` names a directory, writes `<dir>/<fn>/<sha1 of input json>.json` as `{"fn", "input", "output"}` with `Infinity` → `"Infinity"` and `-Infinity` → `"-Infinity"` (JSON cannot carry them), `undefined` fields dropped as JSON does.
- Produces (Go):
  ```go
  package fixtures
  type Case struct { Name string; Input json.RawMessage; Output json.RawMessage }
  func Load(t *testing.T, fn string) []Case      // reads testdata/recorded/<fn>/*.json; t.Fatal when none
  func Float(raw json.RawMessage) float64        // "Infinity" → +Inf, "-Infinity" → -Inf, else number
  func Equal(t *testing.T, name string, got any, want json.RawMessage)  // marshals got, compares as canonical JSON with floats at 1e-9
  ```

- [ ] **Step 1: Write the Go loader test**

`internal/fixtures/fixtures_test.go`:
```go
package fixtures

import (
	"encoding/json"
	"testing"
)

func TestLoadDecideHasCases(t *testing.T) {
	cases := Load(t, "decide")
	if len(cases) < 50 {
		t.Fatalf("decide fixtures: %d cases, expected the recorded suite", len(cases))
	}
}

func TestFloatInfinity(t *testing.T) {
	if !isInf(Float(json.RawMessage(`"Infinity"`)), 1) {
		t.Fatal("Infinity")
	}
	if got := Float(json.RawMessage(`1.5`)); got != 1.5 {
		t.Fatal(got)
	}
}
```
(`isInf` is `math.IsInf`.)

- [ ] **Step 2: Run it, watch it fail**

Run: `go test ./internal/fixtures/`
Expected: FAIL, `undefined: Load`.

- [ ] **Step 3: Write the TS recorder**

`src/record.ts`:
```ts
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Port tooling, not a feature. When DROVR_RECORD names a directory, every call to a hooked
 * pure function writes its input and output there, keyed by a hash of the input, so the Go
 * suite can replay the whole TS suite's cases. Off (the normal case) it costs one env read.
 * Deleted with src/ at cut-over.
 */
const replacer = (_key: string, value: unknown): unknown => {
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  return value;
};

export const record = <T>(fn: string, input: unknown, output: T): T => {
  const dir = process.env.DROVR_RECORD;
  if (dir === undefined) return output;
  const body = JSON.stringify({ fn, input, output }, replacer, 2);
  const key = createHash('sha1').update(JSON.stringify(input, replacer)).digest('hex').slice(0, 16);
  mkdirSync(join(dir, fn), { recursive: true });
  writeFileSync(join(dir, fn, `${key}.json`), `${body}\n`, 'utf8');
  return output;
};
```

Hook each exported pure function by wrapping its return. The rule: `input` is the function's full argument list as an object with the TS parameter names, so the Go test can decode it by field. Examples, one per shape:

`src/decide.ts`:
```ts
export const decide = (input: DecideInput): Decision => record('decide', { input }, decideUnrecorded(input));
// rename the existing body to decideUnrecorded
export const cyclesFundableFrom = (pool: Pool, cost: CycleCost, running: number): Funding =>
  record('cyclesFundableFrom', { pool, cost, running }, cyclesFundableFromUnrecorded(pool, cost, running));
export const requiredCycles = (binding: BucketName, control: Control, rank: number): number =>
  record('requiredCycles', { binding, control, rank }, (binding === 'session' ? 1 : 1 + control.reserveCycles) + rank * control.priorityStepCycles);
export const poolContext = (funding: Funding, pool: Pool, now: number): string =>
  record('poolContext', { funding, pool, now }, poolContextUnrecorded(funding, pool, now));
```
`src/capacity.ts`: `poolFrom` → `record('poolFrom', { status, ceilings, now }, …)`.
`src/ledger.ts`: `estimateCycleCost` → `{ cycles, seed, minSamples, fraction }`; `chargeForRunning` → `{ running, poolNow, cost }`; `cyclesStartedSince` → `{ cycles, since }`; `consecutiveFailures` → `{ cycles, now, windowMinutes }`; `consecutiveZeroYield` → `{ cycles }`; `unansweredAsks` → `{ cycles }`; `spentSince` → `{ cycles, windowStart, until }` (`until` defaults to `Infinity`, which the replacer carries); `inFlight` → `{ cycles, now, maxHours }`.
`src/allocation.ts`: `allocationSegments` → `{ input }`.
`src/control.ts`: `priorityRank` → `{ control, program, now, lastStarts }` where `lastStarts` is `Object.fromEntries(control.programs.map(p => [p.name, lastStartFor(p.name)]))` (a function cannot be serialised; the Go side rebuilds the closure from the map); `orderCeilings` → `{ ceilings, edited }`; `effectivePriority` → `{ program, now, horizonDays }`.
`src/status-payload.ts`: `buildStatusPayload` → `{ input }`.
`src/status-accounts.ts`: `accountsFromTeamclaude` → `{ status }`.
`src/service.ts`: `describeService` → `{ state, lastTickAt, now, lockedBy }`; `serviceHealth` → `{ state, lastTickAt, now }`.

Each hook is the same mechanical change: rename the body to `<name>Unrecorded`, export a one-line wrapper. The `Unrecorded` functions stay module-private.

- [ ] **Step 4: The recording script**

`scripts/record-fixtures.sh`:
```sh
#!/bin/sh
# Replays the TS suite with the recorder on, so testdata/recorded holds every case the Go
# suite must match. Re-run whenever a TS test changes; commit the result.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
out="$root/testdata/recorded"
rm -rf "$out"
DROVR_RECORD="$out" node --test "$root"/test/*.spec.ts > /dev/null
for fn in "$out"/*/; do printf '%s %s\n' "$(ls "$fn" | wc -l | tr -d ' ')" "$(basename "$fn")"; done
```

Run: `chmod +x scripts/record-fixtures.sh && scripts/record-fixtures.sh`
Expected: a count per function; `decide` well above 50, `poolFrom`, `estimateCycleCost`, `allocationSegments`, `buildStatusPayload`, `priorityRank` all present. The TS suite itself still passes: `node --test test/*.spec.ts` → 593/593 (the hooks must not change a result).

- [ ] **Step 5: The Go loader**

`internal/fixtures/fixtures.go`: `Load` walks `testdata/recorded/<fn>` relative to the repo root (found by walking up from the test's working directory to the dir containing `go.mod`), decodes each file, `t.Fatalf` when the directory is missing or empty. `Float` handles the two sentinel strings. `Equal` marshals `got` with `SetEscapeHTML(false)`, decodes both sides into `any`, and compares recursively: objects by key set and value, arrays by length and element, numbers within `1e-9` absolute, strings exactly; on mismatch `t.Errorf` with the JSON path and both values. Sentinel strings on the `want` side compare equal to `±Inf` on the `got` side only when the Go value marshals through a type that writes them (see Task 7: `Funding.Cycles` marshals `+Inf` as the string `"Infinity"` by a custom `MarshalJSON` on a named `Cycles float64` type).

- [ ] **Step 6: Run, vet, commit**

Run: `go test ./internal/fixtures/ && go vet ./... && gofmt -l . && node --test test/*.spec.ts 2>&1 | tail -3`
Expected: `ok`; TS `pass 593`.

```bash
git add src/record.ts scripts/record-fixtures.sh src/*.ts internal/fixtures testdata/recorded
git commit -m "test(go): recorder hook in every pure TS function and the fixture corpus the Go suite replays"
```

---

### Task 3: `internal/control`

**Files:**
- Create: `internal/control/control.go`, `internal/control/parse.go`, `internal/control/control_test.go`
- Port from: `src/control.ts`, `src/modes.ts`

**Interfaces:**
- Produces:
  ```go
  package control
  type Mode string                      // "off" | "low" | "normal" | "away"
  var Modes = []Mode{"off", "low", "normal", "away"}
  type Ceiling struct { Weekly, Session float64 }
  var DefaultCeilings = map[string]Ceiling{"low": {0.25, 0.25}, "normal": {0.55, 0.4}, "away": {0.85, 0.6}}
  type Host struct { Environment, SSH, Cwd, DrovrHome, Claude string; Wake *string }
  type Aice struct { AsksPage *string }
  type Program struct {
      Name, Cwd string; Description *string; Host *Host; CycleCommand string; Enabled bool; Model string
      UseDirenv bool; Runner string; CyclePrompt, SessionName string; MaxCyclesPerDay *float64
      Priority float64; Deadline, PauseUntil, Cadence *string; Aice *Aice; AsksFile *string
  }
  type Cost struct { Fable, General, Session float64 }   // = ledger.CycleCost; defined here to avoid an import cycle, aliased in ledger
  type Control struct {
      Mode Mode; PauseUntil *string; Ceilings map[string]Ceiling; ReserveCycles, PriorityStepCycles float64
      MaxCyclesPerDay, MaxCycleHours, TickBudgetMinutes, MaxConcurrentCycles, DeadlineHorizonDays float64
      ContextCeilingTokens, CrashWindowMinutes float64; NotifyTo *string
      NudgeAfterMinutes, BlockedBackoffMinutes, StuckCycleThreshold, StallNudgeMinutes, MaxStallNudges, BlockedAlertMinutes float64
      SeedCycleCost Cost; Programs []Program
  }
  func Parse(data []byte) (Control, error)       // "control file is invalid: <path>: <why>"
  func Read(path string) (Control, error)
  func (c Control) Program(name string) (Program, bool)
  func CeilingsFor(c Control) (Ceiling, bool, error)   // false when mode off; error when the mode has no entry
  func ApplyAwayMode(c Control, away bool) Control
  func EffectivePriority(p Program, now epoch.Millis, horizonDays float64) (float64, error)
  func ByPriority(ps []Program, now epoch.Millis, horizonDays float64) ([]Program, error)
  type Rank struct { Rank int; Above []string }
  func PriorityRank(c Control, program string, now epoch.Millis, lastStartFor func(string) (epoch.Millis, bool)) (Rank, error)
  func ParseDuration(s string) (epoch.Millis, error)
  const MaxRestDays = 35
  func ProgramPausedUntil(p Program, now epoch.Millis) (epoch.Millis, bool, error)
  func NextCadenceStart(p Program, lastStartedAt epoch.Millis, hasLast bool) (epoch.Millis, bool, error)
  func IsPaused(c Control, now epoch.Millis) (bool, error)
  func OrderCeilings(ceilings map[string]Ceiling, edited string) map[string]Ceiling
  ```
  Numbers that zod typed `z.number()` are `float64` even when they are counts, so a `control.json` holding `8.0` round-trips; the ledger's `Date.parse` failures that *throw* in TS return `error` here, and the message text is the TS message.

- [ ] **Step 1: Write the failing tests**

`internal/control/control_test.go` — a table over parse cases plus fixture replays:
```go
package control

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
)

func TestParseDefaults(t *testing.T) {
	c, err := Parse([]byte(`{"programs":[{"name":"demo","cwd":"/tmp/demo","host":{"environment":"e1","ssh":"u@box","cwd":"/home/u/demo"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != "normal" || c.ReserveCycles != 0.5 || c.MaxCyclesPerDay != 8 || c.TickBudgetMinutes != 8 || c.BlockedAlertMinutes != 20 {
		t.Fatalf("defaults: %+v", c)
	}
	if c.Ceilings["away"] != (Ceiling{0.85, 0.6}) || c.SeedCycleCost != (Cost{0.1, 0.08, 0.25}) {
		t.Fatalf("ceilings/seed: %+v", c)
	}
	p := c.Programs[0]
	if p.CycleCommand != `teamclaude run -- --model {model} -p "/project-loop {program}"` || !p.Enabled || p.Model != "fable" || !p.UseDirenv || p.Runner != "orca" || p.SessionName != "{program} program runner" || p.Priority != 0 || p.PauseUntil != nil || p.Aice != nil || p.AsksFile != nil {
		t.Fatalf("program defaults: %+v", p)
	}
	if p.Host.DrovrHome != "~/.drovr" || p.Host.Claude != "~/.local/bin/claude" || p.Host.Wake != nil {
		t.Fatalf("host defaults: %+v", *p.Host)
	}
}

func TestParseRefusals(t *testing.T) {
	cases := map[string]string{
		`{"mode":"loud"}`:                                              "mode",
		`{"programs":[{"cwd":"/x"}]}`:                                  "programs[0].name",
		`{"programs":[{"name":"a","cwd":"/x","cadence":"soon"}]}`:      "cadence must look like 30m, 12h, or 7d",
		`{"programs":[{"name":"a","cwd":"/x","host":{"environment":"e","ssh":"s","cwd":"rel"}}]}`: "host.cwd must be an absolute path on the box",
		`{"programs":[{"name":"a","cwd":"/x","runner":"docker"}]}`:     "runner",
		`{"programs":[{"name":"a","cwd":"/x","description":"` + strings.Repeat("x", 501) + `"}]}`: "description",
		`{"reserveCycles":"half"}`:                                     "reserveCycles",
		`{"programs":[{"name":null,"cwd":"/x"}]}`:                      "programs[0].name",
	}
	for in, want := range cases {
		_, err := Parse([]byte(in))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%s) err = %v, want it to name %q", in, err, want)
		}
	}
}

func TestParseStripsUnknownAndKeepsNullPause(t *testing.T) {
	c, err := Parse([]byte(`{"legacyKey":1,"programs":[{"name":"a","cwd":"/x","pauseUntil":null,"statusPage":"gone"}]}`))
	if err != nil || c.Programs[0].PauseUntil != nil {
		t.Fatalf("%v %+v", err, c)
	}
}

func TestDurationAndPauses(t *testing.T) {
	for in, want := range map[string]epoch.Millis{"30m": 1_800_000, "12h": 43_200_000, "7d": 604_800_000} {
		got, err := ParseDuration(in)
		if err != nil || got != want {
			t.Errorf("ParseDuration(%q) = %d, %v", in, got, err)
		}
	}
	if _, err := ParseDuration("1w"); err == nil || !strings.Contains(err.Error(), `duration must look like 30m, 3h, or 2d — got "1w"`) {
		t.Errorf("1w: %v", err)
	}
	now := epoch.MustParse("2026-08-22T12:00:00.000Z")
	past := "2026-08-22T11:00:00.000Z"
	future := "2026-08-22T13:00:00.000Z"
	if _, held, _ := ProgramPausedUntil(Program{Name: "a", PauseUntil: &past}, now); held {
		t.Error("lapsed pause held")
	}
	if until, held, _ := ProgramPausedUntil(Program{Name: "a", PauseUntil: &future}, now); !held || until != now+3_600_000 {
		t.Error("future pause not held")
	}
	bad := "yesterday"
	if _, _, err := ProgramPausedUntil(Program{Name: "a", PauseUntil: &bad}, now); err == nil || err.Error() != "a.pauseUntil is not a valid timestamp: yesterday" {
		t.Errorf("bad pause: %v", err)
	}
}

func TestPriorityRankFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "priorityRank") {
		var in struct {
			Control    json.RawMessage               `json:"control"`
			Program    string                        `json:"program"`
			Now        epoch.Millis                  `json:"now"`
			LastStarts map[string]*epoch.Millis      `json:"lastStarts"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		ctl, err := Parse(in.Control)
		if err != nil {
			t.Fatal(c.Name, err)
		}
		got, err := PriorityRank(ctl, in.Program, in.Now, func(name string) (epoch.Millis, bool) {
			v, ok := in.LastStarts[name]
			if !ok || v == nil {
				return 0, false
			}
			return *v, true
		})
		if err != nil {
			t.Fatal(c.Name, err)
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
}

func TestOrderCeilingsFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "orderCeilings") {
		var in struct {
			Ceilings map[string]Ceiling `json:"ceilings"`
			Edited   string             `json:"edited"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, OrderCeilings(in.Ceilings, in.Edited), c.Output)
	}
}

func TestEffectivePriorityFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "effectivePriority") {
		var in struct {
			Program     json.RawMessage `json:"program"`
			Now         epoch.Millis    `json:"now"`
			HorizonDays float64         `json:"horizonDays"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		p, err := parseProgram(in.Program, "program")
		if err != nil {
			t.Fatal(err)
		}
		got, err := EffectivePriority(p, in.Now, in.HorizonDays)
		if err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
}
```
The recorded `control` in a `priorityRank` input is an already-parsed TS `Control` (every default filled, null for every absent nullable), so `Parse` on it is a round trip — which is itself a test that the Go struct's JSON tags match the TS field names.

- [ ] **Step 2: Run, watch them fail**

Run: `go test ./internal/control/`
Expected: FAIL, `undefined: Parse` and friends.

- [ ] **Step 3: Implement**

`parse.go`: decode into a raw `map[string]json.RawMessage` first, then field by field into the struct with defaults pre-set — this is what gives zod's error paths. Write one small helper per shape: `parseControl(raw json.RawMessage) (Control, error)`, `parseProgram(raw json.RawMessage, path string) (Program, error)`, `parseHost(raw, path)`, `parseAice(raw, path)`, `parseCeiling(raw, path)`. Each helper: `json.Unmarshal` into a struct of pointers (so absent and null are distinguishable), then: required field nil → `fmt.Errorf("%s.%s: required", path, key)`; enum check for `mode` and `runner`; `cadence` against `^\d+[mhd]$`; `host.cwd` against `^/`; `description` length ≤ 500 (count UTF-16 code units as zod does: `len(utf16.Encode([]rune(s)))`). A JSON type mismatch surfaces from `json.Unmarshal` as `*json.UnmarshalTypeError`; wrap it with the path. The outer error is `fmt.Errorf("control file is invalid: %w", err)`.

JSON tags on the exported structs: camelCase exactly as TS (`json:"pauseUntil"` etc.); nullable pointers carry no `omitempty` because the TS writes explicit nulls. `Program.Host` is `*Host` with the same rule.

`control.go`: straight ports. `CeilingsFor` returns `(Ceiling{}, false, nil)` for `off`, `(c, true, nil)` otherwise, and the error text `control.ceilings has no entry for mode "<mode>"`. `ByPriority` uses `sort.SliceStable` with the comparator `effective(a) - effective(b) || a.Name < b.Name` — TS `localeCompare` on ASCII program names is byte order; note it in a comment and keep names ASCII (a non-ASCII program name is nobody's case). `PriorityRank` mirrors the TS exactly, including the `Set` of distinct priorities among `higher`. `OrderCeilings` copies the map before mutating.

- [ ] **Step 4: Run tests, vet, fmt**

Run: `go test ./internal/control/ && go vet ./... && gofmt -l .`
Expected: PASS, including every fixture.

- [ ] **Step 5: Commit**

```bash
git add internal/control
git commit -m "feat(go): control.json — parse with zod's defaults and refusals, priority rank, cadence, pauses, ordered ceilings; fixtures green"
```

---

### Task 4: `internal/exec` and `internal/teamclaude`

**Files:**
- Create: `internal/exec/exec.go`, `internal/exec/exec_test.go`, `internal/teamclaude/teamclaude.go`, `internal/teamclaude/teamclaude_test.go`
- Port from: `src/exec.ts` (`runBounded`, `explainSpawn`, `ExecTimedOut`), `src/teamclaude.ts`

**Interfaces:**
- Produces:
  ```go
  package exec
  type Bounds struct { Timeout time.Duration; Cwd string; Label string }   // Timeout required (>0), asserted
  type Result struct { Stdout, Stderr string }
  type TimedOut struct{ Msg string }       // Error() = Msg
  type ExitError struct { Err error; Stdout, Stderr string; Code int }  // the original failure with its output kept
  func RunBounded(ctx context.Context, bin string, args []string, b Bounds) (Result, error)
  func ExplainSpawn(bin string, err error) error   // ErrNotFound → the PATH message; else err
  func RunSsh(ctx context.Context, target, command string, timeout time.Duration) (Result, error)

  package teamclaude
  type Quota struct { Unified5h *float64; Unified5hReset *epoch.Millis; Unified7d *float64; Unified7dReset *epoch.Millis; Unified7dFable *float64; Unified7dFableReset *epoch.Millis; UnifiedStatus *string }
  type Account struct { Name, Type string; OrgName, Status *string; Sessions float64; Disabled bool; Quota Quota; Usage struct{ LastUsed *string }; RateLimitedUntil, PausedUntil *epoch.Millis; SwitchThreshold *float64 }
  type RouteAccount struct { Name string; Eligible bool }
  type Route struct { Name string; Accounts []RouteAccount; Target *string }
  type Status struct { CurrentAccount *string; Accounts []Account; Routes []Route; SwitchThreshold *float64; SwitchThresholds map[string]float64 /* nil when null */ }
  func Parse(data []byte) (Status, error)   // "teamclaude status did not match expected shape: <path>: <why>"
  func Read(ctx context.Context, bin string) (Status, error)   // bin "" → "teamclaude"; STATUS_TIMEOUT 20s, 8 MiB cap
  type Thresholds struct { Session, General, Fable *float64 }
  func SwitchThresholds(s Status, a Account) Thresholds
  func FableEligible(s Status) (map[string]bool, bool)   // false = no route declared
  ```
  `EpochMs` coercion is a custom `UnmarshalJSON` on an unexported wrapper used only during parsing; the exported field is `*epoch.Millis`.

- [ ] **Step 1: Write the failing tests**

`internal/exec/exec_test.go`:
```go
package exec

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"
)

func TestRunBoundedCapturesOutput(t *testing.T) {
	r, err := RunBounded(context.Background(), "sh", []string{"-c", "echo out; echo err >&2"}, Bounds{Timeout: time.Second})
	if err != nil || r.Stdout != "out\n" || r.Stderr != "err\n" {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestRunBoundedTimesOutWithTail(t *testing.T) {
	_, err := RunBounded(context.Background(), "sh", []string{"-c", "echo waiting on you >&2; sleep 5"}, Bounds{Timeout: 200 * time.Millisecond, Label: "slow thing"})
	var to *TimedOut
	if !errors.As(err, &to) || !strings.Contains(err.Error(), "slow thing did not return within 0s and was killed; it had printed: waiting on you") {
		t.Fatalf("%v", err)
	}
}

func TestRunBoundedKeepsOriginalFailure(t *testing.T) {
	_, err := RunBounded(context.Background(), "sh", []string{"-c", `echo '{"ok":false,"code":"x"}'; exit 3`}, Bounds{Timeout: time.Second})
	var ee *ExitError
	if !errors.As(err, &ee) || ee.Code != 3 || !strings.Contains(ee.Stdout, `"ok":false`) {
		t.Fatalf("%v", err)
	}
}

func TestRunBoundedExplainsMissingBinary(t *testing.T) {
	t.Setenv("PATH", "/nonexistent")
	_, err := RunBounded(context.Background(), "definitely-not-here", nil, Bounds{Timeout: time.Second})
	if err == nil || !strings.Contains(err.Error(), "definitely-not-here is not on PATH. Looked in: /nonexistent. If this came from a launchd tick, re-run `drovr service install`") {
		t.Fatalf("%v", err)
	}
}
```
`Math.round(200/1000)` is `0`, so the TS message for a 200 ms budget says `0s`; the Go copies that.

`internal/teamclaude/teamclaude_test.go`:
```go
package teamclaude

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/fixtures"
)

const minimal = `{"currentAccount":"a","accounts":[{"name":"a","disabled":false,"quota":{"unified5h":null,"unified5hReset":null,"unified7d":0.1,"unified7dReset":1787400000000,"unified7dFable":0.1,"unified7dFableReset":"1787400000000"},"rateLimitedUntil":%s,"pausedUntil":null}]}`

func TestEpochCoercion(t *testing.T) {
	cases := map[string]*int64{
		`null`: nil, `1787400000000`: ptr(1787400000000), `"1787400000000"`: ptr(1787400000000),
		`"2026-08-22T12:00:00.000Z"`: ptr(1787400000000), `"soon"`: nil, `"  1787400000000 "`: ptr(1787400000000),
	}
	for in, want := range cases {
		s, err := Parse([]byte(strings.Replace(minimal, "%s", in, 1)))
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		got := s.Accounts[0].RateLimitedUntil
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Errorf("rateLimitedUntil %s → %v want %v", in, got, want)
		}
		if r := s.Accounts[0].Quota.Unified7dFableReset; r == nil || *r != 1787400000000 {
			t.Errorf("string reset not coerced: %v", r)
		}
	}
}

func TestDefaultsAndRefusals(t *testing.T) {
	s, err := Parse([]byte(strings.Replace(minimal, "%s", "null", 1)))
	if err != nil {
		t.Fatal(err)
	}
	a := s.Accounts[0]
	if a.Type != "oauth" || a.OrgName != nil || a.Status != nil || a.Sessions != 0 || a.Usage.LastUsed != nil || a.SwitchThreshold != nil || len(s.Routes) != 0 || s.SwitchThreshold != nil || s.SwitchThresholds != nil {
		t.Fatalf("%+v", s)
	}
	for in, path := range map[string]string{
		`{"currentAccount":null,"accounts":[{"name":"a","quota":{}}]}`: "accounts[0].disabled",
		`{"currentAccount":null}`: "accounts",
		`{"currentAccount":null,"accounts":[{"name":"a","disabled":false,"quota":{"unified5h":"lots","unified5hReset":null,"unified7d":null,"unified7dReset":null,"unified7dFable":null,"unified7dFableReset":null},"rateLimitedUntil":null,"pausedUntil":null}]}`: "accounts[0].quota.unified5h",
	} {
		if _, err := Parse([]byte(in)); err == nil || !strings.Contains(err.Error(), path) || !strings.HasPrefix(err.Error(), "teamclaude status did not match expected shape: ") {
			t.Errorf("%s: %v", in, err)
		}
	}
}

func TestFableEligibleAndThresholds(t *testing.T) {
	for _, c := range fixtures.Load(t, "accountsFromTeamclaude") {
		var in struct{ Status json.RawMessage `json:"status"` }
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		if _, err := Parse(in.Status); err != nil {
			t.Errorf("%s: recorded status does not round-trip: %v", c.Name, err)
		}
	}
	s, _ := Parse([]byte(`{"currentAccount":null,"accounts":[],"routes":[{"name":"fable","accounts":[{"name":"a","eligible":true},{"name":"b","eligible":false}]}],"switchThreshold":0.9,"switchThresholds":{"unified5h":0.8}}`))
	eligible, declared := FableEligible(s)
	if !declared || !eligible["a"] || eligible["b"] {
		t.Fatalf("%v %v", eligible, declared)
	}
	th := SwitchThresholds(s, Account{})
	if th.Session == nil || *th.Session != 0.8 || th.General == nil || *th.General != 0.9 {
		t.Fatalf("%+v", th)
	}
	own := 0.5
	th = SwitchThresholds(s, Account{SwitchThreshold: &own})
	if *th.Session != 0.5 || *th.Fable != 0.5 {
		t.Fatalf("%+v", th)
	}
	if _, declared := FableEligible(Status{Routes: []Route{{Name: "fable"}}}); declared {
		t.Fatal("an empty fable route is 'no restriction known'")
	}
}

func ptr(v int64) *int64 { return &v }
```

- [ ] **Step 2: Run, watch them fail**

Run: `go test ./internal/exec/ ./internal/teamclaude/`
Expected: FAIL, undefined symbols.

- [ ] **Step 3: Implement**

`exec.go`: `RunBounded` asserts `b.Timeout > 0` (`panic` — it is a programming error, the TS made it a required parameter for the same reason). `context.WithTimeout`, `exec.CommandContext` with `cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}` and `cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }` so a timeout kills the group; `cmd.WaitDelay = time.Second`. Stdout and stderr to `bytes.Buffer`s. After `Run`: if `ctx.Err() == context.DeadlineExceeded` → `&TimedOut{Msg: fmt.Sprintf("%s did not return within %ds and was killed%s", shown, int(math.Round(b.Timeout.Seconds())), tail)}` where `tail` is the last two stderr lines joined by a space, prefixed `; it had printed: `, or empty. If `errors.Is(err, exec.ErrNotFound)` → `ExplainSpawn`. Any other error → `&ExitError{Err: err, Stdout, Stderr, Code}` (`Code` from `*exec.ExitError`, `-1` otherwise). `shown` is `b.Label` or `bin + " " + strings.Join(args, " ")`. `RunSsh` is the TS argv verbatim.

`teamclaude.go`: parse through pointer-structs with an `epochMs` wrapper type:
```go
type epochMs struct{ v *epoch.Millis }
func (e *epochMs) UnmarshalJSON(b []byte) error {
	var any interface{}
	if err := json.Unmarshal(b, &any); err != nil { return err }
	switch x := any.(type) {
	case nil: return nil
	case float64: if !math.IsInf(x,0) && !math.IsNaN(x) { v := epoch.Millis(x); e.v = &v }; return nil
	case string:
		text := strings.TrimSpace(x)
		if digits.MatchString(text) { n, _ := strconv.ParseInt(text, 10, 64); e.v = &n; return nil }
		if ms, ok := epoch.Parse(text); ok { e.v = &ms }
		return nil
	}
	return fmt.Errorf("expected number or string")
}
```
A JSON number is `float64` here; `Number(text)` on a digit string in TS can exceed 2^53 and lose precision — not a case that occurs (epoch ms are 13 digits). Required fields: `currentAccount` (nullable but required), `accounts`, per account `name`, `disabled`, `quota` with its six bucket fields present (nullable), `rateLimitedUntil`, `pausedUntil` (nullable, required). Error prefix as in the test. `Read` runs `RunBounded(ctx, bin, []string{"status", "--json"}, Bounds{Timeout: 20 * time.Second})` and refuses stdout over 8 MiB with the same wording as Node's `maxBuffer` would be unhelpful — use `"teamclaude status printed more than 8 MiB"`.

- [ ] **Step 4: Run tests, vet, fmt**

Run: `go test ./internal/exec/ ./internal/teamclaude/ && go vet ./... && gofmt -l .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/exec internal/teamclaude
git commit -m "feat(go): runBounded — the only spawn, with the timeout required and the child's output kept on the error; teamclaude status with epochMs coercion"
```

---

### Task 5: `internal/ledger`

**Files:**
- Create: `internal/ledger/ledger.go`, `internal/ledger/ledger_test.go`
- Port from: `src/ledger.ts`

**Interfaces:**
- Produces:
  ```go
  package ledger
  type Cost = control.Cost
  type Yield struct { TicketsMoved, PrsOpened, Commits float64 }
  type Cycle struct {
      V int; Kind, Program, StartedAt string; EndedAt *string; Exit string
      PoolBefore Cost; PoolAfter *Cost; StartupTokens *float64; Yield *Yield
      AsksRaised float64; PauseUntil, SessionID, Closing *string
  }
  type Decision struct { V int; At, Program, Verdict, Reason string; Pool *Cost; CyclesFundable *float64 }
  var Exits = []string{"context","capacity","seam","blocked","crash","stalled","deferred","abandoned","running"}
  func ParseCycle(data []byte) (Cycle, error)
  func ReadCycles(path string) ([]Cycle, error)     // "<path>:<line> is not a valid cycle record: <why>"; missing file → nil, nil
  func AppendRecord(path string, record any) error
  func LatestEnds(cycles []Cycle) []Cycle
  func LastCycleReported(cycles []Cycle) bool
  func Percentile(values []float64, fraction float64) float64
  func EstimateCycleCost(cycles []Cycle, seed Cost, minSamples int, fraction float64) Cost   // callers pass 3, 0.9
  func ChargeForRunning(running []Cycle, poolNow Cost, cost Cost) float64
  func SpentSince(cycles []Cycle, windowStart float64, until epoch.Millis) Cost   // windowStart is a float because the TS computes it in float and compares as numbers; until = math.MaxInt64 for "unbounded"
  func InFlight(cycles []Cycle, now epoch.Millis, maxHours float64) []Cycle
  func CyclesStartedSince(cycles []Cycle, since epoch.Millis) int
  func ConsecutiveFailures(cycles []Cycle, now epoch.Millis, windowMinutes float64) int
  func ConsecutiveZeroYield(cycles []Cycle) int
  func LastStartedAt(cycles []Cycle) (epoch.Millis, bool)
  func LastFinished(cycles []Cycle) (Cycle, bool)
  type Owed struct { Asks float64; At epoch.Millis }
  func UnansweredAsks(cycles []Cycle) (Owed, bool)
  func StampTick(path string, now epoch.Millis) error
  func ReadTickStamp(path string) (epoch.Millis, bool)
  func LastDecisionAt(path string) (epoch.Millis, bool)
  ```
  `Date.parse` of a cycle's `startedAt` is `epoch.Parse`; an unparseable `startedAt` is `NaN` in TS and every comparison with it is false — mirror that by treating `!ok` as "fails every comparison" (skip in `InFlight`, `SpentSince`, `CyclesStartedSince`; `LastStartedAt` ignores it as the TS does).

- [ ] **Step 1: Write the failing tests**

`internal/ledger/ledger_test.go`:
```go
package ledger

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
)

func TestReadCyclesRefusesByLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cycles.jsonl")
	os.WriteFile(path, []byte(`{"v":1,"kind":"delivery","program":"a","startedAt":"2026-08-22T10:00:00.000Z","endedAt":null,"exit":"running","poolBefore":{"fable":1,"general":1,"session":1},"poolAfter":null,"startupTokens":null,"yield":null}
{"v":1,"kind":"delivery","program":"a","startedAt":"x","endedAt":null,"exit":"vanished","poolBefore":{"fable":1,"general":1,"session":1},"poolAfter":null,"startupTokens":null,"yield":null}
`), 0o644)
	_, err := ReadCycles(path)
	if err == nil || !strings.HasPrefix(err.Error(), path+":2 is not a valid cycle record: ") || !strings.Contains(err.Error(), "exit") {
		t.Fatalf("%v", err)
	}
	if cycles, err := ReadCycles(filepath.Join(t.TempDir(), "missing")); err != nil || cycles != nil {
		t.Fatalf("missing file: %v %v", cycles, err)
	}
}

func TestStartRecordDefaults(t *testing.T) {
	c, err := ParseCycle([]byte(`{"v":1,"kind":"delivery","program":"a","startedAt":"2026-08-22T10:00:00.000Z","endedAt":null,"exit":"running","poolBefore":{"fable":1,"general":1,"session":1},"poolAfter":null,"startupTokens":null,"yield":null}`))
	if err != nil || c.AsksRaised != 0 || c.PauseUntil != nil || c.SessionID != nil || c.Closing != nil || c.PoolAfter != nil {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := ParseCycle([]byte(`{"v":2}`)); err == nil || !strings.Contains(err.Error(), "v") {
		t.Fatalf("v:2 accepted: %v", err)
	}
}

func TestPercentileNearestRank(t *testing.T) {
	if got := Percentile([]float64{0.3, 0.1, 0.2}, 0.9); got != 0.3 {
		t.Fatal(got)
	}
	if got := Percentile([]float64{0.3, 0.1, 0.2}, 0.5); got != 0.2 {
		t.Fatal(got)
	}
	if got := Percentile([]float64{5}, 0.9); got != 5 {
		t.Fatal(got)
	}
}

func decodeCycles(t *testing.T, raw json.RawMessage) []Cycle {
	var out []Cycle
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestEstimateCycleCostFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "estimateCycleCost") {
		var in struct {
			Cycles     json.RawMessage `json:"cycles"`
			Seed       Cost            `json:"seed"`
			MinSamples int             `json:"minSamples"`
			Fraction   float64         `json:"fraction"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, EstimateCycleCost(decodeCycles(t, in.Cycles), in.Seed, in.MinSamples, in.Fraction), c.Output)
	}
}

func TestChargeForRunningFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "chargeForRunning") {
		var in struct {
			Running json.RawMessage `json:"running"`
			PoolNow Cost            `json:"poolNow"`
			Cost    Cost            `json:"cost"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, ChargeForRunning(decodeCycles(t, in.Running), in.PoolNow, in.Cost), c.Output)
	}
}

func TestSpentSinceFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "spentSince") {
		var in struct {
			Cycles      json.RawMessage `json:"cycles"`
			WindowStart float64         `json:"windowStart"`
			Until       json.RawMessage `json:"until"`
		}
		json.Unmarshal(c.Input, &in)
		until := epoch.Millis(math.MaxInt64)
		if f := fixtures.Float(in.Until); !math.IsInf(f, 1) {
			until = epoch.Millis(f)
		}
		fixtures.Equal(t, c.Name, SpentSince(decodeCycles(t, in.Cycles), in.WindowStart, until), c.Output)
	}
}

func TestCountsFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "inFlight") {
		var in struct {
			Cycles   json.RawMessage `json:"cycles"`
			Now      epoch.Millis    `json:"now"`
			MaxHours float64         `json:"maxHours"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, InFlight(decodeCycles(t, in.Cycles), in.Now, in.MaxHours), c.Output)
	}
	for _, c := range fixtures.Load(t, "cyclesStartedSince") {
		var in struct {
			Cycles json.RawMessage `json:"cycles"`
			Since  epoch.Millis    `json:"since"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, CyclesStartedSince(decodeCycles(t, in.Cycles), in.Since), c.Output)
	}
	for _, c := range fixtures.Load(t, "consecutiveFailures") {
		var in struct {
			Cycles        json.RawMessage `json:"cycles"`
			Now           epoch.Millis    `json:"now"`
			WindowMinutes float64         `json:"windowMinutes"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, ConsecutiveFailures(decodeCycles(t, in.Cycles), in.Now, in.WindowMinutes), c.Output)
	}
	for _, c := range fixtures.Load(t, "consecutiveZeroYield") {
		var in struct{ Cycles json.RawMessage `json:"cycles"` }
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, ConsecutiveZeroYield(decodeCycles(t, in.Cycles)), c.Output)
	}
	for _, c := range fixtures.Load(t, "unansweredAsks") {
		var in struct{ Cycles json.RawMessage `json:"cycles"` }
		json.Unmarshal(c.Input, &in)
		owed, ok := UnansweredAsks(decodeCycles(t, in.Cycles))
		if !ok {
			fixtures.Equal(t, c.Name, nil, c.Output)
			continue
		}
		fixtures.Equal(t, c.Name, owed, c.Output)
	}
}

func TestTickStamp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "last-tick.json")
	if err := StampTick(path, 1787400000000); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "{\"at\":\"2026-08-22T12:00:00.000Z\"}\n" {
		t.Fatalf("%q", b)
	}
	if at, ok := ReadTickStamp(path); !ok || at != 1787400000000 {
		t.Fatal(at, ok)
	}
	os.WriteFile(path, []byte(`{"at":"never"}`), 0o644)
	if _, ok := ReadTickStamp(path); ok {
		t.Fatal("garbage stamp read as a time")
	}
}
```
In the fixture inputs `now` and `since` are plain numbers and the `cycles` are parsed TS records with every default present, so `json.Unmarshal` into `Cycle` is enough there; `ParseCycle` (with defaults and refusals) is for the ledger file. `Owed` marshals as `{"asks":…,"at":…}` to match `{ asks, at }`.

- [ ] **Step 2: Run, watch them fail**

Run: `go test ./internal/ledger/`
Expected: FAIL, undefined symbols.

- [ ] **Step 3: Implement**

Straight port, function for function, with these Go specifics: identity key is `program + "|" + startedAt`; `LatestEnds` must return in **first-seen insertion order** of the identity (a `Map` keeps insertion order, and `lastCycleReported` reads `.at(-1)`), so keep a slice of keys alongside the map. `Percentile` sorts a copy. `EstimateCycleCost` keeps per-bucket sample counts. `ChargeForRunning` uses `math.Max` over the three observed ratios with the floor `1`. `StampTick` writes `{"at":"…"}\n` via `os.WriteFile` (the TS is a plain `writeFileSync` too). `ReadTickStamp`/`LastDecisionAt` return `false` on any parse problem, as the TS returns null. `AppendRecord` opens with `O_APPEND|O_CREATE|O_WRONLY`, 0o644, one `Write` of the marshalled line plus `\n`, with `SetEscapeHTML(false)`.

- [ ] **Step 4: Run tests, vet, fmt**

Run: `go test ./internal/ledger/ && go vet ./... && gofmt -l .`
Expected: PASS, every fixture.

- [ ] **Step 5: Commit**

```bash
git add internal/ledger
git commit -m "feat(go): the ledger — records, latestEnds, pricing at a high percentile, charging in-flight cycles, the streaks; fixtures green"
```

---

### Task 6: `internal/capacity`

**Files:**
- Create: `internal/capacity/capacity.go`, `internal/capacity/capacity_test.go`
- Port from: `src/capacity.ts`, plus `BucketName` from `src/allocation.ts`

**Interfaces:**
- Produces:
  ```go
  package capacity
  type Bucket string   // "fable" | "general" | "session"
  var Buckets = []Bucket{"fable", "general", "session"}
  type Ceilings = control.Ceiling
  type AccountHeadroom struct { Name string; Fable, General, Session float64; Routable bool }
  func (a AccountHeadroom) Of(b Bucket) float64
  type Resets struct { Fable, General, Session *epoch.Millis }
  func (r Resets) Of(b Bucket) *epoch.Millis
  type Pool struct { Fable, General, Session float64; UsableAccounts int; PerAccount []AccountHeadroom; ResetAt Resets; EarliestRecoveryAt *epoch.Millis }
  func (p Pool) Of(b Bucket) float64
  func IsUsable(a teamclaude.Account, now epoch.Millis) bool
  func PoolFrom(s teamclaude.Status, c Ceilings, now epoch.Millis) Pool
  func HoursToWeeklyReset(s teamclaude.Status, now epoch.Millis) (float64, bool)
  ```
  JSON tags: `fable, general, session, usableAccounts, perAccount, resetAt, earliestRecoveryAt`, `AccountHeadroom` as `name, fable, general, session, routable` — the fixture's `pool` output is compared field for field.

- [ ] **Step 1: Write the failing test**

```go
package capacity

import (
	"encoding/json"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/teamclaude"
)

func TestPoolFromFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "poolFrom") {
		var in struct {
			Status   json.RawMessage `json:"status"`
			Ceilings Ceilings        `json:"ceilings"`
			Now      epoch.Millis    `json:"now"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		s, err := teamclaude.Parse(in.Status)
		if err != nil {
			t.Fatal(c.Name, err)
		}
		fixtures.Equal(t, c.Name, PoolFrom(s, in.Ceilings, in.Now), c.Output)
	}
}

func TestHeadroomClampsPerAccount(t *testing.T) {
	blown, fine := 1.5, 0.1
	s := teamclaude.Status{Accounts: []teamclaude.Account{
		{Name: "a", Quota: teamclaude.Quota{Unified7dFable: &blown, Unified7d: &blown}},
		{Name: "b", Quota: teamclaude.Quota{Unified7dFable: &fine, Unified7d: &fine}},
	}}
	p := PoolFrom(s, Ceilings{Weekly: 0.55, Session: 0.4}, 0)
	if p.Fable != 0.45 || p.PerAccount[0].Fable != 0 || p.UsableAccounts != 2 {
		t.Fatalf("%+v", p)
	}
	if p.Session != 0.8 { // null session buckets read as 0 used
		t.Fatalf("session %v", p.Session)
	}
}
```

- [ ] **Step 2: Run, watch it fail**

Run: `go test ./internal/capacity/`
Expected: FAIL.

- [ ] **Step 3: Implement**

Port verbatim. `soonest` returns `nil` when no future reset. `0.55 - 0.1` in float64 is `0.45` to within the fixture tolerance; the hand test compares exactly, so compute `headroom` as `math.Max(0, ceiling-used)` exactly as TS does and expect `0.45000000000000007`? No: `0.55-0.1` is `0.45000000000000007` in both languages. Change the hand assertion to a tolerance or to the value both produce; the point of the test is the clamp, so assert `p.PerAccount[0].Fable == 0` and `p.Fable == p.PerAccount[1].Fable`.

- [ ] **Step 4: Run tests, vet, fmt**

Run: `go test ./internal/capacity/ && go vet ./... && gofmt -l .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/capacity
git commit -m "feat(go): the pool — per-account clamp, resets per bucket, routable kept but flagged; fixtures green"
```

---

### Task 7: `internal/decide`

**Files:**
- Create: `internal/decide/decide.go`, `internal/decide/text.go`, `internal/decide/decide_test.go`
- Port from: `src/decide.ts`

**Interfaces:**
- Produces:
  ```go
  package decide
  type Verdict string   // "GO" | "WAIT" | "STOP"
  type Cycles float64   // marshals ±Inf as "Infinity"/"-Infinity", else a number
  type AccountFunding struct { Name string; Cycles Cycles; Binding capacity.Bucket; Routable bool }
  type Funding struct { Cycles Cycles; Binding capacity.Bucket; Accounts []AccountFunding }
  type Decision struct {
      Verdict Verdict; Reason string; Note *string; Pool *capacity.Pool
      CyclesFundable *Cycles; Binding *capacity.Bucket; EarliestRecoveryAt *epoch.Millis
  }
  type Input struct {
      Status teamclaude.Status; Control control.Control; Cycles []ledger.Cycle; Program string; Now epoch.Millis
      AnsweredAt *epoch.Millis; AsksShared *bool
      RunnerPresent *bool   // nil = unknown; only true holds
  }
  func FullReason(d Decision) string
  func CyclesFundableFrom(pool capacity.Pool, cost ledger.Cost, running float64) Funding
  func ContributingAccounts(f Funding) int
  func PoolContext(f Funding, pool capacity.Pool, now epoch.Millis) string
  func RequiredCycles(binding capacity.Bucket, c control.Control, rank int) float64
  func ProgramReadiness(in Input) (*Decision, error)
  func Decide(in Input) (Decision, error)
  ```
  Errors come only from the places the TS throws (`ceilingsFor`, `Date.parse` guards in control); every other path returns a `Decision`.

- [ ] **Step 1: Write the failing tests**

```go
package decide

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

type recordedInput struct {
	Status        json.RawMessage `json:"status"`
	Control       json.RawMessage `json:"control"`
	Cycles        []ledger.Cycle  `json:"cycles"`
	Program       string          `json:"program"`
	Now           epoch.Millis    `json:"now"`
	AnsweredAt    *epoch.Millis   `json:"answeredAt"`
	AsksShared    *bool           `json:"asksShared"`
	RunnerPresent *bool           `json:"runnerPresent"`
}

func decodeInput(t *testing.T, raw json.RawMessage) Input {
	var wrap struct{ Input recordedInput `json:"input"` }
	if err := json.Unmarshal(raw, &wrap); err != nil {
		t.Fatal(err)
	}
	r := wrap.Input
	s, err := teamclaude.Parse(r.Status)
	if err != nil {
		t.Fatal(err)
	}
	c, err := control.Parse(r.Control)
	if err != nil {
		t.Fatal(err)
	}
	return Input{Status: s, Control: c, Cycles: r.Cycles, Program: r.Program, Now: r.Now, AnsweredAt: r.AnsweredAt, AsksShared: r.AsksShared, RunnerPresent: r.RunnerPresent}
}

func TestDecideFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "decide") {
		got, err := Decide(decodeInput(t, c.Input))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
}

func TestCyclesFundableFromFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "cyclesFundableFrom") {
		var in struct {
			Pool    capacity.Pool `json:"pool"`
			Cost    ledger.Cost   `json:"cost"`
			Running float64       `json:"running"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, CyclesFundableFrom(in.Pool, in.Cost, in.Running), c.Output)
	}
}

func TestPoolContextAndRequiredFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "poolContext") {
		var in struct {
			Funding Funding       `json:"funding"`
			Pool    capacity.Pool `json:"pool"`
			Now     epoch.Millis  `json:"now"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, PoolContext(in.Funding, in.Pool, in.Now), c.Output)
	}
	for _, c := range fixtures.Load(t, "requiredCycles") {
		var in struct {
			Binding capacity.Bucket `json:"binding"`
			Control json.RawMessage `json:"control"`
			Rank    int             `json:"rank"`
		}
		json.Unmarshal(c.Input, &in)
		ctl, err := control.Parse(in.Control)
		if err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, RequiredCycles(in.Binding, ctl, in.Rank), c.Output)
	}
}

func TestEveryAccountPinnedNamesSoonestReset(t *testing.T) {
	soon, late := epoch.Millis(1_000), epoch.Millis(5_000)
	pool := capacity.Pool{
		UsableAccounts: 2,
		PerAccount: []capacity.AccountHeadroom{{Name: "a", Fable: 0, General: 1, Session: 1, Routable: true}, {Name: "b", Fable: 1, General: 1, Session: 0, Routable: true}},
		ResetAt:    capacity.Resets{Fable: &late, Session: &soon},
	}
	f := CyclesFundableFrom(pool, ledger.Cost{Fable: 0.1, General: 0.1, Session: 0.1}, 3)
	if f.Cycles != 0 || f.Binding != "session" {
		t.Fatalf("%+v", f)
	}
}

func TestCyclesMarshalsInfinity(t *testing.T) {
	b, _ := json.Marshal(Cycles(math.Inf(1)))
	if string(b) != `"Infinity"` {
		t.Fatal(string(b))
	}
}
```
`Cycles` needs an `UnmarshalJSON` too (the `poolContext` fixture input carries a recorded `Funding`, which may hold `"Infinity"`).

- [ ] **Step 2: Run, watch them fail**

Run: `go test ./internal/decide/`
Expected: FAIL.

- [ ] **Step 3: Implement**

`decide.go` holds the three layers and `Decide`; `text.go` holds `shortName`, `listOf`, `sourcedFrom`, `concentrationNote`, `couplingNote`, `untilText`, `paceExceeded`'s message. Every string is copied from the TS character for character, em-dashes included. `toFixed(2)` → `jsnum.ToFixed(v, 2)`; `Math.round` → `jsnum.RoundHalfUp`; `Math.ceil` → `math.Ceil`. `ratio` returns `math.Inf(1)` when `cost <= 0`. `fundingFor`'s `reduce` keeps the **first** minimum on ties (TS `<`), so iterate `Buckets` in order and replace only on strictly less. `bindingOf`'s first reduce keeps the first maximum on ties (`>`); the second keeps the earlier bucket on equal reset order. `hold`'s `earliestRecoveryAt` rule is exactly the TS ternary. `Decision` JSON tags: `verdict, reason, note, pool, cyclesFundable, binding, earliestRecoveryAt`.

`paceExceeded` reads `hoursToWeeklyReset`, computes `elapsed`, `windowStart` as `in.Now - epoch.Millis((168-hoursLeft)*3_600_000)` — the TS does this in float then compares `Date.parse(startedAt) >= windowStart` as numbers; truncating to `int64` can differ by under a millisecond from the TS float comparison. Keep `windowStart` as `float64` inside `SpentSince`'s caller: give `ledger.SpentSince` a `float64` `windowStart` parameter instead of `epoch.Millis` (adjust Task 5's signature and test: `WindowStart float64`). Ruling to carry into Task 5 if this task is executed after it: change the signature then.

- [ ] **Step 4: Run tests, vet, fmt**

Run: `go test ./internal/... && go vet ./... && gofmt -l .`
Expected: PASS; the `decide` fixtures are the big one — on a mismatch the path and both values print; fix the port, never the fixture.

- [ ] **Step 5: Commit**

```bash
git add internal/decide internal/ledger
git commit -m "feat(go): decide — readiness, admission limits, the capacity verdict and every reason string; the whole recorded suite agrees"
```

---

### Task 8: `internal/allocation`

**Files:**
- Create: `internal/allocation/allocation.go`, `internal/allocation/allocation_test.go`
- Port from: `src/allocation.ts` (minus `BucketName`, now `capacity.Bucket`)

**Interfaces:**
- Produces:
  ```go
  package allocation
  type Allocation struct { Bucket capacity.Bucket; Total, YoursSpent, ProgramsSpent, ProgramsReserved, ProgramsAvailable, YoursReserved float64 }
  type Input struct { Status teamclaude.Status; Pool capacity.Pool; Bucket capacity.Bucket; SpentByPrograms float64; RunningCycles int; CycleCost ledger.Cost; Now epoch.Millis }
  func For(in Input) Allocation
  type Segments struct { Fable, General, Session Allocation }   // json: fable, general, session
  func SegmentsFor(status teamclaude.Status, pool capacity.Pool, cycles []ledger.Cycle, runningCycles int, cost ledger.Cost, now epoch.Millis) Segments
  ```
  `roundAllocation`'s `Number(x.toFixed(4))` is `strconv.ParseFloat(jsnum.ToFixed(x, 4), 64)`.

- [ ] **Step 1: Write the failing test**

```go
package allocation

import (
	"encoding/json"
	"testing"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

func TestSegmentsFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "allocationSegments") {
		var wrap struct {
			Input struct {
				Status        json.RawMessage `json:"status"`
				Pool          capacity.Pool   `json:"pool"`
				Cycles        []ledger.Cycle  `json:"cycles"`
				RunningCycles int             `json:"runningCycles"`
				CycleCost     ledger.Cost     `json:"cycleCost"`
				Now           epoch.Millis    `json:"now"`
			} `json:"input"`
		}
		if err := json.Unmarshal(c.Input, &wrap); err != nil {
			t.Fatal(err)
		}
		in := wrap.Input
		s, err := teamclaude.Parse(in.Status)
		if err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, SegmentsFor(s, in.Pool, in.Cycles, in.RunningCycles, in.CycleCost, in.Now), c.Output)
	}
}

func TestSegmentsSumToTotal(t *testing.T) {
	a := For(Input{Pool: capacity.Pool{UsableAccounts: 2, Fable: 0.9}, Bucket: "fable", SpentByPrograms: 0.3, RunningCycles: 1, CycleCost: ledger.Cost{Fable: 0.2}})
	sum := a.YoursSpent + a.ProgramsSpent + a.ProgramsReserved + a.ProgramsAvailable + a.YoursReserved
	if sum < a.Total-1e-9 || sum > a.Total+1e-9 {
		t.Fatalf("segments sum %v total %v", sum, a.Total)
	}
}
```

- [ ] **Step 2: Run, watch it fail** — `go test ./internal/allocation/` → FAIL.

- [ ] **Step 3: Implement** — verbatim port; `usedTotal` over usable accounts with `?? 0` as `0` for nil.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/allocation/ && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/allocation
git commit -m "feat(go): allocation bars from the same pool decide() uses; fixtures green"
```

---

### Task 9: `internal/service` (read side), `internal/lock`, `internal/status`

**Files:**
- Create: `internal/service/service.go`, `internal/service/service_test.go`, `internal/lock/lock.go`, `internal/lock/lock_test.go`, `internal/status/accounts.go`, `internal/status/payload.go`, `internal/status/status_test.go`
- Port from: `src/service.ts` (`LABEL`, `plistPathFor`, `plistPath`, `ServiceState`, `serviceStateFor`, `serviceState`, `bootstrapCommand`, `bootoutCommand`, `describeService`, `serviceHealth` — **not** `plist`, `installAgent`, `reloadAgent`, `agentPath`, which are E3), `src/lock.ts`, `src/status-accounts.ts`, `src/status-payload.ts`

**Interfaces:**
- Produces:
  ```go
  package service
  const Label = "tech.propra.drovr"
  func PlistPathFor(label string) string   // ~/Library/LaunchAgents/<label>.plist
  func PlistPath() string
  type State struct { Installed, Loaded bool; Pid, LastExitStatus *int; IntervalSeconds *int }
  func StateFor(label string) State       // runs `launchctl list <label>`; a non-zero exit is "not loaded"
  func Current() State
  func BootstrapCommand(label string) string
  func BootoutCommand(label string) string
  type LockHolder struct { Pid int; HeldMs *int64 }
  func Describe(s State, lastTickAt *epoch.Millis, now epoch.Millis, lockedBy *LockHolder) string
  type Health string   // "not-installed" | "not-loaded" | "no-ticks-yet" | "stalled" | "healthy"
  func HealthOf(s State, lastTickAt *epoch.Millis, now epoch.Millis) Health

  package lock
  type Held struct { Pid int; At *epoch.Millis }
  func HeldBy(path string) (Held, bool)
  func Holder(path string) (int, bool)
  func HeldForMs(path string, now epoch.Millis) (int64, bool)
  func Acquire(path string) (bool, error)
  func Release(path string) error

  package status
  type Bucket struct { UsedFraction *float64; ResetsAt *string }
  type Account struct { Name string; Org, Status *string; Sessions float64; Disabled, Current bool; LastUsedAt *string; FableEligible *bool; FableTarget bool; Buckets struct{ Session, General, Fable Bucket }; SwitchThresholds *teamclaude.Thresholds; Headroom *ledger.Cost `json:"headroom,omitempty"` }
  func AccountsFrom(s teamclaude.Status) []Account
  type Evaluation struct { Program control.Program; Decision decide.Decision; Pid *int }
  type ServiceInput struct { State service.State; LastTickAt *epoch.Millis; LockHolder *service.LockHolder }
  type Input struct { Control control.Control; StoredMode control.Mode; Status teamclaude.Status; Cycles []ledger.Cycle; Now epoch.Millis; Evaluations []Evaluation; Service ServiceInput }
  func Build(in Input) (Payload, error)
  type Payload struct { … }   // one struct per TS object literal, fields in literal order, see Step 3
  ```

- [ ] **Step 1: Write the failing tests**

`internal/lock/lock_test.go`:
```go
package lock

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyBarePidIsHeldWithUnknownAge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	os.WriteFile(path, []byte("76410"), 0o644) // a pid that is not alive here
	if _, held := HeldBy(path); held {
		t.Fatal("dead legacy pid read as held")
	}
	os.WriteFile(path, []byte(itoa(os.Getpid())), 0o644)
	h, held := HeldBy(path)
	if !held || h.Pid != os.Getpid() || h.At != nil {
		t.Fatalf("%+v %v", h, held)
	}
	if _, ok := HeldForMs(path, 0); ok {
		t.Fatal("unknown age must be unknown, never 0")
	}
}

func TestAcquireRefusesLiveHolderAndReleasesOwn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	ok, err := Acquire(path)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, _ := Acquire(path); ok {
		t.Fatal("acquired a lock this process holds")
	}
	if ms, ok := HeldForMs(path, 1<<62); !ok || ms <= 0 {
		t.Fatal(ms, ok)
	}
	if err := Release(path); err != nil {
		t.Fatal(err)
	}
	if _, held := HeldBy(path); held {
		t.Fatal("released lock still held")
	}
	os.WriteFile(path, []byte(`{"pid":1,"at":5}`), 0o644)
	Release(path) // not ours: must stay
	if _, err := os.Stat(path); err != nil {
		t.Fatal("released someone else's lock")
	}
}

func TestGarbageIsUnheld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	for _, body := range []string{"", "   ", "{nope", `{"pid":"x","at":1}`, "-3", "1.5"} {
		os.WriteFile(path, []byte(body), 0o644)
		if _, held := HeldBy(path); held {
			t.Errorf("%q read as held", body)
		}
	}
}
```
(`itoa` is `strconv.Itoa`.) `isAlive` is `syscall.Kill(pid, 0)`: `nil` or `EPERM` → alive, `ESRCH` → dead, else the error propagates — `HeldBy` returns not-held on it as the TS would throw; make `HeldBy` return `(Held, bool)` and log nothing: the TS throws, and that path has never fired; carry a `ruling` in the ledger that an unexpected `kill` errno reads as held, the conservative direction.

`internal/service/service_test.go` and `internal/status/status_test.go` replay the `describeService`, `serviceHealth`, `accountsFromTeamclaude` and `buildStatusPayload` fixtures with the same decode-then-`fixtures.Equal` shape as Task 7, decoding `evaluations[].program` through `control` (the recorded program is a full TS `Program`; decode it with a `parseProgram` exposed as `control.ParseProgram(raw json.RawMessage) (Program, error)`), `evaluations[].decision` straight into `decide.Decision`, and `service.state`/`lockHolder` into the structs. Plus one hand test per package:
```go
func TestDescribeWedged(t *testing.T) {
	iv := 600
	last := epoch.Millis(0)
	held := int64(25 * 60_000)
	got := Describe(State{Installed: true, Loaded: true, IntervalSeconds: &iv}, &last, 2_000_000, &LockHolder{Pid: 42, HeldMs: &held})
	want := "loaded and fires every 600s. Last tick completed 33 minutes ago — that is overdue for a 600s interval, so the agent may be stalled. A live process still holds the tick lock (pid 42, held 25m), so ticks are being skipped rather than not firing. Fix: kill 42"
	if got != want {
		t.Fatalf("\n got %q\nwant %q", got, want)
	}
}
```
and for `status`, a `Build` over an `Input` with mode `off` asserting `pool`, `capacity`, `capacityNote`, `allocation` all marshal as `null` and `modeMeaning == "no cycles will start"`.

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/service/ ./internal/lock/ ./internal/status/` → FAIL.

- [ ] **Step 3: Implement**

`service.go`: `StateFor` runs `launchctl list <label>` through `exec.RunBounded` with a 10 s bound (the TS `execFileSync` had none; a bound here is the one allowed deviation, named `LAUNCHCTL_TIMEOUT`); any error → `Loaded: false`. `numberFrom` is the same regexp; `intervalFromPlist` the same. `Describe` and `HealthOf` verbatim, with `homedir()/.drovr/logs/tick.err` from `os.UserHomeDir()`.

`status/payload.go`: one exported struct per literal with json tags in literal order:
`Payload{GeneratedAt string; Service ServicePayload; Mode control.Mode; ModeFromPhone bool; ModeMeaning string; PausedUntil *string; Paused bool; Pool *PoolPayload; Capacity *FundingPayload; CapacityNote *string; Allocation *AllocationPayload; EstimatedCycleCost CostPayload; InFlight []InFlightPayload; Accounts []Account; AccountsUnits string; ConcurrencyCap float64; Programs []ProgramPayload}` — and the nested ones: `ServicePayload{Health, Explanation string; LastTickAt *string; IntervalSeconds *int}`, `PoolPayload{Fable, General, Session float64; UsableAccounts int; ResetAt struct{Fable, General, Session *string}; EarliestRecoveryAt *string; Units string}`, `FundingPayload{CyclesFundable *float64; BindingBucket capacity.Bucket; FundingAccounts int; PerAccount []PerAccountPayload; Units string}`, `PerAccountPayload{Name string; CyclesFundable *float64; BindingBucket capacity.Bucket; RoutableForFable bool}`, `AllocationPayload{Fable, General, Session allocation.Allocation; Units string}`, `CostPayload{Fable, General, Session float64; Units string}`, `InFlightPayload{Program, StartedAt, Kind string}`, `ProgramPayload{Name, Cwd string; Host *control.Host; Enabled bool; Priority, EffectivePriority float64; Deadline *string; Verdict decide.Verdict; VerdictMeaning, Reason string; PoolNote *string; BindingBucket *capacity.Bucket; CyclesFundable *float64; RecoversAt *string; RunningPid *int}`. The `units` strings are copied byte for byte (they contain `’`). `roundFinite` → `nil` for `±Inf`.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/... && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/service internal/lock internal/status internal/control
git commit -m "feat(go): service state and its prose, the pid+timestamp lock with the bare-pid branch, and the status payload field for field; fixtures green"
```

---

### Task 10: `internal/help` and the dispatcher's help paths

**Files:**
- Create: `internal/help/help.go`, `internal/help/registry.go`, `internal/help/help_test.go`
- Modify: `main.go`
- Port from: `src/help.ts`

**Interfaces:**
- Produces:
  ```go
  package help
  type Flag struct { Flag, Describes string }
  type Command struct { Name, Usage, Summary string; Details []string `json:"details,omitempty"`; Flags []Flag `json:"flags,omitempty"`; Examples []string `json:"examples,omitempty"`; Writes string `json:"writes,omitempty"`; Blocking bool `json:"blocking,omitempty"` }
  var Overview string
  var AgentNotes = Notes{…}     // struct with json tags json, exitCodes, stateFiles, verdicts, exitReasons, gotchas
  var Commands []Command
  func Find(name string) (Command, bool)
  func RenderList() string
  func RenderCommand(c Command) string
  type Tree struct { Tool string `json:"tool"`; Overview string `json:"overview"`; UsingThis Notes `json:"usingThis"`; Commands []Command `json:"commands"` }
  func TreeOf() Tree
  ```
  `Blocking` is `true` in TS (`blocking?: true`); JSON `true` or absent — `omitempty` on a bool gives exactly that. `Details` absent vs present-empty: the TS never has an empty array, so `omitempty` is safe.

- [ ] **Step 1: Write the failing tests**

```go
package help

import (
	"os/exec"
	"strings"
	"testing"
)

func TestEveryCommandRenders(t *testing.T) {
	if len(Commands) != 23 {
		t.Fatalf("%d commands, the TS registry has 23", len(Commands))
	}
	for _, c := range Commands {
		out := RenderCommand(c)
		if !strings.HasPrefix(out, c.Usage+"\n\n  "+c.Summary) || !strings.Contains(out, "\nWrites: ") {
			t.Errorf("%s renders badly:\n%s", c.Name, out)
		}
	}
	if _, ok := Find("add"); !ok {
		t.Fatal("add missing")
	}
}

func TestListMatchesOracle(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	want, err := exec.Command(node, "../../src/cli.ts", "help").Output()
	if err != nil {
		t.Skip("TS tree absent")
	}
	if got := RenderList() + "\n"; got != string(want) {
		t.Fatalf("list differs from the Node CLI:\n%s", diffLines(got, string(want)))
	}
}
```
`diffLines` is a 10-line helper in the test file printing the first differing line of each.

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/help/` → FAIL.

- [ ] **Step 3: Implement**

`registry.go` is `COMMANDS`, `OVERVIEW` and `AGENT_NOTES` transcribed. Do it mechanically: a one-off `node -e` that prints `helpTree()` as JSON, pasted and reshaped into Go literals — never retyped. `help.go` ports `renderList`, `renderCommand` (`padEnd` is `fmt.Sprintf("%-*s", width, s)`), `Find`, `TreeOf`.

`main.go` gains:
```go
json := contains(rest, "--json")
if len(args) > 0 && contains(rest, "--help") { if _, ok := help.Find(args[0]); ok { return showHelp(stdout, &args[0], json) } }
if cmd == "help" || cmd == "--help" || cmd == "-h" { return showHelp(stdout, firstNonFlag(rest), json) }
```
with `showHelp` encoding `help.TreeOf()` (or the found command) through `json.NewEncoder` + `SetEscapeHTML(false)` + `SetIndent("", "  ")`, or printing `RenderList`/`RenderCommand`; an unknown topic is `fmt.Errorf("no command named %q — run `drovr help` for the list", topic)` (the TS uses straight double quotes around the name: `no command named "x"`; match that, not `%q`'s escaping — use `"\"" + topic + "\""`). Running `drovr` with no arguments prints the list and exits 0 — verified against the TS on 2026-10-22: `cli.ts`'s fall-through prints `''` to stderr, `renderList()` to stdout, and sets exit 1 only when a command was given. An unknown command prints `unknown command "<cmd>"` plus a blank line to stderr, the list to stdout, exit 1. In E1 an unknown-but-registered command is still `notPorted`; an unregistered one gets the TS treatment.

- [ ] **Step 4: Run tests, vet, fmt, oracle**

Run: `go test ./internal/help/ && go build -o /tmp/drovr-go . && /tmp/drovr-go help --json > /tmp/go.json && node src/cli.ts help --json > /tmp/ts.json && diff /tmp/go.json /tmp/ts.json && echo SAME`
Expected: PASS and `SAME`. Also `/tmp/drovr-go add --help | diff - <(node src/cli.ts add --help)` empty.

- [ ] **Step 5: Commit**

```bash
git add internal/help main.go
git commit -m "feat(go): the help registry, byte-identical to the Node CLI in all four renderings"
```

---

### Task 11: `drovr status`, `drovr status --json`, the conformance harness

**Files:**
- Create: `internal/cli/status.go`, `internal/cli/status_test.go`, `conformance_test.go` (package `main`), `testdata/home/control.json`, `testdata/home/cycles.jsonl`, `testdata/home/last-tick.json`, `testdata/bin/teamclaude`, `testdata/bin/launchctl`, `testdata/teamclaude-status.json`
- Modify: `main.go`
- Port from: `src/cli.ts` (`evaluateAll` minus asks and runner probes, `statusPayload`, `describeFunding`, `showStatus`, `tickLockHolder`, `round`)

**Interfaces:**
- Produces:
  ```go
  package cli
  type Env struct { Paths paths.Paths; Now func() epoch.Millis; Stdout, Stderr io.Writer; TeamclaudeBin string }
  func Status(ctx context.Context, env Env, json bool) error
  func EvaluateAll(control control.Control, status teamclaude.Status, cycles []ledger.Cycle, now epoch.Millis, lockPid func(string) *int) ([]status.Evaluation, error)
  ```
  In E1 `EvaluateAll` passes `AnsweredAt: nil`, `AsksShared: nil`, `RunnerPresent: nil` for every program — asks and orca are E2, and `nil` is the TS's `undefined`, which never refuses. The phone's Away (`phonePrefs`) is also E2; `StoredMode == Control.Mode` until then. The oracle fixture therefore has `notifyTo: null` and programs with neither `aice` nor `asksFile`, so the Node CLI takes the same `undefined` paths.

- [ ] **Step 1: Build the oracle fixture**

`testdata/home/control.json`: three programs (`alpha` priority 0, `beta` priority 1 with `cadence: "12h"`, `gamma` disabled), `mode: "normal"`, `notifyTo: null`, everything else default. `testdata/home/cycles.jsonl`: eight records — two finished `alpha` deliveries (`seam`, `context`) with pool deltas, one `beta` cycle ended `blocked` 30 minutes before the fixture's "now" is irrelevant since `now` is live: use `endedAt` far in the past (2026-01-01) so backoffs and caps have lapsed and the `12h` cadence window is open; one start record with no end from 2026-01-01 so `inFlight`'s 12 h cutoff drops it. `last-tick.json`: `{"at":"2026-01-01T00:00:00.000Z"}`. `testdata/teamclaude-status.json`: three accounts with resets in **2030** (so `untilText` says `Nd` with the same N for years) and one route `fable` with one ineligible account. `testdata/bin/teamclaude`: `#!/bin/sh\ncat "$(dirname "$0")/../teamclaude-status.json"`. `testdata/bin/launchctl`: `#!/bin/sh\nexit 1` (not loaded). `chmod +x` both.

- [ ] **Step 2: Write the failing conformance test**

`conformance_test.go`:
```go
package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
)

var generatedAt = regexp.MustCompile(`"generatedAt": "[^"]+"`)

func oracle(t *testing.T) (node string, env []string) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	if _, err := os.Stat("src/cli.ts"); err != nil {
		t.Skip("TS tree absent")
	}
	bin, _ := filepath.Abs("testdata/bin")
	home, _ := filepath.Abs("testdata/home")
	return node, append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "DROVR_HOME="+home)
}

func runBoth(t *testing.T, args ...string) (goOut, tsOut string) {
	node, env := oracle(t)
	g := exec.Command("go", append([]string{"run", "."}, args...)...)
	g.Env = env
	gb, err := g.CombinedOutput()
	if err != nil {
		t.Fatalf("go: %v\n%s", err, gb)
	}
	n := exec.Command(node, append([]string{"src/cli.ts"}, args...)...)
	n.Env = env
	nb, err := n.CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, nb)
	}
	return string(gb), string(nb)
}

func TestStatusJSONMatchesOracle(t *testing.T) {
	g, n := runBoth(t, "status", "--json")
	g, n = generatedAt.ReplaceAllString(g, ""), generatedAt.ReplaceAllString(n, "")
	if g != n {
		var gv, nv any
		json.Unmarshal([]byte(g), &gv)
		json.Unmarshal([]byte(n), &nv)
		t.Fatalf("status --json differs\n--- go\n%s\n--- node\n%s", g, n)
	}
}

func TestStatusTextMatchesOracle(t *testing.T) {
	g, n := runBoth(t, "status")
	if g != n {
		t.Fatalf("status differs\n--- go\n%s\n--- node\n%s", g, n)
	}
}

func TestHelpJSONMatchesOracle(t *testing.T) {
	for _, args := range [][]string{{"help", "--json"}, {"help"}, {"help", "status"}, {"status", "--help", "--json"}} {
		g, n := runBoth(t, args...)
		if !bytes.Equal([]byte(g), []byte(n)) {
			t.Fatalf("%v differs\n--- go\n%s\n--- node\n%s", args, g, n)
		}
	}
}
```
The text `status` output contains `Last tick completed 5234h12m ago`-style minutes that tick over once a minute; both CLIs run within the same second nearly always. If the test flakes on a minute boundary, rerun it — do not normalise it away, since that line is a port target.

- [ ] **Step 3: Run, watch it fail** — `go test -run Oracle . -count=1` → FAIL: `drovr status is not ported to Go yet`.

- [ ] **Step 4: Implement**

`internal/cli/status.go`: `Status` reads control (`control.Read`), status (`teamclaude.Read` with `env.TeamclaudeBin`), cycles, `now`, `lastTickAt` from `ReadTickStamp` else `LastDecisionAt`, `service.Current()`, the tick-lock holder via `lock.HeldBy(env.Paths.TickLock)`; then `EvaluateAll` (ordered by `control.ByPriority`, the `projected` start record appended on every `GO` of an enabled program exactly as `cli.ts` does, `pid` from `lock.Holder(env.Paths.ProgramLock(name))`); then either `status.Build` encoded with the indent-2 encoder, or the text block ported line for line from `showStatus` (`describeFunding`, the `pool:` line with `toFixed(2)`, the cost line with `toFixed(3)`, `cycles recorded`, `in flight`, the per-program `[p<n>] name[flags]: VERDICT — reason` with the `runs on` line for a host). `main.go` routes `status` to it.

- [ ] **Step 5: Run everything**

Run: `go test ./... -count=1 && go vet ./... && gofmt -l . && node --test test/*.spec.ts 2>&1 | tail -3`
Expected: all `ok`, including the three oracle tests; TS still `pass 593`.

- [ ] **Step 6: Commit**

```bash
git add internal/cli main.go conformance_test.go testdata/home testdata/bin testdata/teamclaude-status.json
git commit -m "feat(go): drovr status and status --json, identical to the Node CLI on the same DROVR_HOME; the oracle harness"
```

---

### Task 12: CLAUDE.md and README notes for a tree with two implementations

**Files:**
- Modify: `CLAUDE.md` (Conventions), `README.md` (one paragraph under Install)

- [ ] **Step 1: CLAUDE.md**

Under "Conventions", add:
```
- **Two implementations live here until the Go port cuts over** (spec `docs/superpowers/specs/2026-10-22-go-port-design.md`).
  `src/` is what launchd runs. `internal/` is the Go port, one package per TS module. The TS is the oracle:
  `scripts/record-fixtures.sh` replays the TS suite with `DROVR_RECORD` set and writes `testdata/recorded/`,
  which the Go tests read; `conformance_test.go` diffs the two CLIs on `testdata/home`. A behaviour change
  lands in the TS first, with its test, then `scripts/record-fixtures.sh`, then the Go — never the Go alone,
  and never a hand-edited fixture. Gates: `go test ./... && go vet ./... && gofmt -l .` beside `pnpm check-types`.
```

- [ ] **Step 2: README**

Under Install, after the existing block: "A Go build of drovr is in progress (`go build .`); it is not yet what the service runs. The install above is the one that works today."

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: how the TS and Go trees relate until cut-over — the TS is the oracle, fixtures are recorded never written"
```

---

## Self-review

**Spec coverage (E1 = phases 1 and 2):** skeleton (T1), read side — control (T3), ledger (T5), teamclaude (T4), help (T10), `status --json` (T11); decision core — capacity (T6), decide (T7), allocation (T8), pricing and charging (T5), `priorityRank`/`applyAwayMode` (T3); fixtures (T2) and the oracle (T11); conventions (T12). `service` and `lock` read sides came forward from phase 3 because `status --json` cannot be built without them; their write sides (plist, install, acquire-in-tick) stay in E2/E3. `exec.RunBounded` came forward for the same reason (teamclaude read).

**Placeholders:** none. Every TS string the Go must reproduce is named by its TS function, and the fixtures hold the expected values.

**Type consistency:** `control.Cost` is the one cost type (`ledger.Cost` aliases it) to avoid a `ledger → control → ledger` cycle; `capacity.Bucket` replaces `allocation.BucketName`; `epoch.Millis` is `int64` everywhere except `SpentSince`'s `windowStart`, ruled `float64` in Task 7 (apply it in Task 5 when executing in order: make the parameter `float64` there and in its test from the start). `decide.Cycles` carries the `Infinity` sentinel both ways.

**Review Focus → tests:** 1 → Task 3 `TestParseDefaults`/`TestParseStripsUnknownAndKeepsNullPause`; 2 → Task 4 `TestEpochCoercion`; 3 → Task 5 `TestReadCyclesRefusesByLine`/`TestStartRecordDefaults`; 4 → Task 7 `TestEveryAccountPinnedNamesSoonestReset` plus fixtures; 5 → Task 10 oracle diff and Task 11 `TestStatusJSONMatchesOracle`.
