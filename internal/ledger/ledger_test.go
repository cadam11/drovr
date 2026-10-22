package ledger

import (
	"encoding/json"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
)

func TestReadCyclesRefusesByLine(t *testing.T) {
	path := filepath.Join(t.TempDir(), "cycles.jsonl")
	os.WriteFile(path, []byte(`{"v":1,"kind":"delivery","program":"a","startedAt":"2026-08-22T10:00:00.000Z","endedAt":null,"exit":"running","poolBefore":{"fable":1,"general":1,"session":1},"poolAfter":null,"startupTokens":null,"yield":null}
{"v":1,"kind":"delivery","program":"a","startedAt":"x","endedAt":null,"exit":"vanished","poolBefore":{"fable":1,"general":1,"session":1},"poolAfter":null,"startupTokens":null,"yield":null}
`), 0o644)
	_, err := ReadCycles(path)
	if err == nil || !strings.HasPrefix(err.Error(), path+":2 is not a valid cycle record: ") || !strings.Contains(err.Error(), "exit") {
		t.Fatalf("%v", err)
	}
	if cycles, err := ReadCycles(filepath.Join(t.TempDir(), "missing")); err != nil || cycles != nil {
		t.Fatalf("missing file: %v %v", cycles, err)
	}
}

func TestStartRecordDefaults(t *testing.T) {
	c, err := ParseCycle([]byte(`{"v":1,"kind":"delivery","program":"a","startedAt":"2026-08-22T10:00:00.000Z","endedAt":null,"exit":"running","poolBefore":{"fable":1,"general":1,"session":1},"poolAfter":null,"startupTokens":null,"yield":null}`))
	if err != nil || c.AsksRaised != 0 || c.PauseUntil != nil || c.SessionID != nil || c.Closing != nil || c.PoolAfter != nil {
		t.Fatalf("%+v %v", c, err)
	}
	if _, err := ParseCycle([]byte(`{"v":2}`)); err == nil || !strings.Contains(err.Error(), "v") {
		t.Fatalf("v:2 accepted: %v", err)
	}
}

func TestPercentileNearestRank(t *testing.T) {
	if got := Percentile([]float64{0.3, 0.1, 0.2}, 0.9); got != 0.3 {
		t.Fatal(got)
	}
	if got := Percentile([]float64{0.3, 0.1, 0.2}, 0.5); got != 0.2 {
		t.Fatal(got)
	}
	if got := Percentile([]float64{5}, 0.9); got != 5 {
		t.Fatal(got)
	}
}

func decodeCycles(t *testing.T, raw json.RawMessage) []Cycle {
	var out []Cycle
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestEstimateCycleCostFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "estimateCycleCost") {
		var in struct {
			Cycles     json.RawMessage `json:"cycles"`
			Seed       Cost            `json:"seed"`
			MinSamples int             `json:"minSamples"`
			Fraction   float64         `json:"fraction"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, EstimateCycleCost(decodeCycles(t, in.Cycles), in.Seed, in.MinSamples, in.Fraction), c.Output)
	}
}

func TestChargeForRunningFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "chargeForRunning") {
		var in struct {
			Running json.RawMessage `json:"running"`
			PoolNow Cost            `json:"poolNow"`
			Cost    Cost            `json:"cost"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, ChargeForRunning(decodeCycles(t, in.Running), in.PoolNow, in.Cost), c.Output)
	}
}

func TestSpentSinceFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "spentSince") {
		var in struct {
			Cycles      json.RawMessage `json:"cycles"`
			WindowStart float64         `json:"windowStart"`
			Until       json.RawMessage `json:"until"`
		}
		json.Unmarshal(c.Input, &in)
		until := epoch.Millis(math.MaxInt64)
		if f := fixtures.Float(in.Until); !math.IsInf(f, 1) {
			until = epoch.Millis(f)
		}
		fixtures.Equal(t, c.Name, SpentSince(decodeCycles(t, in.Cycles), in.WindowStart, until), c.Output)
	}
}

func TestCountsFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "inFlight") {
		var in struct {
			Cycles   json.RawMessage `json:"cycles"`
			Now      epoch.Millis    `json:"now"`
			MaxHours float64         `json:"maxHours"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, InFlight(decodeCycles(t, in.Cycles), in.Now, in.MaxHours), c.Output)
	}
	for _, c := range fixtures.Load(t, "cyclesStartedSince") {
		var in struct {
			Cycles json.RawMessage `json:"cycles"`
			Since  epoch.Millis    `json:"since"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, CyclesStartedSince(decodeCycles(t, in.Cycles), in.Since), c.Output)
	}
	for _, c := range fixtures.Load(t, "consecutiveFailures") {
		var in struct {
			Cycles        json.RawMessage `json:"cycles"`
			Now           epoch.Millis    `json:"now"`
			WindowMinutes float64         `json:"windowMinutes"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, ConsecutiveFailures(decodeCycles(t, in.Cycles), in.Now, in.WindowMinutes), c.Output)
	}
	for _, c := range fixtures.Load(t, "consecutiveZeroYield") {
		var in struct {
			Cycles json.RawMessage `json:"cycles"`
		}
		json.Unmarshal(c.Input, &in)
		fixtures.Equal(t, c.Name, ConsecutiveZeroYield(decodeCycles(t, in.Cycles)), c.Output)
	}
	for _, c := range fixtures.Load(t, "unansweredAsks") {
		var in struct {
			Cycles json.RawMessage `json:"cycles"`
		}
		json.Unmarshal(c.Input, &in)
		owed, ok := UnansweredAsks(decodeCycles(t, in.Cycles))
		if !ok {
			fixtures.Equal(t, c.Name, nil, c.Output)
			continue
		}
		fixtures.Equal(t, c.Name, owed, c.Output)
	}
}

func TestTickStamp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "last-tick.json")
	if err := StampTick(path, 1787400000000); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if string(b) != "{\"at\":\"2026-08-22T12:00:00.000Z\"}\n" {
		t.Fatalf("%q", b)
	}
	if at, ok := ReadTickStamp(path); !ok || at != 1787400000000 {
		t.Fatal(at, ok)
	}
	os.WriteFile(path, []byte(`{"at":"never"}`), 0o644)
	if _, ok := ReadTickStamp(path); ok {
		t.Fatal("garbage stamp read as a time")
	}
}
