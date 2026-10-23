package service

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
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

func TestPlistNamesTheBinaryAndItsLogs(t *testing.T) {
	got := Plist(PlistInput{Label: ShadowLabel, Binary: "/opt/homebrew/bin/drovr", Args: []string{"tick", "--shadow"}, LogName: "tick-shadow", IntervalSeconds: 60, LogDir: "/Users/x/.drovr/logs", Path: "/opt/homebrew/bin:/usr/bin"})
	want := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>tech.propra.drovr.shadow</string>
  <key>ProgramArguments</key>
  <array>
    <string>/opt/homebrew/bin/drovr</string>
    <string>tick</string>
    <string>--shadow</string>
  </array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>/Users/x/.drovr/logs/tick-shadow.log</string>
  <key>StandardErrorPath</key><string>/Users/x/.drovr/logs/tick-shadow.err</string>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/bin</string></dict>
</dict>
</plist>
`
	if got != want {
		t.Fatalf("got\n%s", got)
	}
	path := filepath.Join(t.TempDir(), "x.plist")
	if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
		t.Fatal(err)
	}
	if bin, ok := PlistBinary(path); !ok || bin != "/opt/homebrew/bin/drovr" {
		t.Fatalf("%s %v", bin, ok)
	}
	if _, differs := BinaryMismatch(path, "/opt/homebrew/bin/drovr"); differs {
		t.Fatal("same binary reported as moved")
	}
	if note, differs := BinaryMismatch(path, "/usr/local/bin/drovr"); !differs || note != "note: the launchd agent runs /opt/homebrew/bin/drovr but this is /usr/local/bin/drovr — re-run: drovr service install" {
		t.Fatalf("%q", note)
	}
	if _, differs := BinaryMismatch(filepath.Join(t.TempDir(), "absent.plist"), "/usr/local/bin/drovr"); differs {
		t.Fatal("no plist is not a moved binary")
	}
}

func TestAgentPathKeepsTheShellsOrderThenTheStandardDirs(t *testing.T) {
	if got := AgentPath("/Users/x/Library/pnpm:/usr/bin::/opt/homebrew/bin"); got != "/Users/x/Library/pnpm:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/bin" {
		t.Fatal(got)
	}
}

func shimLaunchctl(t *testing.T) string {
	dir := t.TempDir()
	bin, err := filepath.Abs("testdata")
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	t.Setenv("LAUNCHCTL_DIR", dir)
	t.Setenv("HOME", t.TempDir())
	return dir
}

func TestInstallReloadsALoadedAgent(t *testing.T) {
	dir := shimLaunchctl(t)
	in := PlistInput{Label: Label, Binary: "/b/drovr", Args: []string{"tick"}, LogName: "tick", IntervalSeconds: 600, LogDir: "/l", Path: "/usr/bin"}
	if got, err := InstallAgent(context.Background(), in); err != nil || got != "loaded" {
		t.Fatalf("%s %v", got, err)
	}
	if got, _ := InstallAgent(context.Background(), in); got != "reloaded" {
		t.Fatalf("a rewrite over a loaded agent must boot it out and back in: %s", got)
	}
	log, _ := os.ReadFile(filepath.Join(dir, "calls.log"))
	if !strings.Contains(string(log), fmt.Sprintf("bootout gui/%d/tech.propra.drovr", os.Getuid())) {
		t.Fatalf("%s", log)
	}
	if err := os.WriteFile(filepath.Join(dir, "refuse"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if got, _ := InstallAgent(context.Background(), in); got != "failed" {
		t.Fatalf("%s", got)
	}
}
