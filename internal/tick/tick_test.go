package tick

import (
	"bytes"
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/paths"
)

func itoa(n int) string { return strconv.Itoa(n) }

func watchdogEnv(t *testing.T, control string) (Env, string) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "control.json"), []byte(control), 0o644)
	p := paths.Paths{Base: dir, Control: filepath.Join(dir, "control.json"), TickLock: filepath.Join(dir, "tick.lock")}
	return Env{Paths: p, Out: &bytes.Buffer{}, Err: &bytes.Buffer{}, Host: "mac"}, p.TickLock
}

func TestOverrunReleasesItsOwnLock(t *testing.T) {
	for _, control := range []string{`{"notifyTo":null,"programs":[]}`, `{ not json`} {
		env, lockPath := watchdogEnv(t, control)
		if ok, err := lock.Acquire(lockPath); !ok || err != nil {
			t.Fatal(ok, err)
		}
		msg := ReleaseOverrunningTick(context.Background(), env, lockPath, 3*time.Minute)
		if _, held, _ := lock.HeldBy(lockPath); held {
			t.Fatalf("control %q: the lock survived the watchdog", control)
		}
		if !strings.Contains(msg, "overran 3m") || !strings.Contains(msg, "pid "+itoa(os.Getpid())) || !strings.Contains(msg, "lock is released") {
			t.Fatal(msg)
		}
	}
	env, lockPath := watchdogEnv(t, `{"notifyTo":null,"programs":[]}`)
	if msg := ReleaseOverrunningTick(context.Background(), env, lockPath, 30*time.Second); !strings.Contains(msg, "overran 30s") {
		t.Fatal("a sub-minute budget is reported in seconds; an already-free lock is quiet")
	}
}

func TestFailedTickMarksTheEpisodeOnce(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "tick-failure.json")
	boom := errors.New("teamclaude status did not match expected shape: [")
	at := epoch.MustParse("2026-09-14T17:38:50Z")
	for i, want := range []bool{true, false, false} {
		if began, err := RecordTickFailure(marker, at+epoch.Millis(i)*600_000, boom); err != nil || began != want {
			t.Fatalf("%d: %v %v", i, began, err)
		}
	}
	raw, _ := os.ReadFile(marker)
	if string(raw) != `{"at":"2026-09-14T17:38:50.000Z","reason":"teamclaude status did not match expected shape: ["}`+"\n" {
		t.Fatalf("%s", raw)
	}
	if err := ClearTickFailure(marker); err != nil {
		t.Fatal(err)
	}
	if err := ClearTickFailure(marker); err != nil {
		t.Fatal("clearing an episode that never started is not an error")
	}
	if began, _ := RecordTickFailure(marker, at, boom); !began {
		t.Fatal("the next outage alerts again")
	}
}

func TestFailedTickTextIsOneLine(t *testing.T) {
	text := FailedTickText(errors.New("teamclaude status did not match expected shape: [\n  {\n    \"code\": \"invalid_type\"\n  }\n]"))
	if strings.Contains(text, "\n") || strings.Contains(text, `"code"`) || !strings.Contains(text, "no program can start") || !strings.HasSuffix(text, "See it: tail -40 ~/.drovr/logs/tick.err") {
		t.Fatal(text)
	}
	if len(FailedTickText(errors.New(strings.Repeat("x", 5000)))) >= 260 {
		t.Fatal("an enormous message is cut")
	}
}

func TestOrphanActionAndDuration(t *testing.T) {
	yes, no := true, false
	if OrphanAction(&yes) != "reattach" || OrphanAction(&no) != "close" || OrphanAction(nil) != "skip" {
		t.Fatal("orphan")
	}
	for ms, want := range map[int64]string{10_000: "10s", 59_499: "59s", 60_000: "1m", 90_000: "2m", 480_000: "8m"} {
		if DurationText(ms) != want {
			t.Errorf("%d → %s", ms, DurationText(ms))
		}
	}
}

func TestDecisionRecordWritesInfinityAsNull(t *testing.T) {
	inf := decide.Cycles(math.Inf(1))
	d := decide.Decision{Verdict: "GO", Reason: "fundable", CyclesFundable: &inf}
	rec := DecisionRecord("alpha", d, 1787400000000)
	path := filepath.Join(t.TempDir(), "decisions.jsonl")
	if err := ledger.AppendRecord(path, rec); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"v":1,"at":"2026-08-22T12:00:00.000Z","program":"alpha","verdict":"GO","reason":"fundable","pool":null,"cyclesFundable":null}`+"\n" {
		t.Fatalf("%s", raw)
	}
}
