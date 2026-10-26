package paths

import (
	"os"
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
		p.CycleTerminal("demo"): "/tmp/x/programs/demo/cycle-terminal.json", p.CurrentCycle("demo"): "/tmp/x/programs/demo/current-cycle.json",
		p.Nudged("demo"): "/tmp/x/programs/demo/nudged.json", p.ProfileSeeded("demo"): "/tmp/x/programs/demo/profile-seeded.json",
		p.WorkerLog("demo"): "/tmp/x/logs/demo-worker.log",
	}
	for got, exp := range want {
		if got != exp {
			t.Errorf("got %q want %q", got, exp)
		}
	}
}

func TestRootDefaultsToHome(t *testing.T) {
	t.Setenv("DROVR_HOME", "") // registers the restore
	os.Unsetenv("DROVR_HOME")
	t.Setenv("HOME", "/Users/nobody")
	if got := Root(); got != filepath.Join("/Users/nobody", ".drovr") {
		t.Fatalf("Root() = %q", got)
	}
}

func TestRootEmptyDrovrHomeIsSet(t *testing.T) {
	t.Setenv("DROVR_HOME", "")
	if got := Root(); got != "" {
		t.Fatalf("Root() = %q, want empty (Node's ?? only falls back on unset)", got)
	}
}

func TestEnsureDirs(t *testing.T) {
	t.Setenv("DROVR_HOME", t.TempDir())
	p := New()
	if err := EnsureDirs(p, "demo"); err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{p.Logs, p.ProgramState("demo")} {
		if _, err := os.Stat(dir); err != nil {
			t.Errorf("%s: %v", dir, err)
		}
	}
}
