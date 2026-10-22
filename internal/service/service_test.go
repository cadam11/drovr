package service

import (
	"encoding/json"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
)

func TestDescribeFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "describeService") {
		var in struct {
			State      State         `json:"state"`
			LastTickAt *epoch.Millis `json:"lastTickAt"`
			Now        epoch.Millis  `json:"now"`
			LockedBy   *LockHolder   `json:"lockedBy"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, Describe(in.State, in.LastTickAt, in.Now, in.LockedBy), c.Output)
	}
}

func TestHealthFixtures(t *testing.T) {
	for _, c := range fixtures.Load(t, "serviceHealth") {
		var in struct {
			State      State         `json:"state"`
			LastTickAt *epoch.Millis `json:"lastTickAt"`
			Now        epoch.Millis  `json:"now"`
		}
		if err := json.Unmarshal(c.Input, &in); err != nil {
			t.Fatal(err)
		}
		fixtures.Equal(t, c.Name, HealthOf(in.State, in.LastTickAt, in.Now), c.Output)
	}
}

func TestDescribeWedged(t *testing.T) {
	iv := 600
	last := epoch.Millis(0)
	held := int64(25 * 60_000)
	got := Describe(State{Installed: true, Loaded: true, IntervalSeconds: &iv}, &last, 2_000_000, &LockHolder{Pid: 42, HeldMs: &held})
	want := "loaded and fires every 600s. Last tick completed 33 minutes ago — that is overdue for a 600s interval, so the agent may be stalled. A live process still holds the tick lock (pid 42, held 25m), so ticks are being skipped rather than not firing. Fix: kill 42"
	if got != want {
		t.Fatalf("\n got %q\nwant %q", got, want)
	}
}
