package orca

import (
	"bytes"
	"context"
	"errors"
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

func TestGarbageOnASuccessfulExitIsNotJSON(t *testing.T) {
	shim(t, map[string]string{"terminal_show.json": "segfault"})
	c, _ := client(t)
	if _, err := c.AgentState(context.Background(), "term_1", ""); err == nil || !strings.Contains(err.Error(), "did not return JSON. It printed: segfault") {
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

// A refusal on the exit probe that is not a timeout is orca failing, not the pty ending.
func TestExitProbeRefusalIsAnErrorNotGone(t *testing.T) {
	dir := shim(t, map[string]string{"terminal_show.json": okClaude, "terminal_wait_exit.json": `{"ok":false,"error":{"code":"internal"}}`, "terminal_wait_exit.code": "1"})
	c, _ := client(t)
	state, err := c.AgentState(context.Background(), "term_1", "")
	var refused *Refused
	if !errors.As(err, &refused) || refused.Code != "internal" || state == Gone {
		t.Fatalf("%s %v", state, err)
	}
	if strings.Contains(calls(t, dir), "tui-idle") {
		t.Fatal("probed idle after a failed exit probe")
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
		"terminal_create.json":          `{"ok":true,"result":{"terminal":{"handle":"term_1","tabId":"tab-1"}}}`,
		"terminal_show.json":            okClaude,
		"terminal_wait_exit.json":       timeout,
		"terminal_wait_tui-idle.1.json": satisfied,
		"terminal_wait_tui-idle.json":   timeout,
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

func TestUnregisteredWorktreeNamesTheFix(t *testing.T) {
	shim(t, map[string]string{"worktree_show.json": `{"ok":false,"error":{"code":"selector_not_found"}}`, "worktree_show.code": "1"})
	c, _ := client(t)
	p := program("alpha")
	p.Host = &control.Host{Environment: "box", Cwd: "~/code/alpha"}
	_, err := c.ResolveWorktree(context.Background(), p)
	if err == nil || err.Error() != "orca has no worktree at ~/code/alpha, so alpha has nowhere to run. Register it:  orca repo add --path ~/code/alpha --environment box" {
		t.Fatalf("%v", err)
	}
}

func TestReadPreviewNeverFails(t *testing.T) {
	shim(t, map[string]string{"terminal_show.json": okClaude, "terminal_read.json": "garbage", "terminal_read.code": "2"})
	c, _ := client(t)
	if p, w := c.ReadPreview(context.Background(), "alpha"); p != nil || w == nil || *w != "preview unavailable for alpha: no runner terminal" {
		t.Fatalf("%+v %v", p, w)
	}
	remember(t, c, "alpha", Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	if p, w := c.ReadPreview(context.Background(), "alpha"); p != nil || w == nil || !strings.HasPrefix(*w, "preview unavailable for alpha: orca terminal read --terminal term_1 --limit 40 failed") {
		t.Fatalf("%+v %v", p, w)
	}
}
