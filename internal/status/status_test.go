package status

import (
	"encoding/json"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/service"
	"github.com/cadam11/drovr/internal/teamclaude"
)

func TestAccountsFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "accountsFromTeamclaude") {
		var in struct {
			Status json.RawMessage `json:"status"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		s, err := teamclaude.Parse(in.Status)
		if err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, AccountsFrom(s), c.Output)
	}
}

type recordedInput struct {
	Control     json.RawMessage `json:"control"`
	StoredMode  control.Mode    `json:"storedMode"`
	Status      json.RawMessage `json:"status"`
	Cycles      []ledger.Cycle  `json:"cycles"`
	Now         epoch.Millis    `json:"now"`
	Service     ServiceInput    `json:"service"`
	Evaluations []struct {
		Program  json.RawMessage `json:"program"`
		Decision decide.Decision `json:"decision"`
		Pid      *int            `json:"pid"`
	} `json:"evaluations"`
}

func decodeInput(t *testing.T, raw json.RawMessage) Input {
	var wrap struct {
		Input recordedInput `json:"input"`
	}
	if err := json.Unmarshal(raw, &wrap); err != nil {
		t.Fatal(err)
	}
	r := wrap.Input
	c, err := control.Parse(r.Control)
	if err != nil {
		t.Fatal(err)
	}
	s, err := teamclaude.Parse(r.Status)
	if err != nil {
		t.Fatal(err)
	}
	in := Input{Control: c, StoredMode: r.StoredMode, Status: s, Cycles: r.Cycles, Now: r.Now, Service: r.Service}
	for _, e := range r.Evaluations {
		p, err := control.ParseProgram(e.Program)
		if err != nil {
			t.Fatal(err)
		}
		in.Evaluations = append(in.Evaluations, Evaluation{Program: p, Decision: e.Decision, Pid: e.Pid})
	}
	return in
}

func TestBuildFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "buildStatusPayload") {
		got, err := Build(decodeInput(t, c.Input))
		if err != nil {
			t.Fatalf("%s: %v", c.Name, err)
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
}

func TestBuildModeOff(t *testing.T) {
	c, err := control.Parse([]byte(`{"mode":"off"}`))
	if err != nil {
		t.Fatal(err)
	}
	p, err := Build(Input{Control: c, StoredMode: "off", Now: 1_787_400_000_000, Service: ServiceInput{State: service.State{}}})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var got map[string]json.RawMessage
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"pool", "capacity", "capacityNote", "allocation"} {
		if string(got[key]) != "null" {
			t.Errorf("%s = %s, want null", key, got[key])
		}
	}
	if p.ModeMeaning != "no cycles will start" {
		t.Errorf("modeMeaning %q", p.ModeMeaning)
	}
}
