package cli

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/orca"
)

// alpha holds a bare shell (closed), beta has a cycle in flight (left alone, orca never asked
// about it), gamma has no terminal at all.
func TestTidyClosesAnEmptyTerminal(t *testing.T) {
	env, out, _ := cliEnv(t, `{"programs":[{"name":"alpha","cwd":"/a"},{"name":"beta","cwd":"/b"},{"name":"gamma","cwd":"/g"}]}`)
	running := `{"v":1,"kind":"delivery","program":"beta","startedAt":"2026-08-28T10:00:00.000Z","endedAt":null,"exit":"running","poolBefore":{"fable":1,"general":1,"session":1},"poolAfter":null,"startupTokens":null,"yield":null}` + "\n"
	if err := os.WriteFile(env.Paths.Cycles, []byte(running), 0o644); err != nil {
		t.Fatal(err)
	}
	answers := t.TempDir()
	shell := `{"ok":true,"result":{"terminal":{"handle":"term_1","title":"alpha cycles","worktreePath":"/a","agentIdentity":null}}}`
	for name, body := range map[string]string{"terminal_show.json": shell, "terminal_close.json": `{"ok":true,"result":{}}`} {
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
	if err := Tidy(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	want := "alpha: closed term_1\nbeta: cycle in flight, left alone\ngamma: no empty cycle terminal\n"
	if out.String() != want {
		t.Fatalf("%q", out.String())
	}
	calls, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
	if !strings.Contains(string(calls), "terminal close --terminal term_1") || strings.Contains(string(calls), "beta") {
		t.Fatalf("orca calls:\n%s", calls)
	}
	if _, err := os.Stat(env.Paths.CycleTerminal("alpha")); !os.IsNotExist(err) {
		t.Fatalf("the remembered terminal survived its close: %v", err)
	}
}
