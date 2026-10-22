package decide

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

type recordedInput struct {
	Status        json.RawMessage `json:"status"`
	Control       json.RawMessage `json:"control"`
	Cycles        []ledger.Cycle  `json:"cycles"`
	Program       string          `json:"program"`
	Now           epoch.Millis    `json:"now"`
	AnsweredAt    *epoch.Millis   `json:"answeredAt"`
	AsksShared    *bool           `json:"asksShared"`
	RunnerPresent *bool           `json:"runnerPresent"`
}

func decodeInput(t *testing.T, raw json.RawMessage) Input {
	var wrap struct {
		Input recordedInput `json:"input"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		t.Fatal(err)
	}
	r := wrap.Input
	s, err := teamclaude.Parse(r.Status)
	if err != nil {
		t.Fatal(err)
	}
	c, err := control.Parse(r.Control)
	if err != nil {
		t.Fatal(err)
	}
	return Input{Status: s, Control: c, Cycles: r.Cycles, Program: r.Program, Now: r.Now, AnsweredAt: r.AnsweredAt, AsksShared: r.AsksShared, RunnerPresent: r.RunnerPresent}
}

func TestDecideFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "decide") {
		got, err := Decide(decodeInput(t, c.Input))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
}

func TestCyclesFundableFromFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "cyclesFundableFrom") {
		var in struct {
			Pool    capacity.Pool `json:"pool"`
			Cost    ledger.Cost   `json:"cost"`
			Running float64       `json:"running"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, CyclesFundableFrom(in.Pool, in.Cost, in.Running), c.Output)
	}
}

func TestPoolContextAndRequiredFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "poolContext") {
		var in struct {
			Funding Funding       `json:"funding"`
			Pool    capacity.Pool `json:"pool"`
			Now     epoch.Millis  `json:"now"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, PoolContext(in.Funding, in.Pool, in.Now), c.Output)
	}
	for _, c := range fixtures.Load(t, "requiredCycles") {
		var in struct {
			Binding capacity.Bucket `json:"binding"`
			Control json.RawMessage `json:"control"`
			Rank    int             `json:"rank"`
		}
		json.Unmarshal(c.Input, &in)
		ctl, err := control.Parse(in.Control)
		if err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, RequiredCycles(in.Binding, ctl, in.Rank), c.Output)
	}
}

func TestEveryAccountPinnedNamesSoonestReset(t *testing.T) {
	soon, late := epoch.Millis(1_000), epoch.Millis(5_000)
	pool := capacity.Pool{
		UsableAccounts: 2,
		PerAccount:     []capacity.AccountHeadroom{{Name: "a", Fable: 0, General: 1, Session: 1, Routable: true}, {Name: "b", Fable: 1, General: 1, Session: 0, Routable: true}},
		ResetAt:        capacity.Resets{Fable: &late, Session: &soon},
	}
	f := CyclesFundableFrom(pool, ledger.Cost{Fable: 0.1, General: 0.1, Session: 0.1}, 3)
	if f.Cycles != 0 || f.Binding != "session" {
		t.Fatalf("%+v", f)
	}
}

func TestCyclesMarshalsInfinity(t *testing.T) {
	b, _ := json.Marshal(Cycles(math.Inf(1)))
	if string(b) != `"Infinity"` {
		t.Fatal(string(b))
	}
}
