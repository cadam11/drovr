package keys

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
)

const now = epoch.Millis(1787400000000)

func scratch(t *testing.T, body string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "control.json")
	if body == "" {
		body = `{"mode":"normal","pauseUntil":null,"programs":[{"name":"sunnyt","cwd":"/s","priority":0},{"name":"joinery","cwd":"/j","priority":2}]}`
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func read(t *testing.T, path string) control.Control {
	t.Helper()
	c, err := control.Read(path)
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestMutateKeepsKeyOrderAndNodeFormatting(t *testing.T) {
	path := scratch(t, `{"programs":[{"cwd":"/s","name":"sunnyt","maxCyclesPerDay":null,"x":1.50}],"mode":"normal","reserveCycles":0.5,"notifyTo":"craig","note":"café <ok> é"}`)
	if _, err := SetMode(path, "away"); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	want := "{\n  \"programs\": [\n    {\n      \"cwd\": \"/s\",\n      \"name\": \"sunnyt\",\n      \"maxCyclesPerDay\": null,\n      \"x\": 1.5\n    }\n  ],\n  \"mode\": \"away\",\n  \"reserveCycles\": 0.5,\n  \"notifyTo\": \"craig\",\n  \"note\": \"café <ok> é\"\n}\n"
	if string(got) != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func TestModeCyclesAndWraps(t *testing.T) {
	path := scratch(t, "")
	for _, want := range []control.Mode{"away", "off", "low", "normal"} {
		if _, err := CycleMode(path, read(t, path).Mode); err != nil {
			t.Fatal(err)
		}
		if read(t, path).Mode != want {
			t.Fatalf("want %s got %s", want, read(t, path).Mode)
		}
	}
}

func TestPauseTogglesRatherThanStacks(t *testing.T) {
	path := scratch(t, "")
	a, _ := CyclePause(path, nil, now)
	if a.Message != "paused 1h" || *read(t, path).PauseUntil != epoch.ISO(now+3_600_000) {
		t.Fatalf("%+v", a)
	}
	a, _ = CyclePause(path, read(t, path).PauseUntil, now)
	if a.Message != "pause cleared" || read(t, path).PauseUntil != nil {
		t.Fatalf("%+v", a)
	}
	past := epoch.ISO(now - 1)
	if a, _ = CyclePause(path, &past, now); a.Message != "paused 1h" {
		t.Fatal("an expired pause starts a fresh one")
	}
	if a, _ = PauseForHours(path, 5, now); a.Message != "paused 5h" {
		t.Fatalf("%+v", a)
	}
	for _, h := range []float64{0.5, 73} {
		if _, err := PauseForHours(path, h, now); err == nil {
			t.Errorf("%vh accepted", h)
		}
	}
}

func TestProgramEditsAreClampedAndRefusedCleanly(t *testing.T) {
	path := scratch(t, "")
	ToggleEnabled(path, "sunnyt")
	if read(t, path).Programs[0].Enabled {
		t.Fatal("toggle")
	}
	SetEnabled(path, "sunnyt", true)
	SetEnabled(path, "sunnyt", true)
	if !read(t, path).Programs[0].Enabled {
		t.Fatal("setEnabled is a set, not a flip")
	}
	NudgePriority(path, "sunnyt", 30)
	AdjustConcurrency(path, -7)
	if read(t, path).Programs[0].Priority != 9 || read(t, path).MaxConcurrentCycles != 1 {
		t.Fatal("clamps")
	}
	before, _ := os.ReadFile(path)
	if _, err := SetEnabled(path, "nope", false); err == nil || !strings.Contains(err.Error(), `no program named "nope"`) {
		t.Fatalf("%v", err)
	}
	if _, err := SetMode(path, "loud"); err == nil || !strings.Contains(err.Error(), `unknown mode "loud"`) {
		t.Fatalf("%v", err)
	}
	after, _ := os.ReadFile(path)
	strays, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp"))
	if string(before) != string(after) || len(strays) != 0 {
		t.Fatal("a refused write changed the file or left a staging file")
	}
}

func TestSetReserveKeepsCeilingsOrdered(t *testing.T) {
	path := scratch(t, "")
	a, err := SetReserve(path, "normal", 0.45)
	if err != nil || a.Message != "normal: 45% held for you — programs up to 55% weekly, 40% per 5h" {
		t.Fatalf("%+v %v", a, err)
	}
	SetReserve(path, "low", 0.05)
	c := read(t, path)
	low, normal, away := c.Ceilings["low"], c.Ceilings["normal"], c.Ceilings["away"]
	if low.Weekly != 0.95 || !(low.Session <= normal.Session && normal.Session <= away.Session && low.Weekly <= normal.Weekly && normal.Weekly <= away.Weekly) {
		t.Fatalf("%+v %+v %+v", low, normal, away)
	}
	if _, err := SetReserve(path, "normal", 2); err != nil || read(t, path).Ceilings["normal"].Weekly != 0.050000000000000044 {
		t.Fatal("reserve is clamped to 0.95, so weekly is 1 - 0.95 as JS computes it")
	}
	off := scratch(t, `{"mode":"off","programs":[]}`)
	if _, err := NudgeReserve(off, 0.1); err == nil || !strings.Contains(err.Error(), "mode is off") {
		t.Fatalf("%v", err)
	}
}

func TestFailedRenameCleansUp(t *testing.T) {
	if _, err := exec.LookPath("chflags"); err != nil {
		t.Skip("chflags is macOS-only")
	}
	path := scratch(t, "")
	before, _ := os.ReadFile(path)
	if err := exec.Command("chflags", "uchg", path).Run(); err != nil {
		t.Fatal(err)
	}
	defer exec.Command("chflags", "nouchg", path).Run()
	if _, err := SetMode(path, "away"); err == nil {
		t.Fatal("the rename onto an immutable file must fail")
	}
	strays, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp"))
	after, _ := os.ReadFile(path)
	if len(strays) != 0 || string(after) != string(before) {
		t.Fatal("staging file survived or control.json was damaged")
	}
}

func TestExtendPauseStepsPastWhatIsLeft(t *testing.T) {
	path := scratch(t, "")
	cases := []struct {
		current *string
		want    string
	}{{nil, "paused 1h"}, {ptr(epoch.ISO(now + 3_600_000)), "paused 3h"}, {ptr(epoch.ISO(now + 86_400_000)), "paused 24h"}, {ptr("garbage"), "paused 24h"}}
	for _, c := range cases {
		if a, err := ExtendPause(path, c.current, now); err != nil || a.Message != c.want {
			t.Errorf("%v: %+v %v", c.current, a, err)
		}
	}
}

func ptr(s string) *string { return &s }

func TestMutateInPlaceWritesWithoutStaging(t *testing.T) {
	path := scratch(t, "")
	c, err := MutateInPlace(path, func(d *Doc) error { d.Set("mode", "low"); return nil })
	strays, _ := filepath.Glob(filepath.Join(filepath.Dir(path), "*.tmp"))
	if err != nil || c.Mode != "low" || read(t, path).Mode != "low" || len(strays) != 0 {
		t.Fatalf("%v %v", err, strays)
	}
}
