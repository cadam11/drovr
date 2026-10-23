package cli

import (
	"os"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/asks"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// The conformance fixture, read in-process: an admitted program must be booked as in flight
// before the next one is judged, or every program is told it has the whole pool.
func fixture(t *testing.T) (control.Control, teamclaude.Status, []ledger.Cycle) {
	c, err := control.Read("../../testdata/home/control.json")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile("../../testdata/teamclaude-status.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := teamclaude.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	cycles, err := ledger.ReadCycles("../../testdata/home/cycles.jsonl")
	if err != nil {
		t.Fatal(err)
	}
	return c, s, cycles
}

var noProbes = Probes{
	Asks:   func(control.Program) (*asks.State, error) { return nil, nil },
	Runner: func(control.Program) *bool { return nil },
}

func TestEvaluateAllBooksEachGO(t *testing.T) {
	c, s, cycles := fixture(t)
	pid := 4242
	lockPid := func(name string) *int {
		if name == "gamma" {
			return &pid
		}
		return nil
	}
	got, err := EvaluateAll(c, s, cycles, epoch.MustParse("2026-06-01T00:00:00.000Z"), lockPid, noProbes)
	if err != nil {
		t.Fatal(err)
	}
	want := []struct {
		name, verdict, reasonHas string
		pid                      bool
	}{
		{"alpha", "GO", "(0 running)", false},
		{"gamma", "STOP", "disabled", true},
		{"beta", "GO", "(1 running)", false},
	}
	if len(got) != len(want) {
		t.Fatalf("got %d evaluations, want %d", len(got), len(want))
	}
	for i, w := range want {
		e := got[i]
		if e.Program.Name != w.name || string(e.Decision.Verdict) != w.verdict || !strings.Contains(e.Decision.Reason, w.reasonHas) || (e.Pid != nil) != w.pid {
			t.Errorf("%d: got %s %s %q pid=%v, want %+v", i, e.Program.Name, e.Decision.Verdict, e.Decision.Reason, e.Pid, w)
		}
	}
}

func TestDescribeFunding(t *testing.T) {
	cases := []struct {
		name string
		in   decide.Funding
		want string
	}{
		{"every account carries", decide.Funding{Cycles: 1.5, Binding: "fable", Accounts: []decide.AccountFunding{
			{Name: "a", Cycles: 1, Binding: "fable", Routable: true}, {Name: "b", Cycles: 0.5, Binding: "general", Routable: true},
		}}, "1.50 cycles fundable, fable binding — a 1.00 (fable) · b 0.50 (general)"},
		{"one unroutable", decide.Funding{Cycles: 0.125, Binding: "session", Accounts: []decide.AccountFunding{
			{Name: "a", Cycles: 0.125, Binding: "session", Routable: true}, {Name: "c", Cycles: 0, Binding: "fable", Routable: false},
		}}, "0.13 cycles fundable from 1 of 2 accounts, session binding — a 0.13 (session) · c 0.00 (fable, not routed)"},
	}
	for _, tc := range cases {
		if got := describeFunding(tc.in); got != tc.want {
			t.Errorf("%s:\n got %s\nwant %s", tc.name, got, tc.want)
		}
	}
}

func TestEvaluateAllHoldsAProgramWithALiveRunner(t *testing.T) {
	c, s, cycles := fixture(t)
	present := true
	got, err := EvaluateAll(c, s, cycles, epoch.MustParse("2026-06-01T00:00:00.000Z"), func(string) *int { return nil }, Probes{
		Asks: func(control.Program) (*asks.State, error) { return nil, nil },
		Runner: func(p control.Program) *bool {
			if p.Name == "alpha" {
				return &present
			}
			return nil
		},
	})
	if err != nil || got[0].Program.Name != "alpha" || got[0].Decision.Verdict == "GO" {
		t.Fatalf("%+v %v", got[0], err)
	}
}
