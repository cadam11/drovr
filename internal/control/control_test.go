package control

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
)

func TestParseDefaults(t *testing.T) {
	c, err := Parse([]byte(`{"programs":[{"name":"demo","cwd":"/tmp/demo","host":{"environment":"e1","ssh":"u@box","cwd":"/home/u/demo"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if c.Mode != "normal" || c.ReserveCycles != 0.5 || c.MaxCyclesPerDay != 8 || c.TickBudgetMinutes != 8 || c.BlockedAlertMinutes != 20 {
		t.Fatalf("defaults: %+v", c)
	}
	if c.Ceilings["away"] != (Ceiling{0.85, 0.6}) || c.SeedCycleCost != (Cost{0.1, 0.08, 0.25}) {
		t.Fatalf("ceilings/seed: %+v", c)
	}
	p := c.Programs[0]
	if p.CycleCommand != `teamclaude run -- --model {model} -p "/project-loop {program}"` || !p.Enabled || p.Model != "fable" || !p.UseDirenv || p.Runner != "orca" || p.SessionName != "{program} program runner" || p.Priority != 0 || p.PauseUntil != nil || p.Aice != nil || p.AsksFile != nil {
		t.Fatalf("program defaults: %+v", p)
	}
	if p.Host.DrovrHome != "~/.drovr" || p.Host.Claude != "~/.local/bin/claude" || p.Host.Wake != nil {
		t.Fatalf("host defaults: %+v", *p.Host)
	}
}

func TestParseRefusals(t *testing.T) {
	cases := map[string]string{
		`{"mode":"loud"}`:             "mode",
		`{"programs":[{"cwd":"/x"}]}`: "programs[0].name",
		`{"programs":[{"name":"a","cwd":"/x","cadence":"soon"}]}`:                                 "cadence must look like 30m, 12h, or 7d",
		`{"programs":[{"name":"a","cwd":"/x","host":{"environment":"e","ssh":"s","cwd":"rel"}}]}`: "host.cwd must be an absolute path on the box",
		`{"programs":[{"name":"a","cwd":"/x","runner":"docker"}]}`:                                "runner",
		`{"programs":[{"name":"a","cwd":"/x","description":"` + strings.Repeat("x", 501) + `"}]}`: "description",
		`{"reserveCycles":"half"}`:                "reserveCycles",
		`{"programs":[{"name":null,"cwd":"/x"}]}`: "programs[0].name",
	}
	for in, want := range cases {
		_, err := Parse([]byte(in))
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("Parse(%s) err = %v, want it to name %q", in, err, want)
		}
	}
}

func TestParseStripsUnknownAndKeepsNullPause(t *testing.T) {
	c, err := Parse([]byte(`{"legacyKey":1,"programs":[{"name":"a","cwd":"/x","pauseUntil":null,"statusPage":"gone"}]}`))
	if err != nil || c.Programs[0].PauseUntil != nil {
		t.Fatalf("%v %+v", err, c)
	}
}

func TestDurationAndPauses(t *testing.T) {
	for in, want := range map[string]epoch.Millis{"30m": 1_800_000, "12h": 43_200_000, "7d": 604_800_000} {
		got, err := ParseDuration(in)
		if err != nil || got != want {
			t.Errorf("ParseDuration(%q) = %d, %v", in, got, err)
		}
	}
	if _, err := ParseDuration("1w"); err == nil || !strings.Contains(err.Error(), `duration must look like 30m, 3h, or 2d — got "1w"`) {
		t.Errorf("1w: %v", err)
	}
	now := epoch.MustParse("2026-08-22T12:00:00.000Z")
	past := "2026-08-22T11:00:00.000Z"
	future := "2026-08-22T13:00:00.000Z"
	if _, held, _ := ProgramPausedUntil(Program{Name: "a", PauseUntil: &past}, now); held {
		t.Error("lapsed pause held")
	}
	if until, held, _ := ProgramPausedUntil(Program{Name: "a", PauseUntil: &future}, now); !held || until != now+3_600_000 {
		t.Error("future pause not held")
	}
	bad := "yesterday"
	if _, _, err := ProgramPausedUntil(Program{Name: "a", PauseUntil: &bad}, now); err == nil || err.Error() != "a.pauseUntil is not a valid timestamp: yesterday" {
		t.Errorf("bad pause: %v", err)
	}
}

func TestPriorityRankFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "priorityRank") {
		var in struct {
			Control    json.RawMessage          `json:"control"`
			Program    string                   `json:"program"`
			Now        epoch.Millis             `json:"now"`
			LastStarts map[string]*epoch.Millis `json:"lastStarts"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		ctl, err := Parse(in.Control)
		if err != nil {
			t.Fatal(c.Name, err)
		}
		got, err := PriorityRank(ctl, in.Program, in.Now, func(name string) (epoch.Millis, bool) {
			v, ok := in.LastStarts[name]
			if !ok || v == nil {
				return 0, false
			}
			return *v, true
		})
		if err != nil {
			t.Fatal(c.Name, err)
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
}

func TestOrderCeilingsFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "orderCeilings") {
		var in struct {
			Ceilings map[string]Ceiling `json:"ceilings"`
			Edited   string             `json:"edited"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, OrderCeilings(in.Ceilings, in.Edited), c.Output)
	}
}

func TestEffectivePriorityFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "effectivePriority") {
		var in struct {
			Program     json.RawMessage `json:"program"`
			Now         epoch.Millis    `json:"now"`
			HorizonDays float64         `json:"horizonDays"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		p, err := ParseProgram(in.Program)
		if err != nil {
			t.Fatal(err)
		}
		got, err := EffectivePriority(p, in.Now, in.HorizonDays)
		if err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
}
