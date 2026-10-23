package exec

import (
	"context"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestRunBoundedCapturesOutput(t *testing.T) {
	r, err := RunBounded(context.Background(), "sh", []string{"-c", "echo out; echo err >&2"}, Bounds{Timeout: time.Second})
	if err != nil || r.Stdout != "out\n" || r.Stderr != "err\n" {
		t.Fatalf("%+v %v", r, err)
	}
}

func TestRunBoundedTimesOutWithTail(t *testing.T) {
	_, err := RunBounded(context.Background(), "sh", []string{"-c", "echo waiting on you >&2; sleep 5"}, Bounds{Timeout: 200 * time.Millisecond, Label: "slow thing"})
	var to *TimedOut
	if !errors.As(err, &to) || !strings.Contains(err.Error(), "slow thing did not return within 0s and was killed; it had printed: waiting on you") {
		t.Fatalf("%v", err)
	}
}

func TestRunBoundedKeepsOriginalFailure(t *testing.T) {
	_, err := RunBounded(context.Background(), "sh", []string{"-c", `echo '{"ok":false,"code":"x"}'; exit 3`}, Bounds{Timeout: time.Second})
	var ee *ExitError
	if !errors.As(err, &ee) || ee.Code != 3 || !strings.Contains(ee.Stdout, `"ok":false`) {
		t.Fatalf("%v", err)
	}
}

func TestRunBoundedExplainsMissingBinary(t *testing.T) {
	t.Setenv("PATH", "/nonexistent")
	_, err := RunBounded(context.Background(), "definitely-not-here", nil, Bounds{Timeout: time.Second})
	if err == nil || !strings.Contains(err.Error(), "definitely-not-here is not on PATH. Looked in: /nonexistent. If this came from a launchd tick, re-run `drovr service install`") {
		t.Fatalf("%v", err)
	}
}

func TestRunBoundedFailureNamesCommandAndStderr(t *testing.T) {
	_, err := RunBounded(context.Background(), "sh", []string{"-c", "echo out; echo 'proxy is down' >&2; exit 3"}, Bounds{Timeout: time.Second})
	var ee *ExitError
	if !errors.As(err, &ee) || ee.Code != 3 || ee.Stdout != "out\n" {
		t.Fatalf("%v", err)
	}
	want := "Command failed: sh -c echo out; echo 'proxy is down' >&2; exit 3\nproxy is down"
	if err.Error() != want {
		t.Fatalf("got %q want %q", err.Error(), want)
	}
	_, err = RunBounded(context.Background(), "sh", []string{"-c", "exit 1"}, Bounds{Timeout: time.Second, Label: "quiet thing"})
	if err == nil || err.Error() != "Command failed: quiet thing" {
		t.Fatalf("%q", err)
	}
}

func readLog(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, fs.ErrNotExist) {
		t.Fatal(err)
	}
	return string(b)
}

func TestDetachReturnsAtOnceInItsOwnSession(t *testing.T) {
	log := filepath.Join(t.TempDir(), "w.log")
	if err := os.WriteFile(log, []byte("old\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	pid, err := Detach("sh", []string{"-c", "echo started; sleep 0.3; echo done"}, log)
	if err != nil || pid <= 0 {
		t.Fatal(pid, err)
	}
	if waited := time.Since(start); waited > 200*time.Millisecond {
		t.Fatalf("Detach waited %v for a child it must not wait on", waited)
	}
	if pgid, err := syscall.Getpgid(pid); err != nil || pgid != pid {
		t.Errorf("child is not a session leader: pgid %d pid %d err %v", pgid, pid, err)
	}
	for i := 0; i < 40 && !strings.Contains(readLog(t, log), "done"); i++ {
		time.Sleep(50 * time.Millisecond)
	}
	if got := readLog(t, log); got != "old\nstarted\ndone\n" {
		t.Fatalf("log = %q, want the child's output appended", got)
	}
}

func TestDetachExplainsAMissingBinary(t *testing.T) {
	t.Setenv("PATH", "/nonexistent")
	_, err := Detach("definitely-not-here", nil, filepath.Join(t.TempDir(), "w.log"))
	if err == nil || !strings.Contains(err.Error(), "definitely-not-here is not on PATH") {
		t.Fatalf("%v", err)
	}
}

func TestRunBoundedToALogWithEnv(t *testing.T) {
	log := filepath.Join(t.TempDir(), "h.log")
	r, err := RunBounded(context.Background(), "sh", []string{"-c", "echo $DROVR_PROGRAM; echo err >&2"},
		Bounds{Timeout: 2 * time.Second, LogPath: log, Env: []string{"DROVR_PROGRAM=alpha"}})
	if err != nil || r.Stdout != "" || r.Stderr != "" {
		t.Fatalf("%+v %v", r, err)
	}
	if got := readLog(t, log); got != "alpha\nerr\n" {
		t.Fatalf("log = %q", got)
	}
}
