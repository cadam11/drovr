package state

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/allocation"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/teamclaude"
)

const (
	now  = epoch.Millis(1787400000000)
	hour = epoch.Millis(3_600_000)
)

func input(t *testing.T) Input {
	t.Helper()
	raw, err := os.ReadFile("../../testdata/teamclaude-status.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := teamclaude.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	c, err := control.Parse([]byte(`{"programs":[{"name":"demo","cwd":"/tmp/demo"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	iv, last := 600, now-60_000
	return Input{Status: s, Control: c, Now: now, Service: ServiceInput{Loaded: true, IntervalSeconds: &iv, LastTickAt: &last}}
}

// statusOf mirrors test/fixtures.ts's account(): 5h resets two hours out, weekly ones 84.
func statusOf(t *testing.T, used ...[3]float64) teamclaude.Status {
	t.Helper()
	accounts := make([]string, 0, len(used))
	for i, u := range used {
		accounts = append(accounts, fmt.Sprintf(`{"name":"%c","disabled":false,"rateLimitedUntil":null,"pausedUntil":null,"quota":{"unified7dFable":%v,"unified7dFableReset":%d,"unified7d":%v,"unified7dReset":%d,"unified5h":%v,"unified5hReset":%d,"unifiedStatus":"allowed"}}`,
			'a'+i, u[0], now+84*hour, u[1], now+84*hour, u[2], now+2*hour))
	}
	s, err := teamclaude.Parse([]byte(`{"currentAccount":"a","switchThreshold":0.9,"switchThresholds":null,"accounts":[` + strings.Join(accounts, ",") + `]}`))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func running(program string, startedAt epoch.Millis) ledger.Cycle {
	return ledger.Cycle{V: 1, Kind: "delivery", Program: program, StartedAt: epoch.ISO(startedAt), Exit: "running"}
}

func verdictOf(st DrovrState, name string) string {
	for _, p := range st.Programs {
		if p.Name == name {
			return p.Verdict
		}
	}
	return ""
}

func TestBuildEnvelopeRoundingAndPrograms(t *testing.T) {
	st, err := Build(input(t))
	if err != nil {
		t.Fatal(err)
	}
	if st.SchemaVersion != 1 || st.GeneratedAt != "2026-08-22T12:00:00.000Z" || len(st.Programs) != 1 || st.Programs[0].Name != "demo" {
		t.Fatalf("%+v", st)
	}
	for _, v := range []float64{st.Pool.Fable, st.Pool.General, st.Pool.Session} {
		if v*1e4 != float64(int64(v*1e4+0.5)) && v*1e4 != float64(int64(v*1e4)) {
			t.Errorf("%v carries more than four places", v)
		}
	}
	if st.Service.Overdue {
		t.Error("a tick a minute ago is not overdue")
	}
}

func TestBuildAllocationSegmentsSumToTheTotal(t *testing.T) {
	st, err := Build(input(t))
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range []allocation.Allocation{st.Allocation.Fable, st.Allocation.General, st.Allocation.Session} {
		if sum := a.YoursSpent + a.ProgramsSpent + a.ProgramsReserved + a.ProgramsAvailable + a.YoursReserved; math.Abs(sum-a.Total) >= 0.01 {
			t.Errorf("%s segments %v != total %v", a.Bucket, sum, a.Total)
		}
	}
}

func TestBuildMarksOverdueAndRun(t *testing.T) {
	in := input(t)
	stale := now - 4*600_000
	in.Service.LastTickAt = &stale
	in.Cycles = []ledger.Cycle{{V: 1, Kind: "delivery", Program: "demo", StartedAt: epoch.ISO(now - 3_600_000), Exit: "running"}}
	st, err := Build(in)
	if err != nil || !st.Service.Overdue || st.Programs[0].Verdict != "RUN" || *st.Programs[0].StartedAt != epoch.ISO(now-3_600_000) || st.CyclesInFlight != 1 {
		t.Fatalf("%+v %v", st, err)
	}
}

// decide() cuts in-flight off at control.maxCycleHours (12 by default), not InFlight's own default.
func TestBuildStopsCountingACycleOlderThanMaxCycleHours(t *testing.T) {
	in := input(t)
	in.Cycles = []ledger.Cycle{running("demo", now-13*hour)}
	st, err := Build(in)
	if err != nil || verdictOf(st, "demo") == "RUN" || st.CyclesInFlight != 0 {
		t.Fatalf("%+v %v", st.Programs, err)
	}
}

func TestBuildAdmitsOnlyWhatThePoolFundsInPriorityOrder(t *testing.T) {
	for _, tc := range []struct {
		alpha, beta   float64
		winner, loser string
	}{
		{0, 1, "alpha", "beta"},
		{1, 0, "beta", "alpha"},
	} {
		in := input(t)
		in.Status = statusOf(t, [3]float64{0.2, 0.1, 0})
		c, err := control.Parse([]byte(fmt.Sprintf(`{"programs":[{"name":"alpha","cwd":"/tmp/alpha","priority":%v},{"name":"beta","cwd":"/tmp/beta","priority":%v}]}`, tc.alpha, tc.beta)))
		if err != nil {
			t.Fatal(err)
		}
		in.Control = c
		st, err := Build(in)
		if err != nil || verdictOf(st, tc.winner) != "GO" || verdictOf(st, tc.loser) == "GO" {
			t.Fatalf("%+v %v", st.Programs, err)
		}
	}
}

// A 5h hold recovers in hours and a weekly one in days; the recovery shown must be the binding bucket's.
func TestBuildReportsWhenTheBindingBucketRecovers(t *testing.T) {
	in := input(t)
	in.Status = statusOf(t, [3]float64{0.1, 0.1, 0.99}, [3]float64{0.1, 0.1, 0.99})
	st, err := Build(in)
	if err != nil || st.BindingBucket != "session" || *st.BindingRecoveryAt != epoch.ISO(now+2*hour) || *st.HoursToWeeklyReset != 84 {
		t.Fatalf("%v %v %v %v", st.BindingBucket, st.BindingRecoveryAt, st.HoursToWeeklyReset, err)
	}
	in.Status = statusOf(t, [3]float64{0.99, 0.1, 0}, [3]float64{0.99, 0.1, 0})
	st, err = Build(in)
	if err != nil || st.BindingBucket != "fable" || *st.BindingRecoveryAt != epoch.ISO(now+84*hour) {
		t.Fatalf("%v %v %v", st.BindingBucket, st.BindingRecoveryAt, err)
	}
}

func TestBuildUnderThePhonesAway(t *testing.T) {
	in := input(t)
	in.AwayFromPhone = true
	st, _ := Build(in)
	if st.Mode != "away" || !st.ModeFromPhone || st.Reserve != 0.15 {
		t.Fatalf("%s %v %v", st.Mode, st.ModeFromPhone, st.Reserve)
	}
	plain, _ := Build(input(t))
	if plain.Mode != "normal" || plain.ModeFromPhone {
		t.Fatal("no away, no override")
	}
}

func TestBuildJSONKeepsTheTSKeysAndEmptyArrays(t *testing.T) {
	st, err := Build(input(t))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(st)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"schemaVersion":1,"generatedAt"`, `"recentCycles":[]`, `"asksUrl":null`, `"preview":null`, `"bindingRecoveryAt"`, `"capacityNote"`} {
		if !strings.Contains(string(raw), key) {
			t.Errorf("missing %s in %s", key, raw)
		}
	}
}

func collector(t *testing.T) (*Collector, string) {
	t.Helper()
	home := t.TempDir()
	os.WriteFile(filepath.Join(home, "control.json"), []byte(`{"notifyTo":null,"programs":[{"name":"demo","cwd":"/tmp/demo"}]}`), 0o644)
	p := paths.Paths{Base: home, Control: filepath.Join(home, "control.json"), Cycles: filepath.Join(home, "cycles.jsonl"), Decisions: filepath.Join(home, "decisions.jsonl"), LastTick: filepath.Join(home, "last-tick.json")}
	answers := t.TempDir()
	orcaBin, _ := filepath.Abs("../orca/testdata")
	bin, _ := filepath.Abs("../../testdata/bin") // teamclaude and launchctl shims
	t.Setenv("PATH", orcaBin+":"+bin+":"+os.Getenv("PATH"))
	t.Setenv("ORCA_ANSWERS", answers)
	os.WriteFile(filepath.Join(answers, "terminal_show.json"), []byte(`{"ok":true,"result":{"terminal":{"handle":"term_1","agentIdentity":"claude","agentWait":null}}}`), 0o644)
	os.WriteFile(filepath.Join(answers, "terminal_wait_exit.json"), []byte(`{"ok":false,"error":{"code":"timeout"}}`), 0o644)
	o := orca.NewClient(p, os.Stderr)
	os.MkdirAll(p.ProgramState("demo"), 0o755)
	orca.RememberTerminal(p, "demo", orca.Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"})
	return &Collector{Paths: p, Orca: o, Host: "mac", Now: func() epoch.Millis { return now }}, answers
}

func TestCollectRequiresASink(t *testing.T) {
	c, _ := collector(t)
	defer func() {
		if recover() == nil {
			t.Fatal("a nil onWarning must panic: dropping a warning is a choice the caller makes out loud")
		}
	}()
	c.Collect(context.Background(), nil, 0)
}

func TestCollectNeverProbesIdle(t *testing.T) {
	c, answers := collector(t)
	st, err := c.Collect(context.Background(), func(string) {}, 0)
	if err != nil || st.Programs[0].Verdict == "GO" {
		t.Fatalf("a present runner holds the program: %+v %v", st.Programs, err)
	}
	log, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
	if strings.Contains(string(log), "tui-idle") {
		t.Fatalf("presence must not pay the idle probe:\n%s", log)
	}
}

func TestProbesReusedOnlyInsideTheWindow(t *testing.T) {
	c, answers := collector(t)
	count := func() int {
		log, _ := os.ReadFile(filepath.Join(answers, "calls.log"))
		return strings.Count(string(log), "terminal show")
	}
	c.Collect(context.Background(), func(string) {}, 0)
	perCollect := count() // runnerTerminal's show, then runnerIsPresent's
	c.Collect(context.Background(), func(string) {}, 0)
	if perCollect == 0 || count() != 2*perCollect {
		t.Fatalf("window 0 must probe fresh every call: %d then %d", perCollect, count())
	}
	c.Collect(context.Background(), func(string) {}, time.Minute)
	if count() != 2*perCollect {
		t.Fatalf("inside the window the probe is reused: %d", count())
	}
	os.WriteFile(c.Paths.Control, []byte(`{"mode":"low","notifyTo":null,"programs":[{"name":"demo","cwd":"/tmp/demo"}]}`), 0o644)
	if st, _ := c.Collect(context.Background(), func(string) {}, time.Minute); st.Mode != "low" {
		t.Fatal("the cheap half (control.json) is re-read on every call")
	}
}

// A runner orca cannot answer for is unknown, never absent, and the sink hears why; a reused
// probe replays the same warning rather than letting it blink out of the frame.
func TestRunnerFailureWarnsAndReplaysInsideTheWindow(t *testing.T) {
	c, answers := collector(t)
	os.WriteFile(filepath.Join(answers, "terminal_show.json"), []byte(`{"ok":false,"error":{"code":"boom","message":"orca fell over"}}`), 0o644)
	os.WriteFile(filepath.Join(answers, "terminal_show.code"), []byte("1"), 0o644)
	var heard []string
	sink := func(w string) { heard = append(heard, w) }
	if _, err := c.Collect(context.Background(), sink, 0); err != nil {
		t.Fatal(err)
	}
	if len(heard) != 1 || !strings.HasPrefix(heard[0], "could not read demo's runner state: ") {
		t.Fatalf("%q", heard)
	}
	c.Collect(context.Background(), sink, time.Minute)
	if len(heard) != 2 || heard[1] != heard[0] {
		t.Fatalf("%q", heard)
	}
}

func TestCollectAppliesThePhonesAwayWithoutWritingIt(t *testing.T) {
	c, _ := collector(t)
	os.WriteFile(c.Paths.Control, []byte(`{"notifyTo":"craig","programs":[{"name":"demo","cwd":"/tmp/demo"}]}`), 0o644)
	c.Caller = func() (hey.Call, error) {
		return func(context.Context, string, any) (json.RawMessage, error) {
			return json.RawMessage(`{"prefs":{"quietHours":null,"away":true}}`), nil
		}, nil
	}
	st, err := c.Collect(context.Background(), func(string) {}, 0)
	if err != nil || st.Mode != "away" || !st.ModeFromPhone {
		t.Fatalf("%s %v %v", st.Mode, st.ModeFromPhone, err)
	}
	stored, err := control.Read(c.Paths.Control)
	if err != nil || stored.Mode != "normal" {
		t.Fatalf("the phone's away is never written: %s %v", stored.Mode, err)
	}
}

func TestCollectLinksALocalAsksFile(t *testing.T) {
	c, _ := collector(t)
	os.WriteFile(c.Paths.Control, []byte(`{"notifyTo":null,"programs":[{"name":"demo","cwd":"/tmp/demo","asksFile":"docs/asks.md"}]}`), 0o644)
	st, err := c.Collect(context.Background(), func(string) {}, 0)
	if err != nil || st.Programs[0].AsksURL == nil || *st.Programs[0].AsksURL != "file:///tmp/demo/docs/asks.md" {
		t.Fatalf("%v %v", st.Programs[0].AsksURL, err)
	}
}
