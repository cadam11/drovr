package cli

import (
	"os"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// The conformance fixture, read in-process: an admitted program must be booked as in flight
// before the next one is judged, or every program is told it has the whole pool.
func TestEvaluateAllBooksEachGO(t *testing.T) {
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
	pid := 4242
	lockPid := func(name string) *int {
		if name == "gamma" {
			return &pid
		}
		return nil
	}
	got, err := EvaluateAll(c, s, cycles, epoch.MustParse("2026-06-01T00:00:00.000Z"), lockPid)
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

// Until plan E2 the Go status skips inputs the tick reads; it has to say so, or it prints
// GO for a program the tick holds.
func TestStatusCaveatNamesWhatItCannotRead(t *testing.T) {
	c, err := control.Read("../../testdata/home/control.json")
	if err != nil {
		t.Fatal(err)
	}
	fixture := unreadCaveat(c)
	if !strings.Contains(fixture, "orca runner state") || strings.Contains(fixture, "Away") || strings.Contains(fixture, "asks") {
		t.Fatalf("fixture caveat: %q", fixture)
	}
	to := "craig"
	c.NotifyTo = &to
	if got := unreadCaveat(c); !strings.HasPrefix(got, "note: this Go build does not yet read the phone's Away mode or orca runner state; ") || !strings.HasSuffix(got, "(see plan E2)\n") {
		t.Fatalf("notifyTo caveat: %q", got)
	}
	c.NotifyTo = nil
	for i := range c.Programs {
		c.Programs[i].Runner = "headless"
	}
	if got := unreadCaveat(c); got != "" {
		t.Fatalf("headless, no notifyTo: %q", got)
	}
	page := "craig/asks.html"
	c.Programs[0].Aice = &control.Aice{AsksPage: &page}
	if got := unreadCaveat(c); !strings.Contains(got, "read asks pages;") {
		t.Fatalf("asks caveat: %q", got)
	}
}
