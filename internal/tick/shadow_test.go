package tick

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
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
	answers := idleReportedLeftover(t, env, fixed)
	before := snapshot(t, env.Paths.Base)
	shadow := env
	shadow.Shadow = true
	shadowOut := &bytes.Buffer{}
	shadow.Out = shadowOut
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
	if !strings.Contains(shadowOut.String(), "alpha: would release the runner its last cycle left behind (exit)") || !strings.Contains(shadowOut.String(), ": would launch") {
		t.Fatalf("%s", shadowOut)
	}
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	calls, _ = os.ReadFile(filepath.Join(answers, "calls.log"))
	if !strings.Contains(string(calls), "--text /exit") {
		t.Fatalf("the live pass was meant to release alpha's runner:\n%s", calls)
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

// idleReportedLeftover gives alpha a reported last cycle and a runner idling at the prompt —
// the leftover the live pass sends /exit — and returns the orca shim's answers directory.
func idleReportedLeftover(t *testing.T, env Env, fixed epoch.Millis) string {
	answers := os.Getenv("ORCA_ANSWERS")
	ended := epoch.ISO(fixed - 600_000)
	ledger.AppendRecord(env.Paths.Cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: "alpha", StartedAt: epoch.ISO(fixed - 7_200_000), EndedAt: &ended, Exit: "seam", PoolAfter: &ledger.Cost{}})
	os.MkdirAll(env.Paths.ProgramState("alpha"), 0o755)
	orca.RememberTerminal(env.Paths, "alpha", orca.Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
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
	return answers
}

func keys(m map[string]string) []string {
	var out []string
	for k := range m {
		out = append(out, k)
	}
	return out
}

// The rows of the effects table that the parity test cannot see: a shadow texts nothing (no
// nudge, no publish, no failure alert, no overrun text), takes its own lock so a live tick
// holding tick.lock does not stop it, leaves no failure marker, and refuses a writable orca.
func TestShadowSendsNothingAndKeepsItsOwnLock(t *testing.T) {
	env, _, _ := home(t, `{"notifyTo":"craig","programs":[{"name":"alpha","cwd":"/tmp/a"}]}`)
	now := epoch.Now()
	asked, blocked := epoch.ISO(now-5*3_600_000), epoch.ISO(now-4*3_600_000)
	ledger.AppendRecord(env.Paths.Cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: "alpha", StartedAt: asked, EndedAt: &asked, Exit: "seam", AsksRaised: 1, PoolAfter: &ledger.Cost{}})
	ledger.AppendRecord(env.Paths.Cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: "alpha", StartedAt: blocked, EndedAt: &blocked, Exit: "blocked", PoolAfter: &ledger.Cost{}})
	var tools []string
	env.Caller = func() (hey.Call, error) {
		return func(_ context.Context, tool string, _ any) (json.RawMessage, error) {
			tools = append(tools, tool)
			return json.RawMessage(`{"prefs":{"quietHours":null,"away":false}}`), nil
		}, nil
	}
	env.Shadow = true
	if err := Run(context.Background(), env); err == nil || !strings.Contains(err.Error(), "read-only orca") {
		t.Fatalf("a writable orca client was accepted: %v", err)
	}
	env.Orca.ReadOnly = true
	os.WriteFile(env.Paths.TickLock, []byte(`{"pid":1,"at":`+strconv.FormatInt(now, 10)+`}`), 0o644)
	if err := Run(context.Background(), env); err != nil {
		t.Fatal(err)
	}
	if len(decisions(t, env.Paths.DecisionsShadow)) != 1 || strings.Join(tools, ",") != "prefs" {
		t.Fatalf("decided %d, called %v", len(decisions(t, env.Paths.DecisionsShadow)), tools)
	}
	if _, err := os.Stat(env.Paths.TickShadowLock); !os.IsNotExist(err) {
		t.Fatal("the shadow lock outlived the pass")
	}
	live := env
	live.Shadow, tools = false, nil
	os.Remove(env.Paths.TickLock)
	if err := Run(context.Background(), live); err != nil || !slices.Contains(tools, "send") {
		t.Fatalf("the live pass was meant to nudge: %v %v", err, tools)
	}
	broken := t.TempDir()
	os.WriteFile(filepath.Join(broken, "teamclaude"), []byte("#!/bin/sh\nexit 1\n"), 0o755)
	t.Setenv("PATH", broken+":"+os.Getenv("PATH"))
	tools = nil
	if err := Run(context.Background(), env); err == nil {
		t.Fatal("a failed shadow pass still fails")
	}
	ReleaseOverrunningTick(context.Background(), env, env.Paths.TickShadowLock, time.Minute)
	if _, err := os.Stat(env.Paths.TickFailure); !os.IsNotExist(err) || strings.Join(tools, ",") != "prefs" {
		t.Fatalf("marker %v, called %v", err, tools)
	}
}
