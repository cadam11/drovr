package cli

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"
)

// The stub stands in for this binary: it records its argv where the test can read it, which
// proves the worker was spawned as `run-cycle alpha` and that Start did not wait for it.
func TestStartLaunchesTheWorkerDetached(t *testing.T) {
	env, out, _ := cliEnv(t, `{"programs":[{"name":"alpha","cwd":"/a"}]}`)
	if err := os.MkdirAll(env.Paths.Logs, 0o755); err != nil {
		t.Fatal(err)
	}
	argvFile := filepath.Join(t.TempDir(), "argv")
	env.Self = filepath.Join(t.TempDir(), "stub")
	script := "#!/bin/sh\necho \"$*\" > " + argvFile + "\nsleep 0.2\n"
	if err := os.WriteFile(env.Self, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	began := time.Now()
	if err := Start(env, []string{"alpha"}); err != nil {
		t.Fatal(err)
	}
	if time.Since(began) > 150*time.Millisecond {
		t.Fatal("Start waited on the worker")
	}
	want := regexp.MustCompile("^alpha: launched cycle \\(pid \\d+, log " + regexp.QuoteMeta(env.Paths.WorkerLog("alpha")) + "\\)\n$")
	if !want.MatchString(out.String()) {
		t.Fatalf("%q", out.String())
	}
	for i := 0; i < 500; i++ {
		if b, err := os.ReadFile(argvFile); err == nil && strings.TrimSpace(string(b)) == "run-cycle alpha" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	log, _ := os.ReadFile(env.Paths.WorkerLog("alpha"))
	argv, err := os.ReadFile(argvFile)
	t.Fatalf("the worker never ran `run-cycle alpha`; argv %q (%v), log %q", argv, err, log)
}

func TestStartRefusals(t *testing.T) {
	env, _, _ := cliEnv(t, `{"programs":[{"name":"alpha","cwd":"/a"}]}`)
	if err := Start(env, nil); err == nil || err.Error() != "usage: drovr start <program>" {
		t.Fatalf("%v", err)
	}
	if err := Start(env, []string{"nope"}); err == nil || err.Error() != `no program named "nope"` {
		t.Fatalf("%v", err)
	}
}
