package tick

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
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

// A runner still there is re-watched, never closed: measured 2026-09-12, a killed run-cycle
// left a healthy runner working, and closing it latched the program and lost its report. And a
// working leftover with no cycle in flight holds its program (runnerPresent reaches decide()).
func TestALiveRunnerIsReattachedAndALeftoverHolds(t *testing.T) {
	env, out, _ := home(t, threePrograms)
	answers := os.Getenv("ORCA_ANSWERS")
	for name, body := range map[string]string{
		"terminal_show.json":          `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"x cycles","worktreePath":"/w","agentIdentity":"claude","agentWait":null}}}`,
		"terminal_wait_exit.json":     `{"ok":false,"error":{"code":"timeout"}}`,
		"terminal_wait_tui-idle.json": `{"ok":false,"error":{"code":"timeout"}}`,
	} {
		os.WriteFile(filepath.Join(answers, name), []byte(body), 0o644)
	}
	for _, p := range []string{"alpha", "gamma"} {
		paths.EnsureDirs(env.Paths, p)
		orca.RememberTerminal(env.Paths, p, orca.Remembered{Handle: "term_1", TabID: "tab-" + p, WorktreeID: "wt"})
	}
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	cycles, _ := ledger.ReadCycles(env.Paths.Cycles)
	for _, c := range cycles {
		if c.Program == "gamma" && c.Exit != "running" {
			t.Fatalf("a live runner's cycle was closed: %+v", c)
		}
	}
	if !strings.Contains(out.String(), "gamma: cycle started") || !strings.Contains(out.String(), "but its runner is still there — attaching a new one") {
		t.Fatalf("%s", out)
	}
	if got := launched(t, env, 1); !slices.Contains(got, "gamma") || slices.Contains(got, "alpha") {
		t.Fatalf("launched %v\n%s", got, out)
	}
	for _, d := range decisions(t, env.Paths.Decisions) {
		if d.Program == "alpha" && !strings.Contains(d.Reason, "outlived its cycle") {
			t.Fatalf("a working leftover did not hold alpha: %+v", d)
		}
	}
	calls, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
	if strings.Contains(string(calls), "/exit") {
		t.Fatal("a working leftover was sent /exit")
	}
}

// A disabled program is still published (decided without I/O), and the pass never writes it a
// decision line: decisions.jsonl is admission's log.
func TestDisabledProgramIsPublishedNotDecided(t *testing.T) {
	env, _, _ := home(t, `{"notifyTo":"craig","programs":[{"name":"alpha","cwd":"/tmp/a"},{"name":"zeta","cwd":"/tmp/z","enabled":false}]}`)
	var published string
	env.Caller = func() (hey.Call, error) {
		return func(_ context.Context, tool string, args any) (json.RawMessage, error) {
			if tool == "putStatus" {
				b, _ := json.Marshal(args)
				published = string(b)
				return json.RawMessage(`{"sk":"status#drovr@mac","at":"x","expiresAt":1}`), nil
			}
			return json.RawMessage(`{"prefs":{"quietHours":null,"away":false}}`), nil
		}, nil
	}
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(published, `\"name\":\"zeta\"`) {
		t.Fatalf("published %s", published)
	}
	for _, d := range decisions(t, env.Paths.Decisions) {
		if d.Program == "zeta" {
			t.Fatal("a disabled program was logged as decided")
		}
	}
}

// The watchdog is armed by Tick itself: a pass stuck in a subprocess past its budget releases
// the lock and exits non-zero while the subprocess is still running.
func TestWatchdogFiresOnAStuckPass(t *testing.T) {
	env, _, errs := home(t, `{"notifyTo":null,"tickBudgetMinutes":0.002,"programs":[]}`)
	slow := t.TempDir()
	os.WriteFile(filepath.Join(slow, "teamclaude"), []byte("#!/bin/sh\nsleep 1\nexit 1\n"), 0o755)
	t.Setenv("PATH", slow+":"+os.Getenv("PATH"))
	exited := make(chan int, 1)
	env.Exit = func(code int) {
		if _, held, _ := lockHeld(env.Paths.TickLock); held {
			t.Error("exited holding the lock")
		}
		exited <- code
	}
	Tick(context.Background(), env)
	select {
	case code := <-exited:
		if code != 1 || !strings.Contains(errs.String(), "a tick overran") {
			t.Fatalf("%d %s", code, errs)
		}
	default:
		t.Fatal("the watchdog never fired")
	}
}
