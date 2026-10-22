package capacity

import (
	"encoding/json"
	"math"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/teamclaude"
)

func TestPoolFromFixtures(t *testing.T) {
	cases := fixtures.Load(t, "poolFrom")
	if len(cases) == 0 {
		t.Fatal("no poolFrom fixtures")
	}
	for _, c := range cases {
		var in struct {
			Status   json.RawMessage `json:"status"`
			Ceilings Ceilings        `json:"ceilings"`
			Now      epoch.Millis    `json:"now"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		s, err := teamclaude.Parse(in.Status)
		if err != nil {
			t.Fatal(c.Name, err)
		}
		fixtures.Equal(t, c.Name, PoolFrom(s, in.Ceilings, in.Now), c.Output)
	}
}

func TestHeadroomClampsPerAccount(t *testing.T) {
	blown, fine := 1.5, 0.1
	s := teamclaude.Status{Accounts: []teamclaude.Account{
		{Name: "a", Quota: teamclaude.Quota{Unified7dFable: &blown, Unified7d: &blown}},
		{Name: "b", Quota: teamclaude.Quota{Unified7dFable: &fine, Unified7d: &fine}},
	}}
	p := PoolFrom(s, Ceilings{Weekly: 0.55, Session: 0.4}, 0)
	if p.PerAccount[0].Fable != 0 || p.Fable != p.PerAccount[1].Fable || p.UsableAccounts != 2 {
		t.Fatalf("%+v", p)
	}
	if want := math.Max(0, 0.4-0) + math.Max(0, 0.4-0); p.Session != want { // null session buckets read as 0 used
		t.Fatalf("session %v want %v", p.Session, want)
	}
}

func TestSnapshotAndOf(t *testing.T) {
	p := Pool{Fable: 1, General: 2, Session: 3}
	if s := p.Snapshot(); s.Fable != 1 || s.General != 2 || s.Session != 3 {
		t.Fatalf("%+v", s)
	}
	for b, want := range map[Bucket]float64{"fable": 1, "general": 2, "session": 3} {
		if p.Of(b) != want {
			t.Fatalf("%s", b)
		}
	}
}
