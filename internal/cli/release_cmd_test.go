package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/orca"
)

const (
	shimClaude  = `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/w/alpha","agentIdentity":"claude","agentWait":null}}}`
	shimBlocked = `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/w/alpha","agentIdentity":"claude","agentWait":{"kind":"permission"}}}}`
	shimTimeout = `{"ok":false,"error":{"code":"timeout"}}`
	shimSettled = `{"ok":true,"result":{"wait":{"satisfied":true}}}`
)

// releaseRig is a program with a remembered terminal and an orca shim answering with show,
// the exit probe and the idle probe; it returns the env, the shim's call log and the client.
func releaseRig(t *testing.T, show, idleProbe string) (Env, func() string, *orca.Client) {
	env, _, _ := cliEnv(t, `{"programs":[{"name":"alpha","cwd":"/a"}]}`)
	answers := t.TempDir()
	for name, body := range map[string]string{
		"terminal_show.json": show, "terminal_wait_exit.json": shimTimeout,
		"terminal_wait_tui-idle.json": idleProbe, "terminal_send.json": `{"ok":true,"result":{}}`,
		"terminal_close.json": `{"ok":true,"result":{}}`,
	} {
		if err := os.WriteFile(filepath.Join(answers, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	shim, _ := filepath.Abs("../orca/testdata")
	t.Setenv("PATH", shim+":"+os.Getenv("PATH"))
	t.Setenv("ORCA_ANSWERS", answers)
	if err := os.MkdirAll(env.Paths.ProgramState("alpha"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := orca.RememberTerminal(env.Paths, "alpha", orca.Remembered{Handle: "term_1", TabID: "tab_1", WorktreeID: "wt_1"}); err != nil {
		t.Fatal(err)
	}
	client := orca.NewClient(env.Paths, env.Stderr)
	client.Sleep = func(time.Duration) {}
	calls := func() string {
		b, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
		return string(b)
	}
	return env, calls, client
}

func TestReleaseRefusesWorkingAndBlocked(t *testing.T) {
	for state, show := range map[string]string{"working": shimClaude, "blocked": shimBlocked} {
		env, calls, client := releaseRig(t, show, shimTimeout)
		err := release(context.Background(), env, client, []string{"alpha"})
		if err != ErrPrinted {
			t.Fatalf("%s: %v", state, err)
		}
		stderr := env.Stderr.(interface{ String() string }).String()
		if !strings.HasPrefix(stderr, "alpha: its runner is "+state+", so it was left alone") ||
			!strings.Contains(stderr, "\n  open it:  orca terminal switch --terminal term_1\n") {
			t.Fatalf("%s: %q", state, stderr)
		}
		if strings.Contains(calls(), "terminal send") || strings.Contains(calls(), "terminal close") {
			t.Fatalf("%s: orca was asked to act:\n%s", state, calls())
		}
	}
}

func TestReleaseSendsExitOnlyToIdle(t *testing.T) {
	env, calls, client := releaseRig(t, shimClaude, shimSettled)
	// The shim keeps the pty alive after /exit, so this ends in "did not exit"; the send is the point.
	_ = release(context.Background(), env, client, []string{"alpha"})
	if n := strings.Count(calls(), "--text /exit"); n != 1 {
		t.Fatalf("%d /exit sends:\n%s", n, calls())
	}
	if idle, send := strings.Index(calls(), "--for tui-idle"), strings.Index(calls(), "terminal send"); idle < 0 || idle > send {
		t.Fatalf("/exit went out before the agent was read as settled:\n%s", calls())
	}
}

func TestReleaseReportsAnIgnoredExit(t *testing.T) {
	env, _, client := releaseRig(t, shimClaude, shimSettled)
	err := release(context.Background(), env, client, []string{"alpha"})
	if err != ErrPrinted {
		t.Fatalf("%v", err)
	}
	want := "alpha: the runner did not exit; it still holds its \"alpha cycles\" tab in alpha. Run this again, or close the tab:  orca terminal switch --terminal term_1\n"
	if got := env.Stdout.(interface{ String() string }).String(); got != want {
		t.Fatalf("%q", got)
	}
	r := orca.RememberedTerminal(env.Paths, "alpha", env.Stderr)
	if r == nil || !r.ExitSent {
		t.Fatalf("exitSent not recorded: %+v", r)
	}
}
