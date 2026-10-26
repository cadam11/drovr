# Go port E3: the rest of the CLI, `watch`, release, cut-over — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Go binary named `drovr`, installed by `brew install cadam11/tap/drovr`, that does everything `src/cli.ts` does — including `drovr watch` with full parity — so the TypeScript tree can be deleted.

**Architecture:** Same rule as E1 and E2: one package per TS module, same names, same bytes. The fifteen unported commands are transcriptions of `src/cli.ts` proven by an oracle diff against `node src/cli.ts` on temp copies of `testdata/home` (stdout, stderr, exit code, resulting `control.json` bytes). `watch` splits into a pure half (`frame`, keybar, ANSI helpers, input parsing, key→intent) proven by recorded fixtures with `TZ=UTC` pinned, and an I/O half (`golang.org/x/term`, signals, ticker, stdin reader, one draw goroutine) proven with injected reader/writer/size. Release is a 40-line deterministic script modelled on hey's; publishing (tap repo, GitHub Release, tofu apply) is never done by an implementer. The TS is deleted in the last task, which runs only after the brew binary is on PATH.

**Tech Stack:** Go 1.26, standard library plus `golang.org/x/term` (Task 8 adds it; nothing else). `gh`, `shasum`, `tar`, `gzip` in `scripts/release.sh`. OpenTofu in the hey repo (Task 11).

**Spec:** `docs/superpowers/specs/2026-10-22-go-port-design.md` (phases 5–7, "What changes for the user", "Non-goals"). **Builds on:** E1 `docs/superpowers/plans/2026-10-22-go-port-e1-core.md`, E2 `docs/superpowers/plans/2026-10-23-go-port-e2-core.md` (both merged; the Go tick has run the live service since 2026-10-26).

**Inventories (read the section a task names, not the whole file):**
- `docs/superpowers/plans/e3-inventory/e3-cli-inventory.md` — every unported command: verbatim TS, grammar, refusal texts, files, output, exit codes, traps. §0 is the shared plumbing every CLI task needs.
- `docs/superpowers/plans/e3-inventory/e3-watch-inventory.md` — `watch` byte for byte: protocol, frame layout, bars, keybar (with golden renders at 6 widths), keys, mouse, view state, detach, pure-function table, porting notes.
- `docs/superpowers/plans/e3-inventory/e3-release-inventory.md` — hey's release script, the missing tap, the drovr.app distribution (no function today), page copy, what to delete.

## Global Constraints

- A port, not a rewrite: no behaviour change. Where the TS is odd, the Go is odd the same way (`cap 12abc` stores 12 and prints `12abc`; `ledger 0` prints everything; `rm` prints a literal `~/.drovr`; `resume` writes `pauseUntil: null` even when nothing was paused; `init` writes the dead `sessionId`/`closing` keys; `usage`'s "Widen it with" prints a fraction where `reserve` reads a percent). The only deviations are the rulings listed below, each bounding something the TS left unbounded or unsafe.
- **Rulings (the complete list; a reviewer flags any other difference):** R1 `drovr watch <non-integer>` is refused with `the interval is a number of seconds, got "abc"` exit 1 (TS: NaN → 1 ms redraw loop). R2 `watch` restores the terminal on SIGTERM and SIGHUP as well as SIGINT (TS leaves raw mode and the alternate screen). R3 `watch`'s `t` and `s` detach through `exec.Detach` — `t` appends to `Paths.Logs/tick.log`, `s` calls `tick.Launch` (the run-cycle worker directly, skipping the `drovr start` hop; same worker, same log, same message) — because the TS spawns with `stdio: 'ignore'` and `exec.Detach` is the only spawn allowed. R4 `--shadow`, `service install --shadow`, `tech.propra.drovr.shadow`, `scripts/shadowdiff`, `scripts/shadow-diff.sh` and `conformance_test.go` are deleted in Task 13: without a Node oracle they are dead code. R5 `version` enters the help registry in Task 13 and not before (`help --json` is an oracle target until then). R6 flag lookup matches the TS `flag()`: a trailing flag counts as **absent**, and the value is never checked for a leading `--` except in `requiredFlag`.
- `cli.ts`'s own `mutate` is `keys.MutateInPlace` (in place, raw object, no staged rename): `add`, `host`, `rm`, `pause`, `resume`, `cadence`, `cap`, `mode`. Only `reserve` goes through `keys.SetReserve` (staged). Never `keys.SetMode`/`PauseForHours` for the CLI — different write mode and error text.
- JS numbers: `Number.parseInt` is `jsnum.ParseInt`, `Number.parseFloat` is `jsnum.ParseFloat` (Task 1), interpolation is `jsnum.String`, `toFixed` is `jsnum.ToFixed`, `Math.round` is `jsnum.RoundHalfUp`. Empty arrays are `[]` never `null` — allocate every slice that reaches an encoder.
- Oracle comparison is exact on stdout, stderr, exit code and file bytes, except: zod messages are compared up to the `control file is invalid:` prefix; Node's ENOENT/SyntaxError texts are excluded (assert the exit code only); `pause` masks `\d{4}-\d\d-\d\dT[\d:.]+Z`; `start` masks `pid \d+`. Every write command runs on a `t.TempDir()` copy of `testdata/home` with `DROVR_HOME` and `HOME` pointing there, exactly as `TestReportRefusalsMatchOracle` does.
- `exec.RunBounded` and `exec.Detach` remain the only spawns (`TestOnlyExecSpawns` stays green; `watch`'s `open <url>` goes through `RunBounded` with a 5 s cap, named `openTimeout`).
- Timeouts are named constants beside their caller: `orcaTimeout` 20 s (existing), `release`'s `ReleaseRunner(…, 10)` attempts, `openTimeout` 5 s, `watch` interval `max(2, n)` s and probe window `max(2, n)` s.
- Help registry untouched until Task 13; the `watch` entry already exists. Never document a flag before implementing it.
- Functions under 60 lines and two nesting levels; every loop has a named cap (the mouse parser's 8 presses per chunk, the keybar wrap, the frame clamp).
- Gates after every task: `go test ./... -count=1`, `go vet ./...`, `gofmt -l .` empty, `node --test test/*.spec.ts`, `pnpm check-types` (until Task 13 removes the TS gates).
- Nothing is pushed, released, or applied by an implementer. Task 10 builds and writes files locally; Task 11 edits the hey repo on a branch and stops at `tofu plan`. The controller runs the non-Cognito apply; Craig creates the tap repo, runs `scripts/release.sh --publish`, installs, and re-runs `drovr service install`.
- Agents never touch `~/.drovr`, `~/Library/LaunchAgents`, or `~/code/drovr` (the live checkout). Work happens in the `~/code/drovr-go` worktree on branch `go-port-e3`.

## Review Focus

1. **A trailing flag (`drovr add x /tmp --priority`).** TS reads it as absent (priority 0); Go must not read `""` and fail parsing. → Task 1 `TestFlagTrailingIsAbsent`, Task 2 oracle case.
2. **`watch` on a terminal narrower than 72 or shorter than 24 rows.** Narrow keybar wraps and every key stays reachable; the clamp reserves the message line, preview warning and keybar. → Task 6 `TestKeybarEveryKeyReachableAt40Narrow`, `TestClampKeepsTheTail`.
3. **A keystroke or click while `x`/`s` is armed.** Only `y` confirms; any other chunk, a row click, a link click or a wheel event cancels; `q`/Ctrl-C quit; a click on dead space or a right/middle button leaves it armed. → Task 7 `TestConfirmationMatrix`.
4. **A pasted multi-character chunk, and a split escape sequence.** Whole-chunk equality: `jj` does nothing; mouse reports are stripped first and the remainder is one key. → Task 7 `TestChunkIsOneKey`.
5. **`release` against a working or blocked runner, and a runner that ignores `/exit`.** Refused on stderr exit 1; ignored exit reported on stdout exit 1; `/exit` sent only to `idle`. → Task 4 `TestReleaseRefusesWorkingAndBlocked`, `TestReleaseReportsAnIgnoredExit`.

## Trap ledger

| Row | Pinned by |
|---|---|
| `watch.ts` alternate screen, home-and-clear per line, clamp to rows, no trailing newline | Task 8 `TestPaintBytes` (enter/frame/restore sequences byte for byte) |
| `watch.ts` clip by visible length; wrap the keybar | Task 6 recorded `clip`/`visibleLength` fixtures, `TestKeybarWrapsNeverClips` |
| `watch.ts` clamp reserves the tail | Task 6 `TestClampKeepsTheTail` (24 rows at 60/80/100/120) |
| `watch.ts` `setInterval` not unref'd; restore on every exit | Task 8 `TestRunRestoresOnEveryExit` (quit, SIGINT, fatal first draw, R2 signals) |
| `watch.ts` clicks resolve against `lastHits`; `keybarLayout` single source; click while armed cancels | Task 7 `TestConfirmationMatrix`, Task 6 `TestKeybarKeyAtMatchesKeybarLines`, Task 8 `TestClickUsesTheFrameOnScreen` |
| `watch.ts` mouse reporting takes clicks from the terminal; asks link has its own hit | Task 6 recorded `frameWithHits` hits (`{asks:0}` rows), Task 8 `TestAsksClickOpensTheUrl` |
| `watch.ts` a failed refresh must not end the session | Task 8 `TestDrawFailedKeepsTheLastFrame` |
| `state.ts` sink is the caller's choice; watch folds warnings into the frame | Task 8 passes the frame sink explicitly (`TestWarningsLandOnThePreviewLine`) |
| `state.ts` `probeMaxAgeMs` 0 except in watch | Task 8 `TestOnlyRAndLProbeFresh` |
| `keys.ts` ceilings stay ordered on every write | existing E2 `TestSetReserveKeepsCeilingsOrdered`; Task 2 `reserve` oracle |
| `keys.ts` one writer means one code path | Task 2 uses `MutateInPlace`/`SetReserve` only (reviewer checks no third writer) |
| `cycle.ts` release on report is cleanup; `/exit` only to settled | Task 4 release tests |
| `tick.ts` `drovr start` re-attaches, never a foreground `run-cycle` | Task 4 `TestStartLaunchesTheWorkerDetached` |
| `service.ts` launchd holds the loaded plist; reinstall after the binary moves | spec; README copy in Task 12 says `brew upgrade drovr && drovr service install` |
| `usage.ts` records and reads, feeds no gate | Task 3 `usage` is read-only (reviewer checks) |
| everywhere: name the fix, not a reference | every refusal text copied verbatim from the inventory |

---

### Task 1: `jsnum.ParseInt`, `jsnum.ParseFloat`, the TS-compatible flag lookup, `usage.ShareOf`/`ObservedYours`

**Files:**
- Modify: `internal/jsnum/jsnum.go` (+ `jsnum_test.go`)
- Modify: `internal/cycle/report.go:141-150` (replace `leadingInt` with `jsnum.ParseInt`), `internal/cli/service.go:60` (replace `leadingDigits`)
- Create: `internal/cli/args.go` (+ `args_test.go`)
- Modify: `src/usage.ts` (record hooks on `shareOf`, `observedYours`), `internal/usage/usage.go` (+ test), `testdata/recorded/` (re-recorded)

**Interfaces:**
- Produces: `jsnum.ParseInt(s string) (float64, bool)` — JS `Number.parseInt(s,10)`: skip leading ASCII whitespace, optional sign, longest digit prefix; `ok=false` is NaN. `jsnum.ParseFloat(s string) (float64, bool)` — JS `Number.parseFloat`: skip whitespace, longest StrDecimalLiteral prefix including `Infinity`, `.5`, `1e1`; `ok=false` is NaN. `cli.Flag(rest []string, name string) (string, bool)` — value after the **first** `--name`; `false` when absent **or trailing** (R6). `cli.RequiredFlag(rest []string, name, usage string) (string, error)` — error `--<name> is required\n<usage>` when absent or value starts with `--`. `usage.ShareOf`, `usage.ObservedYours` with the TS signatures (inventory §14 quotes the bodies).

- [ ] **Step 1: Failing tests for the number parsers**

```go
func TestParseIntLikeJS(t *testing.T) {
	for _, c := range []struct{ in string; want float64; ok bool }{
		{"12abc", 12, true}, {"1.9", 1, true}, {"1e3", 1, true}, {"0x10", 0, true},
		{"  -7", -7, true}, {"", 0, false}, {"abc", 0, false}, {"+3", 3, true},
	} {
		got, ok := jsnum.ParseInt(c.in)
		if ok != c.ok || got != c.want { t.Errorf("ParseInt(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok) }
	}
}
func TestParseFloatLikeJS(t *testing.T) {
	for _, c := range []struct{ in string; want float64; ok bool }{
		{"45abc", 45, true}, {".5", 0.5, true}, {"1e1", 10, true}, {"Infinity", math.Inf(1), true},
		{"-Infinity", math.Inf(-1), true}, {"abc", 0, false}, {"  60%", 60, true}, {"", 0, false},
	} {
		got, ok := jsnum.ParseFloat(c.in)
		if ok != c.ok || got != c.want { t.Errorf("ParseFloat(%q) = %v,%v want %v,%v", c.in, got, ok, c.want, c.ok) }
	}
}
```

- [ ] **Step 2: Run** `go test ./internal/jsnum/ -run 'ParseInt|ParseFloat' -count=1` — Expected: FAIL, undefined.
- [ ] **Step 3: Implement** with `regexp.MustCompile(`^\s*[+-]?\d+`)` for `ParseInt` and `^\s*[+-]?(Infinity|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)` for `ParseFloat`, `strconv.ParseFloat` on the match. Replace `leadingInt` in `internal/cycle/report.go` and `leadingDigits` in `internal/cli/service.go` with calls to `jsnum.ParseInt`; their tests stay green.
- [ ] **Step 4: Run** `go test ./internal/jsnum/ ./internal/cycle/ ./internal/cli/ -count=1` — Expected: PASS.
- [ ] **Step 5: Failing tests for the flag lookup**

```go
func TestFlagTrailingIsAbsent(t *testing.T) {
	if _, ok := cli.Flag([]string{"x", "/tmp", "--priority"}, "priority"); ok { t.Fatal("trailing flag must read as absent") }
	if v, ok := cli.Flag([]string{"--asks", "--no-aice"}, "asks"); !ok || v != "--no-aice" { t.Fatalf("got %q %v", v, ok) }
	if v, _ := cli.Flag([]string{"--a", "1", "--a", "2"}, "a"); v != "1" { t.Fatal("first occurrence wins") }
	_, err := cli.RequiredFlag([]string{"--ssh", "--cwd", "/x"}, "ssh", "USAGE")
	if err == nil || err.Error() != "--ssh is required\nUSAGE" { t.Fatalf("got %v", err) }
}
```

- [ ] **Step 6: Run, see it fail, implement `internal/cli/args.go`, run again** — Expected: PASS.
- [ ] **Step 7: TS record hooks.** In `src/usage.ts` wrap the return of `shareOf` and `observedYours` in `record('usage.shareOf', {...inputs}, result)` / `record('usage.observedYours', ...)` exactly as `src/ledger.ts` does for its hooked functions (same import, same call shape). Run `node --test test/usage.spec.ts` — Expected: PASS unchanged. Run `scripts/record-fixtures.sh` — Expected: two new directories listed with their counts; no other count changes.
- [ ] **Step 8: Go `usage.ShareOf` and `ObservedYours`** from inventory §14's quoted TS, plus `TestShareOfFixtures`/`TestObservedYoursFixtures` reading `testdata/recorded/usage.shareOf` and `usage.observedYours` through `fixtures.Load` and comparing with `fixtures.Equal` (see `internal/ledger/ledger_test.go` for the pattern). Run `go test ./internal/usage/ -count=1` — Expected: PASS, and `t.Logf` of the case count equals the directory's file count.
- [ ] **Step 9: Gates and commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)" && node --test test/*.spec.ts && pnpm check-types
git add -A && git commit -m "feat(go): jsnum.ParseInt/ParseFloat, the TS flag lookup, usage.ShareOf/ObservedYours with recorded fixtures"
```

### Task 2: The control.json writers — `init`, `add`, `host`, `rm`, `cap`, `mode`, `pause`, `resume`, `cadence`, `reserve`

**Files:**
- Create: `internal/cli/control_cmds.go` (one function per command, ≤ 60 lines each; `HOST_USAGE` and every refusal string copied verbatim from inventory §1–4, §6, §8–12)
- Create: `internal/cli/control_cmds_test.go` (Go unit tests for refusals that the oracle cannot compare exactly)
- Modify: `conformance_test.go` (add `TestControlWritersMatchOracle`)
- Modify: `main.go` dispatch (add the ten names to the `dispatch` case list; remove them from `notPorted` reach)

**Interfaces:**
- Consumes: `keys.MutateInPlace`, `keys.Doc.Get/Set`, `keys.ProgramAt`, `keys.SetReserve`, `control.ParseDuration`, `control.Read`, `paths.EnsureDirs`, `epoch.ISO`, `jsnum.ParseInt/ParseFloat/String`, `cli.Flag/RequiredFlag`.
- Produces: `cli.Init(env Env) error`, `cli.Add(env Env, rest []string) error`, `cli.Host(...)`, `cli.Remove(...)`, `cli.Cap(...)`, `cli.Mode(...)`, `cli.Pause(...)`, `cli.Resume(...)`, `cli.Cadence(...)`, `cli.Reserve(...)`, all `(env Env, rest []string) error`.

- [ ] **Step 1: Oracle test first.** In `conformance_test.go` add a table-driven `TestControlWritersMatchOracle` that, for each argv below, copies `testdata/home` to a temp dir (reuse the helper `TestReportRefusalsMatchOracle` uses), runs both CLIs with `DROVR_HOME` and `HOME` set to it, and compares stdout, stderr, exit code and the bytes of `control.json` afterwards (prefix rule for `control file is invalid:`; exit-code-only for cases marked `enoent`). Cases: `init` (on an **empty** temp home, then again for the "already exists" line; diff the written file bytes too), `add delta <tmp> --priority 2`, `add delta <tmp> --priority` (trailing flag → priority 0), `add alpha <tmp>` (duplicate), `add`, `host beta --clear`, `host beta --environment e --ssh u@h --cwd /x`, `host beta --ssh u@h` (missing flag → usage), `host nope --clear`, `rm gamma`, `rm nope`, `cap 12abc`, `cap -3`, `cap alpha`, `cap alpha 3`, `cap alpha global`, `cap --json`, `mode away`, `mode sideways`, `pause 2h` (masked), `pause`, `pause 0h`, `pause abc`, `resume`, `cadence` (read-only on the fixture itself), `cadence alpha 6h`, `cadence alpha off`, `cadence alpha soon`, `reserve`, `reserve 60`, `reserve 45%`, `reserve 0`, `reserve abc`, `reserve 60` on a copy whose mode is `off`.
- [ ] **Step 2: Run** `go test -run TestControlWritersMatchOracle -count=1 .` — Expected: FAIL on every case with the Go side printing `drovr <cmd> is not ported to Go yet`.
- [ ] **Step 3: Port each command** from the inventory section's verbatim TS. Rules: refusal text byte for byte; `console.log` → `fmt.Fprintln(env.Stdout, …)`; thrown errors are returned (main prints and exits 1); `process.exitCode = 1` without a throw is `ErrPrinted`. `add` resolves `~` with `env.Home` and `path.resolve` semantics via `filepath.Abs`; `pause` formats with `epoch.ISO(env.Now() + ms)`; `cap` prints the **raw** argument text while storing `jsnum.ParseInt`'s value.
- [ ] **Step 4: Wire `main.go`** so the ten names reach `dispatch`, each a one-line case.
- [ ] **Step 5: Run the oracle test** — Expected: PASS for every case. Any case that cannot be compared exactly gets a one-line comment naming the rule it uses (prefix/enoent/mask).
- [ ] **Step 6: Go-only refusal tests** in `control_cmds_test.go` for the texts the oracle compares only by prefix: a bad `mode` value and a bad `host --cwd` produce an error starting with `control file is invalid:` and write nothing (compare file bytes before and after).
- [ ] **Step 7: Gates and commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)" && node --test test/*.spec.ts && pnpm check-types
git add -A && git commit -m "feat(go): init, add, host, rm, cap, mode, pause, resume, cadence, reserve — oracle-diffed on temp homes"
```

### Task 3: The readers — `ledger`, `usage`, `tidy`

**Files:**
- Create: `internal/cli/ledger_cmd.go`, `internal/cli/usage_cmd.go`, `internal/cli/tidy_cmd.go` (+ tests)
- Create: `testdata/home/usage.jsonl` (≥ 24 samples, generated by a small Go test helper or by hand from the `usage.Sample` shape and committed) and `testdata/home-usage-thin/usage.jsonl` (< 24) — or a second temp copy written by the test; the task chooses and says which in its report
- Modify: `testdata/home/cycles.jsonl` (one record with a multi-line `closing`), `conformance_test.go`, `main.go`

**Interfaces:**
- Consumes: `ledger.ReadCycles`, `ledger.LatestEnds`, `help` exit-reason notes (`AGENT_NOTES.exitReasons` twin), `usage.ReadSamples`, `usage.ShareOf`, `usage.ObservedYours`, `ledger.SpentSince`, `control.Read`, `ledger.InFlight`, `orca.Client.TidyRunnerTerminal`.
- Produces: `cli.Ledger(env, rest, asJSON)`, `cli.Usage(env, rest, asJSON)`, `cli.Tidy(ctx, env)`.

- [ ] **Step 1: Oracle cases first** in `conformance_test.go`: `ledger`, `ledger alpha 2`, `ledger 0`, `ledger --last`, `ledger --json`, `ledger --json --last`, `ledger nope --json` (must print `[]`), `ledger --closing`; `usage` and `usage --json` on the fixture home without `usage.jsonl` (the "no samples" line, all-null JSON), then on the ≥ 24-sample home (table and verdict), then on the thin home; `tidy` on the fixture (three `no empty cycle terminal` lines). Run — Expected: FAIL, not ported.
- [ ] **Step 2: Add the fixtures.** `ledger.Cycle`'s JSON key order must match the TS record order (inventory §13 lists it); the `closing` record carries `\n` inside its string.
- [ ] **Step 3: Port** from inventory §13, §14, §5. `lastPerProgram` is a private helper. `usage`'s percentage lines go through `jsnum.ToFixed`; the JSON shape's key order is the inventory's. `tidy` calls the existing orca method per program and prints its outcome line verbatim.
- [ ] **Step 4: Run the oracle test** — Expected: PASS. Then a Go-only `TestTidyClosesAnEmptyTerminal` with a seeded `cycle-terminal.json` and a scripted `orca` shim on `PATH` (pattern: `internal/orca/client_test.go`) covering the closed and in-flight paths the oracle cannot reach hermetically.
- [ ] **Step 5: Gates and commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)" && node --test test/*.spec.ts && pnpm check-types
git add -A && git commit -m "feat(go): ledger, usage, tidy with fixtures — oracle-diffed read-only"
```

### Task 4: `start` and `release`

**Files:**
- Create: `internal/cli/start_cmd.go`, `internal/cli/release_cmd.go` (+ tests)
- Modify: `conformance_test.go`, `main.go`

**Interfaces:**
- Consumes: `tick.Launch(env tick.Env, program string) error` via `cli.TickEnv(env, false)`; `orca.Client.RunnerState`, `RunnerAddress`, `ReleaseRunner(ctx, program, attempts)`, `orca.IsSettled`.
- Produces: `cli.Start(ctx, env, rest)`, `cli.Release(ctx, env, rest)`; `Release` takes an injected `sleep func(time.Duration)` through `Env` (default `time.Sleep`) so the ignored-exit path tests in milliseconds.

- [ ] **Step 1: Oracle cases**: `start` (no name), `start nope`, `start alpha` with `logs/` present (mask `pid \d+`; the Go argv differs from node's and is **not** compared — assert the masked line shape only), `release` (no name), `release nope`, `release alpha` with no `cycle-terminal.json` → `no runner to release` exit 0. Run — Expected: FAIL.
- [ ] **Step 2: Port** from inventory §7 and §15. `start` prints the TS line and returns; it never waits on the worker. `release`: `working`/`blocked` → stderr refusal, `ErrPrinted`; `idle` → `ReleaseRunner(…, 10)`; `false` back → the stdout "would not exit" line and `ErrPrinted`; `gone` → the stdout line, exit 0.
- [ ] **Step 3: Go tests with a stateful `orca` shim** (`internal/orca/client_test.go` has the pattern): `TestStartLaunchesTheWorkerDetached` (a stub `self` binary records its argv; the worker log path is `Paths.WorkerLog`), `TestReleaseRefusesWorkingAndBlocked`, `TestReleaseReportsAnIgnoredExit` (sleep injected, shim keeps answering `idle` after `/exit`), `TestReleaseSendsExitOnlyToIdle`.
- [ ] **Step 4: Run** `go test ./internal/cli/ -count=1 && go test -run 'Start|Release' -count=1 .` — Expected: PASS.
- [ ] **Step 5: Gates and commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)" && node --test test/*.spec.ts && pnpm check-types
git add -A && git commit -m "feat(go): start and release — detached worker, settled-only /exit"
```

### Task 5: `watch` record hooks in the TS, and the recorded frames

**Files:**
- Modify: `src/watch.ts` (record hooks only — no behaviour change), `scripts/record-fixtures.sh` (`TZ=UTC` on the node line), `test/watch-state.spec.ts` / `test/layout.spec.ts` (only if a hook needs a pure entry point the tests already exercise)
- Modify: `testdata/recorded/` (re-recorded, committed)

**Interfaces:**
- Produces fixture directories: `watch.frameWithHits` (input `{state, view, columns, rows}`, output `{text, hits}`), `watch.clip` (`{text, width}`), `watch.visibleLength`, `watch.wrapText` (`{text, width, maxLines}`), `watch.keybarLines` (`{width, narrow}`), `watch.keybarKeyAt` (`{width, narrow, row, column}`), `watch.untilLabel` (`{at, now}`), `watch.accountsLabel`, `watch.childReason` (input `{message}` or `{text}` — errors do not serialise; record the string form the function sees).

- [ ] **Step 1:** Add `record(...)` at the return of each function in the list above, exactly as `src/decide.ts` does (import from `./record.ts`, wrap the return value). `frameWithHits` records only when `columns` was supplied (otherwise it read `process.stdout` and is not pure). Keep `frame` unhooked: it is `frameWithHits(...).text`.
- [ ] **Step 2:** `TZ=UTC` is set on the `node --test` line in `scripts/record-fixtures.sh` so the header clock is reproducible. Run `node --test test/*.spec.ts` — Expected: PASS, no count change. Run `scripts/record-fixtures.sh` — Expected: nine new `watch.*` directories listed with counts; every pre-existing count unchanged (`git diff --stat testdata/recorded | tail -1` shows only additions).
- [ ] **Step 3:** `go test ./... -count=1` still green (nothing reads the new fixtures yet). Commit:

```bash
git add -A && git commit -m "test(ts): record hooks on watch's pure functions; fixtures recorded under TZ=UTC"
```

### Task 6: `internal/watch` pure half — ANSI helpers, frame, keybar

**Files:**
- Create: `internal/watch/ansi.go`, `internal/watch/frame.go`, `internal/watch/keybar.go`, `internal/watch/view.go`, `internal/watch/watch_test.go`

**Interfaces:**
- Consumes: `state.DrovrState` (the Go twin of `buildState`'s output), `jsnum.*`, `epoch.*`.
- Produces: `watch.View` struct (inventory §7 fields and defaults: `selected`, `help`, `message`, `previewWarning`, `confirmStop`, `confirmStart`, …), `watch.LineHit` (`Program *int`, `Asks *int`, `Keybar *int`), `watch.FrameWithHits(st state.DrovrState, v View, columns, rows int, now epoch.Millis, loc *time.Location) (string, []*LineHit)`, `watch.Frame(...) string`, `watch.KeybarLines(width int, narrow bool) []string`, `watch.KeybarKeyAt(width int, narrow bool, row, column int) (string, bool)`, `watch.VisibleLength`, `watch.Clip`, `watch.WrapText`, `watch.UntilLabel`, `watch.AccountsLabel`, `watch.ChildReason(text string) string`, and the constants table from inventory §2 ("Constants") with the same names.

- [ ] **Step 1: Fixture tests first.** For each recorded directory from Task 5 write a `Test<Fn>Fixtures` that loads every case with `fixtures.Load`, decodes input into the Go types (the `state` input decodes into `state.DrovrState` — its JSON shape is already byte-matched by E2's `TestBuildJSONKeepsTheTSKeysAndEmptyArrays`), calls the Go function with `loc = time.UTC`, and compares output with `fixtures.Equal` (frames as exact strings; hits as JSON). Run `go test ./internal/watch/ -count=1` — Expected: FAIL, package does not exist.
- [ ] **Step 2: `ansi.go`** from inventory §1 "ANSI helpers" and §2 "visibleLength / clip / wrapText": the OSC-then-CSI strip, rune counting, `Clip`'s scan-to-`m` quirk copied byte for byte, `WrapText`'s word wrap and its errors. Run the three fixture tests — Expected: PASS.
- [ ] **Step 3: `keybar.go`** from §4: the key table, `keybarLayout` as the single source for both `KeybarLines` and `KeybarKeyAt`. Add `TestKeybarKeyAtMatchesKeybarLines` (for every width 24..120 and both `narrow` values, each cell's `KeybarKeyAt` is non-empty exactly where the rendered line shows a key label — the golden renders in §4 pin six widths) and `TestKeybarEveryKeyReachableAt40Narrow`. Expected: PASS against the `watch.keybarLines`/`keybarKeyAt` fixtures.
- [ ] **Step 4: `frame.go`** from §2 "Layout top to bottom" and §2 "Help frame", §3 bars, `clampAndClip` verbatim with `TestClampKeepsTheTail` (24 rows at widths 60/80/100/120 using the recorded 24-row cases: the clamped frame still contains the message line, the preview warning and the whole keybar). Expected: `TestFrameWithHitsFixtures` PASS — every recorded frame byte-identical, every hit equal.
- [ ] **Step 5: Gates and commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)"
git add -A && git commit -m "feat(go): watch frame, keybar and ANSI helpers byte-matched to recorded TS frames"
```

### Task 7: `internal/watch` input — chunk parsing and key→intent

**Files:**
- Create: `internal/watch/input.go`, `internal/watch/input_test.go`

**Interfaces:**
- Produces: `watch.MouseEvent{Button, X, Y int; Press bool}`; `watch.ParseChunk(chunk string) (presses []MouseEvent, rest string)` — SGR regexp `\x1b\[<(\d+);(\d+);(\d+)([Mm])`, at most `maxPressesPerChunk = 8` presses honoured, releases ignored, every report stripped, remainder returned whole; `watch.Intent` (a small sum type: `Quit`, `Help`, `Move{±1}`, `Refresh{fresh bool}`, `SetMode`, `TogglePause`, `ExtendPause`, `ToggleEnabled{program}`, `NudgePriority{program, delta}`, `AdjustConcurrency{delta}`, `NudgeReserve{delta}`, `SetReserveOff{…}` for `<`/`>` in `off` mode (the TS quirk, kept), `ArmStop{program}`, `ArmStart{program}`, `Confirm`, `Cancel`, `TickNow`, `StartCycle{program}`, `Interrupt{program}`, `ReleaseLeftover{program}`, `OpenAsks{url}`, `None`); `watch.DecideKey(key string, v View, programs []state.ProgramState) (Intent, View)` — pure, returns the new view (message, armed flags, selection) alongside the intent; `watch.DecideClick(ev MouseEvent, hits []*LineHit, v View, programs []state.ProgramState) (Intent, View)`.

- [ ] **Step 1: Failing tests.** `TestChunkIsOneKey` (`"jj"` → `None`; `"\x1b[<0;5;3M\x1b[<0;5;3mq"` → one press and rest `"q"`; nine presses → eight honoured); `TestConfirmationMatrix` — armed `confirmStop` then each of: `y` → `Interrupt`; `n`, `j`, `"\x1b[A"`, a row click, an asks-link click, a wheel event (button 64/65) → `Cancel` with the TS message text; `q` and `"\x03"` → `Quit` while still armed; a click on dead space, a right click (button 2), a middle click (button 1) → `None` and still armed. Same for `confirmStart`. `TestSelectionWraps` (inventory §5: `j`/`k`/arrows semantics, including the TS `selected = -1` with zero programs — kept). `TestMessagesAreVerbatim` for each intent's message string from §5. Run — Expected: FAIL.
- [ ] **Step 2: Implement** from §5 `handle` (in its exact order) and §6 (mouse). The impure parts of `handle` (reading control.json, lock files, spawning) are **not** here — they become intents the runner executes in Task 8.
- [ ] **Step 3: Run** `go test ./internal/watch/ -count=1` — Expected: PASS.
- [ ] **Step 4: Commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)"
git add -A && git commit -m "feat(go): watch input — SGR mouse parsing, key→intent, the confirmation matrix"
```

### Task 8: `internal/watch` run loop, and `drovr watch`

**Files:**
- Modify: `go.mod`/`go.sum` (`golang.org/x/term`, latest tagged release via `go get golang.org/x/term@latest`; the hey CLI does not use it)
- Create: `internal/watch/run.go`, `internal/watch/exec.go` (the intent executor), `internal/watch/run_test.go`
- Create: `internal/cli/watch_cmd.go` (+ test for R1)
- Modify: `main.go`

**Interfaces:**
- Consumes: `state.Collector.Collect(ctx, onWarning, probeMaxAge)`; `keys.CycleMode/CyclePause/ExtendPause/ToggleEnabled/NudgePriority/AdjustConcurrency/NudgeReserve/SetReserve`; `orca.Client.InterruptRunner`, `ReleaseLeftover`; `lock.Holder`; `tick.Launch`; `exec.Detach`; `exec.RunBounded` for `open`.
- Produces: `watch.Terminal` interface (`Size() (cols, rows int, err)`, `MakeRaw() (restore func(), err)`, `IsTerminal() bool`) with the real `x/term` implementation and a fake; `watch.Run(ctx, deps Deps, intervalSeconds int) error` where `Deps{In io.Reader; Out io.Writer; Term Terminal; Collector *state.Collector; Keys keysWriter; Orca *orca.Client; Paths paths.Paths; Self string; Now func() epoch.Millis; Signals <-chan os.Signal; Loc *time.Location}`; `cli.Watch(ctx, env, rest) error` parsing the interval with `jsnum.ParseInt` and R1.

- [ ] **Step 1: Failing tests with fake deps.** `TestPaintBytes`: with a fake terminal 100×40 and a `Collector` over fixture inputs, the bytes written are exactly `\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h` then `\x1b[H` + each line + `\x1b[K` joined by `\r\n` + `\x1b[0J` (no trailing newline), and after `q` on `In`: `\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l`. `TestRunRestoresOnEveryExit`: quit, SIGINT, SIGTERM, SIGHUP, and a first draw that fails all end with the restore bytes and the raw-mode `restore` called once. `TestDrawFailedKeepsTheLastFrame`: a second `Collect` that errors leaves the previous frame on screen with the message line set to the TS `drawFailed` text; only the first failure is fatal. `TestOnlyRAndLProbeFresh`: the ticker's draws pass `probeMaxAge = max(2,n) s`; `r` and a successful `l` pass 0. `TestClickUsesTheFrameOnScreen`: hits from the last painted frame resolve a click even after a resize changed the layout. `TestAsksClickOpensTheUrl`: the executor runs `open <url>` through `RunBounded` with `openTimeout`. `TestWarningsLandOnThePreviewLine`: a warning from the collector sink appears as `view.previewWarning`. `TestTickerIsNotUnrefd`: `Run` blocks until quit. Run — Expected: FAIL.
- [ ] **Step 2: Implement `run.go`**: one draw goroutine owning `View` and `lastHits`; a stdin goroutine sending chunks; a ticker at `max(2, n)` s; SIGWINCH → non-fresh draw; signals per R2; the executor in `exec.go` maps each intent to the setter/orca call/`tick.Launch`/`exec.Detach(self, ["tick"], Paths.Logs/"tick.log", "", nil)` (R3) and returns the message. Every error from a setter lands on the message line (the TS died; keeping the session alive is **not** a ruling here — copy TS: a setter error is fatal via `die`, restore first). Width clamp `max(24, min(cols, 120))`, rows `max(6, rows)`, narrow `< 72`.
- [ ] **Step 3: `cli.Watch`** — R1 refusal; default 15; calls `watch.Run` with real deps (`x/term` terminal, `os.Stdin`, `os.Stdout`, `signal.Notify` for INT/TERM/HUP/WINCH). Wire `main.go`.
- [ ] **Step 4: Run** `go test ./internal/watch/ ./internal/cli/ -count=1` — Expected: PASS. Then the whole suite; `TestOnlyExecSpawns` must still pass (no `os/exec` in `internal/watch`).
- [ ] **Step 5: Commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)" && node --test test/*.spec.ts && pnpm check-types
git add -A && git commit -m "feat(go): drovr watch — raw mode, alternate screen, mouse, keys, detach; parity with the TS view"
```

The controller smoke-tests `go run . watch` in a real terminal before Task 9 (an agent cannot drive a TTY); findings go back as a fix round on this task.

### Task 9: Dispatch complete; conformance over every command

**Files:**
- Modify: `main.go` (every registry command dispatches; `notPorted` deleted), `main_test.go`, `conformance_test.go`

- [ ] **Step 1:** `TestEveryRegistryCommandDispatches` in `main_test.go`: for each entry of `help.Commands` (the registry slice), `run([]string{name})` with an empty temp `DROVR_HOME` never returns an error containing `not ported` (it may return the command's own refusal). `watch`, `tick` and `run-cycle` are skipped by name with a comment: a TTY, the live lock, and a worker are not runnable here. Expected: FAIL — `notPorted` still answers for every command not yet wired.
- [ ] **Step 2:** Delete `notPorted`; make the `switch` exhaustive. Run `go test -count=1 . ./internal/cli/` — Expected: PASS. Run the whole conformance file against the Node oracle one last time: `go test -run 'Oracle' -count=1 .` — Expected: PASS, every command.
- [ ] **Step 3: Commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)" && node --test test/*.spec.ts && pnpm check-types
git add -A && git commit -m "feat(go): every command dispatches; notPorted is gone"
```

### Task 10: `scripts/release.sh` and the Homebrew formula

**Files:**
- Create: `scripts/release.sh`, `scripts/release_test.sh` (a shell test the Go suite runs through `TestReleaseScriptIsDeterministic`), `homebrew/drovr.rb.tmpl` → written to `dist/tap/Formula/drovr.rb`
- Modify: `.gitignore` (`/dist/` already ignored — verify)

**Interfaces:**
- Produces: `scripts/release.sh` — reads `VERSION` (`tr -d '[:space:]'`), builds `CGO_ENABLED=0 GOOS=darwin GOARCH=arm64 go build -trimpath -ldflags "-s -w -X main.version=$version" -o "$work/drovr" .`, `touch -t 200001010000`, `tar -C "$work" --format ustar --uid 0 --gid 0 --uname '' --gname '' -cf - drovr | gzip -n -9 > dist/cli/drovr_darwin_arm64.tar.gz`, `shasum -a 256 drovr_darwin_arm64.tar.gz > sha256sums.txt` inside `dist/cli`, renders `dist/tap/Formula/drovr.rb` from the template with the version and sha256, prints the sums. With `--publish` **only**: refuses unless the tree is clean and `git tag v$version` does not exist; `git tag v$version && git push origin main v$version`; `gh release create v$version dist/cli/drovr_darwin_arm64.tar.gz dist/cli/sha256sums.txt --title v$version --notes-file <(git log --oneline <prev-tag>..HEAD)`; clones `git@github.com:cadam11/homebrew-tap.git` into `$work/tap`, copies the formula to `Formula/drovr.rb`, commits `drovr $version`, pushes. Every step after the build is under `--publish`; without it the script is pure local output.

Formula template:

```ruby
class Drovr < Formula
  desc "Capacity-aware supervisor that decides when a project-loop cycle may start"
  homepage "https://drovr.app"
  url "https://github.com/cadam11/drovr/releases/download/v__VERSION__/drovr_darwin_arm64.tar.gz"
  sha256 "__SHA256__"
  version "__VERSION__"
  license "MIT"

  depends_on arch: :arm64
  depends_on :macos

  def install
    bin.install "drovr"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/drovr version")
  end
end
```

- [ ] **Step 1: Failing test.** `TestReleaseScriptIsDeterministic` in a new `scripts/release_test.go` (package `scripts_test`, build-tagged `release` so `go test ./...` runs it only with `-tags release`? — no: it must run in the gate; it takes ~10 s. Keep it untagged): runs `scripts/release.sh` twice into two `DIST=<tmp>` dirs (the script honours `DIST` for tests, default `dist`), asserts the two tarballs are byte-identical, `sha256sums.txt` matches `shasum` of the tarball, the formula contains the sha and `version "0.2.0"`, and `tar -tzf` lists exactly `drovr`. Expected: FAIL, script missing.
- [ ] **Step 2: Write the script** (≤ 60 lines, `set -eu`, `trap 'rm -rf "$work"' EXIT INT TERM` on the line after `mktemp`). Run the test — Expected: PASS.
- [ ] **Step 3:** Extract the built binary from the tarball and run `./drovr version` — Expected: `0.2.0`. Run `./drovr help` — Expected: the registry list.
- [ ] **Step 4: Commit**

```bash
go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)"
git add -A && git commit -m "build: scripts/release.sh — deterministic darwin_arm64 tarball, sums, formula; --publish gated"
```

### Task 11: hey repo — drovr.app/cli redirects and the install copy

**Files (in `~/code/hey`, branch `drovr-cli-redirects`):**
- Create: `infra/site-cli-redirects.tf` (`aws_cloudfront_function.site_cli_redirects`, `cloudfront-js-2.0`, the handler from the release inventory: `/cli/drovr_darwin_arm64.tar.gz` → `https://github.com/cadam11/drovr/releases/latest/download/drovr_darwin_arm64.tar.gz`, `/cli/drovr-sha256sums.txt` → `…/sha256sums.txt`, 302 `Found`, everything else passes through)
- Modify: `infra/site.tf` — `function_association { event_type = "viewer-request"; function_arn = aws_cloudfront_function.site_cli_redirects.arn }` inside `aws_cloudfront_distribution.site.default_cache_behavior`
- Modify: `infra/site/index.html` lines 172–218: exchange 1 becomes `brew install cadam11/tap/drovr` with the `needs` row `teamclaude, Orca` (no "Node 24"); a new exchange between 1 and 2: "Then set up its home." with `drovr init`; the section heading changes from "Four commands" to "Five commands" (count the code blocks: brew, init, add, service install, status).
- Modify: hey `CLAUDE.md` one line under its CloudFront notes: the drovr.app distribution now carries a viewer-request function; the FunctionInUse two-commit removal rule applies to it too.

- [ ] **Step 1:** Make the edits. `cd ~/code/hey/infra && dotenvx run -q -f .env -- tofu fmt -check && dotenvx run -q -f .env -- tofu validate` — Expected: clean. (Requires `pnpm build:lambda && pnpm build:cli` first or the plan fails on missing artifacts — the inventory says so.)
- [ ] **Step 2:** `dotenvx run -q -f .env -- tofu plan -no-color > /tmp/e3-plan.txt` — Expected: exactly one function to create, one distribution update (association), one S3 object update (index.html). Commit on the branch; **do not apply** — the controller applies (not Cognito-touching) after Task 12 lands.
- [ ] **Step 3:** After the controller's apply: `curl -sI https://drovr.app/cli/drovr_darwin_arm64.tar.gz | head -3` — Expected: `HTTP/2 302` with `location: https://github.com/cadam11/drovr/releases/latest/download/drovr_darwin_arm64.tar.gz` (GitHub then 404s until the release exists — expected). `curl -sI https://drovr.app/cli/hey_darwin_arm64.tar.gz` — Expected: still 200.

### Task 12: README, CLAUDE.md and the spec for a brew-installed drovr

**Files:**
- Modify: `README.md` (Install section → `brew install cadam11/tap/drovr` / `drovr init` / `drovr service install`; upgrades `brew upgrade drovr && drovr service install`; the bare-download note with `xattr -d com.apple.quarantine`; delete the "Node 24" bullet and the `process.execPath` note; keep the PATH-bakes-in note), `CLAUDE.md` ("Interfaces" → the Go binary; "Not yet observed working" gains: a brew install, a `brew upgrade` followed by `service install`, the redirect serving a real asset, `drovr watch` on the Go binary in daily use), the spec's "Answered" section (2026-10-26: cut over after one clean shadow pass at Craig's word).
- Leave the TS conventions paragraph for Task 13.

- [ ] **Step 1:** Edit; `pnpm check-types` and `go test ./... -count=1` unaffected. Commit:

```bash
git add -A && git commit -m "docs: install drovr with brew; what the release has not yet been seen to do"
```

**Merge gate.** After Task 12 the controller merges `go-port-e3` to `main`, applies the hey plan, and hands Craig three acts in order: `gh repo create cadam11/homebrew-tap --public` (an empty repo with a README is enough), `scripts/release.sh --publish` from `~/code/drovr`, then `brew install cadam11/tap/drovr && drovr version && drovr service install && drovr service status && rm ~/.local/bin/drovr-go`. `which drovr` must print `/opt/homebrew/bin/drovr` and that file must be brew's, not the pnpm link — if the pnpm link is still first, `pnpm unlink --global` in `~/code/drovr` first. Task 13 starts only when `drovr service status` names the brew path.

### Task 13: Delete the TypeScript; the tree is Go

**Files:**
- Delete: `src/`, `test/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `node_modules/` (untracked), `conformance_test.go`, `scripts/record-fixtures.sh`, `scripts/shadow-diff.sh`, `scripts/shadowdiff/` (R4)
- Modify: `internal/tick` (`Env.Shadow` and every `if env.Shadow` branch), `internal/cli/service.go` (`--shadow`, `installWarnings`' shadow half), `internal/service` (`ShadowLabel`, `ShadowLogName`, `ShadowIntervalSeconds`), `internal/paths` (`TickShadowLock`), `main.go` (`tick` takes no arguments at all), their tests
- Modify: `internal/help/registry.go` (add `version` — usage `drovr version`, summary `print the installed version`, reads/writes nothing) and `main.go` so `help version` renders (R5)
- Modify: `CLAUDE.md` Conventions (Go-only: `go test ./... -count=1 && go vet ./... && gofmt -l .` is the gate; `testdata/recorded/` is frozen history — a behaviour change now lands in Go with its own test and, where a fixture disagrees, the fixture is deleted with the commit that changes the behaviour, never hand-edited; the trap table's `.ts` file names stay as the names of the Go packages), the "drovr is also a program" paragraph (drop the parenthetical history), the Notifications paragraph (`src/hey-http.ts` → `internal/hey`), the Interfaces list; `README.md` any remaining `src/` mention; `.envrc` if it adds `node_modules/.bin`
- Flag, do not delete: `.claude/skills/add-dark-mode` and `.claude/skills/design` (unrelated to the port; the report names them for Craig)

- [ ] **Step 1:** `TestNoShadowRemains` in `main_test.go`: `grep -ri shadow` over `internal/ main.go scripts/` returns nothing (implemented with `filepath.WalkDir` + `strings.Contains`, case-insensitive). Run — Expected: FAIL.
- [ ] **Step 2:** Delete and modify as listed. Keep `testdata/` whole. Run `go test ./... -count=1 && go vet ./... && test -z "$(gofmt -l .)"` — Expected: PASS (the recorded-fixture tests still read `testdata/recorded`).
- [ ] **Step 3:** `go run . help version` — Expected: the new page. `go run . tick --shadow` — Expected: `tick takes no arguments` exit 1. `git grep -n 'cli.ts\|pnpm\|node --test\|tsc' -- ':!docs/superpowers' ':!testdata'` — Expected: no output.
- [ ] **Step 4: Commit**

```bash
git add -A && git commit -m "chore: delete the TypeScript — the Go binary is drovr; shadow tooling and the Node oracle go with it"
```

Then the controller merges to `main`; Craig's `drovr service install` has already happened, so nothing running changes.

## Self-review

- **Spec coverage.** Phase 5 (rest of the CLI): Tasks 1–4, 9. Phase 6 (watch): Tasks 5–8. Phase 7 (release, tap, redirects, README, page, shadow removed, TS deleted, CLAUDE.md for Go): Tasks 10–13 and the merge gate. "What changes for the user": Tasks 11–12. Non-goals respected: no behaviour change beyond the six rulings; arm64 only; no signing (the `xattr` line is README copy).
- **Placeholders.** Every task names its tests and expected outputs; transcription tasks point at the inventory section whose verbatim TS is the code. No "add error handling", no "similar to Task N".
- **Type consistency.** `cli.Flag`/`RequiredFlag` (Task 1) are what Task 2 consumes; `watch.View`, `LineHit`, `Intent`, `DecideKey`, `DecideClick` (Tasks 6–7) are what Task 8's `run.go` consumes; `watch.Terminal`/`Deps` are defined once in Task 8; `tick.Launch(env tick.Env, program string)` is the E2 signature. `ReleaseRunner(ctx, program, attempts)` — Task 4 must confirm the exact E2 signature in `internal/orca/cycle.go` and adapt the call, not the method.
- **Review Focus.** Each of the five lines names its test and task. Rulings R1–R6 are the only behaviour differences and each is bounded, named, and will appear in the executor's final report.
- **Order of risk.** The TS is deleted last, after brew's binary is on PATH and the service re-installed, so no step leaves Craig without a working `drovr`.
