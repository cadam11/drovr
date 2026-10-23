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
	"syscall"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/control"
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
		"worktree_show.json":   `{"ok":true,"result":{"worktree":{"id":"wt-1","repoId":"r1"}}}`,
		"repo_list.json":       `{"ok":true,"result":{"repos":[{"id":"r1","badgeColor":"#737373"}]}}`,
		"terminal_create.json": `{"ok":true,"result":{"terminal":{"handle":"term_1","tabId":"tab-1"}}}`,
		"terminal_show.json":   claudeShow, "terminal_show.exited.json": shellShow,
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

func TestOneFailedPollDoesNotEndTheWatch(t *testing.T) {
	r := newRig(t, alphaControl, nil)
	// Calls 3 and 4 are the first poll's runner lookup; garbage there and on the next poll.
	for n := 3; n < 5; n++ {
		os.WriteFile(filepath.Join(r.answers, fmt.Sprintf("terminal_show.%d.json", n)), []byte("segfault"), 0o644)
	}
	polls := 0
	r.w.Sleep = func(time.Duration) {
		if polls++; polls == 4 {
			WriteReport(r.p, "alpha", Report{Exit: "seam"})
		}
	}
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	got := r.records(t)
	if got[len(got)-1].Exit != "seam" || strings.Count(r.errs.String(), "could not read its runner's state") != 2 {
		t.Fatalf("%+v\n%s", got, r.errs)
	}
}

func TestBlockedRunnerIsAlertedOnceAndNeverNudged(t *testing.T) {
	blocked := `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/w/alpha","agentIdentity":"claude","agentWait":{"kind":"permission"}}}}`
	r := newRig(t, `{"notifyTo":"craig","blockedAlertMinutes":0,"stallNudgeMinutes":0,"programs":[{"name":"alpha","cwd":"/w/alpha","useDirenv":false}]}`,
		map[string]string{"terminal_show.json": blocked, "terminal_show.1.json": claudeShow, "terminal_show.2.json": claudeShow})
	polls := 0
	r.w.Sleep = func(time.Duration) {
		if polls++; polls == 5 {
			WriteReport(r.p, "alpha", Report{Exit: "seam"})
		}
	}
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	if strings.Count(r.errs.String(), "on a dialog — asked Craig to clear it") != 1 || strings.Count(strings.Join(r.tools, ","), "send") != 1 {
		t.Fatalf("one alert, one send:\n%s\n%v", r.errs, r.tools)
	}
	if strings.Contains(r.calls(), "[drovr] You have been idle") {
		t.Fatal("a blocked runner is never nudged")
	}
	if got := r.records(t); got[len(got)-1].Exit != "seam" {
		t.Fatalf("%+v", got)
	}
}

func TestHeadlessRunnerThatExitsWithoutAReportIsACrash(t *testing.T) {
	r := newRig(t, `{"notifyTo":null,"programs":[{"name":"alpha","cwd":"/","useDirenv":false,"runner":"headless","cycleCommand":"echo \"$DROVR_PROGRAM {mode}\"; exit 3"}]}`, nil)
	r.w.Sleep = func(time.Duration) { time.Sleep(10 * time.Millisecond) } // the child is real; give it time to exit
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	got := r.records(t)
	if got[len(got)-1].Exit != "crash" || !strings.Contains(r.errs.String(), "produced no report — recorded as crash. headless runner exited 3, log at "+r.p.Logs) {
		t.Fatalf("%+v\n%s", got, r.errs)
	}
	logs, _ := filepath.Glob(filepath.Join(r.p.Logs, "alpha-*.log"))
	if body, _ := os.ReadFile(logs[0]); string(body) != "alpha onboard\n" {
		t.Fatalf("%q", body)
	}
}

// drovr never kills a cycle: past maxCycleHours the watch ends as abandoned and the child
// keeps running.
func TestHeadlessRunnerOutlivingTheWatchIsAbandonedNotKilled(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	r := newRig(t, fmt.Sprintf(`{"notifyTo":null,"maxCycleHours":0.05,"programs":[{"name":"alpha","cwd":"/","useDirenv":false,"runner":"headless","cycleCommand":"echo $$ > %s; exec sleep 30"}]}`, pidFile), nil)
	r.w.Sleep = func(time.Duration) { time.Sleep(10 * time.Millisecond) }
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	var pid int
	for i := 0; i < 100 && pid == 0; i++ {
		b, _ := os.ReadFile(pidFile)
		fmt.Sscan(string(b), &pid)
		time.Sleep(20 * time.Millisecond)
	}
	if pid <= 0 {
		t.Fatal("the stub never wrote its pid")
	}
	defer syscall.Kill(-pid, syscall.SIGKILL)
	if err := syscall.Kill(pid, 0); err != nil {
		t.Fatalf("the headless child was killed: %v", err)
	}
	got := r.records(t)
	if got[len(got)-1].Exit != "abandoned" {
		t.Fatalf("%+v\n%s", got, r.errs)
	}
}

// One unreadable report poll must not end the watch; maxPollFailures in a row is lost sight,
// recorded as abandoned, with the child still running.
func TestHeadlessUnreadableReportIsLostSightNotAnError(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "pid")
	r := newRig(t, `{"notifyTo":null,"programs":[]}`, nil)
	// A directory where the report belongs: every read of it fails.
	cmd := fmt.Sprintf("echo $$ > %s; mkdir %s; exec sleep 30", pidFile, r.p.LastCycle("alpha"))
	os.WriteFile(r.p.Control, []byte(fmt.Sprintf(`{"notifyTo":null,"maxCycleHours":1,"programs":[{"name":"alpha","cwd":"/","useDirenv":false,"runner":"headless","cycleCommand":%q}]}`, cmd)), 0o644)
	r.w.Sleep = func(time.Duration) { time.Sleep(10 * time.Millisecond) }
	if err := r.w.RunProgram(context.Background(), "alpha"); err != nil {
		t.Fatal(err)
	}
	var pid int
	for i := 0; i < 100 && pid == 0; i++ {
		b, _ := os.ReadFile(pidFile)
		fmt.Sscan(string(b), &pid)
		time.Sleep(20 * time.Millisecond)
	}
	if pid > 0 {
		defer syscall.Kill(-pid, syscall.SIGKILL)
	}
	got := r.records(t)
	if got[len(got)-1].Exit != "abandoned" || strings.Count(r.errs.String(), "could not read its report") != maxPollFailures {
		t.Fatalf("%+v\n%s", got, r.errs)
	}
}

// ssh answers only once $UP exists; the wake creates it.
func TestEnsureReachableWakesAStoppedBox(t *testing.T) {
	bin := t.TempDir()
	up := filepath.Join(t.TempDir(), "up")
	os.WriteFile(bin+"/ssh", []byte("#!/bin/sh\n[ -f \"$UP\" ] && exit 0\necho 'ssh: connect to host box port 22: Connection refused' >&2\nexit 255\n"), 0o755)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("UP", up)
	r := newRig(t, alphaControl, nil)
	wake := "touch \"$UP\""
	host := hostOf("box", nil)
	if err := r.w.ensureReachable(context.Background(), programNamed("relliq"), host); err == nil || !strings.Contains(err.Error(), "drovr host relliq --wake '<command>'") {
		t.Fatalf("%v", err)
	}
	host.Wake = &wake
	if err := r.w.ensureReachable(context.Background(), programNamed("relliq"), host); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(r.out.String(), "relliq: box is unreachable (") || !strings.Contains(r.out.String(), "— waking it: "+wake) {
		t.Fatalf("%s", r.out)
	}
}

func TestEnsureReachableNamesATailscaleCheck(t *testing.T) {
	bin := t.TempDir()
	os.WriteFile(bin+"/ssh", []byte("#!/bin/sh\necho '# Tailscale SSH requires an additional check. To authenticate, visit: https://login.tailscale.com/a/abc123' >&2\nexit 255\n"), 0o755)
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	r := newRig(t, alphaControl, nil)
	err := r.w.ensureReachable(context.Background(), programNamed("relliq"), hostOf("box", nil))
	if err == nil || !strings.Contains(err.Error(), "box holds ssh on a Tailscale SSH check; visit https://login.tailscale.com/a/abc123") {
		t.Fatalf("%v", err)
	}
}

func programNamed(name string) control.Program { return control.Program{Name: name} }

func hostOf(ssh string, wake *string) control.Host { return control.Host{SSH: ssh, Wake: wake} }
