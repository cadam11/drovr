package teamclaude

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/fixtures"
)

const minimal = `{"currentAccount":"a","accounts":[{"name":"a","disabled":false,"quota":{"unified5h":null,"unified5hReset":null,"unified7d":0.1,"unified7dReset":1787400000000,"unified7dFable":0.1,"unified7dFableReset":"1787400000000"},"rateLimitedUntil":%s,"pausedUntil":null}]}`

func TestEpochCoercion(t *testing.T) {
	cases := map[string]*int64{
		`null`: nil, `1787400000000`: ptr(1787400000000), `"1787400000000"`: ptr(1787400000000),
		`"2026-08-22T12:00:00.000Z"`: ptr(1787400000000), `"soon"`: nil, `"  1787400000000 "`: ptr(1787400000000),
	}
	for in, want := range cases {
		s, err := Parse([]byte(strings.Replace(minimal, "%s", in, 1)))
		if err != nil {
			t.Fatalf("%s: %v", in, err)
		}
		got := s.Accounts[0].RateLimitedUntil
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Errorf("rateLimitedUntil %s → %v want %v", in, got, want)
		}
		if r := s.Accounts[0].Quota.Unified7dFableReset; r == nil || *r != 1787400000000 {
			t.Errorf("string reset not coerced: %v", r)
		}
	}
}

func TestDefaultsAndRefusals(t *testing.T) {
	s, err := Parse([]byte(strings.Replace(minimal, "%s", "null", 1)))
	if err != nil {
		t.Fatal(err)
	}
	a := s.Accounts[0]
	if a.Type != "oauth" || a.OrgName != nil || a.Status != nil || a.Sessions != 0 || a.Usage.LastUsed != nil || a.SwitchThreshold != nil || len(s.Routes) != 0 || s.SwitchThreshold != nil || s.SwitchThresholds != nil {
		t.Fatalf("%+v", s)
	}
	for in, path := range map[string]string{
		`{"currentAccount":null,"accounts":[{"name":"a","quota":{}}]}`:                "accounts[0].disabled",
		`{"currentAccount":null}`:                                                     "accounts",
		`{"currentAccount":null,"accounts":[],"switchThresholds":{"unified5h":null}}`: "switchThresholds.unified5h: expected number",
		`{"currentAccount":null,"accounts":[{"name":"a","disabled":false,"quota":{"unified5h":"lots","unified5hReset":null,"unified7d":null,"unified7dReset":null,"unified7dFable":null,"unified7dFableReset":null},"rateLimitedUntil":null,"pausedUntil":null}]}`: "accounts[0].quota.unified5h",
	} {
		if _, err := Parse([]byte(in)); err == nil || !strings.Contains(err.Error(), path) || !strings.HasPrefix(err.Error(), "teamclaude status did not match expected shape: ") {
			t.Errorf("%s: %v", in, err)
		}
	}
}

func TestFableEligibleAndThresholds(t *testing.T) {
	for _, c := range fixtures.Load(t, "accountsFromTeamclaude") {
		var in struct {
			Status json.RawMessage `json:"status"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		if _, err := Parse(in.Status); err != nil {
			t.Errorf("%s: recorded status does not round-trip: %v", c.Name, err)
		}
	}
	s, _ := Parse([]byte(`{"currentAccount":null,"accounts":[],"routes":[{"name":"fable","accounts":[{"name":"a","eligible":true},{"name":"b","eligible":false}]}],"switchThreshold":0.9,"switchThresholds":{"unified5h":0.8}}`))
	eligible, declared := FableEligible(s)
	if !declared || !eligible["a"] || eligible["b"] {
		t.Fatalf("%v %v", eligible, declared)
	}
	th := SwitchThresholds(s, Account{})
	if th.Session == nil || *th.Session != 0.8 || th.General == nil || *th.General != 0.9 {
		t.Fatalf("%+v", th)
	}
	own := 0.5
	th = SwitchThresholds(s, Account{SwitchThreshold: &own})
	if *th.Session != 0.5 || *th.Fable != 0.5 {
		t.Fatalf("%+v", th)
	}
	if _, declared := FableEligible(Status{Routes: []Route{{Name: "fable"}}}); declared {
		t.Fatal("an empty fable route is 'no restriction known'")
	}
}

func ptr(v int64) *int64 { return &v }
