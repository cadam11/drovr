# drovr as one static Go binary — design

**Status:** draft for Craig's review, 2026-10-22. Spec E of the launch work; A is done.

## Why

drovr is now public, and its install is `git clone`, Node 24, pnpm, then a launchd plist that
pins an absolute `node` path and runs TypeScript straight out of the checkout. That is three
tools a new user must have before the first `drovr status`, and the plist breaks every time nvm
moves `node`. The hey CLI already went this way (`cli/hey` in the hey repo, one static binary at
drovr.app/cli) for the same reason. The port makes drovr `brew install`-able and lets the
supervisor run from a binary instead of a working tree.

**This is a port, not a rewrite.** No behaviour changes, no new features, every file format
byte-compatible, so the cut-over is `drovr service install` from the new binary and nothing is
migrated. design.md and the CLAUDE.md trap table apply to the Go code unchanged; every trap is a
test in the TS suite and stays one in Go.

## Fixed by Craig

- Distribution: a static binary plus Homebrew.
- drovr stays free and open source; the Go code lives in the public repo.

## Decisions in this spec (flip any before plan E is written)

| Decision | Choice | Why |
|---|---|---|
| Where the code lives | Same repo. `go.mod` at the root, module `github.com/cadam11/drovr`, `main.go` at the root and packages under `internal/`. The TS tree stays until cut-over, then is deleted in one commit. | One history, one README, one issue tracker. Root module means `go build .` and `go install github.com/cadam11/drovr@latest` both work with no path to remember. |
| Targets | `darwin_arm64` only. | drovr runs beside Orca and teamclaude on the Mac. Hosted programs run their *cycles* elsewhere; the supervisor never does. Intel and Linux are non-goals until someone asks (Craig, 2026-10-22: "meh"). |
| Where binaries are hosted | Both (Craig, 2026-10-22). GitHub Releases on `cadam11/drovr`, one tag per version (`v0.2.0`), assets `drovr_darwin_arm64.tar.gz` and `sha256sums.txt`, is the source the formula downloads from. The same archive and a `drovr-manifest.json` are also published at `https://drovr.app/cli/` beside hey's binaries by the hey repo's `cli.tf`, so the product page can link a file it owns. | Releases are free, need no tofu, and are what a public project's users expect. drovr.app/cli is the mirror the page points at; it lags a release by one tofu apply in the hey repo, which is Craig's act. |
| Homebrew | A tap, `cadam11/homebrew-tap`, formula `drovr` with the Release URL and sha256 (arm64 only). Install line: `brew install cadam11/tap/drovr`. | A core formula needs notability drovr does not have; a tap is a one-file repo the release script rewrites. |
| Release tooling | A 40-line `scripts/release.sh` modelled on hey's `release-hey.sh`: deterministic build (`-trimpath -ldflags "-s -w -X main.version=…"`, pinned mtime, `tar --uid 0`, `gzip -n`) into `dist/cli/`, then `gh release create` and a commit to the tap. The hey repo's `cli.tf` reads the same `dist/cli/` from a sibling checkout for the drovr.app mirror. | goreleaser would do the same in 80 lines of YAML plus a dependency. Not worth it for one target. |
| Version | `VERSION` file at the root, read by the script, stamped into the binary; `drovr version` prints it. The TS CLI never had a version; `0.2.0` is the first Go release. | Same as hey. The commit is not the version. |
| Dependencies | `golang.org/x/term` for raw mode and the terminal size, nothing else. JSON, HTTP, subprocess, file locking all come from the standard library. | Raw mode on macOS needs termios ioctls; `x/term` is the maintained wrapper and drags in only `x/sys`. Zod has no Go equivalent and needs none (see Validation). |
| Go version | 1.26, same as the hey CLI. | One toolchain on this Mac. |
| `drovr watch` | Full parity in the first release: alternate screen, SGR mouse, keybar hit map, the lot. `0.2.0` waits for it (Craig, 2026-10-22). | Craig uses watch daily; a plainer one would be a regression he would notice first. |
| Launchd | The plist's `ProgramArguments` become `[<binary path>, "tick"]`; `nodeBin` and `cliPath` go. `service install` writes it from `os.Executable()` resolved through symlinks, so a brew upgrade that moves the binary needs a re-run, which `service status` detects by comparing the plist's path with its own. | The absolute-node-path trap in README goes away with the node. |

## Shape

```
main.go                      dispatch only; mirrors src/cli.ts's switch
VERSION
go.mod
scripts/release.sh
internal/
  control/   control.json shape, mutate (staged write-and-rename), applyAwayMode, modes
  ledger/    cycles.jsonl records, latestEnds, pricing, inFlight, chargeForRunning
  capacity/  pool from teamclaude status, per-account clamp, Σ min_bucket
  decide/    programReadiness, admissionLimits, capacityVerdict, requiredCycles, priorityRank
  allocation/ bar segments from the same Pool decide() uses
  teamclaude/ status --json parse (epochMs coercion, routes[].accounts[].eligible)
  orca/      every orca call: create/show/wait/send/read/close, stale-handle adoption, envelopes
  exec/      runBounded, the only spawn helper; detach for run-cycle and tick
  cycle/     run-cycle worker: start, watch loop, poll report, stall/nudge, release, record
  tick/      lock, watchdog, reconcile, admission, usage sample, publish, stampTick
  lock/      pid+timestamp lock, legacy bare-pid shape
  asks/      aice notes list, local asks file
  hey/       wire contract + HTTP client, copied from the hey repo's cli/hey (wire.go, hey_http.go)
  nudge/     textCraig, publishStatus, alertFrom
  state/     collectState with the probe cache and the onWarning sink
  status/    status-payload and status-accounts (the --json builder)
  usage/     the byte-bounded sampler
  service/   plist, launchctl, PATH capture
  help/      the command registry; help, help <cmd>, --help, help --json
  watch/     frame, layout, keys, mouse, preview parser
  transcript/ closing message from a recorded session
  paths/     DROVR_HOME and every file name
testdata/    shared JSON fixtures (see Conformance)
```

One package per TS module, same names, so a trap row that names `decide.ts` still names the
place. `src/` is deleted at cut-over; nothing in Go imports it.

## Porting rules

These are the places a Go port drifts from the TS without anyone noticing. Each is a rule the
plan's tasks test, not advice.

**Validation replaces zod, shape for shape.** Every boundary that had a zod schema gets a Go
type plus a `parse<Name>([]byte) (T, error)` function that enforces the same thing:

- strict where zod was strict (declared interfaces: control.json, the cycle report, orca's
  envelopes): `json.Decoder.DisallowUnknownFields()`, required fields checked by hand after
  decode, errors naming the field path;
- stripping where zod stripped (`genericStatusShape`, teamclaude status): plain `json.Unmarshal`;
- lenient where the TS was a scrape (preview parser, `readAsks`): return the zero value, never
  an error;
- `absent` and `null` are different only where the TS said so. `agentIdentity` absent or null
  are both *gone*; `title` null is allowed; `agentWait` absent means *never looked*. A pointer
  field tells null from a value; an `*json.RawMessage` tells absent from null where that matters;
- `epochMs` coerces number-or-string-or-null through a custom `UnmarshalJSON`, never widened to
  a string;
- Go's zero values are the trap: a missing `pauseUntil` must read as `null`, not `""`, and a
  missing count as absent, not `0`. Every optional field is a pointer or has a presence test.

**Numbers.** The TS prints rounded floats and ISO timestamps; `--json` output is compared to
the oracle byte for byte, so rounding is `strconv.FormatFloat(v, 'f', n, 64)` at the same `n`
and times are `time.RFC3339Nano` trimmed to milliseconds (`2006-01-02T15:04:05.000Z07:00`
formatted in UTC), which is what `Date.prototype.toISOString` emits.

**Subprocesses.** `exec.RunBounded(ctx, bin, args, Bounds{Timeout, Label})` is the only
spawn. It wraps `exec.CommandContext` with the timeout, keeps the child's stdout and stderr on
the returned error (orca's `ok:false` envelope is read back out of it), turns `ErrNotFound` into
the "install it with …" message, and kills the process group on timeout. Detached children
(`run-cycle` from the tick, `tick` and `start` from watch) use `Setsid` with stdio on the log
files, and the parent does not wait. Every timeout is a named constant beside its caller, as now.

**Files.** Every write that was staged through a rename stays staged: `control.json`,
`cycle-terminal.json`, `last-cycle.json`, the usage prune, the credentials file (0600). JSONL
appends use `O_APPEND` on one `write` per line. The lock keeps its `{pid, at}` shape and the
bare-pid legacy branch. `DROVR_HOME` is honoured everywhere; the test suite uses it.

**Signals and the terminal.** watch restores cursor, raw mode and mouse reporting on every exit
path including SIGINT and SIGTERM (a `defer` plus a signal handler that runs the same restore).
The tick watchdog is a timer that releases the lock, then logs, then exits, in that order, as now.

**Help.** `internal/help` is a registry rendered four ways; `help --json` is compared to the
Node CLI's output in the conformance test, so the flag tables and the `AGENT_NOTES` vocabulary
are copied, not paraphrased. A flag the Go CLI does not yet implement is not in the registry.

## Conformance: how we know it is the same program

Three layers, cheapest first.

1. **Shared fixtures for the pure core.** The TS suite's decide, capacity, ledger, allocation
   and priority cases become JSON files under `testdata/` (`{input, expected}` per case),
   written once by a script that runs the TS tests with a recorder. Both suites read the same
   files; the TS test for each becomes a loop over its fixtures (its hand-written cases are
   retired at cut-over). This is the one place the port can be *proven* rather than inspected,
   and `decide()` being pure is what makes it possible.
2. **The Node CLI as oracle.** `conformance_test.go` runs `node src/cli.ts <cmd> --json` and the
   Go binary on the same `DROVR_HOME` fixture and diffs the output for `status`, `help`,
   `ledger`, `usage`, `cap`, `mode`, `reserve` and `cadence`. It skips when `node` or `src/` is
   absent, which is what happens after cut-over, and the fixtures from layer 1 carry on. Same
   pattern as hey's conformance test.
3. **Shadow ticks.** `drovr tick --shadow` evaluates everything, writes its decision lines to
   `decisions-shadow.jsonl`, and launches nothing, publishes nothing, samples nothing. It runs
   under a second launchd label for at least a day beside the live Node service, and a script
   diffs the two files tick by tick (same `at` to the second, same verdict and reason per
   program). Cut-over needs a clean day; any diff is a bug in the port until proven otherwise.

The suite target is the same 593 tests' worth of behaviour, not the same count: table-driven Go
tests collapse many TS cases into one function. The trap table is the review checklist for the
port: every row names a file, and the plan's task for that package lists the rows it owns.

## Phases

The plan will cut this into tasks in this order. Each phase ends with a binary that does
strictly more than the last, and the first four are usable before any TUI exists.

1. **Skeleton and the read side.** `go.mod`, `main.go`, `paths`, `control`, `ledger` reader,
   `teamclaude` parse, `help`; `drovr status --json` from a static `teamclaude status --json`
   file; layer-1 fixtures recorded and the Go tests reading them. Conformance test runs.
2. **The decision core.** `capacity`, `decide`, `allocation`, `ledger` pricing and charging,
   `priorityRank`, `applyAwayMode`. All layer-1 fixtures green.
3. **Adapters.** `exec`, `orca` (every call, every envelope rule), `asks`, `hey` (copied Go
   files plus `putStatus`, `prefs`, `profile`), `nudge`, `usage`, `lock`, `service`, `state`.
4. **The unattended core.** `tick` (lock, watchdog, reconcile, admission, launch, sample,
   publish, stamp), `cycle` (the worker end to end), `--shadow`. Shadow service installed.
5. **The rest of the CLI.** `add`, `host`, `rm`, `report`, `notify`, `tidy`, `cap`, `start`,
   `mode`, `reserve`, `pause`, `resume`, `cadence`, `ledger`, `release`, `usage`, `init`,
   `version`. Oracle diff green for every `--json` command.
6. **watch.** `frame`, layout, keys, mouse, preview, the detach to `tick`/`start`.
7. **Release and cut-over.** `scripts/release.sh`, the tap, `v0.2.0`, the drovr.app/cli mirror
   objects in the hey repo's `cli.tf`; README install becomes
   `brew install cadam11/tap/drovr` then `drovr init && drovr service install`; the drovr.app
   page's four commands change (hey repo); the shadow label removed; `src/`, `test/`,
   `package.json`, `tsconfig.json` and the pnpm lockfile deleted; CLAUDE.md conventions
   rewritten for Go (`go test ./...`, `go vet` as the gate, the "drovr is also a program"
   section loses the "launchd executes TypeScript from this tree" reason but keeps the worktree
   for the git-index one).

A phase is "done" when its tests are green **and** the trap rows for its packages are each
either covered by a named test or ruled not applicable in the plan's ledger.

## What changes for the user

Before:

```
git clone https://github.com/cadam11/drovr.git ~/code/drovr
cd ~/code/drovr && pnpm install
node src/cli.ts init
node src/cli.ts service install
```

After:

```
brew install cadam11/tap/drovr
drovr init
drovr service install
```

Upgrades: `brew upgrade drovr && drovr service install`. The second step is needed only when
the binary's path changed, and `drovr status` says so when it has.

Nothing under `~/.drovr` changes. `control.json`, the ledger, `decisions.jsonl` and every
program keep working; a user who downgrades to the Node tree sees the same files.

## Non-goals

- Any behaviour change, however small, including ones the trap table would welcome. They go
  in after cut-over as their own commits with their own tests, on a tree where the port is no
  longer a variable.
- Intel, Linux or Windows targets.
- Replacing orca, teamclaude or the `hey` binary; drovr still shells out to all three.
- A Go module API for anyone else. Everything is `internal/`.
- Signed or notarized binaries. Homebrew-installed binaries run without Gatekeeper prompts;
  a bare download from Releases needs `xattr -d com.apple.quarantine`, which the README says.

## Answered 2026-10-22

1. Binaries: GitHub Releases **and** the drovr.app/cli mirror.
2. Intel: no.
3. `0.2.0` waits for watch parity.

## Plans

Three plans, written one at a time so each can name the Go signatures the previous one landed:

- **E1** phases 1 and 2: skeleton, the read side, the decision core, shared fixtures.
- **E2** phases 3 and 4: adapters, tick, cycle, shadow service.
- **E3** phases 5 to 7: the rest of the CLI, watch, release, cut-over.
