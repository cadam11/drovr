package exec

import (
	"context"
	"errors"
	"strings"
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
