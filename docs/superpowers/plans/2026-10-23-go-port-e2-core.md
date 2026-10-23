# Go port E2: shared decoder, adapters, run-cycle and tick, the shadow tick — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Go `drovr` binary that runs the unattended half of drovr (`tick`, `run-cycle`, `report`, `notify`, `service`) against real orca, teamclaude, hey, aice and ssh through the same files as the Node service, plus `drovr tick --shadow` under its own launchd label and a diff of the two decision logs, so E3 can cut over on a clean day.

**Architecture:** Same rule as E1: one package per TS module under `internal/`, same names, same file formats. Pure halves get table tests mirroring the TS specs. Subprocess adapters are proven against shim scripts on a test `PATH` (`orca`, `teamclaude`, `launchctl`, `direnv`, `ssh`), never mocks. hey's HTTP is proven the way the hey repo proves it: an injected `httpDo` plus one `httptest.Server` round trip. The tick and the `run-cycle` worker are proven end to end in a temp `DROVR_HOME` with a stub binary standing in for the detached worker. The recorded fixtures (E1) cover the pure core and must stay green through Task 1's refactor. Nothing in this plan replaces the live Node service; installing the shadow label is Craig's act.

**Tech Stack:** Go 1.26, standard library only (`os/exec` inside `internal/exec` alone, `net/http`, `net/http/httptest`, `crypto/rand`, `go/parser` for one guard test). `golang.org/x/term` stays out until E3.

**Spec:** `docs/superpowers/specs/2026-10-22-go-port-design.md` (phases 3 and 4, "Porting rules", "Conformance" layer 3). **Builds on:** `docs/superpowers/plans/2026-10-22-go-port-e1-core.md` (done, merged).

## Global Constraints

- A port, not a rewrite: no behaviour change, however small. Where the TS is odd, the Go is odd the same way. The only deviations are the ones named in a task's "Rulings" line, each of which bounds something the TS left unbounded or exists only for the shadow run.
- Every zod boundary decodes through `internal/shape` (Task 1): strict where zod was strict (cycle report, orca envelopes and `terminal show`, hey wire), stripping where zod stripped (control, teamclaude, ledger, usage), lenient where the TS was a scrape (`readAsks`, preview, transcript, profile). Error text names the field path.
- `absent` and `null` differ only where the TS says so: `agentIdentity` absent or null is *gone*; `title` null is allowed; `agentWait` present-and-non-null is *blocked*, anything else is not. Optional fields are pointers.
- Every timeout is a named constant beside its caller, copied from the TS: `orcaTimeout` 20 s, `idleProbe` 1.5 s, `agentStartTimeout` 90 s, `promptSubmitWaitS` 10, `direnvTimeout` 30 s, `notesTimeout` 20 s, `sshTimeout` 20 s, `wakeTimeout` 6 min, hey's `callTimeout` 15 s, `pollInterval` 30 s, `maxPollFailures` 20.
- `exec.RunBounded` and `exec.Detach` are the only spawns. Task 2 adds a test that fails on an `os/exec` import anywhere else.
- Staged through a rename exactly where the TS staged: `control.json` via `keys`, `last-cycle.json` via `drovr report`, the usage prune, the hey credentials file (0600). Written in place exactly where the TS wrote in place: `cycle-terminal.json`, `current-cycle.json`, `nudged.json`, `profile-seeded.json`, `tick-failure.json`, `last-tick.json`, and `cli.ts`'s own `mutate` (used by `report`).
- `Date` is `epoch.Millis`; ISO strings via `epoch.ISO`; `Math.round` via `jsnum.RoundHalfUp`; `String.prototype.slice(0, n)` via `jsnum.Slice` (UTF-16 code units, Task 2).
- JSON out through an encoder with `SetEscapeHTML(false)`; JSONL lines through `ledger.AppendRecord` (one `O_APPEND` write per line). `JSON.stringify(Infinity)` is `null`, so a decision line's `cyclesFundable` is `null` when infinite — never the recorder's `"Infinity"` string (Task 15).
- `tick` and `run-cycle` stamp every diagnostic line with `<ISO> ` exactly as `cli.ts`'s `stampConsole` does (Task 2's `epoch.Stamped`); each message is one `Fprintln`. No other command stamps.
- Never swallow an error, except where the TS documents a swallow. Each such site carries a `// swallowed:` comment naming the TS reason. The full list: the usage sample and the status publish in the tick; `readReportOrWarn`; `textCraig`, `publishStatus`, `phonePrefs` (best-effort sends); `readAsks`'s notes failure (null); `aiceBaseUrl` (null); `runnerAddress` and `terminalAddress` (bare handle); an unreadable `cycle-terminal.json` (null, logged); `terminal list` during adoption (null); the `/exit` send in `releaseAgent`; `releaseRunner` inside `releaseFinished`/`abandonStalled` (false); the profile seed; an unreadable transcript (null, logged); a failed nudge send and a failed blocked-alert send in the watch (logged).
- Functions stay under 60 lines and two nesting levels; every loop has a named cap.
- `go test ./... -count=1`, `go vet ./...` clean, `gofmt -l .` empty, and the TS suite still `node --test test/*.spec.ts` green after every task.
- `--shadow` (on `tick` and on `service install`) is port tooling that E3 deletes with the shadow label, so it is **not** in the help registry: `help --json` is an oracle target and a flag the Node CLI lacks would break it.
- E1 rulings carried in: `lock.HeldBy` returns an error and an unreadable lock is never free; `jsnum.ToFixed` handles non-finite; `ledger.SpentSince` takes a `float64` window start; `decide.Input.RunnerPresent` is `*bool` with nil meaning unknown.
- Names are kept. `textCraig` is `TextCraig`, `runnerIsPresent` is `RunnerIsPresent`: a trap row that names a TS function must find its Go twin by the same word.

## Review Focus

1. **orca answering a refusal with exit 0 and with exit 1, and answering garbage.** Both envelopes are read (the second out of `ExitError.Stdout`); garbage is an error naming the command, never *gone*. → Task 4 `TestRefusalIsReadWhateverTheExitCode`, `TestGarbageIsAnErrorNotGone`.
2. **A report caught mid-write, a complete report with the wrong shape, and an unreadable one beside an abandoned record.** Poll: torn is "not yet", wrong shape throws; tick: logged and read as absent, the pass carries on to admission. → Task 13 `TestPollLeniency`, Task 15 `TestMalformedLateReportDoesNotStopTheTick`.
3. **A decision whose `cyclesFundable` is infinite (a bucket costing nothing).** The decision line carries `null`, as `JSON.stringify` writes, not `"Infinity"`. → Task 15 `TestDecisionRecordWritesInfinityAsNull`.
4. **`control.json` rewritten by a Go key press.** Key order, number text and `null`s come back exactly as `JSON.stringify(raw, null, 2)` writes them, so a Node reader and a `git diff` see only the edited field. → Task 9 `TestMutateKeepsKeyOrderAndNodeFormatting`.
5. **A shadow tick facing an idle, reported leftover runner and an orphaned cycle.** It decides as the live tick would but sends no `/exit`, closes no terminal, appends nothing to `cycles.jsonl`, writes no `decisions.jsonl`, stamps nothing. → Task 16 `TestShadowDecidesLikeLiveAndTouchesNothing`.

## Trap ledger

Every CLAUDE.md trap row for a module this plan ports, and where it is pinned. Rows for E1 modules (`decide`, `capacity`, `ledger` pricing, `control`, `lock`, `teamclaude`, `allocation`) were closed in E1.

| Row | Pinned by |
|---|---|
| `exec.ts` only spawn through `runBounded` | Task 2 `TestOnlyExecSpawns` |
| `exec.ts` original error kept | E1 `TestRunBoundedKeepsOriginalFailure`; Task 4 reads orca's envelope out of it |
| `orca.ts` one terminal per program, leftover cleared before create | Task 4 `TestStartClearsTheLeftoverFirst` |
| `orca.ts` stale handle re-resolved by tab id | Task 3 `TestAdoptHandleByTabID`, Task 4 `TestRunnerTerminalAdoptsAndRewrites` |
| `orca.ts` refusal = envelope on stdout and non-zero exit | Task 4 `TestRefusalIsReadWhateverTheExitCode` |
| `orca.ts` `agentIdentity` absent = gone; `title` null; shape error names the path | Task 3 `TestAgentStateFrom`, `TestShapeErrorNamesThePath` |
| `orca.ts` tui-idle settles on a dialog; identity, then idle, then exactly `idle` | Task 4 `TestStartBehindADialogIsPaneBusy` |
| `orca.ts` exited pty still named by `show`; `wait --for exit` first | Task 3 `TestAgentStateFrom` (exited row), Task 4 `TestAgentStateProbesExitBeforeIdle` |
| `orca.ts` never types into a shell; `--command` | Task 4 `TestStartCreatesWithCommandAndPrompts` |
| `orca.ts` `--model fable` in argv | Task 13 `TestLaunchArgv` |
| `orca.ts` `PaneBusy` is not a crash | Task 14 `TestPaneBusyIsDeferred` |
| `orca.ts` `/exit` only to a settled agent | Task 4 `TestReleaseRefusesAWorkingRunner` |
| everywhere: a handle is not an address | Task 3 `TestTerminalAddress`, Task 4 `TestRunnerAddressNamesTheTab` |
| `cycle.ts` interactive session cannot end itself; release on report | Task 14 `TestWorkerRunsACycleEndToEnd` |
| `cycle.ts` idle without report is stalled; bounded nudges | Task 13 `TestStallAction`, Task 14 `TestStalledRunnerIsGivenUpOn` |
| `cycle.ts` `maxCycleHours` bounds the watch → `abandoned` | Task 14 `TestDeadlineIsAbandonedNotCrash` |
| `cycle.ts` one failed poll must not end the watch | Task 14 `TestPollFailuresAreCountedThenAbandoned` |
| `cycle.ts` blocked: never nudged, never silent | Task 13 `TestStallAction` (blocked rows) |
| `cycle.ts` `last-cycle.json` one blessed writer; poll lenient | Task 13 `TestWriteReportIsStagedAndRoundTrips`, `TestPollLeniency` |
| `tick.ts` watchdog: holder kills itself, release first | Task 15 `TestOverrun*` |
| `tick.ts` runner outlives watcher (reattach / close / skip) | Task 15 `TestOrphanActionAndDuration`, `TestTickClosesAnOrphanAsAbandoned` |
| `tick.ts` `reconcileLateReports` before admission | Task 15 `TestTickSupersedesAnAbandonedCycle` |
| `tick.ts` neither report read may throw | Task 15 `TestMalformedLateReportDoesNotStopTheTick` |
| `tick.ts` idle is not done (`leftoverAction`) | Task 3 `TestSettledAndLeftoverAction`, Task 4 `TestIgnoredExitIsRememberedSoItIsNeverSentTwice`, Task 16 shadow test |
| `tick.ts` usage sample logged and swallowed, last | Task 15 `TestUsageFailureDoesNotFailTheTick` |
| `tick.ts` status publish after admission, `lockHolder` null, no second probe | Task 15 `TestAwayIsAppliedNotWritten` (asserts the published payload) |
| `tick.ts` a throwing tick is an outage (marker, once per episode) | Task 15 `TestFailedTickMarksTheEpisodeOnce` |
| `tick.ts` phone Away never written | Task 15 `TestAwayIsAppliedNotWritten` |
| `tick.ts` same-pass launches folded into `running` | Task 15 `TestEveryGOLaunchesExactlyOnce` |
| `tick.ts` pace/reservations global, caps per program | decide-level, E1 fixtures; the tick passes every program's cycles (Task 15) |
| `asks.ts` notes off returns nothing; lenient | Task 5 `TestFromNotes` |
| `asks.ts` every aice call bounded | Task 5 `TestNotesCallIsBoundedAndNamed` |
| `nudge.ts` `textCraig` bounded | hey `callTimeout` 15 s (Task 6 copied tests) |
| `nudge.ts` `from` required | not applicable in Go: there are no default parameters; `from` is a required positional `string`. `AlertFrom` tested in Task 7 |
| `nudge.ts` `publishStatus` builds its caller inside the guard | Task 7 `TestPublishStatusMalformedConfigIsAReason` |
| `hey-http.ts` 401 retried once after one refresh | Task 6 copied `TestToolCallerRetriesOnceOn401ThenGivesUp` |
| `hey-http.ts` credentials renamed, 0600, refresh grace | Task 6 copied `TestCredentialsFileRoundTripBytesAndMode` |
| `state.ts` `onWarning` sink is the caller's | Task 11 `TestCollectRequiresASink` |
| `state.ts` probe window defaults to fresh; cheap half always re-read | Task 11 `TestProbesReusedOnlyInsideTheWindow` |
| `state.ts` `runnerIsPresent`, not `agentState` | Task 11 `TestCollectNeverProbesIdle` |
| `usage.ts` records and reads, feeds no gate | structural: only `tick` and (E3) `cli` import `usage` |
| `usage.ts` bounded by bytes, newest half, staged | Task 8 `TestAppendBoundsTheLog` |
| `keys.ts` ceilings ordered on every write | Task 9 `TestSetReserveKeepsCeilingsOrdered` |
| `keys.ts` one code path, not one process | not applicable as a test: no lock is built, by the row's own instruction |
| `service.ts` launchd holds the loaded plist; install reloads | Task 10 `TestInstallReloadsALoadedAgent` |
| `profile.ts` lenient reader; seed after the terminal is up | Task 12 `TestFromRepo`, Task 14 `TestWorkerRunsACycleEndToEnd` (call order) |
| `preview.ts` lenient scrape | Task 3 `TestPreviewParse` |
| `transcript.ts` (closing) scrape | Task 12 `TestClosingFrom` |

---

### Task 1: `internal/shape`, `control.Bucket` and `Cost.Of`

The E1 final review's ruling: the three near-copies of the mini-zod decoder (`control/parse.go`, `teamclaude/teamclaude.go`, `ledger/ledger.go`) become one, and the three `costOf` switches become one accessor. Behaviour is unchanged; the existing tests and every recorded fixture are the proof.

**Files:**
- Create: `internal/shape/shape.go`, `internal/shape/shape_test.go`
- Modify: `internal/control/parse.go` (delete `decoder`, `newDecoder`, `orRoot`, `at`, `fail`, `present`, `check`, `isNull`, `into`, `required`, `optional`, `nullable`), `internal/control/control.go` (add `Bucket`, `Buckets`, `Cost.Of`), `internal/control/control_test.go`, `internal/teamclaude/teamclaude.go` (delete its decoder block, lines ~185–303), `internal/ledger/ledger.go` (delete `fields`, `objectOf`, `isNull`, `into`, `required`, `nullableRequired`, `nullableDefault`, `optional`, `oneOf`, `prefixed`, `firstErr`, `nested`), `internal/capacity/capacity.go` (alias), `internal/decide/decide.go` (drop `costOf`, `bucketIndex`), `internal/allocation/allocation.go` (drop `costOf`)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  ```go
  package shape
  // Object is one JSON object decoded field by field in the zod schema's order. The first
  // refusal is kept in Err and every later step is skipped; unknown keys are stripped.
  type Object struct { Err error /* fields, path unexported */ }
  func Decode(raw json.RawMessage, path string) (*Object, error) // "<path>: expected object, received null" | "<path>: expected object: <why>"; path "" prints "(root)"
  func IsNull(raw json.RawMessage) bool
  func OrRoot(path string) string
  func (o *Object) At(key string) string                    // "key" at the root, "path.key" below it
  func (o *Object) Fail(err error)                          // keeps the first non-nil
  func (o *Object) Check(key string, ok bool, why string)   // "<at>: <why>" when !ok
  func (o *Object) Present(key string) (json.RawMessage, bool) // present and not null
  func Required[T any](o *Object, key string, dst *T)         // absent or null → "<at>: required"
  func RequiredNullable[T any](o *Object, key string, dst *T) // absent → required; null → zero value
  func Optional[T any](o *Object, key string, dst *T)         // absent keeps default; null → "<at>: expected a value, received null"
  func NullableDefault[T any](o *Object, key string, dst *T)  // absent or null keeps default
  func Each[T any](o *Object, key string, raw json.RawMessage, parse func(json.RawMessage, string) (T, error)) []T // "<at>[i]" paths
  func OneOf[T ~string](o *Object, key string, value T, allowed []T) // "<at>: invalid enum value \"v\", expected a | b"

  package control
  type Bucket string
  var Buckets = []Bucket{"fable", "general", "session"}
  func (c Cost) Of(b Bucket) float64 // panics on an unknown bucket, as decide.costOf did

  package capacity
  type Bucket = control.Bucket
  var Buckets = control.Buckets
  ```
  Type-mismatch text stays `"<at>: " + json's own message` (e.g. `programs[0].count: json: cannot unmarshal string into Go value of type float64`), as all three decoders wrote it.

- [ ] **Step 1: Write the failing tests**

`internal/shape/shape_test.go`:
```go
package shape

import (
	"encoding/json"
	"strings"
	"testing"
)

type sample struct {
	Name  string
	Count float64
	Note  *string
	Reset *float64
	Kind  string
}

func decodeSample(raw string) (sample, error) {
	o, err := Decode(json.RawMessage(raw), "programs[0]")
	if err != nil {
		return sample{}, err
	}
	s := sample{Count: 8, Kind: "orca"}
	Required(o, "name", &s.Name)
	Optional(o, "count", &s.Count)
	NullableDefault(o, "note", &s.Note)
	RequiredNullable(o, "reset", &s.Reset)
	Optional(o, "kind", &s.Kind)
	OneOf(o, "kind", s.Kind, []string{"orca", "headless"})
	return s, o.Err
}

func TestFieldRules(t *testing.T) {
	s, err := decodeSample(`{"name":"a","reset":null,"extra":1}`)
	if err != nil || s.Name != "a" || s.Count != 8 || s.Note != nil || s.Reset != nil || s.Kind != "orca" {
		t.Fatalf("%+v %v", s, err)
	}
	cases := map[string]string{
		`{"reset":1}`:                         "programs[0].name: required",
		`{"name":null,"reset":1}`:             "programs[0].name: required",
		`{"name":"a"}`:                        "programs[0].reset: required",
		`{"name":"a","reset":1,"count":null}`: "programs[0].count: expected a value, received null",
		`{"name":"a","reset":1,"count":"x"}`:  "programs[0].count: json: cannot unmarshal string",
		`{"name":"a","reset":1,"kind":"vm"}`:  `programs[0].kind: invalid enum value "vm", expected orca | headless`,
		`null`:                                "programs[0]: expected object, received null",
		`[1]`:                                 "programs[0]: expected object:",
	}
	for in, want := range cases {
		if _, err := decodeSample(in); err == nil || !strings.HasPrefix(err.Error(), want) {
			t.Errorf("%s: err = %v, want prefix %q", in, err, want)
		}
	}
}

func TestFirstRefusalWins(t *testing.T) {
	if _, err := decodeSample(`{"count":null}`); err == nil || err.Error() != "programs[0].name: required" {
		t.Fatalf("%v", err)
	}
}

func TestRootPathAndEach(t *testing.T) {
	if _, err := Decode(json.RawMessage(`null`), ""); err == nil || err.Error() != "(root): expected object, received null" {
		t.Fatalf("%v", err)
	}
	o, _ := Decode(json.RawMessage(`{"xs":[{"n":1},{}]}`), "")
	var raw json.RawMessage
	Required(o, "xs", &raw)
	Each(o, "xs", raw, func(item json.RawMessage, path string) (float64, error) {
		inner, err := Decode(item, path)
		if err != nil {
			return 0, err
		}
		var n float64
		Required(inner, "n", &n)
		return n, inner.Err
	})
	if o.Err == nil || o.Err.Error() != "xs[1].n: required" {
		t.Fatalf("%v", o.Err)
	}
}
```
Append to `internal/control/control_test.go`:
```go
func TestCostOf(t *testing.T) {
	c := Cost{Fable: 1, General: 2, Session: 3}
	for b, want := range map[Bucket]float64{"fable": 1, "general": 2, "session": 3} {
		if got := c.Of(b); got != want {
			t.Errorf("Of(%s) = %v", b, got)
		}
	}
	defer func() {
		if recover() == nil {
			t.Fatal("an unknown bucket must panic: it is a programming error")
		}
	}()
	c.Of("weekly")
}
```

- [ ] **Step 2: Run, watch them fail**

Run: `go test ./internal/shape/ ./internal/control/`
Expected: build failure, `undefined: Decode`, `undefined: Bucket`.

- [ ] **Step 3: Implement `shape`**

`Decode` unmarshals into `map[string]json.RawMessage` (null refused first). `Required`/`Optional`/`RequiredNullable`/`NullableDefault` return at once when `o.Err != nil`; decoding failures go through one unexported `into` that wraps as `fmt.Errorf("%s: %v", o.At(key), err)`. `Each` returns nil on the first failing element. Package comment: "zod has no Go twin; this is the subset drovr's schemas use, so every boundary refuses the same shapes with a path."

- [ ] **Step 4: Refactor the three packages onto it**

Mechanical, one mapping per helper: control `newDecoder`→`shape.Decode`, `nullable`→`shape.NullableDefault`, `d.present`→`o.Present`, `d.check`→`o.Check`; teamclaude `present`→`shape.RequiredNullable`, `nullable`→`shape.NullableDefault` (null into the `epochMs` wrapper and skipping null both leave `v == nil`), `each`→`shape.Each`; ledger `objectOf`→`shape.Decode`, `nullableRequired`→`shape.RequiredNullable`, `nullableDefault`→`shape.NullableDefault`, `oneOf`→`shape.OneOf`, and `prefixed` disappears because the sub-object's `Decode(raw, "poolAfter")` carries the path. `ParseCycle` keeps its order exactly: `v` literal, every field, then `OneOf(kind)`, `OneOf(exit)`, then `poolBefore` through `parseCost` — the first refusal must stay the one the old `firstErr` chain returned. `ReadTickStamp` and `parseDecision` move too. Add `Bucket`, `Buckets`, `Cost.Of` to `control.go`; `capacity.Bucket`/`capacity.Buckets` become aliases; `decide.costOf(c, b)` and `allocation.costOf(c, b)` become `c.Of(b)`.

Out of scope: every other E1 review minor that is not in these files. The duplicated `isNull`/`orRoot` helpers go away here because they fall out; nothing else is touched.

- [ ] **Step 5: Run everything**

Run: `go test ./... -count=1 && go vet ./... && gofmt -l .`
Expected: every package `ok`, including `TestParseRefusals`, `TestDefaultsAndRefusals`, `TestReadCyclesRefusesByLine`, every fixture replay and the three oracle tests; no vet output; no files listed.

- [ ] **Step 6: Commit**

```bash
git add internal/shape internal/control internal/teamclaude internal/ledger internal/capacity internal/decide internal/allocation
git commit -m "refactor(go): one mini-zod decoder for control, teamclaude and the ledger; Cost.Of replaces three bucket switches"
```

---

### Task 2: `exec.Detach`, logged spawns, the spawn guard, paths, stamped output, `jsnum.Slice`

**Files:**
- Modify: `internal/exec/exec.go`, `internal/exec/exec_test.go`, `internal/paths/paths.go`, `internal/paths/paths_test.go`, `internal/epoch/epoch.go`, `internal/epoch/epoch_test.go`, `internal/jsnum/jsnum.go`, `internal/jsnum/jsnum_test.go`
- Create: `internal/exec/guard_test.go`
- Port from: `tick.ts` `launchDetached` (the spawn half), `cycle.ts` `runHeadless` (the spawn half), `cli.ts` `stampConsole`

**Interfaces:**
- Consumes: `exec.RunBounded(ctx, bin, args, Bounds) (Result, error)`, `exec.ExplainSpawn(bin, err) error`, `epoch.ISO(Millis) string`.
- Produces:
  ```go
  package exec
  // Bounds gains: LogPath string — stdout and stderr appended to this file instead of captured
  // (Result is then empty); Env []string — added to os.Environ() for the child.
  func Detach(bin string, args []string, logPath string) (int, error) // new session (Setsid), stdio on logPath (append), stdin /dev/null, never waited on; returns the pid

  package paths
  // Paths gains DecisionsShadow (<base>/decisions-shadow.jsonl) and TickShadowLock (<base>/tick-shadow.lock).
  func (p Paths) CycleTerminal(program string) string // programs/<p>/cycle-terminal.json
  func (p Paths) CurrentCycle(program string) string  // programs/<p>/current-cycle.json
  func (p Paths) Nudged(program string) string        // programs/<p>/nudged.json
  func (p Paths) ProfileSeeded(program string) string // programs/<p>/profile-seeded.json
  func (p Paths) WorkerLog(program string) string     // logs/<p>-worker.log

  package epoch
  func Stamped(w io.Writer, now func() Millis) io.Writer // "<ISO> " before every Write call

  package jsnum
  func Slice(s string, n int) string // String.prototype.slice(0, n): the first n UTF-16 code units
  ```

- [ ] **Step 1: Write the failing tests**

Append to `internal/exec/exec_test.go`:
```go
func readLog(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	return string(b)
}

func TestDetachReturnsAtOnceInItsOwnSession(t *testing.T) {
	log := filepath.Join(t.TempDir(), "w.log")
	if err := os.WriteFile(log, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	pid, err := Detach("sh", []string{"-c", "echo started; sleep 0.3; echo done"}, log)
	if err != nil || pid <= 0 {
		t.Fatal(pid, err)
	}
	if waited := time.Since(start); waited > 200*time.Millisecond {
		t.Fatalf("Detach waited %v for a child it must not wait on", waited)
	}
	if pgid, err := syscall.Getpgid(pid); err != nil || pgid != pid {
		t.Errorf("child is not a session leader: pgid %d pid %d err %v", pgid, pid, err)
	}
	for i := 0; i < 40 && !strings.Contains(readLog(t, log), "done"); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if got := readLog(t, log); got != "old\nstarted\ndone\n" {
		t.Fatalf("log = %q, want the child's output appended", got)
	}
}

func TestDetachExplainsAMissingBinary(t *testing.T) {
	t.Setenv("PATH", "/nonexistent")
	_, err := Detach("definitely-not-here", nil, filepath.Join(t.TempDir(), "w.log"))
	if err == nil || !strings.Contains(err.Error(), "definitely-not-here is not on PATH") {
		t.Fatalf("%v", err)
	}
}

func TestRunBoundedToALogWithEnv(t *testing.T) {
	log := filepath.Join(t.TempDir(), "h.log")
	r, err := RunBounded(context.Background(), "sh", []string{"-c", "echo $DROVR_PROGRAM; echo err >&2"},
		Bounds{Timeout: 2 * time.Second, LogPath: log, Env: []string{"DROVR_PROGRAM=alpha"}})
	if err != nil || r.Stdout != "" || r.Stderr != "" {
		t.Fatalf("%+v %v", r, err)
	}
	if got := readLog(t, log); got != "alpha\nerr\n" {
		t.Fatalf("log = %q", got)
	}
}
```
(`errors`, `io/fs`, `os`, `path/filepath`, `syscall` join that file's imports.)

`internal/exec/guard_test.go`:
```go
package exec

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The trap row: one hung child holds the tick lock forever, so the bound is a parameter of
// the only spawn helper rather than per-call-site discipline. This makes the rule a build gate.
func TestOnlyExecSpawns(t *testing.T) {
	root, _ := filepath.Abs("../..")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if d.IsDir() && (rel == "internal/exec" || rel == "node_modules" || rel == "testdata" || strings.HasPrefix(rel, ".")) && rel != "." {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range f.Imports {
			if p, _ := strconv.Unquote(imp.Path.Value); p == "os/exec" {
				t.Errorf("%s imports os/exec; spawn through exec.RunBounded or exec.Detach", rel)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
```
Append to `internal/epoch/epoch_test.go`:
```go
func TestStampedPrefixesEveryWrite(t *testing.T) {
	var b strings.Builder
	w := Stamped(&b, func() Millis { return 1787400000123 })
	fmt.Fprintln(w, "alpha: GO — fine")
	fmt.Fprintln(w, "alpha is busy\n  look:  orca terminal switch --terminal term_1")
	want := "2026-08-22T12:00:00.123Z alpha: GO — fine\n" +
		"2026-08-22T12:00:00.123Z alpha is busy\n  look:  orca terminal switch --terminal term_1\n"
	if b.String() != want {
		t.Fatalf("%q", b.String())
	}
}
```
Append to `internal/jsnum/jsnum_test.go`:
```go
func TestSliceCountsUTF16Units(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{{"abcdef", 3, "abc"}, {"ab", 5, "ab"}, {"é✳x", 2, "é✳"}, {"a🦾b", 3, "a🦾"}, {"", 4, ""}}
	for _, c := range cases {
		if got := Slice(c.in, c.n); got != c.want {
			t.Errorf("Slice(%q,%d) = %q want %q", c.in, c.n, got, c.want)
		}
	}
}
```
In `internal/paths/paths_test.go` extend the `want` map with `p.DecisionsShadow: "/tmp/x/decisions-shadow.jsonl"`, `p.TickShadowLock: "/tmp/x/tick-shadow.lock"`, `p.CycleTerminal("demo"): "/tmp/x/programs/demo/cycle-terminal.json"`, `p.CurrentCycle("demo"): "/tmp/x/programs/demo/current-cycle.json"`, `p.Nudged("demo"): "/tmp/x/programs/demo/nudged.json"`, `p.ProfileSeeded("demo"): "/tmp/x/programs/demo/profile-seeded.json"`, `p.WorkerLog("demo"): "/tmp/x/logs/demo-worker.log"`.

- [ ] **Step 2: Run, watch them fail**

Run: `go test ./internal/exec/ ./internal/paths/ ./internal/epoch/ ./internal/jsnum/`
Expected: build failures naming `Detach`, `LogPath`, `Stamped`, `Slice`, `DecisionsShadow`.

- [ ] **Step 3: Implement**

`Detach`: open `logPath` with `O_APPEND|O_CREATE|O_WRONLY`, 0o644; `osexec.Command(bin, args...)` with `Stdout`/`Stderr` = the file, `Stdin` nil (the os/exec default is `/dev/null`), `SysProcAttr{Setsid: true}`; `Start`; close the file in the parent on every path; `ErrNotFound` → `ExplainSpawn`; `cmd.Process.Release()`; return the pid. No context: a detached child outlives its parent by design, which is the whole reason it is not `RunBounded`.

`RunBounded` with `LogPath`: open the same way and point both streams at it instead of the buffers; close after `Run`. `Env` non-empty sets `cmd.Env = append(os.Environ(), b.Env...)`.

`Stamped`: a two-field writer that writes `ISO(now()) + " "` then `p`. Comment: "cli.ts's stampConsole prefixes each console call, not each line; one Fprintln per message keeps the two the same."

`Slice`: `u := utf16.Encode([]rune(s)); if n >= len(u) { return s }; return string(utf16.Decode(u[:n]))` — a split surrogate pair decodes to U+FFFD, which is what Node writes for a lone surrogate.

- [ ] **Step 4: Run, vet, fmt**

Run: `go test ./... -count=1 && go vet ./... && gofmt -l .`
Expected: all `ok`; `TestOnlyExecSpawns` passes (no package outside `internal/exec` imports `os/exec` today).

- [ ] **Step 5: Commit**

```bash
git add internal/exec internal/paths internal/epoch internal/jsnum
git commit -m "feat(go): Detach for the run-cycle worker, logged bounded spawns, a build gate on any other spawn, stamped tick output"
```

---

### Task 3: `internal/orca` pure half, and `internal/preview`

**Files:**
- Create: `internal/orca/envelope.go` (`Refused`, `Unwrap`, `IsGone`, the `terminal show` / `wait` / `read` / `list` shapes), `internal/orca/state.go` (`AgentStateFrom`, `PresentFrom`, `TerminalExited`, `IsSettled`, `LeftoverAction`), `internal/orca/address.go` (`ShellCommand`, `EnvArgs`, `TerminalAddress`, `OpenLine`, `AdoptHandle`, `PreviewText`), `internal/orca/remembered.go`, `internal/orca/pure_test.go`, `internal/preview/preview.go`, `internal/preview/preview_test.go`
- Port from: `src/orca.ts` lines 97–430 (everything above "Live calls"), `src/preview.ts`

**Interfaces:**
- Consumes: `shape.Decode`, `shape.Required`, `shape.NullableDefault`, `(*shape.Object).Present`; `paths.Paths.CycleTerminal(program) string`; `jsnum.Slice`.
- Produces:
  ```go
  package orca
  type AgentState string
  const ( Idle AgentState = "idle"; Working AgentState = "working"; Blocked AgentState = "blocked"; Gone AgentState = "gone" )
  type Refused struct{ Shown, Code string } // Error(): "<shown> refused: <code>"
  func Unwrap(payload json.RawMessage, shown string) (json.RawMessage, error) // bad shape: "<shown> did not answer with an orca envelope: <first 300 UTF-16 units>"
  func IsGone(err error) bool // *Refused with terminal_handle_stale | terminal_not_found | selector_not_found
  func AgentStateFrom(show, idle, exit json.RawMessage) (AgentState, error) // exit nil = a live pty (the TS LIVE_EXIT_PROBE)
  func PresentFrom(show, exit json.RawMessage) (bool, error)
  func TerminalExited(wait json.RawMessage) (bool, error)
  func IsSettled(s AgentState) bool
  type Leftover string // "close" | "exit" | "hold"
  func LeftoverAction(state AgentState, reported, exitSent bool) Leftover
  func PreviewText(read json.RawMessage) (string, error)
  func ShellCommand(argv []string) string
  func EnvArgs(environment string) []string // "" (this Mac) → nil
  type PaneAddress struct{ Where string; Open *string }
  func TerminalAddress(show json.RawMessage, handle, environment string) PaneAddress
  func OpenLine(a PaneAddress) string // "" or "\n  look:  <open>"
  func AdoptHandle(list json.RawMessage, tabID string) (string, bool, error)
  type Remembered struct {
      Handle      string `json:"handle"`
      TabID       string `json:"tabId"`
      WorktreeID  string `json:"worktreeId"`
      Environment string `json:"environment,omitempty"`
      ExitSent    bool   `json:"exitSent,omitempty"`
  }
  func RememberedTerminal(p paths.Paths, program string, log io.Writer) *Remembered // nil: no file, unreadable (logged), or wrong shape
  func RememberTerminal(p paths.Paths, program string, r Remembered) error         // JSON indent 2 + "\n", written in place as the TS does
  func ForgetTerminal(p paths.Paths, program string) error                          // rm -f

  package preview
  type Preview struct { Lines []string; ContextPercent, ContextTokens, Subagents *float64 }
  func Parse(raw string, maxLines int) *Preview // nil on anything unrecognised; never an error
  ```
  `terminal show`'s inner shape: `terminal` required object; `handle` required string; `agentIdentity` string, null or absent (absent and null both nil); `agentWait` blocked iff `Present`; `title` string, null or absent; `worktreePath` optional string; unknown keys stripped. A shape failure is `orca terminal show did not match the expected shape — <path>: <why>` and its path is `terminal.agentIdentity`, never a payload prefix.

- [ ] **Step 1: Write the failing tests**

`internal/orca/pure_test.go` (fixtures recorded verbatim from orca 1.4.199 in `test/orca.spec.ts`, trimmed):
```go
package orca

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/paths"
)

func shown(fields string) json.RawMessage {
	return json.RawMessage(`{"id":"82729c72","ok":true,"result":{"terminal":{"handle":"term_844e8720-ac95-453c-bb73-7e2fd567479a","worktreePath":"/Users/cadam/code/sunnyt","connected":true,` + fields + `}}}`)
}

var (
	claudeShown   = shown(`"title":"✳ Claude Code","agentIdentity":"claude","agentWait":null`)
	shellShown    = shown(`"title":"~/code/sunnyt","agentIdentity":null,"agentWait":null`)
	bareShown     = shown(`"title":"✳ Claude Code"`)
	blockedShown  = shown(`"title":"✳ Claude Code","agentIdentity":"claude","agentWait":{"kind":"permission","evidence":"prompt-text"}`)
	restoredShell = shown(`"tabId":"c4c69d5f","title":null,"lastOutputAt":null,"preview":"","agentWait":null`)
	noWaitField   = shown(`"title":"✳ Claude Code","agentIdentity":"claude"`)
	stale         = json.RawMessage(`{"id":"ca3dceb8","ok":false,"error":{"code":"terminal_handle_stale","message":"terminal_handle_stale"}}`)
	idleSatisfied = json.RawMessage(`{"id":"175e9e23","ok":true,"result":{"wait":{"handle":"term_844e8720","condition":"tui-idle","satisfied":true,"status":"running","exitCode":null}}}`)
	idleTimedOut  = json.RawMessage(`{"id":"175e9e24","ok":false,"error":{"code":"timeout","message":"timeout"}}`)
	exited        = json.RawMessage(`{"id":"43d5e42a","ok":true,"result":{"wait":{"handle":"term_2c1446bd","condition":"exit","satisfied":true,"status":"exited","exitCode":0}}}`)
)

func TestAgentStateFrom(t *testing.T) {
	cases := []struct {
		name             string
		show, idle, exit json.RawMessage
		want             AgentState
	}{
		{"a stale handle is gone", stale, idleTimedOut, nil, Gone},
		{"a plain shell is gone", shellShown, idleSatisfied, nil, Gone},
		{"show omits agentIdentity on a bare shell: gone", bareShown, idleSatisfied, nil, Gone},
		{"a restored terminal with a null title is a shell, not a shape error", restoredShell, idleSatisfied, nil, Gone},
		{"a claude on a human-only prompt is blocked whatever idle says", blockedShown, idleSatisfied, nil, Blocked},
		{"an exited pty is gone although show still names claude", claudeShown, idleTimedOut, exited, Gone},
		{"settled within the probe is idle", claudeShown, idleSatisfied, nil, Idle},
		{"not settled within the probe is working", claudeShown, idleTimedOut, nil, Working},
		{"an older host that never looked for a wait", noWaitField, idleTimedOut, nil, Working},
	}
	for _, c := range cases {
		got, err := AgentStateFrom(c.show, c.idle, c.exit)
		if err != nil || got != c.want {
			t.Errorf("%s: %s, %v", c.name, got, err)
		}
	}
}

func TestShapeErrorNamesThePath(t *testing.T) {
	_, err := AgentStateFrom(shown(`"title":"t","agentIdentity":7`), idleSatisfied, nil)
	if err == nil || !strings.Contains(err.Error(), "did not match the expected shape") || !strings.Contains(err.Error(), "terminal.agentIdentity") {
		t.Fatalf("%v", err)
	}
}

func TestRefusalsOtherThanTimeoutThrow(t *testing.T) {
	if _, err := AgentStateFrom(claudeShown, stale, nil); err == nil || !strings.Contains(err.Error(), "terminal_handle_stale") {
		t.Errorf("idle probe: %v", err)
	}
	if _, err := TerminalExited(stale); err == nil || !strings.Contains(err.Error(), "terminal_handle_stale") {
		t.Errorf("exit probe: %v", err)
	}
	if _, err := PresentFrom(claudeShown, stale); err == nil {
		t.Error("presentFrom read a refusal as absent")
	}
	if _, err := Unwrap(json.RawMessage(`{"result":{}}`), "orca terminal show"); err == nil || !strings.HasPrefix(err.Error(), "orca terminal show did not answer with an orca envelope") {
		t.Errorf("unwrap: %v", err)
	}
	if exitedNow, err := TerminalExited(idleTimedOut); err != nil || exitedNow {
		t.Errorf("a timed-out exit probe is a live pty: %v %v", exitedNow, err)
	}
}

func TestPresentFromAgreesWithAgentStateFrom(t *testing.T) {
	cases := []struct {
		name       string
		show, exit json.RawMessage
	}{{"live claude", claudeShown, nil}, {"exited pty", claudeShown, exited}, {"bare shell", shellShown, nil}, {"stale", stale, nil}, {"blocked", blockedShown, nil}}
	for _, c := range cases {
		for _, idle := range []json.RawMessage{idleSatisfied, idleTimedOut} {
			state, err := AgentStateFrom(c.show, idle, c.exit)
			present, perr := PresentFrom(c.show, c.exit)
			if err != nil || perr != nil || present != (state != Gone) {
				t.Errorf("%s: state %s present %v (%v %v)", c.name, state, present, err, perr)
			}
		}
	}
}

func TestSettledAndLeftoverAction(t *testing.T) {
	for state, want := range map[AgentState]bool{Idle: true, Gone: true, Working: false, Blocked: false} {
		if IsSettled(state) != want {
			t.Errorf("IsSettled(%s)", state)
		}
	}
	for _, reported := range []bool{true, false} {
		for _, sent := range []bool{true, false} {
			if LeftoverAction(Gone, reported, sent) != "close" {
				t.Error("an exited runner is always closed")
			}
			for _, busy := range []AgentState{Working, Blocked} {
				if LeftoverAction(busy, reported, sent) != "hold" {
					t.Errorf("%s runner touched", busy)
				}
			}
		}
	}
	if LeftoverAction(Idle, true, false) != "exit" || LeftoverAction(Idle, false, false) != "hold" || LeftoverAction(Idle, true, true) != "hold" {
		t.Error("idle: exit only when reported, and only once")
	}
}

func TestShellCommandAndEnvArgs(t *testing.T) {
	cases := map[string][]string{
		`direnv exec /Users/cadam/code/aice-x/aice teamclaude run -- --name 'aice-x program runner'\''s'`: {"direnv", "exec", "/Users/cadam/code/aice-x/aice", "teamclaude", "run", "--", "--name", "aice-x program runner's"},
		`~/.local/bin/claude --name 'relliq program runner'`: {"~/.local/bin/claude", "--name", "relliq program runner"},
		`cat ~/'.drovr/programs/my prog/last-cycle.json'`:     {"cat", "~/.drovr/programs/my prog/last-cycle.json"},
		`'~alone'`: {"~alone"},
	}
	for want, argv := range cases {
		if got := ShellCommand(argv); got != want {
			t.Errorf("ShellCommand(%q) = %s", argv, got)
		}
	}
	if EnvArgs("") != nil || strings.Join(EnvArgs("a7a12606"), " ") != "--environment a7a12606" {
		t.Error("EnvArgs")
	}
}

func TestTerminalAddress(t *testing.T) {
	a := TerminalAddress(claudeShown, "term_844e8720-ac95-453c-bb73-7e2fd567479a", "")
	if a.Where != `its "✳ Claude Code" tab in sunnyt` || a.Open == nil || *a.Open != "orca terminal switch --terminal term_844e8720-ac95-453c-bb73-7e2fd567479a" {
		t.Errorf("%+v", a)
	}
	if OpenLine(a) != "\n  look:  orca terminal switch --terminal term_844e8720-ac95-453c-bb73-7e2fd567479a" {
		t.Errorf("%q", OpenLine(a))
	}
	remote := TerminalAddress(json.RawMessage(`{"ok":true,"result":{"terminal":{"handle":"term_1","agentIdentity":"claude","title":"relliq cycles","worktreePath":"/home/ubuntu/code/propra/relliq"}}}`), "term_1", "a7a12606")
	if remote.Where != `its "relliq cycles" tab in relliq` || *remote.Open != "orca terminal switch --terminal term_1 --environment a7a12606" {
		t.Errorf("%+v", remote)
	}
	for _, show := range []json.RawMessage{restoredShell, stale, nil} {
		if a := TerminalAddress(show, "term_dead", ""); a.Where != "terminal term_dead" || a.Open != nil || OpenLine(a) != "" {
			t.Errorf("%s: %+v", show, a)
		}
	}
}

func TestAdoptHandleByTabID(t *testing.T) {
	list := json.RawMessage(`{"id":"94745afa","ok":true,"result":{"terminals":[{"handle":"term_3998","tabId":"tab-other","agentIdentity":null},{"handle":"term_5b2e","tabId":"tab-drovr","agentIdentity":"claude"}]}}`)
	if h, ok, err := AdoptHandle(list, "tab-drovr"); err != nil || !ok || h != "term_5b2e" {
		t.Errorf("%s %v %v", h, ok, err)
	}
	if _, ok, err := AdoptHandle(list, "tab-gone"); err != nil || ok {
		t.Errorf("%v %v", ok, err)
	}
}

func TestPreviewText(t *testing.T) {
	read := json.RawMessage(`{"id":"a1eff3f9","ok":true,"result":{"terminal":{"handle":"term_844e8720","status":"running","tail":["❯","──────","  using Fable 5.1 | ctx:15% (148k)"],"truncated":false}}}`)
	if got, err := PreviewText(read); err != nil || got != "❯\n──────\n  using Fable 5.1 | ctx:15% (148k)" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestRememberedTerminal(t *testing.T) {
	p := paths.Paths{Base: t.TempDir()}
	var log bytes.Buffer
	if RememberedTerminal(p, "aice-x", &log) != nil {
		t.Fatal("no file yet must be nil")
	}
	want := Remembered{Handle: "term_a1b2", TabID: "tab-1", WorktreeID: "repo-1::/Users/cadam/code/aice-x/aice"}
	if err := os.MkdirAll(p.ProgramState("aice-x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RememberTerminal(p, "aice-x", want); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(p.CycleTerminal("aice-x"))
	if string(raw) != "{\n  \"handle\": \"term_a1b2\",\n  \"tabId\": \"tab-1\",\n  \"worktreeId\": \"repo-1::/Users/cadam/code/aice-x/aice\"\n}\n" {
		t.Fatalf("file bytes %q", raw)
	}
	if got := RememberedTerminal(p, "aice-x", &log); got == nil || *got != want {
		t.Fatalf("%+v", got)
	}
	for _, body := range []string{"{ this is not json", `{"paneId":"old-shape"}`} {
		os.WriteFile(filepath.Join(p.ProgramState("aice-x"), "cycle-terminal.json"), []byte(body), 0o644)
		if RememberedTerminal(p, "aice-x", &log) != nil {
			t.Errorf("%q read as a terminal", body)
		}
	}
	if !strings.Contains(log.String(), "treating aice-x as having no runner terminal") {
		t.Errorf("unreadable file not logged: %q", log.String())
	}
}
```
`internal/preview/preview_test.go` is one table test, `TestPreviewParse`, porting `test/preview.spec.ts` case for case: the `REAL` block (three lines, first `Agent "Promotion train`, last `Cooked for 5s · 1 monitor still running`; percent 18, tokens 176000, subagents 1); forty 400-character lines → six lines each ≤ 200 runes, the last starting `line 39`; ten lines of 190 `✻` → joined ≤ 2048 bytes; `""` and `claude: command not found` → nil; the last gauge and monitor win (41, 402000, 1); fifty turns followed by 450 plain lines → nil (MAX_SCAN 400); `(402K)` and `(1.2M)` → 402000 and 1200000. Copy the TS strings verbatim; the test file is the spec file in Go syntax.

- [ ] **Step 2: Run, watch them fail**

Run: `go test ./internal/orca/ ./internal/preview/`
Expected: build failures, `undefined: AgentStateFrom`, `undefined: Parse`.

- [ ] **Step 3: Implement**

`Unwrap` decodes `{ok *bool, result json.RawMessage, error *struct{Code *string}}`: `ok` absent or not a bool → envelope error; `ok:true` → `result` (absent result is fine: zod's `z.unknown()`); `ok:false` needs `error.code` string → `&Refused{shown, code}`, else envelope error. The 300-unit cut is `jsnum.Slice(string(payload), 300)`.

`state.go` mirrors the TS line for line: `occupancyFrom(show)` → `gone | blocked | occupied` (unwrap error that `IsGone` → gone; other errors propagate; shape error wrapped as above); `idleSatisfied(wait)` and `TerminalExited(wait)` both read `{wait:{satisfied bool}}` and map `Refused{Code:"timeout"}` to false. `AgentStateFrom` and `PresentFrom` with `exit == nil` treat the exit probe as the live default.

`ShellCommand`: safe word `^[A-Za-z0-9_\-./=:@%+,]+$`; a `~/` prefix stays bare and the rest is quoted as a word; otherwise `'` + `strings.ReplaceAll(arg, "'", `'\''`) + `'`.

`TerminalAddress` swallows a show that cannot be read (`// swallowed: orca being unreachable costs the message its address, never the message`); `where` uses `filepath.Base(worktreePath)`.

`RememberedTerminal`: missing → nil; `ReadFile`/JSON failure → `fmt.Fprintf(log, "could not read %s, treating %s as having no runner terminal: %v\n", path, program, err)` and nil; shape (handle, tabId, worktreeId required strings; environment optional string; exitSent optional bool) failure → nil silently, as the TS `safeParse` does.

`preview.Parse`: turn glyphs `⏺ ✻ ✦`; `strip` drops the first rune, trims, cuts at 200 runes; scan the last 400 lines; the gauge regexp `(?i)ctx:\s*(\d+)%\s*\(([\d.]+)([km])\)` and `(\d+)\s+monitor`, last match via `FindAllStringSubmatch`; tokens `jsnum.RoundHalfUp(n * scale)`; `capBytes` at 2048 with `len(line)+1`. Package comment carries the trap row: a scrape, so an unrecognised shape is nil, never an error — the inverse of `terminal show`.

- [ ] **Step 4: Run, vet, fmt**

Run: `go test ./internal/orca/ ./internal/preview/ && go vet ./... && gofmt -l .`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/orca internal/preview
git commit -m "feat(go): orca's envelopes and agent states as pure functions, the remembered terminal, the preview scrape"
```

---

### Task 4: `internal/orca` live calls against an orca shim

**Files:**
- Create: `internal/orca/client.go` (`Client`, `orcaRaw`, `orca`, `AgentState`, `RunnerTerminal`, `RunnerState`, `RunnerIsPresent`, `RunnerAddress`, `AiceBaseURL`, `ResolveWorktree`, `WorktreeRepoID`, `ListRepos`), `internal/orca/cycle.go` (`StartCycleAgent`, `ReleaseAgent`, `ReleaseRunner`, `ReleaseLeftover`, `LeftoverIntent`, `PromptAgent`, `PromptRunner`, `InterruptRunner`, `TidyRunnerTerminal`, `ReadPreview`, `PaneBusy`, `CycleTabLabel`), `internal/orca/testdata/orca` (shim, `chmod +x`), `internal/orca/client_test.go`
- Port from: `src/orca.ts` lines 433–805

**Interfaces:**
- Consumes: Task 3's pure functions; `exec.RunBounded`, `*exec.ExitError` (`Stdout`), `*exec.TimedOut`; `control.Program` (`Name`, `Cwd`, `Host *control.Host{Environment, Cwd}`); `preview.Parse`.
- Produces:
  ```go
  package orca
  const (
      orcaTimeout       = 20 * time.Second
      idleProbe         = 1500 * time.Millisecond
      agentStartTimeout = 90 * time.Second
      promptSubmitWaitS = 10
      direnvTimeout     = 30 * time.Second
      claudeAttempts    = 30              // waitForClaude: 30 × 3 s
      claudePoll        = 3 * time.Second
      settlePoll        = 3 * time.Second
      exitPolls         = 10              // after /exit: 10 × 2 s
      exitPoll          = 2 * time.Second
      DefaultSettleAttempts = 10
  )
  type Client struct {
      Paths    paths.Paths
      Log      io.Writer           // diagnostics (rememberedTerminal)
      ReadOnly bool                // shadow: an adopted handle is used but cycle-terminal.json is not rewritten
      Sleep    func(time.Duration) // time.Sleep; tests pass a no-op
      // unexported: the aice base-URL cache, mutex-guarded (the TS baseUrlCache, per process)
  }
  func NewClient(p paths.Paths, log io.Writer) *Client
  type TerminalRef struct{ Handle, Environment string }
  type PaneBusy struct{ Msg string } // Error() = Msg: the cycle did not start and nothing is wrong
  type Started struct{ Handle, TabID string }
  type StartInput struct{ Program control.Program; WorktreeID string; Command []string; Prompt string }
  type Release string // "released" | "busy" | "exit-ignored"
  func CycleTabLabel(program string) string // "<program> cycles"
  func (c *Client) AgentState(ctx context.Context, handle, environment string) (AgentState, error)
  func (c *Client) RunnerTerminal(ctx context.Context, program string) (*TerminalRef, error)
  func (c *Client) RunnerState(ctx context.Context, program string) (AgentState, error)
  func (c *Client) RunnerIsPresent(ctx context.Context, program string) (bool, error)
  func (c *Client) RunnerAddress(ctx context.Context, program string) PaneAddress
  func (c *Client) AiceBaseURL(ctx context.Context, program control.Program) *string
  func (c *Client) ResolveWorktree(ctx context.Context, program control.Program) (string, error)
  func (c *Client) WorktreeRepoID(ctx context.Context, program control.Program) (string, error)
  func (c *Client) ListRepos(ctx context.Context) ([]json.RawMessage, error)
  func (c *Client) StartCycleAgent(ctx context.Context, in StartInput) (Started, error)
  func (c *Client) ReleaseAgent(ctx context.Context, handle, environment string, settleAttempts int) (Release, error)
  func (c *Client) ReleaseRunner(ctx context.Context, program string, settleAttempts int) (bool, error)
  func (c *Client) ReleaseLeftover(ctx context.Context, program string, reported bool) (bool, error)
  func (c *Client) LeftoverIntent(ctx context.Context, program string, reported bool) (Leftover, error) // what ReleaseLeftover would do, doing none of it (shadow)
  func (c *Client) PromptAgent(ctx context.Context, handle, prompt, environment string) error
  func (c *Client) PromptRunner(ctx context.Context, program, prompt string) error
  func (c *Client) InterruptRunner(ctx context.Context, program string) error
  func (c *Client) TidyRunnerTerminal(ctx context.Context, program string) (*string, error)
  func (c *Client) ReadPreview(ctx context.Context, program string) (*preview.Preview, *string) // preview, warning
  ```

- [ ] **Step 1: The orca shim**

`internal/orca/testdata/orca`:
```sh
#!/bin/sh
# Test shim. Answers from $ORCA_ANSWERS/<key>.json, where key is the first two words
# ("terminal_show") plus, for `terminal wait`, the --for value ("terminal_wait_exit").
# <key>.<n>.json answers the n-th call of that key when it exists; <key>.code is the exit
# code (default 0). After `terminal send --text /exit`, show and the exit probe answer from
# <key>.exited.json when it exists. Every argv is appended to $ORCA_ANSWERS/calls.log.
dir="$ORCA_ANSWERS"
echo "$*" >> "$dir/calls.log"
key="$1_$2"
if [ "$1 $2" = "terminal wait" ]; then
  key="${key}_$(printf '%s\n' "$@" | sed -n '/^--for$/{n;p;}')"
fi
case " $* " in *" --text /exit "*) : > "$dir/exited" ;; esac
n=$(( $(cat "$dir/$key.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$dir/$key.count"
answer="$dir/$key.json"
[ -f "$dir/$key.$n.json" ] && answer="$dir/$key.$n.json"
[ -f "$dir/exited" ] && [ -f "$dir/$key.exited.json" ] && answer="$dir/$key.exited.json"
cat "$answer" 2>/dev/null
exit "$(cat "$dir/$key.code" 2>/dev/null || echo 0)"
```

- [ ] **Step 2: Write the failing tests**

`internal/orca/client_test.go`:
```go
package orca

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/paths"
)

// shim puts testdata/orca first on PATH and writes the answers it should give.
func shim(t *testing.T, answers map[string]string) (dir string) {
	t.Helper()
	dir = t.TempDir()
	bin, _ := filepath.Abs("testdata")
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("ORCA_ANSWERS", dir)
	for name, body := range answers {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func calls(t *testing.T, dir string) string {
	b, _ := os.ReadFile(filepath.Join(dir, "calls.log"))
	return string(b)
}

func client(t *testing.T) (*Client, *bytes.Buffer) {
	var log bytes.Buffer
	c := NewClient(paths.Paths{Base: t.TempDir()}, &log)
	c.Sleep = func(time.Duration) {}
	return c, &log
}

func remember(t *testing.T, c *Client, program string, r Remembered) {
	t.Helper()
	if err := os.MkdirAll(c.Paths.ProgramState(program), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RememberTerminal(c.Paths, program, r); err != nil {
		t.Fatal(err)
	}
}

const (
	okClaude  = `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/w/alpha","agentIdentity":"claude","agentWait":null}}}`
	okShell   = `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/w/alpha","agentIdentity":null}}}`
	staleBody = `{"ok":false,"error":{"code":"terminal_handle_stale"}}`
	timeout   = `{"ok":false,"error":{"code":"timeout"}}`
	satisfied = `{"ok":true,"result":{"wait":{"satisfied":true}}}`
)

func TestRefusalIsReadWhateverTheExitCode(t *testing.T) {
	for _, code := range []string{"0", "1"} {
		dir := shim(t, map[string]string{"terminal_show.json": staleBody, "terminal_show.code": code})
		c, _ := client(t)
		state, err := c.AgentState(context.Background(), "term_1", "")
		if err != nil || state != Gone {
			t.Errorf("exit %s: %s %v", code, state, err)
		}
		if !strings.Contains(calls(t, dir), "terminal show --terminal term_1 --json") {
			t.Errorf("argv: %s", calls(t, dir))
		}
	}
}

func TestGarbageIsAnErrorNotGone(t *testing.T) {
	shim(t, map[string]string{"terminal_show.json": "segfault", "terminal_show.code": "1"})
	c, _ := client(t)
	if _, err := c.AgentState(context.Background(), "term_1", ""); err == nil || !strings.Contains(err.Error(), "orca terminal show --terminal term_1 failed") {
		t.Fatalf("%v", err)
	}
}

func TestAgentStateProbesExitBeforeIdle(t *testing.T) {
	dir := shim(t, map[string]string{"terminal_show.json": okClaude, "terminal_wait_exit.json": timeout, "terminal_wait_tui-idle.json": satisfied})
	c, _ := client(t)
	if state, err := c.AgentState(context.Background(), "term_1", "env-1"); err != nil || state != Idle {
		t.Fatalf("%s %v", state, err)
	}
	log := calls(t, dir)
	if strings.Index(log, "--for exit") > strings.Index(log, "--for tui-idle") || !strings.Contains(log, "--timeout-ms 1500 --environment env-1 --json") {
		t.Fatalf("probe order or argv wrong:\n%s", log)
	}
}

func TestRunnerTerminalAdoptsAndRewrites(t *testing.T) {
	shim(t, map[string]string{
		"terminal_show.json": staleBody,
		"terminal_list.json": `{"ok":true,"result":{"terminals":[{"handle":"term_new","tabId":"tab-1"}]}}`,
	})
	c, _ := client(t)
	remember(t, c, "alpha", Remembered{Handle: "term_old", TabID: "tab-1", WorktreeID: "wt-1"})
	ref, err := c.RunnerTerminal(context.Background(), "alpha")
	if err != nil || ref == nil || ref.Handle != "term_new" {
		t.Fatalf("%+v %v", ref, err)
	}
	if got := RememberedTerminal(c.Paths, "alpha", c.Log); got == nil || got.Handle != "term_new" {
		t.Fatalf("not rewritten: %+v", got)
	}
	c.ReadOnly = true
	remember(t, c, "alpha", Remembered{Handle: "term_old", TabID: "tab-1", WorktreeID: "wt-1"})
	if ref, _ := c.RunnerTerminal(context.Background(), "alpha"); ref == nil || ref.Handle != "term_new" {
		t.Fatal("read-only must still adopt")
	}
	if got := RememberedTerminal(c.Paths, "alpha", c.Log); got.Handle != "term_old" {
		t.Fatal("read-only rewrote cycle-terminal.json")
	}
}

func TestRunnerAddressNamesTheTab(t *testing.T) {
	shim(t, map[string]string{"terminal_show.json": okClaude})
	c, _ := client(t)
	if a := c.RunnerAddress(context.Background(), "alpha"); a.Where != "no terminal (alpha has never run, or its terminal is closed)" {
		t.Errorf("%+v", a)
	}
	remember(t, c, "alpha", Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	if a := c.RunnerAddress(context.Background(), "alpha"); a.Where != `its "alpha cycles" tab in alpha` {
		t.Errorf("%+v", a)
	}
}

func program(name string) control.Program {
	return control.Program{Name: name, Cwd: "/w/" + name, Model: "fable"}
}

func TestStartCreatesWithCommandAndPrompts(t *testing.T) {
	dir := shim(t, map[string]string{
		"terminal_create.json":        `{"ok":true,"result":{"terminal":{"handle":"term_1","tabId":"tab-1"}}}`,
		"terminal_show.json":          okClaude,
		"terminal_wait_exit.json":     timeout,
		"terminal_wait_tui-idle.json": satisfied,
		"terminal_send.json":          `{"ok":true,"result":{}}`,
	})
	c, _ := client(t)
	started, err := c.StartCycleAgent(context.Background(), StartInput{Program: program("alpha"), WorktreeID: "wt-1", Command: []string{"teamclaude", "run", "--", "--name", "alpha program runner"}, Prompt: "/project-loop alpha"})
	if err != nil || started.Handle != "term_1" || started.TabID != "tab-1" {
		t.Fatalf("%+v %v", started, err)
	}
	log := calls(t, dir)
	for _, want := range []string{
		"terminal create --worktree id:wt-1 --title alpha cycles --command teamclaude run -- --name 'alpha program runner' --json",
		"terminal wait --terminal term_1 --for tui-idle --timeout-ms 90000 --json",
		"terminal send --terminal term_1 --text /project-loop alpha --enter --wait-submit 10 --json",
	} {
		if !strings.Contains(log, want) {
			t.Errorf("missing %q in\n%s", want, log)
		}
	}
	if got := RememberedTerminal(c.Paths, "alpha", c.Log); got == nil || got.WorktreeID != "wt-1" {
		t.Errorf("not remembered: %+v", got)
	}
}

func TestStartClearsTheLeftoverFirst(t *testing.T) {
	dir := shim(t, map[string]string{
		"terminal_show.1.json":        okShell, // runnerTerminal: the terminal still exists
		"terminal_show.2.json":        okShell, // agentState: a bare shell, so gone
		"terminal_show.json":          okClaude,
		"terminal_close.json":         `{"ok":true,"result":{}}`,
		"terminal_create.json":        `{"ok":true,"result":{"terminal":{"handle":"term_2","tabId":"tab-2"}}}`,
		"terminal_wait_exit.json":     timeout,
		"terminal_wait_tui-idle.json": satisfied,
		"terminal_send.json":          `{"ok":true,"result":{}}`,
	})
	c, _ := client(t)
	remember(t, c, "alpha", Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	if _, err := c.StartCycleAgent(context.Background(), StartInput{Program: program("alpha"), WorktreeID: "wt-1", Command: []string{"claude"}, Prompt: "go"}); err != nil {
		t.Fatal(err)
	}
	log := calls(t, dir)
	if strings.Index(log, "terminal close --terminal term_1") > strings.Index(log, "terminal create") || strings.Index(log, "terminal close") < 0 {
		t.Fatalf("leftover not closed before create:\n%s", log)
	}
}

func TestStartBehindADialogIsPaneBusy(t *testing.T) {
	dir := shim(t, map[string]string{
		"terminal_create.json":        `{"ok":true,"result":{"terminal":{"handle":"term_1","tabId":"tab-1"}}}`,
		"terminal_show.json":          okClaude,
		"terminal_wait_exit.json":     timeout,
		"terminal_wait_tui-idle.1.json": satisfied,
		"terminal_wait_tui-idle.json": timeout,
	})
	c, _ := client(t)
	_, err := c.StartCycleAgent(context.Background(), StartInput{Program: program("alpha"), WorktreeID: "wt-1", Command: []string{"claude"}, Prompt: "go"})
	var busy *PaneBusy
	if !errors.As(err, &busy) || !strings.Contains(err.Error(), "alpha started but is working in") {
		t.Fatalf("%v", err)
	}
	if strings.Contains(calls(t, dir), "terminal send") {
		t.Fatal("prompted a runner that is not idle")
	}
	if RememberedTerminal(c.Paths, "alpha", c.Log) == nil {
		t.Fatal("the live runner must stay remembered for the next tick")
	}
}

func TestReleaseRefusesAWorkingRunner(t *testing.T) {
	dir := shim(t, map[string]string{"terminal_show.json": okClaude, "terminal_wait_exit.json": timeout, "terminal_wait_tui-idle.json": timeout})
	c, _ := client(t)
	got, err := c.ReleaseAgent(context.Background(), "term_1", "", 0)
	if err != nil || got != "busy" || strings.Contains(calls(t, dir), "/exit") {
		t.Fatalf("%s %v\n%s", got, err, calls(t, dir))
	}
}

func TestReleaseSendsExitThenCloses(t *testing.T) {
	dir := shim(t, map[string]string{
		"terminal_show.json": okClaude, "terminal_show.exited.json": okShell,
		"terminal_wait_exit.json": timeout, "terminal_wait_tui-idle.json": satisfied,
		"terminal_send.json": `{"ok":true,"result":{}}`, "terminal_close.json": `{"ok":true,"result":{}}`,
	})
	c, _ := client(t)
	remember(t, c, "alpha", Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	if ok, err := c.ReleaseRunner(context.Background(), "alpha", 0); err != nil || !ok {
		t.Fatalf("%v %v\n%s", ok, err, calls(t, dir))
	}
	if RememberedTerminal(c.Paths, "alpha", c.Log) != nil {
		t.Fatal("a released runner is forgotten")
	}
}

func TestIgnoredExitIsRememberedSoItIsNeverSentTwice(t *testing.T) {
	shim(t, map[string]string{"terminal_show.json": okClaude, "terminal_wait_exit.json": timeout, "terminal_wait_tui-idle.json": satisfied, "terminal_send.json": `{"ok":true,"result":{}}`})
	c, _ := client(t)
	remember(t, c, "alpha", Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	if ok, err := c.ReleaseRunner(context.Background(), "alpha", 0); err != nil || ok {
		t.Fatalf("%v %v", ok, err)
	}
	if got := RememberedTerminal(c.Paths, "alpha", c.Log); got == nil || !got.ExitSent {
		t.Fatalf("%+v", got)
	}
	if intent, _ := c.LeftoverIntent(context.Background(), "alpha", true); intent != "hold" {
		t.Fatalf("a second /exit would land in claude's dialog: %s", intent)
	}
}
```
(`errors` joins the imports.)

- [ ] **Step 3: Run, watch them fail**

Run: `go test ./internal/orca/ -run 'Refusal|Garbage|Probes|Adopt|Address|Start|Release|Ignored'`
Expected: build failure, `undefined: NewClient`.

- [ ] **Step 4: Implement**

`orcaRaw(ctx, args, timeout)` runs `exec.RunBounded(ctx, "orca", append(args, "--json"), Bounds{Timeout, Label: "orca " + strings.Join(args, " ")})`. `*exec.TimedOut` and the not-on-PATH error propagate as they are. An `*exec.ExitError` whose `Stdout` parses as an envelope (`Unwrap` returns no envelope error) is the answer; any other `ExitError` becomes `fmt.Errorf("%s failed: %s", shown, err)`. On success, stdout that is not JSON is `"<shown> did not return JSON. It printed: <300 units>"`. `orca(ctx, args, timeout)` = `Unwrap(orcaRaw(...), shown)`. The 8 MiB `maxBuffer` has no Go twin (Go buffers do not overflow); ruling noted in a comment.

Everything else follows the TS function for function, with the TS's loops capped by the constants above: `waitForClaude` (≤ `claudeAttempts`, `Sleep(claudePoll)`), the settle loop in `ReleaseAgent` (≤ `settleAttempts`, `Sleep(settlePoll)`), the post-`/exit` loop (≤ `exitPolls`, `Sleep(exitPoll)`). The `/exit` send's failure is swallowed (`// swallowed: the TS .catch(() => ({})) — the poll below is what decides`). `terminal list` failing during adoption is swallowed to "no adoption". `RunnerTerminal` with `ReadOnly` returns the adopted ref without `RememberTerminal`. `LeftoverIntent` is `ReleaseLeftover` up to `leftoverAction` and returns the action instead of acting; nil terminal → `"close"` (nothing holds a terminal, which `ReleaseLeftover` reports as true). `AiceBaseURL` runs `direnv exec <cwd> sh -c 'printf %s "$AICE_BASE_URL"'` bounded by `direnvTimeout`, caches nil and non-nil per program name under a mutex, and swallows the failure (`// swallowed: TS .catch(() => null)`). `ResolveWorktree` uses the host's cwd and environment when `Host != nil`, and turns an `IsGone` refusal into `orca has no worktree at <cwd>, so <name> has nowhere to run. Register it:  orca repo add --path <cwd>[ --environment <env>]`. `ReadPreview` returns `(nil, "preview unavailable for <p>: no runner terminal")` or the first line of the error, never an error.

PaneBusy messages copied verbatim from the TS: `<p>'s previous runner would not exit. The next tick tries again.`; `<p> already has a live session in <where> (<state>). Leaving it alone — it is either still working or being used. The next tick tries again.<openLine>`; `<p> started but is <state> in <where> — answer whatever it is waiting on there and the next tick will prompt it.<openLine>`.

- [ ] **Step 5: Run, vet, fmt**

Run: `go test ./internal/orca/ -count=1 && go vet ./... && gofmt -l .`
Expected: PASS in under five seconds (no real sleeps).

- [ ] **Step 6: Commit**

```bash
git add internal/orca
git commit -m "feat(go): every orca call — envelopes read off a failed exit, stale handles adopted by tab, start, prompt, release and tidy; proven against a shim"
```

---

### Task 5: `internal/asks`

**Files:**
- Create: `internal/asks/asks.go`, `internal/asks/asks_test.go`, `internal/asks/testdata/direnv` (shim)
- Port from: `src/asks.ts`

**Interfaces:**
- Consumes: `exec.RunBounded` with `Bounds{Timeout: notesTimeout, Cwd: program.Cwd}`; `*exec.TimedOut`, `*exec.ExitError`; `epoch.Parse`.
- Produces:
  ```go
  package asks
  const notesTimeout = 20 * time.Second
  const ttl = 60 * time.Second
  type State struct{ Shared bool; LatestAt *epoch.Millis; OpenThreads int }
  func SplitPage(asksPage string) (page string, prefix *string)
  func FromNotes(stdout []byte) *State // lenient: nil on anything that is not {notes:{shared?,threads?}}
  func ReadFile(cwd, file string) (*State, error) // nil for a missing file or a path outside cwd; other read errors returned
  type Reader struct{ /* mutex + per-program cache */ }
  func NewReader() *Reader
  func (r *Reader) Read(ctx context.Context, program control.Program, now epoch.Millis) (*State, error)
  ```
  Rulings: the TS's `execFile` with `maxBuffer` 16 MiB becomes `RunBounded` (no buffer cap exists to overflow). `LatestAt` from a file is `ModTime().UnixMilli()`; Node's `mtimeMs` carries sub-millisecond digits that Go truncates — a sub-millisecond difference in a timestamp compared against hour-scale gates.

- [ ] **Step 1: Write the failing tests**

`internal/asks/testdata/direnv`:
```sh
#!/bin/sh
# Test shim for `direnv exec <cwd> aice notes list <page> [--prefix p] --json`: logs argv and
# prints $ASKS_STDOUT, exiting $ASKS_CODE (default 0); sleeps $ASKS_SLEEP seconds first.
echo "$*" >> "$ASKS_LOG"
[ -n "$ASKS_SLEEP" ] && sleep "$ASKS_SLEEP"
printf '%s' "$ASKS_STDOUT"
exit "${ASKS_CODE:-0}"
```
`internal/asks/asks_test.go`:
```go
package asks

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
)

func TestSplitPage(t *testing.T) {
	cases := []struct{ in, page, prefix string }{
		{"craig/loop-asks.html", "loop-asks.html", "craig"},
		{"asks.html", "asks.html", ""},
		{"craig/programs/asks.html", "programs/asks.html", "craig"},
	}
	for _, c := range cases {
		page, prefix := SplitPage(c.in)
		got := ""
		if prefix != nil {
			got = *prefix
		}
		if page != c.page || got != c.prefix {
			t.Errorf("%s → %s %s", c.in, page, got)
		}
	}
}

func TestFromNotes(t *testing.T) {
	s := FromNotes([]byte(`{"notes":{"shared":true,"threads":[{"id":"a","resolved":true,"createdAt":"2026-10-22T09:00:00.000Z"},{"id":"b","updatedAt":"2026-10-22T10:00:00.000Z","replies":[{"at":"2026-10-22T11:00:00.000Z"},{"at":"garbage"}]}]}}`))
	if s == nil || !s.Shared || s.OpenThreads != 1 || s.LatestAt == nil || *s.LatestAt != epoch.MustParse("2026-10-22T11:00:00.000Z") {
		t.Fatalf("%+v", s)
	}
	off := FromNotes([]byte(`{"notes":{}}`))
	if off == nil || off.Shared || off.LatestAt != nil || off.OpenThreads != 0 {
		t.Fatalf("notes sharing off reads as unshared and empty: %+v", off)
	}
	for _, bad := range []string{"", "not json", `{"error":{"message":"x"}}`, `{"notes":{"threads":7}}`} {
		if FromNotes([]byte(bad)) != nil {
			t.Errorf("%q read as a state", bad)
		}
	}
}

func dirWith(t *testing.T, name, text string) string {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestReadFile(t *testing.T) {
	dir := dirWith(t, "asks.md", "# Asks\n\n- [ ] Which region?\n  context here\n- [x] Keep the old name?\n- [ ] Ship on Friday?\n- [ ]\n- [ ] \n")
	at := time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	os.Chtimes(filepath.Join(dir, "asks.md"), at, at)
	s, err := ReadFile(dir, "asks.md")
	if err != nil || s == nil || !s.Shared || s.OpenThreads != 4 || *s.LatestAt != at.UnixMilli() {
		t.Fatalf("%+v %v", s, err)
	}
	done, _ := ReadFile(dirWith(t, "asks.md", "- [X] done\r\n- [x] also done\r\n"), "asks.md")
	if done.OpenThreads != 0 {
		t.Error("answered items are not open")
	}
	if s, err := ReadFile(dir, "missing.md"); s != nil || err != nil {
		t.Errorf("missing: %v %v", s, err)
	}
	if s, err := ReadFile(filepath.Join(dir, "sub"), "../asks.md"); s != nil || err != nil {
		t.Errorf("outside cwd: %v %v", s, err)
	}
	os.Chmod(filepath.Join(dir, "asks.md"), 0)
	if _, err := ReadFile(dir, "asks.md"); err == nil {
		t.Error("an unreadable file is an error, not an empty answer")
	}
}

func useShim(t *testing.T) string {
	bin, _ := filepath.Abs("testdata")
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	log := filepath.Join(t.TempDir(), "calls.log")
	t.Setenv("ASKS_LOG", log)
	return log
}

func TestReaderRunsNotesListOncePerTTL(t *testing.T) {
	log := useShim(t)
	t.Setenv("ASKS_STDOUT", `{"notes":{"shared":true,"threads":[]}}`)
	page := "craig/loop-asks.html"
	p := control.Program{Name: "alpha", Cwd: t.TempDir(), Aice: &control.Aice{AsksPage: &page}}
	r := NewReader()
	for _, now := range []epoch.Millis{1000, 30_000} {
		if s, err := r.Read(context.Background(), p, now); err != nil || s == nil || !s.Shared {
			t.Fatalf("%+v %v", s, err)
		}
	}
	raw, _ := os.ReadFile(log)
	if strings.Count(string(raw), "\n") != 1 || !strings.Contains(string(raw), "exec "+p.Cwd+" aice notes list loop-asks.html --prefix craig --json") {
		t.Fatalf("calls:\n%s", raw)
	}
}

func TestNotesFailureIsNoAnswerNotAnError(t *testing.T) {
	useShim(t)
	t.Setenv("ASKS_STDOUT", `{"error":{"message":"page not found"}}`)
	t.Setenv("ASKS_CODE", "1")
	page := "asks.html"
	s, err := NewReader().Read(context.Background(), control.Program{Name: "a", Cwd: t.TempDir(), Aice: &control.Aice{AsksPage: &page}}, 1)
	if s != nil || err != nil {
		t.Fatalf("%+v %v", s, err)
	}
}

func TestNotesCallIsBoundedAndNamed(t *testing.T) {
	useShim(t)
	t.Setenv("ASKS_SLEEP", "5")
	start := time.Now()
	_, err := notesJSON(context.Background(), t.TempDir(), []string{"list", "asks.html"}, 200*time.Millisecond)
	if err == nil || err.Error() != "aice notes list did not return within 0.2s and was killed" {
		t.Fatalf("%v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("the bound did not cut the child off")
	}
}

func TestHostedProgramHasNoLocalAsksFile(t *testing.T) {
	file := ".drovr-asks.md"
	dir := dirWith(t, file, "- [ ] x\n")
	p := control.Program{Name: "h", Cwd: dir, AsksFile: &file, Host: &control.Host{Environment: "e", SSH: "u@h", Cwd: "/srv/h"}}
	if s, err := NewReader().Read(context.Background(), p, 1); s != nil || err != nil {
		t.Fatalf("%+v %v", s, err)
	}
}
```
The TS message divides by 1000 without rounding (`NOTES_TIMEOUT_MS / 1000`), so production prints `20s`; the unexported `notesJSON(ctx, cwd, argv, timeout)` takes its bound as a parameter so the test does not wait 20 s, and formats it with `strconv.FormatFloat(timeout.Seconds(), 'f', -1, 64)` — which is how `0.2s` arises.

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/asks/` → build failure, `undefined: SplitPage`.

- [ ] **Step 3: Implement**

`FromNotes` decodes leniently (plain `json.Unmarshal` into `struct{ Notes *struct{ Shared *bool; Threads *[]thread } }` with `thread{Resolved *bool; UpdatedAt, CreatedAt, At *string; Replies []struct{At *string}}`); any decode error or missing `notes` → nil; `shared` defaults false, `threads` defaults empty. Timestamps through `epoch.Parse`, unparseable skipped, max taken. `ReadFile`: `root := filepath.Clean(cwd)`, `path := filepath.Join(root, file)` (lexical, symlinks not resolved, as the TS), refuse unless `strings.HasPrefix(path, root+"/")`; missing → nil; open lines matching `^\s*[-*]\s+\[ \](\s|$)` after splitting on `\r?\n`. `notesJSON` maps `*exec.TimedOut` to the message above, an `*exec.ExitError` whose stdout carries `{"error":{"message":…}}` to `aice notes <cmd> failed: <message>`, anything else to `exec.ExplainSpawn("direnv", err)`. `Read` mirrors `readAsksUncached`: no aice page → `asksFile == nil || Host != nil` → nil, else `ReadFile`; with a page, the notes failure is swallowed to nil (`// swallowed: TS .catch(() => null) — an unreachable aice page is "no answer", and decide treats nil as unknown`). The cache stores nil results too, keyed by program name, under a mutex.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/asks/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/asks
git commit -m "feat(go): asks — aice notes read leniently through direnv, bounded; the markdown asks file; a minute's cache"
```

---
### Task 6: `internal/hey` — the hey repo's Go client, copied, plus drovr's four calls

`src/hey-wire.ts`, `src/hey-http.ts` and the client half of `src/hey.ts` are copies the hey repo owns. Its Go CLI already ported them (`~/code/hey/cli/hey`), so drovr copies those Go files rather than porting the TS a second time, and adds only what drovr calls.

**Files:**
- Copy verbatim, changing only `package main` → `package hey`: `~/code/hey/cli/hey/wire.go`, `hey_http.go`, `config.go`, `jsonout.go` → `internal/hey/`; their tests `wire_test.go`, `hey_http_test.go`, `config_test.go` → `internal/hey/`
- Create: `internal/hey/support_test.go` (the two test helpers the copied tests reach for, which in the hey repo live in files drovr does not copy), `internal/hey/drovr.go`, `internal/hey/icon.go`, `internal/hey/drovr_test.go`, `internal/hey/copies_test.go`
- Port from: `src/hey.ts` (`defaultCaller`, `send`, `readPrefs`, `setProfile`, `putStatus` — the only five `nudge.ts` and `profile.ts` import), `src/hey-wire.ts` (`iconForm`, which the hey Go CLI does not have)

**Interfaces:**
- Consumes (from the copies, unexported): `type Call func(ctx context.Context, tool string, args any) (json.RawMessage, error)`, `toolCaller(callerDeps) Call`, `callerDeps{http httpDo; endpoint, path string; now func() time.Time}`, `readConfig(path) (fileConfig, error)`, `configPath(home) string`, `credentialsPath(home) string`, `send`, `readPrefs`, `setProfile`, `sendRequest`, `profileRequest`, `decodeInto`, `nonEmpty`, `errNotSignedIn`.
- Produces:
  ```go
  package hey
  var ErrNotSignedIn = errNotSignedIn
  func DefaultCaller(home string) (Call, error) // config endpoint, credentials under home, the real clock; a malformed hey.json is the error
  type SendInput struct{ To, From, Host, Cwd, Text string }
  type Sent struct{ ID string; Pushed bool; Reason *string }
  func Send(ctx context.Context, call Call, in SendInput) (Sent, error)
  type Prefs struct{ Away bool }
  func ReadPrefs(ctx context.Context, call Call, to string) (Prefs, error)
  type ProfileInput struct{ To, From string; Icon, Summary, Color *string }
  func SetProfile(ctx context.Context, call Call, in ProfileInput) error
  type StatusInput struct{ To, Host, At, Payload string } // the tick's row: no program, so the handler defaults it to drovr
  func PutStatus(ctx context.Context, call Call, in StatusInput) error
  func IconForm(icon string) string // "emoji" | "symbol" | "url" | "data", or "" for not an icon
  ```
  Ruling: hey's `statusPutRequest` always sends `program`; the tick's call must stay byte-identical to the TS (`{to, host, at, payload}`), so `drovr.go` has its own request type and ack shape rather than copying `status_put.go`.

- [ ] **Step 1: Copy and confirm the copies build**

```bash
src=~/code/hey/cli/hey; dst=internal/hey; mkdir -p $dst
for f in wire.go hey_http.go config.go jsonout.go wire_test.go hey_http_test.go config_test.go; do
  sed '1s/^package main$/package hey/' "$src/$f" > "$dst/$f"
done
```
`internal/hey/support_test.go`:
```go
package hey

import (
	"context"
	"time"
)

// Copied from the hey repo's wait_test.go and main.go, which drovr does not copy whole: the
// copied hey_http_test.go needs both.
type fakeClock struct{ at time.Time }

func (c *fakeClock) now() time.Time { return c.at }

func (c *fakeClock) sleep(ctx context.Context, d time.Duration) error {
	if ctx.Err() != nil {
		return ctx.Err()
	}
	c.at = c.at.Add(d)
	return nil
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
```
Run: `go vet ./internal/hey/ && go test ./internal/hey/`
Expected: PASS — the copied suites (`TestToolCallerRetriesOnceOn401ThenGivesUp`, `TestCredentialsFileRoundTripBytesAndMode`, `TestReadConfigMissingGoodAndBad`, `TestReadPrefsSetProfileWhoamiAndStatusRequests`, …) run unchanged.

- [ ] **Step 2: Write the failing tests**

`internal/hey/copies_test.go`:
```go
package hey

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The hey repo owns these files. A drift is fixed there and copied here, never edited here.
func TestCopiesMatchTheHeyRepo(t *testing.T) {
	repo := os.Getenv("HEY_REPO")
	if repo == "" {
		home, _ := os.UserHomeDir()
		repo = filepath.Join(home, "code", "hey")
	}
	for _, f := range []string{"wire.go", "hey_http.go", "config.go", "jsonout.go", "wire_test.go", "hey_http_test.go", "config_test.go"} {
		theirs, err := os.ReadFile(filepath.Join(repo, "cli", "hey", f))
		if err != nil {
			t.Skipf("hey repo not at %s: %v", repo, err)
		}
		ours, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Replace(string(theirs), "package main\n", "package hey\n", 1) != string(ours) {
			t.Errorf("%s differs from %s — re-copy it (plan E2 Task 6 Step 1)", f, repo)
		}
	}
}
```
`internal/hey/drovr_test.go`:
```go
package hey

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

type recorder struct {
	tools, args []string
	answer      string
}

func (r *recorder) call(_ context.Context, tool string, args any) (json.RawMessage, error) {
	b, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	r.tools, r.args = append(r.tools, tool), append(r.args, string(b))
	return json.RawMessage(r.answer), nil
}

func TestPutStatusSendsNoProgram(t *testing.T) {
	r := &recorder{answer: `{"sk":"status#drovr@mac","at":"2026-10-16T18:40:00.000Z","expiresAt":1}`}
	err := PutStatus(context.Background(), r.call, StatusInput{To: "craig", Host: "mac", At: "2026-10-16T18:40:00.000Z", Payload: `{"a":"<b>"}`})
	if err != nil || r.tools[0] != "putStatus" || r.args[0] != `{"to":"craig","host":"mac","at":"2026-10-16T18:40:00.000Z","payload":"{\"a\":\"<b>\"}"}` {
		t.Fatalf("%v %v %v", err, r.tools, r.args)
	}
	r.answer = `{"at":"x"}`
	if err := PutStatus(context.Background(), r.call, StatusInput{To: "craig"}); err == nil {
		t.Fatal("an ack without sk is a shape error")
	}
}

func TestSendCarriesTheFiveFields(t *testing.T) {
	r := &recorder{answer: `{"id":"01J","createdAt":"2026-10-16T18:40:00.000Z","waitUntil":null,"pushed":false,"quiet":false,"reason":"no device"}`}
	sent, err := Send(context.Background(), r.call, SendInput{To: "craig", From: "sunnyt", Host: "mac", Cwd: "sunnyt", Text: "hi"})
	if err != nil || sent.ID != "01J" || sent.Pushed || sent.Reason == nil || *sent.Reason != "no device" {
		t.Fatalf("%+v %v", sent, err)
	}
	if r.args[0] != `{"to":"craig","from":"sunnyt","host":"mac","cwd":"sunnyt","text":"hi"}` {
		t.Fatalf("%s", r.args[0])
	}
}

func TestDefaultCallerOverHTTPS(t *testing.T) {
	var auth, version string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		auth, version = req.Header.Get("authorization"), req.Header.Get("mcp-protocol-version")
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"prefs":{"quietHours":null,"away":true}}}}`))
	}))
	defer srv.Close()
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "hey.json"), []byte(`{"endpoint":"`+srv.URL+`/mcp"}`), 0o600)
	if err := writeCredentials(credentialsPath(home), credentials{Access: "acc", Refresh: "ref", ExpiresAt: "2099-01-01T00:00:00.000Z", Issuer: srv.URL}); err != nil {
		t.Fatal(err)
	}
	call, err := defaultCallerWith(home, srv.Client().Do)
	if err != nil {
		t.Fatal(err)
	}
	prefs, err := ReadPrefs(context.Background(), call, "craig")
	if err != nil || !prefs.Away || auth != "Bearer acc" || version != "2025-06-18" {
		t.Fatalf("%+v %v %q %q", prefs, err, auth, version)
	}
}

func TestDefaultCallerWithoutSignIn(t *testing.T) {
	call, err := DefaultCaller(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPrefs(context.Background(), call, "craig"); !errors.Is(err, ErrNotSignedIn) {
		t.Fatalf("%v", err)
	}
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "hey.json"), []byte(`{"endpoint": 5}`), 0o600)
	if _, err := DefaultCaller(home); err == nil {
		t.Fatal("a malformed hey.json must be an error, which nudge turns into a reason")
	}
}

func TestIconForm(t *testing.T) {
	cases := map[string]string{
		"sf:globe": "symbol", "sf:paperplane.fill": "symbol", "sf:bad name": "",
		"🦾": "emoji", "📣": "emoji", "✳": "emoji", "👩‍💻": "emoji", "A": "", "a 🦾": "", "😀😀😀😀😀😀😀😀😀": "",
		"https://github.com/propra-tech.png?size=64": "url", "http://x": "",
		"data:image/png;base64,AAAA": "data", "data:image/png;base64,AA!A": "",
	}
	for icon, want := range cases {
		if got := IconForm(icon); got != want {
			t.Errorf("IconForm(%q) = %q want %q", icon, got, want)
		}
	}
	if IconForm("data:image/png;base64,"+repeat("A", 40_000)) != "" {
		t.Error("a data URL over 32 KB is not an icon")
	}
}

func repeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}
```

- [ ] **Step 3: Run, watch them fail** — `go test ./internal/hey/` → build failure, `undefined: PutStatus`, `undefined: defaultCallerWith`.

- [ ] **Step 4: Implement**

`drovr.go`: `DefaultCaller(home)` = `defaultCallerWith(home, http.DefaultClient.Do)`; `defaultCallerWith` reads `readConfig(configPath(home))` and returns `toolCaller(callerDeps{http: do, endpoint: cfg.Endpoint, path: credentialsPath(home), now: time.Now})`. `Send`, `ReadPrefs`, `SetProfile` wrap the copied unexported calls and convert their structs. `PutStatus` posts `statusRequest{To, Host, At, Payload}` (that field order) and decodes with `decodeInto("putStatus", body, []string{"sk", "at", "expiresAt"}, false, func(a statusAck) error { return nonEmpty("sk", a.SK) })`, `statusAck` being a drovr-local `{SK string; At string; ExpiresAt float64}`.

`icon.go` ports `iconForm` in its order: `^sf:[A-Za-z0-9.]+$` → symbol; the `data:image/png;base64,` prefix → data when the whole string is ≤ 32 768 UTF-16 units and the rest matches `^[A-Za-z0-9+/]+={0,2}$`, else not an icon; `https://` → url when ≤ 2048 units and `url.Parse` succeeds; otherwise emoji when the rune count is 1..8, no rune is `unicode.IsSpace` (JS `\s`), and at least one rune is Extended_Pictographic. Go's `unicode` package has no Extended_Pictographic table, so `icon.go` carries one as a `*unicode.RangeTable` literal transcribed from Unicode 15.1 `emoji-data.txt` (the `; Extended_Pictographic` lines, roughly eighty ranges); its comment names the file and version so it can be re-transcribed when V8's ICU moves.

- [ ] **Step 5: Run, vet, fmt** — `go test ./internal/hey/ -count=1 && go vet ./... && gofmt -l .` → PASS, including `TestCopiesMatchTheHeyRepo` (or SKIP on a machine without the hey repo).

- [ ] **Step 6: Commit**

```bash
git add internal/hey
git commit -m "feat(go): hey's Go client copied from the hey repo with its tests, a drift check, and the four calls drovr makes"
```

---

### Task 7: `internal/nudge`

**Files:**
- Create: `internal/nudge/nudge.go`, `internal/nudge/nudge_test.go`
- Port from: `src/nudge.ts`

**Interfaces:**
- Consumes: `hey.Call`, `hey.DefaultCaller(home) (Call, error)`, `hey.Send`, `hey.ReadPrefs`, `hey.PutStatus`, `hey.ErrNotSignedIn`; `paths.Paths.Nudged(program)`, `paths.EnsureDirs`; `jsnum.Slice`, `jsnum.RoundHalfUp`.
- Produces:
  ```go
  package nudge
  type CallerFunc func() (hey.Call, error)
  func DefaultCaller() (hey.Call, error) // hey.DefaultCaller(os.UserHomeDir()): the tick's HOME is the user's
  // Channel is a Recipient plus what a send needs. The Caller is built inside every guard,
  // because a malformed ~/.config/hey.json must be a reason, never a throw into the tick.
  type Channel struct{ NotifyTo *string; Caller CallerFunc; Host string; Log io.Writer }
  type SendResult struct{ Sent bool; MessageID *string; Via string; Reason *string } // Via is always "hey"
  type PublishResult struct{ Sent bool; Reason *string }
  type PhonePrefs struct{ Away bool; Warning *string }
  type Neglect struct{ Program string; Asks float64; AskedAt, Now epoch.Millis; AfterMinutes float64; AsksURL *string }
  func AlertFrom(program *string, host string) string
  func (c Channel) TextCraig(ctx context.Context, message, from string) SendResult
  func (c Channel) PublishStatus(ctx context.Context, at, payload string) PublishResult
  func (c Channel) PhonePrefs(ctx context.Context) PhonePrefs
  func (c Channel) NudgeIfNeglected(ctx context.Context, p paths.Paths, out io.Writer, n Neglect) (bool, error)
  ```
  `TextCraig` keeps its name: it is the identifier the trap rows and the TS use, and a port keeps names.

- [ ] **Step 1: Write the failing tests**

`internal/nudge/nudge_test.go`:
```go
package nudge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/paths"
)

type fakeHey struct {
	tools []string
	fail  error
}

const sentAnswer = `{"id":"01J","createdAt":"2026-10-16T18:40:00.000Z","waitUntil":null,"pushed":true,"quiet":false,"reason":null}`

func (f *fakeHey) call(_ context.Context, tool string, _ any) (json.RawMessage, error) {
	f.tools = append(f.tools, tool)
	if f.fail != nil {
		return nil, f.fail
	}
	answers := map[string]string{"send": sentAnswer, "prefs": `{"prefs":{"quietHours":null,"away":true}}`, "putStatus": `{"sk":"status#drovr@mac","at":"x","expiresAt":1}`}
	return json.RawMessage(answers[tool]), nil
}

func (f *fakeHey) caller() (hey.Call, error) { return f.call, nil }

func craig() *string { s := "craig"; return &s }

func TestAlertFrom(t *testing.T) {
	p := "sunnyt"
	if AlertFrom(&p, "mac") != "sunnyt" || AlertFrom(nil, "mac") != "drovr on mac" {
		t.Fatal("labels")
	}
}

func TestNullNotifyToIsANamedReason(t *testing.T) {
	var log bytes.Buffer
	f := &fakeHey{}
	c := Channel{Caller: f.caller, Host: "mac", Log: &log}
	r := c.TextCraig(context.Background(), "something broke", "drovr on mac")
	if r.Sent || r.Reason == nil || *r.Reason != "notifyTo is null in control.json, so the alert was dropped" || len(f.tools) != 0 {
		t.Fatalf("%+v %v", r, f.tools)
	}
	if log.String() != "notifyTo is null in control.json, so the alert was dropped: something broke\n" {
		t.Fatalf("%q", log.String())
	}
	if p := c.PublishStatus(context.Background(), "at", "{}"); p.Sent || *p.Reason != "notifyTo is null in control.json" {
		t.Fatalf("%+v", p)
	}
	if pr := c.PhonePrefs(context.Background()); pr.Away || pr.Warning != nil {
		t.Fatalf("no handle is no phone, not a warning: %+v", pr)
	}
	if log.Len() != len("notifyTo is null in control.json, so the alert was dropped: something broke\n") {
		t.Fatal("a null notifyTo publish is quiet")
	}
}

func TestSendsAndReads(t *testing.T) {
	f := &fakeHey{}
	c := Channel{NotifyTo: craig(), Caller: f.caller, Host: "mac", Log: &bytes.Buffer{}}
	if r := c.TextCraig(context.Background(), "hi", "sunnyt"); !r.Sent || *r.MessageID != "01J" || r.Via != "hey" {
		t.Fatalf("%+v", r)
	}
	if p := c.PublishStatus(context.Background(), "2026-10-16T18:40:00.000Z", "{}"); !p.Sent || p.Reason != nil {
		t.Fatalf("%+v", p)
	}
	if pr := c.PhonePrefs(context.Background()); !pr.Away || pr.Warning != nil {
		t.Fatalf("%+v", pr)
	}
}

func TestFailuresAreReasonsNeverThrows(t *testing.T) {
	var log bytes.Buffer
	f := &fakeHey{fail: errors.New("The security token included in the request is expired")}
	c := Channel{NotifyTo: craig(), Caller: f.caller, Host: "mac", Log: &log}
	if p := c.PublishStatus(context.Background(), "at", "{}"); p.Sent || !strings.Contains(*p.Reason, "security token") {
		t.Fatalf("%+v", p)
	}
	if pr := c.PhonePrefs(context.Background()); pr.Away || !strings.HasPrefix(*pr.Warning, "could not read the phone's prefs (The security token") || !strings.HasSuffix(*pr.Warning, "— this pass runs on the stored mode") {
		t.Fatalf("%+v", pr)
	}
}

func TestWithoutSignInEveryPathNamesHeyLogin(t *testing.T) {
	home := t.TempDir()
	var log bytes.Buffer
	c := Channel{NotifyTo: craig(), Caller: func() (hey.Call, error) { return hey.DefaultCaller(home) }, Host: "mac", Log: &log}
	if r := c.TextCraig(context.Background(), "x", "drovr on mac"); r.Sent || !strings.Contains(*r.Reason, "run hey login") {
		t.Fatalf("%+v", r)
	}
	if !strings.Contains(log.String(), "— run hey login in a terminal as ") {
		t.Fatalf("sign-in hint missing: %q", log.String())
	}
	if pr := c.PhonePrefs(context.Background()); !strings.Contains(*pr.Warning, "run hey login") {
		t.Fatalf("%+v", pr)
	}
}

func TestPublishStatusMalformedConfigIsAReason(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "hey.json"), []byte(`{"endpoint": 5}`), 0o600)
	c := Channel{NotifyTo: craig(), Caller: func() (hey.Call, error) { return hey.DefaultCaller(home) }, Host: "mac", Log: &bytes.Buffer{}}
	if p := c.PublishStatus(context.Background(), "at", "{}"); p.Sent || !strings.Contains(*p.Reason, "hey.json") {
		t.Fatalf("%+v", p)
	}
}

func TestNudgeOncePerAsk(t *testing.T) {
	p := paths.Paths{Base: t.TempDir()}
	f := &fakeHey{}
	c := Channel{NotifyTo: craig(), Caller: f.caller, Host: "mac", Log: &bytes.Buffer{}}
	var out bytes.Buffer
	n := Neglect{Program: "sunnyt", Asks: 2, AskedAt: 0, Now: 239 * 60_000, AfterMinutes: 240}
	if sent, err := c.NudgeIfNeglected(context.Background(), p, &out, n); err != nil || sent {
		t.Fatalf("before the window: %v %v", sent, err)
	}
	n.Now = 5 * 3_600_000
	if sent, err := c.NudgeIfNeglected(context.Background(), p, &out, n); err != nil || !sent {
		t.Fatalf("%v %v", sent, err)
	}
	if sent, _ := c.NudgeIfNeglected(context.Background(), p, &out, n); sent {
		t.Fatal("one nudge per ask, not one per tick")
	}
	raw, _ := os.ReadFile(p.Nudged("sunnyt"))
	if string(raw) != `{"askedAt":0,"sentAt":18000000}`+"\n" || out.String() != "sent hey about sunnyt (2 ask(s), blocked 5h)\n" {
		t.Fatalf("%q %q", raw, out.String())
	}
	n.AskedAt = 60_000
	if sent, _ := c.NudgeIfNeglected(context.Background(), p, &out, n); !sent {
		t.Fatal("a new ask is nudged again")
	}
	if strings.Count(strings.Join(f.tools, ","), "send") != 2 {
		t.Fatalf("%v", f.tools)
	}
}
```

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/nudge/` → build failure.

- [ ] **Step 3: Implement**

Straight port. `TextCraig` logs and returns on a nil `NotifyTo` (`<reason>: <first 80 UTF-16 units>`); otherwise, inside one guard, `c.Caller()` then `hey.Send(ctx, call, SendInput{To, From: from, Host: c.Host, Cwd: from, Text: message})`; a send that was not pushed logs `sent <id>, but push failed: <reason or "no reason given">`; any error logs `could not send through hey: <detail><hint>` where the hint, for `errors.Is(err, hey.ErrNotSignedIn)`, is ` — run hey login in a terminal as <user.Current().Username>, so the tick's HOME has the credentials file`. `PublishStatus` and `PhonePrefs` as the TS (comments `// swallowed: best-effort, a window onto the tick must never take it down`). `NudgeIfNeglected`: nil `NotifyTo` → false; inside the window → false; `nudged.json` present with the same `askedAt` → false (an unparseable file is returned as an error, as the TS `JSON.parse` throws); message `drovr: <p> has been blocked <h>h on <asks> unanswered ask(s).` plus ` <url>` when given, `h = RoundHalfUp((now-askedAt)/3.6e6)`, `asks` formatted with `strconv.FormatFloat(v, 'f', -1, 64)`; sent with `from = AlertFrom(&program, c.Host)`; not sent → false; then `EnsureDirs`, write `{"askedAt":…,"sentAt":…}\n` in place, log `sent hey about <p> (<asks> ask(s), blocked <h>h)` to `out`.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/nudge/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/nudge
git commit -m "feat(go): nudge — textCraig, the status row, the phone's Away and the neglected-ask nudge, every failure a reason"
```

---

### Task 8: `internal/usage` — the sampler

**Files:**
- Create: `internal/usage/usage.go`, `internal/usage/usage_test.go`
- Port from: `src/usage.ts` (`sampleUsage`, `appendSample`, `prune`, `readSamples`). `shareOf`, `sharesOf`, `observedYours` move with `drovr usage` in E3: nothing in E2 reads a share.

**Interfaces:**
- Consumes: `teamclaude.Status`, `capacity.IsUsable(a, now) bool`, `epoch.ISO`, `shape`.
- Produces:
  ```go
  package usage
  const MaxBytes int64 = 8 << 20
  type AccountSample struct {
      Name    string  `json:"name"`
      Usable  bool    `json:"usable"`
      Fable   float64 `json:"fable"`
      General float64 `json:"general"`
      Session float64 `json:"session"`
      FableReset   *epoch.Millis `json:"fableReset"`
      GeneralReset *epoch.Millis `json:"generalReset"`
      SessionReset *epoch.Millis `json:"sessionReset"`
  }
  type Sample struct { V int `json:"v"`; At string `json:"at"`; Accounts []AccountSample `json:"accounts"` }
  func SampleOf(s teamclaude.Status, now epoch.Millis) Sample
  func Append(path string, s Sample, maxBytes int64) error // one O_APPEND line, then the prune
  func ReadSamples(path string) ([]Sample, error)          // strict: "<path>:<n> is not a valid usage sample: <why>"
  ```

- [ ] **Step 1: Write the failing tests**

```go
package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/teamclaude"
)

const now = epoch.Millis(1787400000000) // 2026-08-22T12:00:00.000Z

func f(v float64) *float64           { return &v }
func ms(v epoch.Millis) *epoch.Millis { return &v }

func TestSampleOfRecordsEveryAccount(t *testing.T) {
	s := teamclaude.Status{Accounts: []teamclaude.Account{
		{Name: "a", Quota: teamclaude.Quota{Unified7dFable: f(0.4), Unified7dFableReset: ms(now + 3_600_000)}},
		{Name: "b", Disabled: true},
	}}
	got := SampleOf(s, now)
	a, b := got.Accounts[0], got.Accounts[1]
	if got.V != 1 || got.At != "2026-08-22T12:00:00.000Z" || !a.Usable || a.Fable != 0.4 || a.General != 0 || a.Session != 0 || *a.FableReset != now+3_600_000 || a.GeneralReset != nil || b.Usable {
		t.Fatalf("%+v", got)
	}
}

func TestReadSamplesRoundTripsAndRefuses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	if got, err := ReadSamples(filepath.Join(dir, "nothing.jsonl")); err != nil || len(got) != 0 {
		t.Fatalf("absent is empty: %v %v", got, err)
	}
	in := SampleOf(teamclaude.Status{Accounts: []teamclaude.Account{{Name: "a"}}}, now)
	if err := Append(path, in, MaxBytes); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"v":1,"at":"2026-08-22T12:00:00.000Z","accounts":[{"name":"a","usable":true,"fable":0,"general":0,"session":0,"fableReset":null,"generalReset":null,"sessionReset":null}]}`+"\n" {
		t.Fatalf("%s", raw)
	}
	os.WriteFile(path, append(raw, []byte(`{"v":2,"at":"x","accounts":[]}`+"\n")...), 0o644)
	if _, err := ReadSamples(path); err == nil || !strings.Contains(err.Error(), "usage.jsonl:2 is not a valid usage sample") {
		t.Fatalf("%v", err)
	}
}

func TestAppendBoundsTheLog(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	for i := 0; i < 200; i++ {
		s := SampleOf(teamclaude.Status{Accounts: []teamclaude.Account{{Name: "a", Quota: teamclaude.Quota{Unified7d: f(float64(i) / 1000)}}}}, now+epoch.Millis(i)*60_000)
		if err := Append(path, s, 4_000); err != nil {
			t.Fatal(err)
		}
	}
	info, _ := os.Stat(path)
	got, err := ReadSamples(path)
	if err != nil || info.Size() > 4_000 || len(got) == 0 || len(got) >= 200 {
		t.Fatalf("size %d, %d samples, %v", info.Size(), len(got), err)
	}
	if got[len(got)-1].At != epoch.ISO(now+199*60_000) || got[0].At <= epoch.ISO(now) {
		t.Fatal("the newest must survive a prune and the oldest go")
	}
	strays, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if len(strays) != 0 {
		t.Fatalf("staging files left: %v", strays)
	}
}
```

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/usage/` → build failure.

- [ ] **Step 3: Implement**

`SampleOf` maps every account (nil bucket → 0). `Append` encodes the sample (no HTML escape, one line) through `ledger.AppendRecord`, then `prune`: stat ≤ max → done; else read, keep non-blank lines `lines[len/2:]`, write `<path>.<pid>.tmp`, rename over `path`, and on any failure remove the staging file and return the error. `ReadSamples` decodes each line with `shape` (`v` literal 1, `at` string, `accounts` array of the eight fields, the three resets `RequiredNullable`) and names `<path>:<line>`; a line that is not JSON is the same refusal.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/usage/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/usage
git commit -m "feat(go): the usage sampler — one line per tick, bounded by bytes, pruned to the newest half through a rename"
```

---

### Task 9: `internal/keys` — control.json writes that keep Node's bytes

**Files:**
- Create: `internal/keys/doc.go` (an insertion-ordered JSON object), `internal/keys/keys.go`, `internal/keys/keys_test.go`
- Port from: `src/keys.ts`, and `cli.ts`'s own `mutate` (as `MutateInPlace`, for `drovr report` in Task 17)

**Interfaces:**
- Consumes: `control.Parse(data []byte) (Control, error)`, `control.Read`, `control.OrderCeilings(map[string]Ceiling, edited string) map[string]Ceiling`, `control.DefaultCeilings`, `control.Modes`, `control.Mode`.
- Produces:
  ```go
  package keys
  // Doc is a JSON object that remembers key order, so a rewrite is JSON.stringify(raw, null, 2)
  // of what JSON.parse read: same keys in the same order, numbers in shortest form, nulls kept.
  type Doc struct{ /* keys []string; vals map[string]any — values are *Doc, []any, string, float64, bool or nil */ }
  func (d *Doc) Get(key string) (any, bool)
  func (d *Doc) Set(key string, v any) // new keys append, existing keep their place
  func ProgramAt(d *Doc, name string) (*Doc, error) // "control.programs is not an array" | `no program named "x"`
  type Action struct{ Message string; Redraw, Quit, Fresh bool }
  func Mutate(path string, change func(*Doc) error) (control.Control, error)        // validate, then stage <path>.<pid>.tmp and rename
  func MutateInPlace(path string, change func(*Doc) error) (control.Control, error) // cli.ts's mutate: validate, then write in place
  func CycleMode(path string, current control.Mode) (Action, error)
  func CyclePause(path string, current *string, now epoch.Millis) (Action, error)
  func ExtendPause(path string, current *string, now epoch.Millis) (Action, error)
  func ToggleEnabled(path, name string) (Action, error)
  func NudgePriority(path, name string, delta float64) (Action, error)
  func SetReserve(path, mode string, fraction float64) (Action, error)
  func AdjustConcurrency(path string, delta float64) (Action, error)
  func SetMode(path, mode string) (Action, error)
  func PauseForHours(path string, hours float64, now epoch.Millis) (Action, error)
  func SetEnabled(path, name string, enabled bool) (Action, error)
  func NudgeReserve(path string, delta float64) (Action, error)
  ```
  `now` is a parameter where the TS read `Date.now()`, so the tests are not racing a clock. Ruling: Go's encoder writes U+2028/U+2029 as ` `/` ` where `JSON.stringify` writes them raw — the one accepted divergence, as in the hey CLI.

- [ ] **Step 1: Write the failing tests**

```go
package keys

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
)

const now = epoch.Millis(1787400000000)

func scratch(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "control.json")
	if body == "" {
		body = `{"mode":"normal","pauseUntil":null,"programs":[{"name":"sunnyt","cwd":"/s","priority":0},{"name":"joinery","cwd":"/j","priority":2}]}`
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func read(t *testing.T, path string) control.Control {
	t.Helper()
	c, err := control.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestMutateKeepsKeyOrderAndNodeFormatting(t *testing.T) {
	path := scratch(t, `{"programs":[{"cwd":"/s","name":"sunnyt","maxCyclesPerDay":null,"x":1.50}],"mode":"normal","reserveCycles":0.5,"notifyTo":"craig","note":"café <ok> é"}`)
	if _, err := SetMode(path, "away"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	want := "{\n  \"programs\": [\n    {\n      \"cwd\": \"/s\",\n      \"name\": \"sunnyt\",\n      \"maxCyclesPerDay\": null,\n      \"x\": 1.5\n    }\n  ],\n  \"mode\": \"away\",\n  \"reserveCycles\": 0.5,\n  \"notifyTo\": \"craig\",\n  \"note\": \"café <ok> é\"\n}\n"
	if string(got) != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestModeCyclesAndWraps(t *testing.T) {
	path := scratch(t, "")
	for _, want := range []control.Mode{"away", "off", "low", "normal"} {
		if _, err := CycleMode(path, read(t, path).Mode); err != nil {
			t.Fatal(err)
		}
		if read(t, path).Mode != want {
			t.Fatalf("want %s got %s", want, read(t, path).Mode)
		}
	}
}

func TestPauseTogglesRatherThanStacks(t *testing.T) {
	path := scratch(t, "")
	a, _ := CyclePause(path, nil, now)
	if a.Message != "paused 1h" || *read(t, path).PauseUntil != epoch.ISO(now+3_600_000) {
		t.Fatalf("%+v", a)
	}
	a, _ = CyclePause(path, read(t, path).PauseUntil, now)
	if a.Message != "pause cleared" || read(t, path).PauseUntil != nil {
		t.Fatalf("%+v", a)
	}
	past := epoch.ISO(now - 1)
	if a, _ = CyclePause(path, &past, now); a.Message != "paused 1h" {
		t.Fatal("an expired pause starts a fresh one")
	}
	if a, _ = PauseForHours(path, 5, now); a.Message != "paused 5h" {
		t.Fatalf("%+v", a)
	}
	for _, h := range []float64{0.5, 73} {
		if _, err := PauseForHours(path, h, now); err == nil {
			t.Errorf("%vh accepted", h)
		}
	}
}

func TestProgramEditsAreClampedAndRefusedCleanly(t *testing.T) {
	path := scratch(t, "")
	ToggleEnabled(path, "sunnyt")
	if read(t, path).Programs[0].Enabled {
		t.Fatal("toggle")
	}
	SetEnabled(path, "sunnyt", true)
	SetEnabled(path, "sunnyt", true)
	if !read(t, path).Programs[0].Enabled {
		t.Fatal("setEnabled is a set, not a flip")
	}
	NudgePriority(path, "sunnyt", 30)
	AdjustConcurrency(path, -7)
	if read(t, path).Programs[0].Priority != 9 || read(t, path).MaxConcurrentCycles != 1 {
		t.Fatal("clamps")
	}
	before, _ := os.ReadFile(path)
	if _, err := SetEnabled(path, "nope", false); err == nil || !strings.Contains(err.Error(), `no program named "nope"`) {
		t.Fatalf("%v", err)
	}
	if _, err := SetMode(path, "loud"); err == nil || !strings.Contains(err.Error(), `unknown mode "loud"`) {
		t.Fatalf("%v", err)
	}
	after, _ := os.ReadFile(path)
	strays, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp"))
	if string(before) != string(after) || len(strays) != 0 {
		t.Fatal("a refused write changed the file or left a staging file")
	}
}

func TestSetReserveKeepsCeilingsOrdered(t *testing.T) {
	path := scratch(t, "")
	a, err := SetReserve(path, "normal", 0.45)
	if err != nil || a.Message != "normal: 45% held for you — programs up to 55% weekly, 40% per 5h" {
		t.Fatalf("%+v %v", a, err)
	}
	SetReserve(path, "low", 0.05)
	c := read(t, path)
	low, normal, away := c.Ceilings["low"], c.Ceilings["normal"], c.Ceilings["away"]
	if low.Weekly != 0.95 || !(low.Session <= normal.Session && normal.Session <= away.Session && low.Weekly <= normal.Weekly && normal.Weekly <= away.Weekly) {
		t.Fatalf("%+v %+v %+v", low, normal, away)
	}
	if _, err := SetReserve(path, "normal", 2); err != nil || read(t, path).Ceilings["normal"].Weekly != 0.050000000000000044 {
		t.Fatal("reserve is clamped to 0.95, so weekly is 1 - 0.95 as JS computes it")
	}
	off := scratch(t, `{"mode":"off","programs":[]}`)
	if _, err := NudgeReserve(off, 0.1); err == nil || !strings.Contains(err.Error(), "mode is off") {
		t.Fatalf("%v", err)
	}
}

func TestFailedRenameCleansUp(t *testing.T) {
	if _, err := exec.LookPath("chflags"); err != nil {
		t.Skip("chflags is macOS-only")
	}
	path := scratch(t, "")
	before, _ := os.ReadFile(path)
	if err := exec.Command("chflags", "uchg", path).Run(); err != nil {
		t.Fatal(err)
	}
	defer exec.Command("chflags", "nouchg", path).Run()
	if _, err := SetMode(path, "away"); err == nil {
		t.Fatal("the rename onto an immutable file must fail")
	}
	strays, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp"))
	after, _ := os.ReadFile(path)
	if len(strays) != 0 || string(after) != string(before) {
		t.Fatal("staging file survived or control.json was damaged")
	}
}
```
(This test imports `os/exec` to run `chflags`; `TestOnlyExecSpawns` skips `_test.go` files on purpose.) `0.050000000000000044` is what `node -e 'console.log(1 - 0.95)'` prints (checked 2026-10-23).

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/keys/` → build failure.

- [ ] **Step 3: Implement**

`doc.go`: decode with `json.Decoder.Token()` recursively — `{` builds a `*Doc` (keys in order; a repeated key keeps its first position and its last value, as `JSON.parse` does), `[` builds `[]any`, scalars are `string`, `float64`, `bool`, `nil`. Encode by hand: objects and arrays in order, scalars through an encoder with `SetEscapeHTML(false)`, then `json.Indent(out, compact, "", "  ")` and a trailing `"\n"` — `json.Indent` writes `[]` and `{}` for empties exactly as `JSON.stringify` does. Both under 60 lines.

`keys.go` ports each setter with its TS message and clamp. `Mutate` reads, decodes, applies `change`, encodes, validates with `control.Parse` (refused → nothing touches disk), writes `<path>.<pid>.tmp`, renames, and removes the staging file when either step fails. `SetReserve`: `reserve = clamp(fraction, 0.05, 0.95)`, `weekly = 1 - reserve`; ceilings seeded `{low, normal, away}` from `DefaultCeilings`, overlaid by the file's `ceilings` entries; `ratio = current.Session / current.Weekly` (1 when weekly is 0); `session = clamp(weekly*ratio, 0.05, 1)`; `control.OrderCeilings(…, mode)`; written back as a `*Doc` with keys `low, normal, away` first and any other mode after, in the file's order. `pct(v)` is `RoundHalfUp(v*100)` + `%`. `NudgeReserve` checks the delta range, reads, refuses `off`, falls back to `DefaultCeilings[mode]` then `normal`.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/keys/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/keys
git commit -m "feat(go): keys — control.json edits staged through a rename, written back in Node's key order and number form; ceilings kept ordered"
```

---

### Task 10: `internal/service` write side, and the shadow label

**Files:**
- Modify: `internal/service/service.go` (package comment: writing is here now), `internal/service/service_test.go`
- Create: `internal/service/write.go`, `internal/service/testdata/launchctl` (shim, `chmod +x`)
- Port from: `src/service.ts` (`agentPath`, `plist`, `reloadAgent`, `installAgent`)

**Interfaces:**
- Consumes: `exec.RunBounded`, `launchctlTimeout`, `PlistPathFor(label)`, `Label`, `StateFor(label)`.
- Produces:
  ```go
  package service
  const ShadowLabel = "tech.propra.drovr.shadow"
  const ShadowIntervalSeconds = 60
  type PlistInput struct {
      Label, Binary string
      Args          []string // ["tick"] or ["tick", "--shadow"]
      LogName       string   // "tick" or "tick-shadow": <logDir>/<LogName>.log and .err
      IntervalSeconds int
      LogDir, Path    string
  }
  func Plist(in PlistInput) string
  func AgentPath(inherited string) string // inherited PATH entries, then /opt/homebrew/bin /usr/local/bin /usr/bin /bin, de-duplicated in order
  func Self() (string, error)             // os.Executable resolved through filepath.EvalSymlinks
  type Reload string                      // "reloaded" | "loaded" | "failed"
  func ReloadAgent(ctx context.Context, label string) Reload
  func InstallAgent(ctx context.Context, in PlistInput) (Reload, error)
  func PlistBinary(plistPath string) (string, bool)          // the first <string> under ProgramArguments
  func BinaryMismatch(plistPath, self string) (string, bool) // the note status and service status print
  ```
  Rulings: `ProgramArguments` is `[<binary>, <args>…]` (spec, Launchd row) — `nodeBin` and `cliPath` go. The shadow agent fires every 60 s so every live decision has a shadow decision from the minute before it (Task 16 pairs them); it logs to `tick-shadow.log/.err` so its output never interleaves with the live tick's. `launchctl` calls are bounded (E1 ruling, `launchctlTimeout`).

- [ ] **Step 1: Write the failing tests**

`internal/service/testdata/launchctl`:
```sh
#!/bin/sh
# Test shim: logs argv; `list <label>` succeeds only while $LAUNCHCTL_DIR/<label>.loaded exists;
# bootout removes that file, bootstrap creates it unless $LAUNCHCTL_DIR/refuse exists.
echo "$*" >> "$LAUNCHCTL_DIR/calls.log"
case "$1" in
  list) [ -f "$LAUNCHCTL_DIR/$2.loaded" ] && { echo '{ "PID" = 1; "LastExitStatus" = 0; };'; exit 0; }; exit 113 ;;
  bootout) rm -f "$LAUNCHCTL_DIR/${2##*/}.loaded"; exit 0 ;;
  bootstrap) [ -f "$LAUNCHCTL_DIR/refuse" ] && exit 5; : > "$LAUNCHCTL_DIR/$(basename "$3" .plist).loaded"; exit 0 ;;
esac
```
Append to `internal/service/service_test.go`:
```go
func TestPlistNamesTheBinaryAndItsLogs(t *testing.T) {
	got := Plist(PlistInput{Label: ShadowLabel, Binary: "/opt/homebrew/bin/drovr", Args: []string{"tick", "--shadow"}, LogName: "tick-shadow", IntervalSeconds: 60, LogDir: "/Users/x/.drovr/logs", Path: "/opt/homebrew/bin:/usr/bin"})
	want := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>tech.propra.drovr.shadow</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/drovr</string>
    <string>tick</string>
    <string>--shadow</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/Users/x/.drovr/logs/tick-shadow.log</string>
  <key>StandardErrorPath</key><string>/Users/x/.drovr/logs/tick-shadow.err</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string></dict>
</dict>
</plist>
`
	if got != want {
		t.Fatalf("got\n%s", got)
	}
	path := filepath.Join(t.TempDir(), "x.plist")
	os.WriteFile(path, []byte(got), 0o644)
	if bin, ok := PlistBinary(path); !ok || bin != "/opt/homebrew/bin/drovr" {
		t.Fatalf("%s %v", bin, ok)
	}
	if _, differs := BinaryMismatch(path, "/opt/homebrew/bin/drovr"); differs {
		t.Fatal("same binary reported as moved")
	}
	if note, differs := BinaryMismatch(path, "/usr/local/bin/drovr"); !differs || note != "note: the launchd agent runs /opt/homebrew/bin/drovr but this is /usr/local/bin/drovr — re-run: drovr service install" {
		t.Fatalf("%q", note)
	}
}

func TestAgentPathKeepsTheShellsOrderThenTheStandardDirs(t *testing.T) {
	if got := AgentPath("/Users/x/Library/pnpm:/usr/bin::/opt/homebrew/bin"); got != "/Users/x/Library/pnpm:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin" {
		t.Fatal(got)
	}
}

func shimLaunchctl(t *testing.T) string {
	dir := t.TempDir()
	bin, _ := filepath.Abs("testdata")
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("LAUNCHCTL_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	return dir
}

func TestInstallReloadsALoadedAgent(t *testing.T) {
	dir := shimLaunchctl(t)
	in := PlistInput{Label: Label, Binary: "/b/drovr", Args: []string{"tick"}, LogName: "tick", IntervalSeconds: 600, LogDir: "/l", Path: "/usr/bin"}
	if got, err := InstallAgent(context.Background(), in); err != nil || got != "loaded" {
		t.Fatalf("%s %v", got, err)
	}
	if got, _ := InstallAgent(context.Background(), in); got != "reloaded" {
		t.Fatalf("a rewrite over a loaded agent must boot it out and back in: %s", got)
	}
	log, _ := os.ReadFile(filepath.Join(dir, "calls.log"))
	if !strings.Contains(string(log), fmt.Sprintf("bootout gui/%d/tech.propra.drovr", os.Getuid())) {
		t.Fatalf("%s", log)
	}
	os.WriteFile(filepath.Join(dir, "refuse"), nil, 0o644)
	if got, _ := InstallAgent(context.Background(), in); got != "failed" {
		t.Fatalf("%s", got)
	}
}
```
(`context`, `fmt`, `os`, `path/filepath`, `strings` join the test imports.)

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/service/` → build failure.

- [ ] **Step 3: Implement**

`Plist` is the TS template with the `ProgramArguments` array built from `Binary` and `Args` (each as `    <string>…</string>`), log paths `filepath.Join(LogDir, LogName+".log")`. `ReloadAgent`: domain `gui/<os.Getuid()>`; `wasLoaded` = `launchctl list <label>` succeeded; if loaded, `bootout <domain>/<label>` (its failure is ignored, as the TS's `launchctl()` returns false and nothing reads it — `// swallowed: the bootstrap below is what decides`); `bootstrap <domain> <plist>`; failed → `failed`, else `reloaded`/`loaded`. `InstallAgent` creates `~/Library/LaunchAgents`, writes the plist in place, reloads. `PlistBinary` reads the first `<string>` after `<key>ProgramArguments</key>` with a regexp. `BinaryMismatch` returns the note only when the plist exists and its binary differs from `self`.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/service/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/service
git commit -m "feat(go): the launchd agent written for the Go binary, reloaded on every install, a shadow label beside it"
```

---
### Task 11: `internal/state` — `buildState` and `collectState`

`drovr watch` (E3) is the only renderer of this state, but `collectState` is where the orca, asks-URL and phone probes meet `decide()`, so it lands with the adapters and is proven here.

**Files:**
- Create: `internal/state/state.go` (`Build`, the types), `internal/state/collect.go` (`Collector`), `internal/state/state_test.go`
- Port from: `src/state.ts`

**Interfaces:**
- Consumes: `control.ApplyAwayMode`, `control.ByPriority`, `control.CeilingsFor`, `control.EffectivePriority`; `capacity.PoolFrom`, `capacity.HoursToWeeklyReset`; `decide.Decide`, `decide.CyclesFundableFrom`, `decide.ContributingAccounts`, `decide.PoolContext`; `ledger.InFlight`, `ledger.EstimateCycleCost(cycles, seed, 3, 0.9)`, `ledger.ChargeForRunning`, `ledger.ReadCycles`, `ledger.ReadTickStamp`, `ledger.LastDecisionAt`; `allocation.SegmentsFor`; `status.AccountsFrom`; `lock.Holder`; `service.Current()`; `teamclaude.Read`; `orca.(*Client).RunnerIsPresent`, `ReadPreview`, `AiceBaseURL`; `nudge.Channel.PhonePrefs`; `preview.Preview`; `jsnum.ToFixed`.
- Produces:
  ```go
  package state
  type Context struct{ Percent, Tokens, Subagents *float64 } // json percent, tokens, subagents
  type ProgramState struct { Name string; Enabled bool; Priority float64; Verdict string; Reason string; Kind, StartedAt *string; Pid *int; AsksURL *string; Context *Context; Preview []string }
  type ServiceState struct { Loaded bool; IntervalSeconds *int; LastTickAt *string; Overdue bool }
  type PoolState struct { UsableAccounts, FundingAccounts int; Fable, General, Session float64 }
  type RecentCycle struct { StartedAt, Program, Kind, Exit string; AsksRaised float64 }
  type DrovrState struct {
      SchemaVersion int; GeneratedAt string; Mode control.Mode; ModeFromPhone bool; PauseUntil *string
      MaxConcurrentCycles, Reserve float64; CyclesInFlight int; Service ServiceState; Pool PoolState
      BindingBucket capacity.Bucket; CyclesFundable float64; BindingRecoveryAt *string; CapacityNote string
      HoursToWeeklyReset *float64; Allocation allocation.Segments; Programs []ProgramState
      Accounts []status.Account; RecentCycles []RecentCycle
  } // json tags camelCase in this order, as the TS type
  type ServiceInput struct{ Loaded bool; IntervalSeconds *int; LastTickAt *epoch.Millis }
  type Input struct {
      Status teamclaude.Status; Control control.Control; Cycles []ledger.Cycle; Now epoch.Millis
      Service ServiceInput; Previews map[string]preview.Preview
      Runners map[string]bool // absent key = unknown
      AwayFromPhone bool; Locks map[string]int; AsksURLs map[string]string
  }
  func Build(in Input) (DrovrState, error)
  type Collector struct {
      Paths paths.Paths; Orca *orca.Client; Caller nudge.CallerFunc; Host, TeamclaudeBin string
      Now func() epoch.Millis
      // unexported: the last probe set and when it was taken
  }
  // Collect reads the world and builds the state. onWarning is required: fold it into a frame,
  // print it, or pass func(string){} to drop it on purpose — never by omission.
  func (c *Collector) Collect(ctx context.Context, onWarning func(string), probeMaxAge time.Duration) (DrovrState, error)
  ```

- [ ] **Step 1: Write the failing tests**

```go
package state

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/teamclaude"
)

const now = epoch.Millis(1787400000000)

func input(t *testing.T) Input {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/teamclaude-status.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := teamclaude.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	c, err := control.Parse([]byte(`{"programs":[{"name":"demo","cwd":"/tmp/demo"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	iv, last := 600, now-60_000
	return Input{Status: s, Control: c, Now: now, Service: ServiceInput{Loaded: true, IntervalSeconds: &iv, LastTickAt: &last}}
}

func TestBuildEnvelopeRoundingAndPrograms(t *testing.T) {
	st, err := Build(input(t))
	if err != nil {
		t.Fatal(err)
	}
	if st.SchemaVersion != 1 || st.GeneratedAt != "2026-08-22T12:00:00.000Z" || len(st.Programs) != 1 || st.Programs[0].Name != "demo" {
		t.Fatalf("%+v", st)
	}
	for _, v := range []float64{st.Pool.Fable, st.Pool.General, st.Pool.Session} {
		if v*1e4 != float64(int64(v*1e4+0.5)) && v*1e4 != float64(int64(v*1e4)) {
			t.Errorf("%v carries more than four places", v)
		}
	}
	if st.Service.Overdue {
		t.Error("a tick a minute ago is not overdue")
	}
}

func TestBuildMarksOverdueAndRun(t *testing.T) {
	in := input(t)
	stale := now - 4*600_000
	in.Service.LastTickAt = &stale
	in.Cycles = []ledger.Cycle{{V: 1, Kind: "delivery", Program: "demo", StartedAt: epoch.ISO(now - 3_600_000), Exit: "running"}}
	st, err := Build(in)
	if err != nil || !st.Service.Overdue || st.Programs[0].Verdict != "RUN" || *st.Programs[0].StartedAt != epoch.ISO(now-3_600_000) || st.CyclesInFlight != 1 {
		t.Fatalf("%+v %v", st, err)
	}
}

func TestBuildUnderThePhonesAway(t *testing.T) {
	in := input(t)
	in.AwayFromPhone = true
	st, _ := Build(in)
	if st.Mode != "away" || !st.ModeFromPhone || st.Reserve != 0.15 {
		t.Fatalf("%s %v %v", st.Mode, st.ModeFromPhone, st.Reserve)
	}
	plain, _ := Build(input(t))
	if plain.Mode != "normal" || plain.ModeFromPhone {
		t.Fatal("no away, no override")
	}
}

func collector(t *testing.T) (*Collector, string) {
	t.Helper()
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "control.json"), []byte(`{"notifyTo":null,"programs":[{"name":"demo","cwd":"/tmp/demo"}]}`), 0o644)
	p := paths.Paths{Base: home, Control: filepath.Join(home, "control.json"), Cycles: filepath.Join(home, "cycles.jsonl"), Decisions: filepath.Join(home, "decisions.jsonl"), LastTick: filepath.Join(home, "last-tick.json")}
	answers := t.TempDir()
	orcaBin, _ := filepath.Abs("../orca/testdata")
	bin, _ := filepath.Abs("../../testdata/bin") // teamclaude and launchctl shims
	t.Setenv("PATH", orcaBin+":"+bin+":"+os.Getenv("PATH"))
	t.Setenv("ORCA_ANSWERS", answers)
	os.WriteFile(filepath.Join(answers, "terminal_show.json"), []byte(`{"ok":true,"result":{"terminal":{"handle":"term_1","agentIdentity":"claude","agentWait":null}}}`), 0o644)
	os.WriteFile(filepath.Join(answers, "terminal_wait_exit.json"), []byte(`{"ok":false,"error":{"code":"timeout"}}`), 0o644)
	o := orca.NewClient(p, os.Stderr)
	os.MkdirAll(p.ProgramState("demo"), 0o755)
	orca.RememberTerminal(p, "demo", orca.Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	return &Collector{Paths: p, Orca: o, Host: "mac", Now: func() epoch.Millis { return now }}, answers
}

func TestCollectRequiresASink(t *testing.T) {
	c, _ := collector(t)
	defer func() {
		if recover() == nil {
			t.Fatal("a nil onWarning must panic: dropping a warning is a choice the caller makes out loud")
		}
	}()
	c.Collect(context.Background(), nil, 0)
}

func TestCollectNeverProbesIdle(t *testing.T) {
	c, answers := collector(t)
	st, err := c.Collect(context.Background(), func(string) {}, 0)
	if err != nil || st.Programs[0].Verdict == "GO" {
		t.Fatalf("a present runner holds the program: %+v %v", st.Programs, err)
	}
	log, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
	if strings.Contains(string(log), "tui-idle") {
		t.Fatalf("presence must not pay the idle probe:\n%s", log)
	}
}

func TestProbesReusedOnlyInsideTheWindow(t *testing.T) {
	c, answers := collector(t)
	count := func() int {
		log, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
		return strings.Count(string(log), "terminal show")
	}
	c.Collect(context.Background(), func(string) {}, 0)
	perCollect := count() // runnerTerminal's show, then runnerIsPresent's
	c.Collect(context.Background(), func(string) {}, 0)
	if perCollect == 0 || count() != 2*perCollect {
		t.Fatalf("window 0 must probe fresh every call: %d then %d", perCollect, count())
	}
	c.Collect(context.Background(), func(string) {}, time.Minute)
	if count() != 2*perCollect {
		t.Fatalf("inside the window the probe is reused: %d", count())
	}
	os.WriteFile(c.Paths.Control, []byte(`{"mode":"low","notifyTo":null,"programs":[{"name":"demo","cwd":"/tmp/demo"}]}`), 0o644)
	if st, _ := c.Collect(context.Background(), func(string) {}, time.Minute); st.Mode != "low" {
		t.Fatal("the cheap half (control.json) is re-read on every call")
	}
}
```
`testdata/bin/teamclaude` cats the shared status fixture; `testdata/bin/launchctl` answers `list`. `Collector.Paths` here is a hand-built `paths.Paths`; `ProgramState`/`CycleTerminal` derive from `Base`.

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/state/` → build failure.

- [ ] **Step 3: Implement**

`Build` is `buildState` line for line: `r(v, places)` is `strconv.ParseFloat(jsnum.ToFixed(v, places), 64)`; ceilings fall back to `{0, 0}` for `off`; funding is `decide.CyclesFundableFrom(pool, cost, ledger.ChargeForRunning(inFlight, pool.Snapshot(), cost))` — the charged figure, never the count (trap row); `bindingRecoveryAt` from `pool.ResetAt.Of(funding.Binding)`; `capacityNote` is `decide.PoolContext(funding, pool, now)`; recent cycles are the last eight ended records, newest first. `programsOf` books a projected start record for each `GO` of an enabled program with nothing live, and passes `RunnerPresent` only for a program in `Runners`.

`Collect` asserts `onWarning != nil` (panic), reads control and cycles every call, reuses the last probe set (status, previews, runners, warnings, phone) only when `now - at < probeMaxAge`, replaying its warnings through `onWarning`. The per-program probes (asks URL — `AiceBaseURL` for an aice page, `file://` + absolute path for a local asks file; `RunnerIsPresent` for an orca runner, an error becoming a warning `could not read <p>'s runner state: <err>` and leaving the key absent; `ReadPreview` only for a program with a cycle in flight) run concurrently, one goroutine per program writing its own slot of a results slice, joined with a `sync.WaitGroup` — the TS `Promise.all`, with no shared map written from two goroutines. The phone's warning is appended after the program probes, as the TS does.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/state/ -count=1 -race && go vet ./... && gofmt -l .` → PASS (the race detector covers the per-program fan-out).

- [ ] **Step 5: Commit**

```bash
git add internal/state
git commit -m "feat(go): state — the frame's numbers from the same calls decide() makes, probes cached only inside the caller's window"
```

---

### Task 12: `internal/transcript` and `internal/profile`

**Files:**
- Create: `internal/transcript/transcript.go`, `internal/transcript/transcript_test.go`, `internal/profile/profile.go`, `internal/profile/profile_test.go`
- Port from: `src/transcript.ts`, `src/profile.ts`

**Interfaces:**
- Consumes: `exec.RunSsh(ctx, target, command, timeout)`; `control.Host`, `control.Program`; `hey.IconForm`, `hey.SetProfile`, `hey.ProfileInput`; `nudge.CallerFunc`; `orca.(*Client).ListRepos`, `WorktreeRepoID`; `paths.Paths.ProfileSeeded`, `paths.EnsureDirs`; `jsnum.Slice`.
- Produces:
  ```go
  package transcript
  const ClosingMaxChars = 4000
  func ClosingFrom(jsonl string) *string // the last non-blank assistant text block, trimmed, cut at 4000 UTF-16 units; nil when none
  // ClosingMessage: nil when there is no transcript or it cannot be read (logged). An error only for
  // a session id that is not a UUID on a hosted program, where it would be interpolated into a shell.
  func ClosingMessage(ctx context.Context, home, sessionID string, host *control.Host, log io.Writer) (*string, error)

  package profile
  var LucideToSF = map[string]string{ /* the 18 entries of LUCIDE_TO_SF, verbatim */ }
  type Patch struct {
      Icon    *string `json:"icon,omitempty"`
      Color   *string `json:"color,omitempty"`
      Summary *string `json:"summary,omitempty"`
  } // icon, color, summary: the order the TS assigns them, which is the order JSON.stringify writes
  func FromRepo(repo json.RawMessage, description *string) *Patch // lenient: nil for nothing to seed or an unknown repo shape
  func FindRepo(repos []json.RawMessage, repoID string) json.RawMessage // first 500 only; nil when absent
  type SeedInput struct {
      Paths paths.Paths; Orca *orca.Client; Caller nudge.CallerFunc; NotifyTo *string
      Program control.Program; Out, Err io.Writer; Now epoch.Millis
  }
  func Seed(ctx context.Context, in SeedInput) // never fails: every failure is a log line and a retry at the next cycle start
  ```

- [ ] **Step 1: Write the failing tests**

`internal/transcript/transcript_test.go`:
```go
package transcript

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
)

func assistant(blocks string) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[` + blocks + `]}}`
}

func TestClosingFrom(t *testing.T) {
	jsonl := strings.Join([]string{
		`{"type":"user","message":{"content":"go"}}`,
		assistant(`{"type":"text","text":"first turn"}`),
		assistant(`{"type":"tool_use","name":"Bash","input":{}}`),
		assistant(`{"type":"text","text":"Cycle 5 closed at a clean seam."}`),
		`{"type":"user","message":{"content":[{"type":"tool_result"}]}}`,
		`{"type":"summary","summary":"x"}`,
	}, "\n")
	if got := ClosingFrom(jsonl); got == nil || *got != "Cycle 5 closed at a clean seam." {
		t.Fatalf("%v", got)
	}
	for _, none := range []string{"", assistant(`{"type":"tool_use","name":"Bash","input":{}}`), assistant(`{"type":"text","text":"   "}`)} {
		if ClosingFrom(none) != nil {
			t.Errorf("%q has no closing", none)
		}
	}
	if got := ClosingFrom(assistant(`{"type":"text","text":"kept"}`) + "\nnot json\n{\"type\":\"assistant\",\"message\":7}"); got == nil || *got != "kept" {
		t.Fatal("a scrape skips what it cannot read")
	}
	if got := ClosingFrom(assistant(`{"type":"text","text":"` + strings.Repeat("x", ClosingMaxChars+500) + `"}`)); len(*got) != ClosingMaxChars {
		t.Fatal("capped")
	}
}

func TestClosingMessageSearchesEveryProject(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-Users-x-code-alpha")
	os.MkdirAll(dir, 0o755)
	id := "6f1c2a7e-3b0d-4c55-9e2a-1d9f0b7c8e41"
	os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(assistant(`{"type":"text","text":"done"}`)), 0o644)
	var log bytes.Buffer
	if got, err := ClosingMessage(context.Background(), home, id, nil, &log); err != nil || got == nil || *got != "done" {
		t.Fatalf("%v %v", got, err)
	}
	if got, err := ClosingMessage(context.Background(), t.TempDir(), id, nil, &log); err != nil || got != nil {
		t.Fatal("no projects directory is no closing")
	}
	if _, err := ClosingMessage(context.Background(), home, "x; rm -rf ~", &control.Host{SSH: "u@box"}, &log); err == nil || !strings.Contains(err.Error(), "session id is not a UUID") {
		t.Fatalf("%v", err)
	}
}
```
`internal/profile/profile_test.go`:
```go
package profile

import (
	"encoding/json"
	"regexp"
	"strings"
	"testing"
)

func repo(over string) json.RawMessage {
	base := `{"id":"r1","path":"/Users/cadam/code/x","badgeColor":"#737373","repoIcon":null`
	if over != "" {
		base += "," + over
	}
	return json.RawMessage(base + "}")
}

func patchJSON(p *Patch) string {
	if p == nil {
		return "null"
	}
	b, _ := json.Marshal(p)
	return string(b)
}

func TestFromRepo(t *testing.T) {
	summary := "Ticket loop for sunnyt"
	cases := []struct {
		name string
		repo json.RawMessage
		desc *string
		want string
	}{
		{"emoji and colour", repo(`"repoIcon":{"type":"emoji","emoji":"🦾"}`), nil, `{"icon":"🦾","color":"#737373"}`},
		{"lucide mapped", repo(`"repoIcon":{"type":"lucide","name":"Globe"}`), nil, `{"icon":"sf:globe","color":"#737373"}`},
		{"lucide unmapped", repo(`"repoIcon":{"type":"lucide","name":"Unicorn"}`), nil, `{"color":"#737373"}`},
		{"https image", repo(`"repoIcon":{"type":"image","src":"https://github.com/propra-tech.png?size=64","source":"github"}`), nil, `{"icon":"https://github.com/propra-tech.png?size=64","color":"#737373"}`},
		{"big data url dropped", repo(`"repoIcon":{"type":"image","src":"data:image/png;base64,` + strings.Repeat("A", 40_000) + `"}`), nil, `{"color":"#737373"}`},
		{"description only", repo(`"badgeColor":null`), &summary, `{"summary":"Ticket loop for sunnyt"}`},
		{"nothing at all", repo(`"badgeColor":null`), nil, `null`},
		{"bad colour dropped", repo(`"badgeColor":"purple","repoIcon":{"type":"emoji","emoji":"📣"}`), nil, `{"icon":"📣"}`},
		{"not a repo", json.RawMessage(`{"nonsense":true}`), nil, `null`},
		{"unknown icon type", repo(`"badgeColor":null,"repoIcon":{"type":"hologram","src":"x"}`), nil, `null`},
	}
	for _, c := range cases {
		if got := patchJSON(FromRepo(c.repo, c.desc)); got != c.want {
			t.Errorf("%s: %s", c.name, got)
		}
	}
	for lucide, sf := range LucideToSF {
		if !regexp.MustCompile(`^[a-z0-9.]+$`).MatchString(sf) {
			t.Errorf("%s → %s", lucide, sf)
		}
	}
}

func TestFindRepo(t *testing.T) {
	repos := []json.RawMessage{json.RawMessage(`{"id":"a"}`), json.RawMessage(`{"id":"b","badgeColor":"#8b5cf6"}`)}
	if got := FindRepo(repos, "b"); !strings.Contains(string(got), "#8b5cf6") {
		t.Fatal(string(got))
	}
	if FindRepo(repos, "zzz") != nil || FindRepo([]json.RawMessage{json.RawMessage(`42`), json.RawMessage(`null`)}, "a") != nil {
		t.Fatal("unknown id or malformed entries are nil")
	}
}
```
(The duplicate `"badgeColor"` keys in the `repo(...)` overrides are deliberate: the later key wins in `encoding/json`, exactly as in `JSON.parse`, which is how the TS spec's spread-override reads.)

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/transcript/ ./internal/profile/` → build failure.

- [ ] **Step 3: Implement**

`ClosingFrom` splits on `\n`, decodes each line into `struct{Type string; Message *struct{Content []json.RawMessage}}` and skips anything that does not decode or is not `assistant` with a content array; a block counts when it decodes as `{type:"text", text:string}` and `strings.TrimSpace(text) != ""` (Go's TrimSpace and JS `trim` agree on every whitespace a transcript carries); the kept value is `jsnum.Slice(trimmed, ClosingMaxChars)`. `ClosingMessage` (local): `<home>/.claude/projects` missing → nil; walk its directories in `os.ReadDir` order (sorted, where `readdirSync` is directory order — first match wins either way since a session id is unique); a read error is logged `could not read the transcript at <path>, recording no closing message: <err>` and nil. Hosted: refuse a non-`^[0-9a-f-]+$` id (case-insensitive) with `session id is not a UUID: <id>`; `exec.RunSsh(ctx, host.SSH, "cat ~/.claude/projects/*/<id>.jsonl", sshTimeout)`; a failure is logged `could not read the transcript for <id> on <ssh>, recording no closing message: <err>` and nil.

`FromRepo`/`FindRepo` port the TS with plain lenient `json.Unmarshal`. `Seed`: nil `NotifyTo` or an existing marker → return; `FindRepo(ListRepos, WorktreeRepoID)`; `FromRepo`; nil → log `<p>: nothing to seed into its hey profile (no Orca icon or colour, no description). To try again: rm <marker>`; else `hey.SetProfile` with `From: program.Name` and log `<p>: seeded its hey profile (icon, color, summary — the keys present, joined ", "). Change it with: hey profile --from <p> …; to seed again: rm <marker>`; then `EnsureDirs` and write `{"seededAt":"<ISO>","patch":<patch>}\n` in place. Any error on the way → `<p>: could not seed its hey profile (<err>) — tried again at its next cycle start` on `Err`, no marker (`// swallowed: an avatar is not worth a failed cycle`).

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/transcript/ ./internal/profile/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/transcript internal/profile
git commit -m "feat(go): the closing message scraped from claude's transcript, and the sender profile seeded once from the Orca repo"
```

---

### Task 13: `internal/cycle` — the report, its sources, and the pure decisions

**Files:**
- Create: `internal/cycle/report.go` (`Report`, `ParseReport`, `ReportFromPoll`, `WriteReport`, `ParseReportArgs`), `internal/cycle/source.go` (`Source`, `SourceFor`, `RemoteReportPath`, `IsMissingFile`, `ReadReport`), `internal/cycle/decisions.go` (`StallAction`, `LaunchArgv`, `WakeDecision`, `TailscaleCheckLink`, `Substitute`, `IsOnboarding`, `NewSessionID`, `UnreportedExit`), `internal/cycle/report_test.go`, `internal/cycle/decisions_test.go`
- Port from: `src/cycle.ts` lines 1–345 (everything above the worker), and `tick.ts` `unreportedExit`

**Interfaces:**
- Consumes: `shape`; `ledger.Yield`; `control.ParseDuration`, `control.MaxRestDays`, `control.Program`, `control.Host`; `exec.RunSsh`, `*exec.ExitError` (`Stderr`); `orca.ShellCommand`, `orca.AgentState`; `paths.Paths.LastCycle`, `StateFile`, `EnsureDirs`; `epoch.Parse`, `epoch.ISO`.
- Produces:
  ```go
  package cycle
  type Report struct {
      Exit          string        `json:"exit"`          // context | capacity | seam | blocked
      StartupTokens *float64      `json:"startupTokens"`
      Yield         *ledger.Yield `json:"yield"`
      AsksRaised    float64       `json:"asksRaised"`
      PauseUntil    *string       `json:"pauseUntil"`
      Cadence       *string       `json:"cadence"`
  }
  func ParseReport(data []byte, label string) (Report, error)        // strict: "<label> is not a valid cycle report: <path>: <why>"; a JSON syntax error is returned as is
  func ReportFromPoll(text *string, label string) (*Report, error)   // nil text or unparseable bytes → nil, nil; complete but wrong shape → error
  func WriteReport(p paths.Paths, program string, r Report) (Report, error) // validated before disk, staged <path>.staged then renamed
  func ParseReportArgs(args []string, now epoch.Millis) (string, Report, error)
  type Source struct { Label string; Read func(context.Context) (*string, error); Clear func(context.Context) error }
  func SourceFor(p paths.Paths, program control.Program) Source
  func RemoteReportPath(h control.Host, program string) string
  func IsMissingFile(stderr string) bool
  func ReadReport(ctx context.Context, s Source) (*Report, error)
  type Stall string // "wait" | "nudge" | "give-up" | "alert"
  type StallInput struct {
      State orca.AgentState; HasReport bool; IdleFor time.Duration; NudgesSent int; NudgeAfter time.Duration
      MaxNudges int; BlockedFor, BlockedAlertAfter time.Duration; Alerted bool
  }
  func StallAction(in StallInput) Stall
  func LaunchArgv(program control.Program, sessionName, sessionID string) []string
  func WakeDecision(reachable bool, wake *string) string // "proceed" | "run-wake" | "fail"
  func TailscaleCheckLink(reason *string) *string
  func Substitute(command string, program control.Program, onboarding bool) string
  func IsOnboarding(p paths.Paths, program string) bool
  func NewSessionID() (string, error) // RFC 4122 v4 from crypto/rand, lowercase: what randomUUID() returns
  func UnreportedExit(deferred, stalled, abandoned bool) string
  ```
  Ruling: zod's own issue dump in "not a valid cycle report" cannot be reproduced; the Go names the field path instead, as E1's control parser does. The text is a log and CLI message, never parsed.

- [ ] **Step 1: Write the failing tests**

`internal/cycle/report_test.go`:
```go
package cycle

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/paths"
)

var now = epoch.MustParse("2026-08-28T12:00:00Z")

func f(v float64) *float64 { return &v }

func TestParseReportArgs(t *testing.T) {
	program, r, err := ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--startup-tokens", "14000", "--tickets-moved", "2", "--prs-opened", "1", "--commits", "6", "--asks-raised", "1"}, now)
	want := Report{Exit: "seam", StartupTokens: f(14000), Yield: &ledger.Yield{TicketsMoved: 2, PrsOpened: 1, Commits: 6}, AsksRaised: 1}
	if err != nil || program != "sunnyt" || !reflect.DeepEqual(r, want) {
		t.Fatalf("%s %+v %v", program, r, err)
	}
	if _, r, _ := ParseReportArgs([]string{"sunnyt", "--exit", "context"}, now); r.Yield != nil || r.StartupTokens != nil || r.AsksRaised != 0 {
		t.Fatal("no yield flags means yield unknown, not zero")
	}
	if _, r, _ := ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--commits", "3"}, now); *r.Yield != (ledger.Yield{Commits: 3}) {
		t.Fatal("one yield flag defaults the other two to zero")
	}
	refusals := []struct {
		args []string
		want string
	}{
		{[]string{}, "usage: drovr report"},
		{[]string{"--exit", "seam"}, "usage: drovr report"},
		{[]string{"sunnyt"}, "--exit is required"},
		{[]string{"sunnyt", "--exit", "seam", "--startup_tokens", "14000"}, "unknown flag --startup_tokens"},
		{[]string{"sunnyt", "--exit", "seam", "--commits", "lots"}, `--commits needs a number, got "lots"`},
		{[]string{"sunnyt", "--exit", "seam", "--pause-until", "2026-08-01"}, "already in the past"},
		{[]string{"sunnyt", "--exit", "seam", "--pause-until", "90d"}, "more than 35 days"},
		{[]string{"sunnyt", "--exit", "seam", "--pause-until", "whenever"}, "needs a duration (48h, 7d) or an ISO date"},
		{[]string{"sunnyt", "--exit", "seam", "--cadence", "weekly"}, "--cadence must look like"},
		{[]string{"sunnyt", "--exit", "seam", "--cadence", "60d"}, "longer than 35 days"},
	}
	for _, c := range refusals {
		if _, _, err := ParseReportArgs(c.args, now); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v (want %q)", c.args, err, c.want)
		}
	}
	_, r, _ = ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--pause-until", "48h", "--cadence", "7d"}, now)
	if *r.PauseUntil != epoch.ISO(now+48*3_600_000) || *r.Cadence != "7d" {
		t.Fatalf("%+v", r)
	}
	_, r, _ = ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--pause-until", "2026-08-30T09:00:00Z"}, now)
	if *r.PauseUntil != "2026-08-30T09:00:00.000Z" {
		t.Fatal(*r.PauseUntil)
	}
}

func alpha(t *testing.T) (paths.Paths, Source) {
	p := paths.Paths{Base: t.TempDir()}
	c, err := control.Parse([]byte(`{"programs":[{"name":"alpha","cwd":"/x"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	return p, SourceFor(p, c.Programs[0])
}

func TestWriteReportIsStagedAndRoundTrips(t *testing.T) {
	p, src := alpha(t)
	written, err := WriteReport(p, "alpha", Report{Exit: "seam", StartupTokens: f(9000), Yield: &ledger.Yield{TicketsMoved: 1, Commits: 4}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReadReport(context.Background(), src)
	if err != nil || !reflect.DeepEqual(*got, written) {
		t.Fatalf("%+v %v", got, err)
	}
	raw, _ := os.ReadFile(p.LastCycle("alpha"))
	if string(raw) != `{"exit":"seam","startupTokens":9000,"yield":{"ticketsMoved":1,"prsOpened":0,"commits":4},"asksRaised":0,"pauseUntil":null,"cadence":null}`+"\n" {
		t.Fatalf("%s", raw)
	}
	entries, _ := os.ReadDir(p.ProgramState("alpha"))
	if len(entries) != 1 {
		t.Fatalf("staging left behind: %v", entries)
	}
	if _, err := WriteReport(p, "beta", Report{Exit: "done"}); err == nil || !strings.Contains(err.Error(), "not a valid cycle report") {
		t.Fatalf("%v", err)
	}
	if _, err := os.Stat(p.LastCycle("beta")); err == nil {
		t.Fatal("an invalid report touched disk")
	}
}

func TestPollLeniency(t *testing.T) {
	text := func(s string) *string { return &s }
	if r, err := ReportFromPoll(nil, "x"); r != nil || err != nil {
		t.Fatal("absent is not yet")
	}
	if r, err := ReportFromPoll(text(`{"exit": "sea`), "x"); r != nil || err != nil {
		t.Fatal("torn is not yet")
	}
	if r, err := ReportFromPoll(text(`{"exit":"seam"}`), "x"); err != nil || r.Exit != "seam" {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := ReportFromPoll(text(`{"exit":"done"}`), "x"); err == nil || !strings.Contains(err.Error(), "not a valid cycle report") {
		t.Fatalf("a complete report with the wrong shape is broken: %v", err)
	}
	p, src := alpha(t)
	os.MkdirAll(p.ProgramState("alpha"), 0o755)
	os.WriteFile(p.LastCycle("alpha"), []byte(`{ "exit": "seam", "startupTo`), 0o644)
	if _, err := ReadReport(context.Background(), src); err == nil {
		t.Fatal("readReport is strict where the poll is lenient")
	}
	if err := src.Clear(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, err := src.Read(context.Background()); got != nil || err != nil {
		t.Fatal("cleared reads as absent")
	}
}

func TestRemotePathsAndMissingFile(t *testing.T) {
	h := control.Host{DrovrHome: "~/.drovr"}
	if RemoteReportPath(h, "relliq") != "~/.drovr/programs/relliq/last-cycle.json" {
		t.Fatal(RemoteReportPath(h, "relliq"))
	}
	if !IsMissingFile("cat: /home/ubuntu/.drovr/programs/relliq/last-cycle.json: No such file or directory\n") || IsMissingFile("ssh: connect to host relliq-devbox port 22: Operation timed out\r\n") || IsMissingFile("") {
		t.Fatal("only cat's own No such file means not yet")
	}
}
```
`internal/cycle/decisions_test.go`:
```go
package cycle

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/orca"
)

func TestStallAction(t *testing.T) {
	base := StallInput{NudgeAfter: 10 * time.Minute, MaxNudges: 3, BlockedAlertAfter: 20 * time.Minute}
	with := func(edit func(*StallInput)) StallInput { in := base; edit(&in); return in }
	cases := []struct {
		name string
		in   StallInput
		want Stall
	}{
		{"working is left alone", with(func(i *StallInput) { i.State = orca.Working; i.IdleFor = 9 * time.Hour }), "wait"},
		{"idle within grace", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 9 * time.Minute }), "wait"},
		{"idle past grace is nudged", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 10 * time.Minute }), "nudge"},
		{"reported is never nudged", with(func(i *StallInput) { i.State = orca.Idle; i.HasReport = true; i.IdleFor = 9 * time.Hour }), "wait"},
		{"the last nudge is spent", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 10 * time.Minute; i.NudgesSent = 2 }), "nudge"},
		{"out of nudges gives up", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 10 * time.Minute; i.NudgesSent = 3 }), "give-up"},
		{"blocked past threshold asks a human", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = 20 * time.Minute }), "alert"},
		{"just blocked waits", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = time.Minute }), "wait"},
		{"blocked alerts once", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = 4 * time.Hour; i.Alerted = true }), "wait"},
		{"blocked and reported is finished", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = 4 * time.Hour; i.HasReport = true }), "wait"},
	}
	for _, c := range cases {
		if got := StallAction(c.in); got != c.want {
			t.Errorf("%s: %s", c.name, got)
		}
	}
	for _, d := range []time.Duration{0, 20 * time.Minute, 12 * time.Hour} {
		if got := StallAction(with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = d; i.IdleFor = time.Hour })); got == "nudge" || got == "give-up" {
			t.Fatal("a blocked runner is never nudged")
		}
	}
}

func TestLaunchArgv(t *testing.T) {
	c, _ := control.Parse([]byte(`{"programs":[{"name":"relliq","cwd":"/Users/cadam/code/propra/relliq"},{"name":"h","cwd":"/x","host":{"environment":"e","ssh":"ubuntu@box","cwd":"/home/ubuntu/code/propra/relliq"}},{"name":"n","cwd":"/x","useDirenv":false,"host":{"environment":"e","ssh":"ubuntu@box","cwd":"/home/ubuntu/code/propra/relliq"}}]}`))
	claude := "--model fable --name relliq program runner --session-id sid"
	want := []string{
		"direnv exec /Users/cadam/code/propra/relliq teamclaude run -- " + claude,
		"direnv exec /home/ubuntu/code/propra/relliq ~/.local/bin/claude " + claude,
		"~/.local/bin/claude " + claude,
	}
	for i, p := range c.Programs {
		if got := strings.Join(LaunchArgv(p, "relliq program runner", "sid"), " "); got != want[i] {
			t.Errorf("%s: %s", p.Name, got)
		}
	}
}

func TestWakeTailscaleSessionAndExits(t *testing.T) {
	wake := "pnpm devbox:start"
	if WakeDecision(true, nil) != "proceed" || WakeDecision(true, &wake) != "proceed" || WakeDecision(false, &wake) != "run-wake" || WakeDecision(false, nil) != "fail" {
		t.Fatal("wakeDecision")
	}
	reason := "ssh ubuntu@box true did not return within 20s and was killed; it had printed: # Tailscale SSH requires an additional check. # To authenticate, visit: https://login.tailscale.com/a/l1e8671de330fd4"
	if got := TailscaleCheckLink(&reason); got == nil || *got != "https://login.tailscale.com/a/l1e8671de330fd4" {
		t.Fatal("link")
	}
	plain := "ssh ubuntu@box true did not return within 20s and was killed"
	if TailscaleCheckLink(&plain) != nil || TailscaleCheckLink(nil) != nil {
		t.Fatal("no link")
	}
	id, err := NewSessionID()
	if err != nil || !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
		t.Fatalf("%q %v", id, err)
	}
	for in, want := range map[[3]bool]string{{true, true, true}: "deferred", {false, true, true}: "stalled", {false, false, true}: "abandoned", {false, false, false}: "crash"} {
		if got := UnreportedExit(in[0], in[1], in[2]); got != want {
			t.Errorf("%v: %s", in, got)
		}
	}
	p := control.Program{Name: "alpha", Model: "fable"}
	if Substitute("/project-loop {program} {mode} --model {model}", p, true) != "/project-loop alpha onboard --model fable" {
		t.Fatal("substitute")
	}
}
```
- [ ] **Step 2: Run, watch them fail** — `go test ./internal/cycle/` → build failure.

- [ ] **Step 3: Implement**

`ParseReport`: `json.Unmarshal` into `json.RawMessage` first (a syntax error returns as is, which is what `readReport` throws and `ReportFromPoll` swallows to nil — `// swallowed: a direct writer may be mid-write; the next poll sees the whole file`), then `shape.Decode(raw, "")`: `exit` required and `OneOf` the four; `startupTokens` `NullableDefault`; `yield` `NullableDefault` into a raw message, decoded through a sub-object with the three required numbers; `asksRaised` `Optional` (default 0); `pauseUntil` `NullableDefault`; `cadence` `NullableDefault` then `Check(cadence matches ^\d+[mhd]$)`. Wrap failures `"%s is not a valid cycle report: %w"`.

`WriteReport` marshals `r`, re-parses it with `ParseReport(b, "the given report")` (the TS validates the object it was handed), `EnsureDirs`, writes `<path>.staged`, renames. The file is `JSON.stringify(parsed)` + `"\n"`: compact, struct order.

`ParseReportArgs` ports `parseReportArgs` with its exact messages: the usage line `usage: drovr report <program> --exit <context|capacity|seam|blocked> [flags]`; unknown flags against the eight known; `numberArg` uses `strconv.Atoi` over the leading digits as `parseInt` does (`"12abc"` → 12; `"lots"` → refused); `parsePauseUntil` takes `^\d+[mhd]$` through `control.ParseDuration`, else `epoch.Parse`, refusing past and beyond `MaxRestDays`; `parseCadence` as the TS. The exit string is not checked here — `WriteReport` refuses a bad one, as in the TS.

`SourceFor`: no host → `p.LastCycle(name)`, read nil when missing, clear `os.Remove` ignoring not-exist; host → `exec.RunSsh(ctx, host.SSH, orca.ShellCommand([]string{"cat", path}), sshTimeout)`, an `*exec.ExitError` whose `Stderr` `IsMissingFile` → nil, anything else returned; clear runs `rm -f`.

`StallAction`, `LaunchArgv`, `WakeDecision`, `TailscaleCheckLink` (`https://login\.tailscale\.com/a/\S+`), `Substitute` (`{program}`, `{model}`, `{mode}` → onboard|deliver), `IsOnboarding` (`!exists(p.StateFile(name))`), `UnreportedExit`: line for line. `NewSessionID`: 16 bytes from `crypto/rand`, `b[6] = b[6]&0x0f | 0x40`, `b[8] = b[8]&0x3f | 0x80`, formatted `%x-%x-%x-%x-%x`.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/cycle/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/cycle
git commit -m "feat(go): the cycle report — strict shape, staged writer, lenient poll, local and ssh sources — and the watch's pure decisions"
```

---
### Task 14: `internal/cycle` — the `run-cycle` worker

**Files:**
- Create: `internal/cycle/worker.go` (`Worker`, `Limits`, `Outcome`, `RunProgram`, `RunCycle`, `ResumeCycle`, `runHeadless`, `runInOrca`, `ensureReachable`), `internal/cycle/watch.go` (`watchCycle`, `releaseFinished`, `abandonStalled`, `askForHuman`, `lostSight`), `internal/cycle/worker_test.go`
- Port from: `src/cycle.ts` lines 345–647, and `tick.ts`'s `runProgramCycle` (the worker lives with the cycle it watches; the tick only launches it)

**Interfaces:**
- Consumes: Task 13's whole surface; `orca.(*Client)` `ResolveWorktree`, `StartCycleAgent`, `RunnerState`, `RunnerAddress`, `ReleaseRunner`, `PromptRunner`, `orca.PaneBusy`, `orca.OpenLine`; `profile.Seed`; `transcript.ClosingMessage`; `nudge.Channel.TextCraig`, `nudge.CallerFunc`; `lock.Acquire`, `lock.Release`, `lock.Holder`; `ledger.ReadCycles`, `ledger.InFlight`, `ledger.AppendRecord`, `ledger.Cycle`; `capacity.PoolFrom`, `(Pool).Snapshot`; `control.Read`, `control.CeilingsFor`; `teamclaude.Read`; `exec.RunBounded` (headless with `LogPath`, wake), `exec.RunSsh`.
- Produces:
  ```go
  package cycle
  const (
      pollInterval    = 30 * time.Second
      maxPollFailures = 20
      sshTimeout      = 20 * time.Second
      wakeTimeout     = 6 * time.Minute
      stallPrompt     = "[drovr] You have been idle for ten minutes without writing this cycle's report. If the cycle is still viable, continue it. If it is finished or cannot proceed, write your cycle report and stand down."
  )
  var ErrAlreadyRunning = errors.New("a cycle is already running") // already printed; main exits 1 without a second line
  type Limits struct { MaxHours float64; StallNudge, BlockedAlert time.Duration; MaxStallNudges int; NotifyTo *string }
  func LimitsOf(c control.Control) Limits
  type Outcome struct { Finished bool; Detail string; Stalled, Abandoned, Deferred bool }
  type Worker struct {
      Paths paths.Paths; Orca *orca.Client; Caller nudge.CallerFunc; Host string
      Home string // whose ~/.claude/projects holds the transcripts
      TeamclaudeBin string; Out, Err io.Writer; Now func() epoch.Millis; Sleep func(time.Duration)
  }
  func (w Worker) RunProgram(ctx context.Context, name string) error
  func (w Worker) RunCycle(ctx context.Context, program control.Program, startedAt, sessionID string, l Limits) (Outcome, error)
  func (w Worker) ResumeCycle(ctx context.Context, program control.Program, l Limits) (Outcome, error)
  ```
  Rulings: the headless runner (`runner: "headless"`, unobserved since the Orca runner landed) waits through `exec.RunBounded` with `LogPath` and a bound of `maxCycleHours` — the TS `spawn` had none; a child that outlives it is reported as a failed run, the same path any other start failure takes. The watch loop's cap is its deadline plus an explicit iteration cap of `maxHours*3600/30 + 1`.

- [ ] **Step 1: Write the failing tests**

`internal/cycle/worker_test.go`:
```go
package cycle

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
)

const (
	claudeShow = `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/w/alpha","agentIdentity":"claude","agentWait":null}}}`
	shellShow  = `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/w/alpha","agentIdentity":null}}}`
	timedOut   = `{"ok":false,"error":{"code":"timeout"}}`
	okEmpty    = `{"ok":true,"result":{}}`
)

type rig struct {
	w       Worker
	p       paths.Paths
	answers string
	out     *bytes.Buffer
	errs    *bytes.Buffer
	clock   epoch.Millis
	tools   []string
}

// newRig: a DROVR_HOME holding one local program, the orca and teamclaude shims on PATH, a
// clock that advances a minute per reading, and a Sleep that runs onSleep (the runner's turn).
func newRig(t *testing.T, controlJSON string, answers map[string]string) *rig {
	t.Helper()
	home := t.TempDir()
	t.Setenv("DROVR_HOME", home)
	p := paths.New()
	os.MkdirAll(p.Logs, 0o755)
	os.WriteFile(p.Control, []byte(controlJSON), 0o644)
	dir := t.TempDir()
	orcaBin, _ := filepath.Abs("../orca/testdata")
	bin, _ := filepath.Abs("../../testdata/bin")
	t.Setenv("PATH", orcaBin+":"+bin+":"+os.Getenv("PATH"))
	t.Setenv("ORCA_ANSWERS", dir)
	base := map[string]string{
		"worktree_show.json": `{"ok":true,"result":{"worktree":{"id":"wt-1","repoId":"r1"}}}`,
		"repo_list.json":     `{"ok":true,"result":{"repos":[{"id":"r1","badgeColor":"#737373"}]}}`,
		"terminal_create.json": `{"ok":true,"result":{"terminal":{"handle":"term_1","tabId":"tab-1"}}}`,
		"terminal_show.json": claudeShow, "terminal_show.exited.json": shellShow,
		"terminal_wait_exit.json": timedOut, "terminal_wait_tui-idle.json": `{"ok":true,"result":{"wait":{"satisfied":true}}}`,
		"terminal_send.json": okEmpty, "terminal_close.json": okEmpty,
	}
	for k, v := range answers {
		base[k] = v
	}
	for k, v := range base {
		os.WriteFile(filepath.Join(dir, k), []byte(v), 0o644)
	}
	r := &rig{p: p, answers: dir, out: &bytes.Buffer{}, errs: &bytes.Buffer{}, clock: epoch.MustParse("2026-10-23T12:00:00.000Z")}
	o := orca.NewClient(p, r.errs)
	o.Sleep = func(time.Duration) {}
	r.w = Worker{Paths: p, Orca: o, Host: "mac", Home: t.TempDir(), Out: r.out, Err: r.errs,
		Now:    func() epoch.Millis { r.clock += 60_000; return r.clock },
		Sleep:  func(time.Duration) {},
		Caller: func() (hey.Call, error) { return r.call, nil }}
	return r
}

func (r *rig) call(_ context.Context, tool string, _ any) (json.RawMessage, error) {
	r.tools = append(r.tools, tool)
	return json.RawMessage(`{"profile":{"from":"alpha","icon":null,"summary":null,"color":"#737373","updatedAt":null},"id":"01J","createdAt":"x","waitUntil":null,"pushed":true,"quiet":false,"reason":null}`), nil
}

func (r *rig) records(t *testing.T) []ledger.Cycle {
	cycles, err := ledger.ReadCycles(r.p.Cycles)
	if err != nil {
		t.Fatal(err)
	}
	return cycles
}

func (r *rig) calls() string {
	b, _ := os.ReadFile(filepath.Join(r.answers, "calls.log"))
	return string(b)
}

const alphaControl = `{"notifyTo":"craig","programs":[{"name":"alpha","cwd":"/w/alpha","useDirenv":false}]}`

func TestWorkerRunsACycleEndToEnd(t *testing.T) {
	r := newRig(t, alphaControl, nil)
	r.w.Sleep = func(time.Duration) {
		if _, err := os.Stat(r.p.LastCycle("alpha")); err != nil {
			WriteReport(r.p, "alpha", Report{Exit: "seam"})
		}
	}
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatalf("%v\n%s", err, r.errs)
	}
	got := r.records(t)
	if len(got) != 2 || got[0].Exit != "running" || got[0].Kind != "onboarding" || got[1].Exit != "seam" || got[1].PoolAfter == nil || got[1].SessionID == nil || got[0].StartedAt != got[1].StartedAt {
		t.Fatalf("%+v", got)
	}
	log := r.calls()
	prompt, repos, exit := strings.Index(log, "--text /project-loop alpha"), strings.Index(log, "repo list"), strings.Index(log, "--text /exit")
	if prompt < 0 || repos < prompt || exit < repos {
		t.Fatalf("want prompt, then the profile seed, then /exit:\n%s", log)
	}
	if !strings.Contains(log, "--command teamclaude run -- --model fable --name 'alpha program runner' --session-id "+*got[1].SessionID) {
		t.Fatalf("launch argv:\n%s", log)
	}
	if _, err := os.Stat(r.p.ProgramLock("alpha")); err == nil {
		t.Fatal("the program lock outlived the worker")
	}
	if orca.RememberedTerminal(r.p, "alpha", r.errs) != nil {
		t.Fatal("a reported runner's terminal is released and forgotten")
	}
	if cur, _ := os.ReadFile(r.p.CurrentCycle("alpha")); !strings.Contains(string(cur), `"prompt": "/project-loop alpha"`) {
		t.Fatalf("%s", cur)
	}
}

func TestPaneBusyIsDeferred(t *testing.T) {
	r := newRig(t, alphaControl, map[string]string{"terminal_wait_tui-idle.1.json": `{"ok":true,"result":{"wait":{"satisfied":true}}}`, "terminal_wait_tui-idle.json": timedOut})
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	got := r.records(t)
	if got[len(got)-1].Exit != "deferred" || !strings.Contains(r.out.String(), "alpha started but is working in") {
		t.Fatalf("%+v\n%s", got, r.out)
	}
	if strings.Contains(r.errs.String(), "recorded as crash") {
		t.Fatal("a busy pane is not a crash")
	}
}

func TestStalledRunnerIsGivenUpOn(t *testing.T) {
	r := newRig(t, `{"notifyTo":null,"stallNudgeMinutes":0,"maxStallNudges":1,"programs":[{"name":"alpha","cwd":"/w/alpha","useDirenv":false}]}`, nil)
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	got := r.records(t)
	if got[len(got)-1].Exit != "stalled" || strings.Count(r.calls(), "--text [drovr] You have been idle") != 1 {
		t.Fatalf("%+v\n%s", got, r.calls())
	}
	if !strings.Contains(r.errs.String(), "cycle for alpha stalled — recorded as stalled.") || !strings.Contains(r.errs.String(), "notifyTo is null in control.json, so the alert was dropped: drovr: alpha stalled") {
		t.Fatalf("%s", r.errs)
	}
}

func TestDeadlineIsAbandonedNotCrash(t *testing.T) {
	r := newRig(t, `{"notifyTo":null,"maxCycleHours":0.01,"programs":[{"name":"alpha","cwd":"/w/alpha","useDirenv":false}]}`, map[string]string{"terminal_wait_tui-idle.json": timedOut, "terminal_wait_tui-idle.1.json": `{"ok":true,"result":{"wait":{"satisfied":true}}}`, "terminal_wait_tui-idle.2.json": `{"ok":true,"result":{"wait":{"satisfied":true}}}`})
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	got := r.records(t)
	if last := got[len(got)-1]; last.Exit != "abandoned" || last.Closing != nil {
		t.Fatalf("%+v", last)
	}
	if orca.RememberedTerminal(r.p, "alpha", r.errs) == nil {
		t.Fatal("drovr never kills a cycle: the runner's terminal is left in place")
	}
}

func TestPollFailuresAreCountedThenAbandoned(t *testing.T) {
	r := newRig(t, `{"notifyTo":null,"programs":[{"name":"alpha","cwd":"/w/alpha","useDirenv":false}]}`, nil)
	// After the start, every show is garbage: orca has stopped answering.
	for n := 5; n < 60; n++ {
		os.WriteFile(filepath.Join(r.answers, fmt.Sprintf("terminal_show.%d.json", n)), []byte("segfault"), 0o644)
	}
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	got := r.records(t)
	if got[len(got)-1].Exit != "abandoned" || strings.Count(r.errs.String(), "could not read its runner's state") != maxPollFailures {
		t.Fatalf("%+v\n%s", got, r.errs)
	}
}

func TestAlreadyRunningAndResume(t *testing.T) {
	r := newRig(t, alphaControl, nil)
	os.MkdirAll(r.p.ProgramState("alpha"), 0o755)
	os.WriteFile(r.p.ProgramLock("alpha"), []byte(fmt.Sprintf(`{"pid":%d,"at":1}`, os.Getpid())), 0o644)
	if err := r.w.RunProgram(context.Background(), "alpha"); !errors.Is(err, ErrAlreadyRunning) || !strings.Contains(r.errs.String(), fmt.Sprintf("a cycle for alpha is already running (pid %d)", os.Getpid())) {
		t.Fatalf("%v %s", err, r.errs)
	}
	os.Remove(r.p.ProgramLock("alpha"))
	started := epoch.ISO(r.clock - 3_600_000)
	sid := "6f1c2a7e-3b0d-4c55-9e2a-1d9f0b7c8e41"
	ledger.AppendRecord(r.p.Cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: "alpha", StartedAt: started, Exit: "running", SessionID: &sid})
	orca.RememberTerminal(r.p, "alpha", orca.Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	WriteReport(r.p, "alpha", Report{Exit: "context"})
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	got := r.records(t)
	if len(got) != 2 || got[1].StartedAt != started || *got[1].SessionID != sid || got[1].Exit != "context" || !strings.Contains(r.out.String(), "re-attaching to the cycle started "+started) {
		t.Fatalf("%+v\n%s", got, r.out)
	}
	if strings.Contains(r.calls(), "terminal create") {
		t.Fatal("a resumed watch opens no terminal")
	}
}
```
`TestPollFailuresAreCountedThenAbandoned` relies on the shim's per-call answers: calls 1–4 of `terminal show` belong to the start (wait-for-claude, agent state) and the first poll's runner lookup; from the fifth on, garbage. If the count of start-phase `show` calls differs once implemented, adjust the `5` to the first poll's call number — read it off `calls.log` — and say so in the commit; the assertion on `maxPollFailures` lines is the point.

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/cycle/ -run 'Worker|PaneBusy|Stalled|Deadline|PollFailures|AlreadyRunning'` → build failure.

- [ ] **Step 3: Implement**

`RunProgram` is `runProgramCycle` line for line: `EnsureDirs(name)`; `lock.Acquire(ProgramLock)` false → `a cycle for <name> is already running (pid <holder>)` on `Err`, return `ErrAlreadyRunning`; `defer lock.Release`; read control; unknown program → `no program named "<name>" in <control path>`; `CeilingsFor` off → `mode is off`; `resumed` = first in-flight record for the program (window `MaxCycleHours`); `startedAt`/`sessionID`/`kind`/`before` from it or fresh (`NewSessionID`, `IsOnboarding`, a `teamclaude.Read` pool snapshot); a start record only when not resumed, else `<name>: re-attaching to the cycle started <at> — its watcher died with the runner still there` on `Out`; run or resume; an error that `errors.As` a `*orca.PaneBusy` → `<name>: <detail>` on `Out`, outcome deferred; any other error → `cycle for <name> failed to run: <detail>` on `Err`, outcome finished; `readReportOrWarn` (`ignoring unreadable cycle report for <name>: <err>` — `// swallowed: a throw here skips the end record and charges the cycle as running forever`); the after-snapshot from a second `teamclaude.Read` (an error there returns, as the TS throws there); the end record with `closing` only when `Finished`; stalled → the `Err` line and `TextCraig` with `drovr: <name> stalled — its runner idled through <n> nudges without writing a report. Its pane is free and the next tick starts a fresh cycle.` from `name`; no report and none of the three flags → `cycle for <name> produced no report — recorded as crash. <detail>`.

`RunCycle`: `EnsureDirs`; hosted → `ensureReachable` (probe `ssh true`; a Tailscale check link → error naming it; `WakeDecision`; `run-wake` logs `<name>: <ssh> is unreachable (<reason>) — waking it: <wake>`, runs `sh -c <wake>` bounded by `wakeTimeout` with the wake as label, re-probes); `Source.Clear`; headless or orca. `runInOrca`: `ResolveWorktree`, `Substitute` the prompt and session name, `LaunchArgv`, `StartCycleAgent`, write `current-cycle.json` (`{handle, tabId, worktreeId, prompt, startedAt}` indent 2, in place), `profile.Seed`, `watchCycle`.

`watchCycle` mirrors the TS: deadline `Now() + maxHours*3.6e6`; each iteration `Sleep(pollInterval)`; a failed report read or state read logs `<p>: could not read its <what> (<err>) — still watching` and counts; `maxPollFailures` in a row → `lostSight` (abandoned, detail verbatim); a report → `releaseFinished`; `Gone` → finished, `the runner is no longer present in <where>`; idle/blocked clocks from `Now()`, `alerted` cleared when not blocked; `StallAction`; `alert` marks before sending and calls `askForHuman` (log line first, then `TextCraig` from the program; its failure is logged, `// swallowed: an alert that fails must still be in the worker log, and the watch carries on`); `nudge` counts and resets the idle clock even when `PromptRunner` fails (logged), then `<p>: idle with no report — nudged it (<n>/<max>)`; past the deadline → abandoned with the TS detail. `releaseFinished` and `abandonStalled` take `ReleaseRunner(ctx, p, orca.DefaultSettleAttempts)` and read an error as not released (`// swallowed: TS .catch(() => false)`), then name the address with `OpenLine`.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/cycle/ -count=1 && go vet ./... && gofmt -l .` → PASS in seconds (every sleep is injected).

- [ ] **Step 5: Commit**

```bash
git add internal/cycle
git commit -m "feat(go): the run-cycle worker — start, prompt, watch, nudge, alert, release and record; abandoned when drovr stops looking, never crash"
```

---

### Task 15: `internal/tick`

**Files:**
- Create: `internal/tick/tick.go` (`Env`, `Tick`, the pass), `internal/tick/reconcile.go` (`OrphanAction`, `reconcileAbandoned`, `reconcileLateReports`), `internal/tick/run.go` (`Run`, the watchdog, the failure marker, `FailedTickText`, `DurationText`), `internal/tick/record.go` (`DecisionRecord`, `Launch`, `everyEvaluation`), `internal/tick/tick_test.go`, `internal/tick/e2e_test.go`
- Port from: `src/tick.ts` (all of it except `runProgramCycle`, which is Task 14, and `inFlightCycles`, which moves with `tidy` in E3)

**Interfaces:**
- Consumes: everything above. Exact calls: `lock.Acquire`, `lock.HeldBy(path) (Held, bool, error)`, `lock.Release`, `lock.Holder`; `control.Read`, `control.ApplyAwayMode`, `control.ByPriority`, `control.CeilingsFor`; `teamclaude.Read(ctx, bin)`; `capacity.PoolFrom`; `ledger.ReadCycles`, `InFlight`, `LatestEnds`, `LastCycleReported`, `UnansweredAsks`, `AppendRecord`, `StampTick`, `ReadTickStamp`; `decide.Decide`, `decide.FullReason`; `asks.(*Reader).Read`; `nudge.Channel` (`PhonePrefs`, `NudgeIfNeglected`, `PublishStatus`, `TextCraig`), `nudge.AlertFrom`; `orca.(*Client).RunnerIsPresent`, `ReleaseLeftover`; `cycle.SourceFor`, `cycle.ReadReport`; `transcript.ClosingMessage`; `usage.SampleOf`, `usage.Append`, `usage.MaxBytes`; `status.Build`, `status.Input`, `status.Evaluation`, `status.ServiceInput`; `service.Current()`; `exec.Detach`; `jsnum.Slice`, `jsnum.RoundHalfUp`.
- Produces:
  ```go
  package tick
  type Env struct {
      Paths paths.Paths; Now func() epoch.Millis; Out, Err io.Writer
      Self string // the drovr binary that `run-cycle <program>` is detached from
      TeamclaudeBin, Host string
      Home string // for transcripts (closing messages of reconciled cycles)
      Orca *orca.Client; Asks *asks.Reader; Caller nudge.CallerFunc
      Exit func(code int) // os.Exit; the watchdog's last act
      Shadow bool         // Task 16
  }
  func Run(ctx context.Context, env Env) error  // runTick: Tick plus the once-per-episode alert
  func Tick(ctx context.Context, env Env) error
  func Launch(env Env, program string) error    // launchDetached: `<Self> run-cycle <program>` into logs/<program>-worker.log
  func ReleaseOverrunningTick(ctx context.Context, env Env, lockPath string, budget time.Duration) string
  func DurationText(ms int64) string            // "<s>s" under a minute, else "<m>m", Math.round both
  func FailedTickText(err error) string
  func RecordTickFailure(markerPath string, at epoch.Millis, err error) (bool, error) // true when this failure began the episode
  func ClearTickFailure(markerPath string) error
  type Orphan string // "reattach" | "close" | "skip"
  func OrphanAction(runnerPresent *bool) Orphan
  func DecisionRecord(program string, d decide.Decision, now epoch.Millis) ledger.Decision // reason via FullReason; pool via Snapshot; cyclesFundable nil when nil or ±Inf
  ```
  `reconcileAbandoned` and `reconcileLateReports` *return* the records they would append (and the programs to re-attach) and `Tick` appends and launches them. Live, that is the same as appending inside; it is what lets Task 16 divert both into memory without a second copy of the logic.

- [ ] **Step 1: Write the failing pure tests**

`internal/tick/tick_test.go`:
```go
package tick

import (
	"bytes"
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/paths"
)

func itoa(n int) string { return strconv.Itoa(n) }

func watchdogEnv(t *testing.T, control string) (Env, string) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "control.json"), []byte(control), 0o644)
	p := paths.Paths{Base: dir, Control: filepath.Join(dir, "control.json"), TickLock: filepath.Join(dir, "tick.lock")}
	return Env{Paths: p, Out: &bytes.Buffer{}, Err: &bytes.Buffer{}, Host: "mac"}, p.TickLock
}

func TestOverrunReleasesItsOwnLock(t *testing.T) {
	for _, control := range []string{`{"notifyTo":null,"programs":[]}`, `{ not json`} {
		env, lockPath := watchdogEnv(t, control)
		if ok, err := lock.Acquire(lockPath); !ok || err != nil {
			t.Fatal(ok, err)
		}
		msg := ReleaseOverrunningTick(context.Background(), env, lockPath, 3*time.Minute)
		if _, held, _ := lock.HeldBy(lockPath); held {
			t.Fatalf("control %q: the lock survived the watchdog", control)
		}
		if !strings.Contains(msg, "overran 3m") || !strings.Contains(msg, "pid "+itoa(os.Getpid())) || !strings.Contains(msg, "lock is released") {
			t.Fatal(msg)
		}
	}
	env, lockPath := watchdogEnv(t, `{"notifyTo":null,"programs":[]}`)
	if msg := ReleaseOverrunningTick(context.Background(), env, lockPath, 30*time.Second); !strings.Contains(msg, "overran 30s") {
		t.Fatal("a sub-minute budget is reported in seconds; an already-free lock is quiet")
	}
}

func TestFailedTickMarksTheEpisodeOnce(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "tick-failure.json")
	boom := errors.New("teamclaude status did not match expected shape: [")
	at := epoch.MustParse("2026-09-14T17:38:50Z")
	for i, want := range []bool{true, false, false} {
		if began, err := RecordTickFailure(marker, at+epoch.Millis(i)*600_000, boom); err != nil || began != want {
			t.Fatalf("%d: %v %v", i, began, err)
		}
	}
	raw, _ := os.ReadFile(marker)
	if string(raw) != `{"at":"2026-09-14T17:38:50.000Z","reason":"teamclaude status did not match expected shape: ["}`+"\n" {
		t.Fatalf("%s", raw)
	}
	if err := ClearTickFailure(marker); err != nil {
		t.Fatal(err)
	}
	if err := ClearTickFailure(marker); err != nil {
		t.Fatal("clearing an episode that never started is not an error")
	}
	if began, _ := RecordTickFailure(marker, at, boom); !began {
		t.Fatal("the next outage alerts again")
	}
}

func TestFailedTickTextIsOneLine(t *testing.T) {
	text := FailedTickText(errors.New("teamclaude status did not match expected shape: [\n  {\n    \"code\": \"invalid_type\"\n  }\n]"))
	if strings.Contains(text, "\n") || strings.Contains(text, `"code"`) || !strings.Contains(text, "no program can start") || !strings.HasSuffix(text, "See it: tail -40 ~/.drovr/logs/tick.err") {
		t.Fatal(text)
	}
	if len(FailedTickText(errors.New(strings.Repeat("x", 5000)))) >= 260 {
		t.Fatal("an enormous message is cut")
	}
}

func TestOrphanActionAndDuration(t *testing.T) {
	yes, no := true, false
	if OrphanAction(&yes) != "reattach" || OrphanAction(&no) != "close" || OrphanAction(nil) != "skip" {
		t.Fatal("orphan")
	}
	for ms, want := range map[int64]string{10_000: "10s", 59_499: "59s", 60_000: "1m", 90_000: "2m", 480_000: "8m"} {
		if DurationText(ms) != want {
			t.Errorf("%d → %s", ms, DurationText(ms))
		}
	}
}

func TestDecisionRecordWritesInfinityAsNull(t *testing.T) {
	inf := decide.Cycles(math.Inf(1))
	d := decide.Decision{Verdict: "GO", Reason: "fundable", CyclesFundable: &inf}
	rec := DecisionRecord("alpha", d, 1787400000000)
	path := filepath.Join(t.TempDir(), "decisions.jsonl")
	if err := ledger.AppendRecord(path, rec); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"v":1,"at":"2026-08-22T12:00:00.000Z","program":"alpha","verdict":"GO","reason":"fundable","pool":null,"cyclesFundable":null}`+"\n" {
		t.Fatalf("%s", raw)
	}
}
```
- [ ] **Step 2: Write the failing end-to-end tests**

`internal/tick/e2e_test.go`:
```go
package tick

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/asks"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
)

func lockHeld(path string) (lock.Held, bool, error) { return lock.HeldBy(path) }

// home builds a DROVR_HOME: alpha (fresh), beta (abandoned an hour ago, its report written
// since), gamma (started an hour ago, no lock holder, no terminal: an orphan). PATH carries the
// teamclaude and launchctl shims; Self is a stub that records the run-cycle it was asked for.
func home(t *testing.T, control string) (Env, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	dir := t.TempDir()
	t.Setenv("DROVR_HOME", dir)
	p := paths.New()
	paths.EnsureDirs(p, "beta")
	os.WriteFile(p.Control, []byte(control), 0o644)
	now := epoch.Now()
	hourAgo, ended := epoch.ISO(now-3_600_000), epoch.ISO(now-1_800_000)
	ledger.AppendRecord(p.Cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: "beta", StartedAt: hourAgo, EndedAt: &ended, Exit: "abandoned", PoolAfter: &ledger.Cost{}})
	ledger.AppendRecord(p.Cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: "gamma", StartedAt: hourAgo, Exit: "running"})
	os.WriteFile(p.LastCycle("beta"), []byte(`{"exit":"seam"}`), 0o644)
	stub := filepath.Join(t.TempDir(), "drovr")
	os.WriteFile(stub, []byte("#!/bin/sh\necho \"$@\" >> \"$DROVR_HOME/launched\"\n"), 0o755)
	bin, _ := filepath.Abs("../../testdata/bin")
	orcaBin, _ := filepath.Abs("../orca/testdata")
	t.Setenv("PATH", orcaBin+":"+bin+":"+os.Getenv("PATH"))
	t.Setenv("ORCA_ANSWERS", t.TempDir())
	out, errs := &bytes.Buffer{}, &bytes.Buffer{}
	return Env{Paths: p, Now: epoch.Now, Out: out, Err: errs, Self: stub, Host: "mac", Home: t.TempDir(),
		Orca: orca.NewClient(p, errs), Asks: asks.NewReader(), Exit: func(int) { t.Fatal("the watchdog fired") }}, out, errs
}

const threePrograms = `{"notifyTo":null,"programs":[{"name":"alpha","cwd":"/tmp/a"},{"name":"beta","cwd":"/tmp/b"},{"name":"gamma","cwd":"/tmp/g"}]}`

func launched(t *testing.T, env Env, want int) []string {
	path := filepath.Join(env.Paths.Base, "launched")
	for i := 0; i < 40; i++ {
		raw, _ := os.ReadFile(path)
		if lines := strings.Fields(strings.ReplaceAll(string(raw), "run-cycle", "")); len(lines) >= want {
			return lines
		}
		time.Sleep(50 * time.Millisecond)
	}
	raw, _ := os.ReadFile(path)
	return strings.Fields(strings.ReplaceAll(string(raw), "run-cycle", ""))
}

func decisions(t *testing.T, path string) []ledger.Decision {
	raw, _ := os.ReadFile(path)
	var out []ledger.Decision
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		var d ledger.Decision
		if line != "" && json.Unmarshal([]byte(line), &d) == nil {
			out = append(out, d)
		}
	}
	return out
}

func TestEveryGOLaunchesExactlyOnce(t *testing.T) {
	env, _, errs := home(t, threePrograms)
	if err := Run(context.Background(), env); err != nil {
		t.Fatalf("%v\n%s", err, errs)
	}
	ds := decisions(t, env.Paths.Decisions)
	var gos []string
	for _, d := range ds {
		if d.Verdict == "GO" {
			gos = append(gos, d.Program)
		}
	}
	if len(ds) != 3 || len(gos) == 0 || len(gos) > 2 {
		t.Fatalf("decisions %+v", ds)
	}
	got := launched(t, env, len(gos))
	sort.Strings(got) // two detached stubs append concurrently: order is theirs, not ours
	sort.Strings(gos)
	if strings.Join(got, ",") != strings.Join(gos, ",") {
		t.Fatalf("launched %v for GO %v", got, gos)
	}
	for _, f := range []string{env.Paths.LastTick, env.Paths.Usage} {
		if _, err := os.Stat(f); err != nil {
			t.Errorf("%s: %v", f, err)
		}
	}
	if _, held, _ := lockHeld(env.Paths.TickLock); held {
		t.Fatal("tick lock outlived the pass")
	}
}

func TestTickSupersedesAnAbandonedCycle(t *testing.T) {
	env, out, _ := home(t, threePrograms)
	Run(context.Background(), env)
	cycles, _ := ledger.ReadCycles(env.Paths.Cycles)
	var beta *ledger.Cycle
	for i := range cycles {
		if cycles[i].Program == "beta" {
			beta = &cycles[i]
		}
	}
	if beta == nil || beta.Exit != "seam" || !strings.Contains(out.String(), `beta: cycle started`) || !strings.Contains(out.String(), `reported "seam" after drovr stopped watching`) {
		t.Fatalf("%+v\n%s", beta, out)
	}
}

func TestTickClosesAnOrphanAsAbandoned(t *testing.T) {
	env, _, errs := home(t, threePrograms)
	Run(context.Background(), env)
	cycles, _ := ledger.ReadCycles(env.Paths.Cycles)
	ends := ledger.LatestEnds(cycles)
	var gamma *ledger.Cycle
	for i := range ends {
		if ends[i].Program == "gamma" {
			gamma = &ends[i]
		}
	}
	if gamma == nil || gamma.Exit != "abandoned" || gamma.PoolAfter == nil || !strings.Contains(errs.String(), "gamma: cycle started") || !strings.Contains(errs.String(), "and no runner — closed as abandoned") {
		t.Fatalf("%+v\n%s", gamma, errs)
	}
}

func TestMalformedLateReportDoesNotStopTheTick(t *testing.T) {
	env, _, errs := home(t, threePrograms)
	os.WriteFile(env.Paths.LastCycle("beta"), []byte("{nope"), 0o644)
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errs.String(), "ignoring unreadable cycle report for beta") || len(decisions(t, env.Paths.Decisions)) != 3 {
		t.Fatalf("%s", errs)
	}
}

func TestUsageFailureDoesNotFailTheTick(t *testing.T) {
	env, _, errs := home(t, threePrograms)
	os.MkdirAll(env.Paths.Usage, 0o755) // a directory where the log should be
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(errs.String(), "usage sample not recorded:") || !strings.Contains(errs.String(), "Admission is unaffected.") {
		t.Fatalf("%s", errs)
	}
	if _, err := os.Stat(env.Paths.LastTick); err != nil {
		t.Fatal("the pass still completed")
	}
}

func TestFailedTickRunsTheEpisode(t *testing.T) {
	env, _, errs := home(t, threePrograms)
	broken := t.TempDir()
	os.WriteFile(filepath.Join(broken, "teamclaude"), []byte("#!/bin/sh\necho 'proxy down' >&2\nexit 1\n"), 0o755)
	t.Setenv("PATH", broken+":"+os.Getenv("PATH"))
	if err := Run(context.Background(), env); err == nil {
		t.Fatal("a failed pass still fails")
	}
	if _, err := os.Stat(env.Paths.TickFailure); err != nil {
		t.Fatal("no episode marker")
	}
	if !strings.Contains(errs.String(), "could not alert the failed tick: notifyTo is null in control.json, so the alert was dropped.") {
		t.Fatalf("%s", errs)
	}
	if _, held, _ := lockHeld(env.Paths.TickLock); held {
		t.Fatal("the lock is released before the alert")
	}
}

func TestBusyLockNamesTheHolder(t *testing.T) {
	env, out, errs := home(t, threePrograms)
	holder := exec.Command("sleep", "5")
	holder.Start()
	defer holder.Process.Kill()
	pid := holder.Process.Pid
	write := func(ageMs int64) {
		os.WriteFile(env.Paths.TickLock, []byte(`{"pid":`+itoa(pid)+`,"at":`+strconv.FormatInt(epoch.Now()-ageMs, 10)+`}`), 0o644)
	}
	write(60_000)
	Tick(context.Background(), env)
	if !strings.Contains(out.String(), "another tick is still evaluating (pid "+itoa(pid)+", held 1m)") {
		t.Fatalf("%s", out)
	}
	write(20 * 60_000)
	Tick(context.Background(), env)
	if !strings.Contains(errs.String(), `wedged rather than busy. Clear it with "kill `+itoa(pid)+`"`) {
		t.Fatalf("%s", errs)
	}
}

func TestAwayIsAppliedNotWritten(t *testing.T) {
	env, out, _ := home(t, `{"notifyTo":"craig","programs":[{"name":"alpha","cwd":"/tmp/a"}]}`)
	var published string
	env.Caller = func() (hey.Call, error) {
		return func(_ context.Context, tool string, args any) (json.RawMessage, error) {
			if tool == "putStatus" {
				b, _ := json.Marshal(args)
				published = string(b)
				return json.RawMessage(`{"sk":"status#drovr@mac","at":"x","expiresAt":1}`), nil
			}
			return json.RawMessage(`{"prefs":{"quietHours":null,"away":true}}`), nil
		}, nil
	}
	before, _ := os.ReadFile(env.Paths.Control)
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	after, _ := os.ReadFile(env.Paths.Control)
	if string(before) != string(after) || !strings.Contains(out.String(), "mode normal → away for this pass: the phone says away") {
		t.Fatalf("%s", out)
	}
	if !strings.Contains(published, `\"modeFromPhone\":true`) || !strings.Contains(published, `"to":"craig","host":"mac"`) {
		t.Fatalf("published %s", published)
	}
	if !strings.Contains(out.String(), "status published to hey (") {
		t.Fatalf("%s", out)
	}
}
```
The TS passes `lockHolder: null` as an *input* to the payload builder (the publisher is the holder); `status.ServicePayload` has no lock-holder field, so what the published row can prove is `modeFromPhone`.

- [ ] **Step 3: Run, watch them fail** — `go test ./internal/tick/` → build failure.

- [ ] **Step 4: Implement**

`Tick` follows the TS pass in order, each step a helper under 60 lines:
1. `EnsureDirs(p, "")`; `lock.Acquire(TickLock)`. Not acquired → one `lock.HeldBy` read (an error there is returned: an unreadable lock is never free) → `another tick is still evaluating (pid <pid|unknown>, held <DurationText|unknown age>)` on `Out`, or with ` — longer than the <budget> budget, so it is wedged rather than busy. Clear it with "kill <pid>"; the next firing then runs.` on `Err` when held longer than the budget; return nil.
2. Budget from `control.Read` *before* the watchdog is armed, outside the release (as the TS: a throw here exits the process and the dead holder's lock is reclaimed next firing). `time.AfterFunc(budget, func() { ReleaseOverrunningTick(…); env.Exit(1) })`; `defer` stop and `lock.Release`.
3. `stored := control.Read`; channel `{stored.NotifyTo, env.Caller, env.Host, env.Err}`; `PhonePrefs` (warning to `Err`); `control.ApplyAwayMode`; the mode-change line on `Out`; `teamclaude.Read`.
4. `reconcileAbandoned(ctx, env, now, control, status)` → `(records []ledger.Cycle, reattach []string)`: in-flight (window `MaxCycleHours`) records with no live program-lock holder; `RunnerIsPresent` → `*bool` (error → nil, logged `<p>: could not read its runner's state (<err>) — admission proceeds as if there were none.`); `OrphanAction`; skip → `<opened> and orca cannot say whether its runner is alive — left open until it can` on `Err`; reattach → `<opened> but its runner is still there — attaching a new one` on `Out`; close → a record `{...cycle, endedAt: now, exit: abandoned, poolAfter: poolNow ?? poolBefore}` and `<opened> and no runner — closed as abandoned; a report it left is reconciled next` on `Err`. `Tick` appends the records and `Launch`es the re-attaches.
5. `reconcileLateReports(ctx, env, now, cycles)` → records: per program in the file's control (not the phone-adjusted one, as the TS re-reads it), latest end `abandoned` and a readable report (`readReportOrWarn`) → the superseding record with the report's fields and `closing` from `transcript.ClosingMessage(…, *last.SessionID, program.Host, Err)` when the session id is set; the `Out` line `<p>: cycle started <at> reported "<exit>" after drovr stopped watching — record superseded, its yield and cost now count`. `Tick` appends.
6. The admission loop over enabled programs by priority: cycles = file + `launched`; owed → `Asks.Read` and `NudgeIfNeglected`; `runnerAfterLeftover` for orca runners (`RunnerIsPresent`; present and no cycle in flight → `ReleaseLeftover(ctx, p, LastCycleReported(mine))`; not released → true; release error → logged `<p>: could not release its leftover runner (<err>)` and true; released → `<p>: released the runner its last cycle left behind` and false); `decide.Decide` with `AnsweredAt`/`AsksShared` from the asks state and `RunnerPresent`; `AppendRecord(Decisions, DecisionRecord(...))`; `<p>: <VERDICT> — <FullReason>` on `Out`; `GO` with a pool → `Launch` and a projected start record into `launched` (poolBefore = the decision's pool snapshot).
7. Usage: `usage.Append(p.Usage, usage.SampleOf(status, now), usage.MaxBytes)`; failure → `usage sample not recorded: <err>. Admission is unaffected.` (`// swallowed: a full disk must cost the measurement, never the tick`).
8. Publish: cycles = file + launched; `status.Build` with `everyEvaluation` (evaluated ones reused, disabled ones decided without I/O), `StoredMode: stored.Mode`, `Now: env.Now()`, service `{service.Current(), ReadTickStamp, nil}`; compact JSON (encoder, no HTML escape, trailing newline trimmed); `PublishStatus(payload.GeneratedAt, text)`; sent → `status published to hey (<n> bytes)` where `n` is the UTF-16 length, as the TS's `text.length`; a Build error → `status not published: <err>. Admission is unaffected.` (`// swallowed: a window onto the tick must not be able to close it`).
9. `StampTick(LastTick, Now())`, `ClearTickFailure`.

`Run` wraps `Tick`: on error, `RecordTickFailure`; when it began the episode, read control (its error → `could not alert the failed tick: <err>`), `TextCraig(FailedTickText(err), AlertFrom(nil, Host))`, then `alerted the failed tick: hey <id>.` or `could not alert the failed tick: <reason or "hey did not take it">.` on `Err`; return the original error. `ReleaseOverrunningTick` logs the message first, releases (an error logged `could not release the tick lock: <err>`), then reads control and texts (errors logged `could not text the overrun: <err>`), returning the message `drovr: a tick overran <DurationText(budget)> and was aborted (pid <pid>). Its lock is released, so the next firing runs. Check ~/.drovr/logs/tick.err.`. `FailedTickText`: first line of the message, `jsnum.Slice(first, 140)`. `Launch`: `exec.Detach(env.Self, ["run-cycle", program], p.WorkerLog(program))`, then `<p>: launched cycle (pid <pid>, log <path>)` on `Out`.

- [ ] **Step 5: Run, vet, fmt** — `go test ./internal/tick/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/tick
git commit -m "feat(go): the tick — lock and watchdog, reconcile before admission, admission with orca and asks, detached workers, sample, publish, stamp"
```

---
### Task 16: `tick --shadow`, and the diff that judges it

The spec's conformance layer 3. A shadow pass is the live pass with every effect turned inward: it reads everything the live tick reads, decides with the same code, and writes only `decisions-shadow.jsonl`.

**Files:**
- Modify: `internal/tick/tick.go`, `internal/tick/reconcile.go`, `internal/tick/run.go`
- Create: `internal/tick/shadow_test.go`, `scripts/shadowdiff/main.go`, `scripts/shadowdiff/main_test.go`, `scripts/shadow-diff.sh` (`chmod +x`)

**Interfaces:**
- Consumes: Task 15's `Env.Shadow`, `reconcileAbandoned`/`reconcileLateReports` returning records; `orca.(*Client).LeftoverIntent`, `Client.ReadOnly`; `paths.Paths.DecisionsShadow`, `TickShadowLock`.
- Produces: `Tick`/`Run` honour `Env.Shadow`:

  | Live | Shadow |
  |---|---|
  | `tick.lock` | `tick-shadow.lock` (never contends with the Node tick) |
  | appends reconciled records to `cycles.jsonl` | appends them to the pass's in-memory cycles |
  | `Launch`es re-attaches and admitted programs | logs `<p>: would launch` / `would attach`; still books the projected start, so later programs see the same pool |
  | `NudgeIfNeglected` | skipped |
  | `ReleaseLeftover` | `LeftoverIntent`: `close`/`exit` read as released (false), `hold` as present; `Orca.ReadOnly = true` so adoption rewrites nothing |
  | `decisions.jsonl` | `decisions-shadow.jsonl` |
  | usage sample, status publish, `StampTick`, `ClearTickFailure` | skipped |
  | `Run`: marker and alert on failure | the error alone |
  | watchdog: release, text, exit | release the shadow lock, log, exit — no text |

  ```go
  // scripts/shadowdiff
  type entry struct{ At, Program, Verdict, Reason string; at epoch.Millis }
  type finding struct{ Kind string; Live entry; Shadow *entry } // Kind: verdict | reason | drift | unpaired
  type report struct{ Paired, Unpaired, Verdict, Reason, Drift int; Findings []finding }
  func compare(live, shadow []entry, since epoch.Millis) report
  ```
  Pairing rule (the spec question this plan answers): launchd's `StartInterval` cannot align two agents to the second, so the shadow fires every 60 s and each live decision is paired with the **latest shadow decision for the same program at or before it, within 60 s** — before, because a shadow pass after the live one sees the cycle the live one just launched. Verdicts must match exactly. Reasons are compared exactly, and a mismatch that disappears when every digit run is replaced by `#` is reported as **numeric drift** (the pool moved in the seconds between the passes), not as a failure. A clean day is zero verdict mismatches, zero reason mismatches and zero unpaired live decisions; drift is listed for a human to glance at.

- [ ] **Step 1: Write the failing tests**

`internal/tick/shadow_test.go`:
```go
package tick

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/orca"
)

func snapshot(t *testing.T, dir string) map[string]string {
	files := map[string]string{}
	filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			b, _ := os.ReadFile(path)
			rel, _ := filepath.Rel(dir, path)
			files[rel] = string(b)
		}
		return nil
	})
	return files
}

func TestShadowDecidesLikeLiveAndTouchesNothing(t *testing.T) {
	env, _, _ := home(t, threePrograms)
	fixed := epoch.Now()
	env.Now = func() epoch.Millis { return fixed }
	env.Orca.Sleep = func(time.Duration) {}
	// alpha: its last cycle reported, and its runner idles at the prompt — live sends /exit.
	ended := epoch.ISO(fixed - 600_000)
	ledger.AppendRecord(env.Paths.Cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: "alpha", StartedAt: epoch.ISO(fixed - 7_200_000), EndedAt: &ended, Exit: "seam", PoolAfter: &ledger.Cost{}})
	os.MkdirAll(env.Paths.ProgramState("alpha"), 0o755)
	orca.RememberTerminal(env.Paths, "alpha", orca.Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	answers := os.Getenv("ORCA_ANSWERS")
	for name, body := range map[string]string{
		"terminal_show.json":          `{"ok":true,"result":{"terminal":{"handle":"term_1","agentIdentity":"claude","agentWait":null}}}`,
		"terminal_show.exited.json":   `{"ok":true,"result":{"terminal":{"handle":"term_1","agentIdentity":null}}}`,
		"terminal_wait_exit.json":     `{"ok":false,"error":{"code":"timeout"}}`,
		"terminal_wait_tui-idle.json": `{"ok":true,"result":{"wait":{"satisfied":true}}}`,
		"terminal_send.json":          `{"ok":true,"result":{}}`,
		"terminal_close.json":         `{"ok":true,"result":{}}`,
	} {
		os.WriteFile(filepath.Join(answers, name), []byte(body), 0o644)
	}
	before := snapshot(t, env.Paths.Base)
	shadow := env
	shadow.Shadow = true
	shadow.Orca = orca.NewClient(env.Paths, env.Err)
	shadow.Orca.ReadOnly, shadow.Orca.Sleep = true, func(time.Duration) {}
	if err := Run(context.Background(), shadow); err != nil {
		t.Fatal(err)
	}
	after := snapshot(t, env.Paths.Base)
	shadowLines := after["decisions-shadow.jsonl"]
	delete(after, "decisions-shadow.jsonl")
	if len(after) != len(before) {
		t.Fatalf("shadow created or removed files: %v", keys(after))
	}
	for name, body := range before {
		if after[name] != body {
			t.Errorf("shadow changed %s", name)
		}
	}
	calls, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
	if strings.Contains(string(calls), "terminal send") || strings.Contains(string(calls), "terminal close") {
		t.Fatalf("shadow acted on a runner:\n%s", calls)
	}
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	live := decisions(t, env.Paths.Decisions)
	shadowDecisions := decisions(t, env.Paths.DecisionsShadow)
	if len(live) != 3 || len(shadowDecisions) != 3 || shadowLines == "" {
		t.Fatalf("live %d shadow %d", len(live), len(shadowDecisions))
	}
	for i := range live {
		if live[i].Program != shadowDecisions[i].Program || live[i].Verdict != shadowDecisions[i].Verdict || live[i].Reason != shadowDecisions[i].Reason {
			t.Errorf("live %+v\nshadow %+v", live[i], shadowDecisions[i])
		}
	}
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}
```
(`time` joins the imports.) The live run afterwards sends `/exit` to alpha's runner and releases it, which is the contrast that makes the shadow's silence meaningful; both passes read alpha's runner as absent.

`scripts/shadowdiff/main_test.go`:
```go
package main

import (
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
)

func e(at, program, verdict, reason string) entry {
	return entry{At: at, Program: program, Verdict: verdict, Reason: reason, at: epoch.MustParse(at)}
}

func TestCompare(t *testing.T) {
	live := []entry{
		e("2026-10-23T10:00:30.000Z", "alpha", "GO", "fundable: 1.25 cycles"),
		e("2026-10-23T10:10:30.000Z", "alpha", "GO", "fundable: 1.25 cycles"),
		e("2026-10-23T10:20:30.000Z", "beta", "WAIT", "x"),
		e("2026-10-23T10:30:30.000Z", "beta", "WAIT", "held for alpha"),
		e("2026-10-23T10:40:30.000Z", "gamma", "STOP", "disabled"),
		e("2026-10-23T09:00:00.000Z", "gamma", "GO", "before --since: ignored"),
	}
	shadow := []entry{
		e("2026-10-23T10:00:05.000Z", "alpha", "GO", "fundable: 1.25 cycles"),
		e("2026-10-23T10:00:40.000Z", "alpha", "WAIT", "after the live pass: never its pair"),
		e("2026-10-23T10:10:10.000Z", "alpha", "GO", "fundable: 1.20 cycles"),
		e("2026-10-23T10:20:20.000Z", "beta", "GO", "x"),
		e("2026-10-23T10:30:01.000Z", "beta", "WAIT", "held back for alpha"),
		e("2026-10-23T10:38:00.000Z", "gamma", "STOP", "disabled"),
	}
	r := compare(live, shadow, epoch.MustParse("2026-10-23T10:00:00.000Z"))
	if r.Paired != 4 || r.Unpaired != 1 || r.Verdict != 1 || r.Reason != 1 || r.Drift != 1 {
		t.Fatalf("%+v", r)
	}
	if summary(r) != "paired 4, unpaired 1, verdict 1, reason 1, numeric drift 1" || exitCode(r) != 1 {
		t.Fatal(summary(r))
	}
	var kinds []string
	for _, f := range r.Findings {
		kinds = append(kinds, f.Kind+":"+f.Live.Program)
	}
	if strings.Join(kinds, ",") != "drift:alpha,verdict:beta,reason:beta,unpaired:gamma" {
		t.Fatal(kinds)
	}
	if exitCode(compare(live[:1], shadow[:1], 0)) != 0 {
		t.Fatal("a clean window exits 0")
	}
}
```
`scripts/shadow-diff.sh`:
```sh
#!/bin/sh
# Pairs the live tick's decisions with the shadow tick's and prints every difference.
# Exit 0 over a whole day is the cut-over gate:
#   scripts/shadow-diff.sh --since 2026-10-24T00:00:00Z
# Defaults: $DROVR_HOME (or ~/.drovr)/decisions.jsonl and decisions-shadow.jsonl.
set -eu
cd "$(dirname "$0")/.."
exec go run ./scripts/shadowdiff "$@"
```

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/tick/ -run Shadow ./scripts/shadowdiff/` → FAIL (`decisions-shadow.jsonl` absent; `undefined: compare`).

- [ ] **Step 3: Implement**

In `tick`: one helper per divergence, each a two-line `if env.Shadow` at the top of the step it changes — never a second copy of a step. `cycles` for the admission loop is `file + reconciled-in-memory + launched` in shadow, `file + launched` live (live has already appended its reconciled records). Shadow passes `env.Orca` with `ReadOnly` set by the caller (Task 17 constructs it).

`scripts/shadowdiff/main.go`: flags `--since <ISO>` (default: 24 h before the newest live line) and two optional positional paths; reads both files leniently (a line that does not decode is counted and named on stderr, never fatal — this is a report about the logs, not one of them); `compare` sorts shadow entries per program by time and binary-searches the latest at or before each live entry within 60 000 ms; `masked(s)` is `regexp.MustCompile(`\d+`).ReplaceAllString(s, "#")`. Each finding prints as
```
<live at>  <program>  <kind>   live <VERDICT>  shadow <VERDICT>
  live:   <reason>
  shadow: <reason>
```
then the summary line; `exitCode` is 1 when `Verdict + Reason + Unpaired > 0`.

- [ ] **Step 4: Run, vet, fmt** — `go test ./internal/tick/ ./scripts/shadowdiff/ -count=1 && go vet ./... && gofmt -l .` → PASS.

- [ ] **Step 5: Commit**

```bash
git add internal/tick scripts/shadowdiff scripts/shadow-diff.sh
git commit -m "feat(go): tick --shadow — the live pass with every effect turned inward — and the diff that pairs it with the Node tick"
```

---

### Task 17: CLI wiring — `tick`, `run-cycle`, `report`, `notify`, `service`, and `status` with its real inputs

**Files:**
- Modify: `main.go`, `internal/cli/status.go` (drop `unreadCaveat`; real asks, runner and phone inputs; the binary-mismatch note), `internal/cli/status_test.go`, `conformance_test.go`
- Create: `internal/cli/wire.go` (constructors for `tick.Env`, `cycle.Worker`, `nudge.Channel`), `internal/cli/report.go`, `internal/cli/notify.go`, `internal/cli/service.go`, `internal/cli/commands_test.go`
- Port from: `src/cli.ts` (`tick`, `run-cycle`, `report`/`reportCycle`, `notify`, `service` and `showService`/`installService`/`uninstallService`, `evaluateAll`'s asks and runner probes, `stampConsole`)

**Interfaces:**
- Consumes: everything above; E1's `cli.Env`, `cli.Status`, `cli.EvaluateAll`, `help.AgentNotes`; in `main.go`, E1's `exitOne{}` and `encode`.
- Produces:
  ```go
  package cli
  // Env gains: Self (the binary, service.Self()), Host (os.Hostname), Home (os.UserHomeDir), Caller nudge.CallerFunc.
  type Probes struct {
      Asks   func(control.Program) (*asks.State, error)
      Runner func(control.Program) *bool // nil: unknown (headless, or orca did not answer)
  }
  func EvaluateAll(c control.Control, s teamclaude.Status, cycles []ledger.Cycle, now epoch.Millis, lockPid func(string) *int, probes Probes) ([]status.Evaluation, error)
  func TickEnv(env Env, shadow bool) tick.Env
  func Worker(env Env) cycle.Worker
  func Report(env Env, args []string) error
  func Notify(ctx context.Context, env Env, args []string, asJSON bool) error
  func Service(ctx context.Context, env Env, args []string, asJSON bool) error
  ```
  `main.go` routes `tick [--shadow]` and `run-cycle <program>` with stdout and stderr wrapped in `epoch.Stamped` (and only those two); `cycle.ErrAlreadyRunning` and a failed `notify` map to `exitOne{}` because their line is already printed. Every other registered command stays `notPorted`.

- [ ] **Step 1: Write the failing tests**

`internal/cli/commands_test.go`:
```go
package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/paths"
)

func cliEnv(t *testing.T, control string) (Env, *bytes.Buffer, *bytes.Buffer) {
	t.Setenv("DROVR_HOME", t.TempDir())
	p := paths.New()
	os.WriteFile(p.Control, []byte(control), 0o644)
	out, errs := &bytes.Buffer{}, &bytes.Buffer{}
	return Env{Paths: p, Now: func() epoch.Millis { return epoch.MustParse("2026-08-28T12:00:00Z") }, Stdout: out, Stderr: errs, Self: "/opt/homebrew/bin/drovr", Host: "mac", Home: t.TempDir()}, out, errs
}

func TestReportWritesAndAppliesTheRest(t *testing.T) {
	env, out, _ := cliEnv(t, `{"programs":[{"name":"sunnyt","cwd":"/s"}]}`)
	if err := Report(env, []string{"sunnyt", "--exit", "seam", "--pause-until", "48h", "--cadence", "7d"}); err != nil {
		t.Fatal(err)
	}
	want := "reported sunnyt: exit=seam → " + env.Paths.LastCycle("sunnyt") + "\n" +
		"sunnyt rests until 2026-08-30T12:00:00.000Z — resume early: drovr resume sunnyt\n" +
		"sunnyt now runs at most once per 7d — change: drovr cadence sunnyt off\n" +
		"the cycle is now over — drovr will close this session; start nothing new\n"
	if out.String() != want {
		t.Fatalf("%q", out.String())
	}
	raw, _ := os.ReadFile(env.Paths.Control)
	if !strings.Contains(string(raw), `"pauseUntil": "2026-08-30T12:00:00.000Z"`) || !strings.Contains(string(raw), `"cadence": "7d"`) {
		t.Fatalf("%s", raw)
	}
	if err := Report(env, []string{"nope", "--exit", "seam"}); err == nil || err.Error() != `no program named "nope" — tracked: sunnyt` {
		t.Fatalf("%v", err)
	}
}

func TestNotify(t *testing.T) {
	env, _, errs := cliEnv(t, `{"notifyTo":null,"programs":[]}`)
	if err := Notify(context.Background(), env, []string{"hi"}, false); err == nil || !strings.Contains(errs.String(), "notifyTo is not set in ~/.drovr/control.json") {
		t.Fatalf("%v %s", err, errs)
	}
	env, out, _ := cliEnv(t, `{"notifyTo":"craig","programs":[]}`)
	env.Caller = func() (hey.Call, error) {
		return func(context.Context, string, any) (json.RawMessage, error) {
			return json.RawMessage(`{"id":"01J","createdAt":"x","waitUntil":null,"pushed":true,"quiet":false,"reason":null}`), nil
		}, nil
	}
	if err := Notify(context.Background(), env, []string{"hello", "there", "--json"}, true); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Sent      bool            `json:"sent"`
		ID        string          `json:"id"`
		To        string          `json:"to"`
		Message   string          `json:"message"`
		Note      string          `json:"note"`
		UsingThis json.RawMessage `json:"usingThis"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || !got.Sent || got.ID != "01J" || got.Message != "hello there" || len(got.UsingThis) == 0 {
		t.Fatalf("%s %v", out, err)
	}
}

func TestServicePrintNamesThisBinary(t *testing.T) {
	env, out, _ := cliEnv(t, `{"programs":[]}`)
	if err := Service(context.Background(), env, []string{"print"}, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "<string>/opt/homebrew/bin/drovr</string>\n    <string>tick</string>\n  </array>") || !strings.Contains(out.String(), "<integer>600</integer>") {
		t.Fatalf("%s", out)
	}
	out.Reset()
	Service(context.Background(), env, []string{"print", "--shadow"}, false)
	if !strings.Contains(out.String(), "tech.propra.drovr.shadow") || !strings.Contains(out.String(), "<string>--shadow</string>") || !strings.Contains(out.String(), "<integer>60</integer>") || !strings.Contains(out.String(), filepath.Join(env.Paths.Logs, "tick-shadow.err")) {
		t.Fatalf("%s", out)
	}
	if err := Service(context.Background(), env, []string{"reload"}, false); err == nil || err.Error() != `unknown service subcommand "reload" — expected status, install, uninstall or print (label: tech.propra.drovr)` {
		t.Fatalf("%v", err)
	}
}
```
In `internal/cli/status_test.go`, `TestEvaluateAllBooksEachGO` passes `Probes{Asks: func(control.Program) (*asks.State, error) { return nil, nil }, Runner: func(control.Program) *bool { return nil }}`, and a new case asserts a runner reported present holds its program:
```go
func TestEvaluateAllHoldsAProgramWithALiveRunner(t *testing.T) {
	c, s, cycles := fixture(t) // the three reads TestEvaluateAllBooksEachGO already does, lifted into a helper
	present := true
	got, err := EvaluateAll(c, s, cycles, epoch.MustParse("2026-06-01T00:00:00.000Z"), func(string) *int { return nil }, Probes{
		Asks:   func(control.Program) (*asks.State, error) { return nil, nil },
		Runner: func(p control.Program) *bool { if p.Name == "alpha" { return &present }; return nil },
	})
	if err != nil || got[0].Program.Name != "alpha" || got[0].Decision.Verdict == "GO" {
		t.Fatalf("%+v %v", got[0], err)
	}
}
```
In `conformance_test.go` add:
```go
func TestServiceStatusJSONMatchesOracle(t *testing.T) {
	g, n := runBoth(t, "service", "status", "--json")
	if g != n {
		t.Fatalf("service status --json differs\n--- go\n%s\n--- node\n%s", g, n)
	}
}

func TestShadowTickThroughTheBinary(t *testing.T) {
	home := t.TempDir()
	src, _ := os.ReadFile("testdata/home/control.json")
	os.WriteFile(filepath.Join(home, "control.json"), src, 0o644)
	bin, _ := filepath.Abs("testdata/bin")
	cmd := exec.Command(goBin, "tick", "--shadow")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "DROVR_HOME="+home, "HOME="+t.TempDir())
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	lines, _ := os.ReadFile(filepath.Join(home, "decisions-shadow.jsonl"))
	if strings.Count(string(lines), "\n") != 2 || !regexp.MustCompile(`(?m)^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z alpha: `).Match(out) {
		t.Fatalf("decisions:\n%s\noutput:\n%s", lines, out)
	}
	for _, f := range []string{"decisions.jsonl", "last-tick.json", "usage.jsonl", "cycles.jsonl", "launched"} {
		if _, err := os.Stat(filepath.Join(home, f)); err == nil {
			t.Errorf("shadow wrote %s", f)
		}
	}
}
```
The fixture has two enabled programs (alpha, beta), so two shadow decision lines; `TestStatusJSONMatchesOracle` and `TestStatusTextMatchesOracle` stay as they are and must still pass with the real probes — the orca shim (`testdata/bin/orca`, exit 1) is never reached because no program has a remembered terminal (both CLIs read the runner as `gone`), `notifyTo` is null (no phone), and no program has an asks page or file.

- [ ] **Step 2: Run, watch them fail** — `go test ./internal/cli/ . -count=1` → build failures (`undefined: Report`, `EvaluateAll` arity), then the two new conformance tests fail on `not ported`.

- [ ] **Step 3: Implement**

`wire.go` builds `tick.Env{Paths, Now, Out: Stdout, Err: Stderr, Self, Host, Home, TeamclaudeBin, Orca: orca.NewClient(p, Stderr) with ReadOnly = shadow, Asks: asks.NewReader(), Caller, Exit: os.Exit, Shadow: shadow}` and the matching `cycle.Worker` (`Sleep: time.Sleep`). `Report` ports `reportCycle` (above, verbatim lines) with `keys.MutateInPlace` for the pause and cadence, as the TS's `cli.ts` `mutate` writes in place. `Notify` ports the `notify` branch: message from the words that are not `--json`, else `drovr: notification test from <host> at <ISO>`; null `notifyTo` → `notifyTo is not set in ~/.drovr/control.json — set it to a hey handle, e.g. "craig" (see infra/users.tf).` on stderr and exit 1; JSON `{sent, id, to, message, note: "sent means the row exists in the hey table; the app shows it on its next refresh or push", usingThis: help.AgentNotes}` indented; text `sent <id> to <to>` or `the send failed: <reason>` on stderr; not sent → exit 1. `Service` ports `showService` (text and the JSON object `{tick: {health, explanation, lastTickAt, installed, loaded, pid, lastExitStatus, intervalSeconds, plistPath, loadCommand, unloadCommand}}`, plus the binary-mismatch note on stderr in text mode), `installService` (seconds from `args[1]`, default 600; `--shadow` → `ShadowLabel`, `["tick","--shadow"]`, `tick-shadow`, `ShadowIntervalSeconds`; the three outcome lines), `uninstallService` (both lines, label-aware with `--shadow`), `print`. `--shadow` is removed from `args` before positional parsing.

`Status`: `readInputs` adds the phone (`Channel.PhonePrefs`, warning to stderr) and applies `ApplyAwayMode`, keeping `StoredMode`; `EvaluateAll` calls `probes.Asks` for every program in priority order (an error is returned, as the TS `readAsks` throws on an unreadable asks file) and `probes.Runner` for orca runners — `RunnerState` with the idle probe, as `cli.ts` does — reading an error as nil; `unreadCaveat` and its `(see plan E2)` line go; the `service.BinaryMismatch(service.PlistPath(), env.Self)` note goes to stderr when it fires.

- [ ] **Step 4: Run everything**

Run: `go test ./... -count=1 && go vet ./... && gofmt -l . && node --test test/*.spec.ts 2>&1 | tail -3`
Expected: all `ok`, including the five oracle tests and `TestShadowTickThroughTheBinary`; TS suite green.

- [ ] **Step 5: Smoke the binary by hand**

```bash
go build -o /tmp/drovr-e2 . && /tmp/drovr-e2 service print --shadow | head -12 && DROVR_HOME=$(mktemp -d) /tmp/drovr-e2 tick --shadow; echo "exit $?"
```
Expected: a plist naming `/private/tmp/drovr-e2` (the symlink-resolved path) with `tick` and `--shadow`; the tick against an empty home fails on the missing control file with exit 1 — the same refusal the Node tick gives.

- [ ] **Step 6: Commit**

```bash
git add main.go internal/cli conformance_test.go
git commit -m "feat(go): tick, tick --shadow, run-cycle, report, notify and service from the binary; status reads asks, runners and the phone"
```

---

### Task 18: CLAUDE.md and README for a tree whose Go half can run the service

**Files:**
- Modify: `CLAUDE.md` (Conventions bullet from E1; "drovr is also a program"; "Not yet observed working"), `README.md` (the E1 paragraph under Install)

- [ ] **Step 1: CLAUDE.md**

Replace the E1 Conventions bullet's second sentence with: "`src/` is what launchd runs. `internal/` is the Go port; `drovr tick --shadow` runs it beside the live service under `tech.propra.drovr.shadow` (install: `drovr service install --shadow` from the Go binary), and `scripts/shadow-diff.sh --since <ISO>` pairs the two decision logs — a clean day is the cut-over gate."

In "drovr is also a program", append: "Once the Go binary is what launchd runs, the service no longer executes this working tree, so that reason goes; the worktree stays for the other one — two runners in one checkout race the git index."

Add to "Not yet observed working":
```
- **The Go tick, live or shadowed.** `drovr tick --shadow` and `drovr service install --shadow`
  landed with plan E2, proven end to end in temp homes against shims; no shadow agent has been
  installed, so `scripts/shadow-diff.sh` has never read a real day, and no Go `run-cycle` has
  watched a real runner.
```

- [ ] **Step 2: README**

Replace the E1 sentence with: "A Go build of drovr (`go build .`) runs the tick, `run-cycle`, `report`, `notify` and `service`; it is being proven beside the Node service with `drovr tick --shadow` and is not yet what the service runs. The install above is the one that works today."

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: the Go tick runs in shadow beside the live one — how to install it, how the day is judged, what has not been seen"
```

---

## Self-review

**Spec coverage (E2 = phases 3 and 4).** Adapters: `exec` (T2), `orca` every call and envelope rule (T3, T4), `asks` (T5), `hey` copied plus `putStatus`/`prefs`/`profile`/`send` (T6), `nudge` (T7), `usage` (T8), `lock` (E1, used by T14/T15), `service` write side (T10), `state` (T11). Unattended core: `tick` (T15), `cycle` (T13, T14), `--shadow` and its label (T16, T10, T17). Porting rules: validation through `shape` (T1); numbers and ISO through `jsnum`/`epoch` (T2); subprocesses through `RunBounded`/`Detach` with a build gate (T2); staged writes where staged (T8, T9, T13, T6); signals — the watchdog releases, logs, exits in that order (T15). Conformance layer 3: T16 and T17; layer 2 grows by `service status --json` (T17). Brought forward from E3 because a phase-3 module needs it: `preview.Parse` (T3, `readPreview` is orca's) and `keys.MutateInPlace` (T9, `report` is phase 4's report writer). Left for E3: `usage` shares and `observedYours` (`drovr usage`), `inFlightCycles` (`tidy`), every other command.

**Placeholder scan.** Two places ask the implementer to read a number off a real run rather than trust the plan: T14's first garbage `show` call index (the assertion on `maxPollFailures` lines is fixed; only the setup index may move) and the Extended_Pictographic table in T6 (transcribed from a named file and version). Neither is a "TBD"; both name what to read and where.

**Type consistency.** `orca.AgentState` constants are used by `cycle.StallInput`; `cycle.Limits` durations replace the TS milliseconds and are built once in `LimitsOf`; `nudge.Channel` is the only send surface (T7, used by T12, T14, T15, T17); `tick.Env` and `cycle.Worker` are built only in `cli/wire.go`; `ledger.Decision.CyclesFundable` stays `*float64` and `DecisionRecord` is the only converter from `*decide.Cycles`; `capacity.Bucket` is `control.Bucket` after T1.

**Review Focus → tests.** 1 → T4 `TestRefusalIsReadWhateverTheExitCode`, `TestGarbageIsAnErrorNotGone`; 2 → T13 `TestPollLeniency`, T15 `TestMalformedLateReportDoesNotStopTheTick`; 3 → T15 `TestDecisionRecordWritesInfinityAsNull`; 4 → T9 `TestMutateKeepsKeyOrderAndNodeFormatting`; 5 → T16 `TestShadowDecidesLikeLiveAndTouchesNothing`.
