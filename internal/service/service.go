// Package service reads the launchd agent that fires the tick and says, in prose a reader
// can act on, whether it is running. Writing and reloading the plist is not here yet.
package service

import (
	"context"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/jsnum"
)

const Label = "tech.propra.drovr"

// launchctlTimeout bounds a local launchd query; the TS execFileSync had no bound, and an
// unbounded child inside the tick holds the lock.
const launchctlTimeout = 10 * time.Second

func home() string {
	dir, _ := os.UserHomeDir()
	return dir
}

func PlistPathFor(label string) string {
	return filepath.Join(home(), "Library", "LaunchAgents", label+".plist")
}

func PlistPath() string { return PlistPathFor(Label) }

type State struct {
	// Installed is the plist existing on disk; Loaded is launchd having it and firing it.
	Installed bool `json:"installed"`
	Loaded    bool `json:"loaded"`
	// Pid is set only while a tick is actually executing; ticks are short, so usually nil.
	Pid             *int `json:"pid"`
	LastExitStatus  *int `json:"lastExitStatus"`
	IntervalSeconds *int `json:"intervalSeconds"`
}

type LockHolder struct {
	Pid    int    `json:"pid"`
	HeldMs *int64 `json:"heldMs"`
}

var startInterval = regexp.MustCompile(`<key>StartInterval</key><integer>(\d+)</integer>`)

func numberFrom(source, key string) *int {
	m := regexp.MustCompile(`"` + key + `"\s*=\s*(-?\d+)`).FindStringSubmatch(source)
	if m == nil {
		return nil
	}
	n, err := strconv.Atoi(m[1])
	if err != nil {
		return nil
	}
	return &n
}

func intervalFromPlist(path string) *int {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	m := startInterval.FindSubmatch(raw)
	if m == nil {
		return nil
	}
	n, err := strconv.Atoi(string(m[1]))
	if err != nil {
		return nil
	}
	return &n
}

// StateFor reads a failed `launchctl list` as "not loaded": a non-zero exit means launchd
// does not know the label, which is an answer, not a failure.
func StateFor(label string) State {
	path := PlistPathFor(label)
	_, statErr := os.Stat(path)
	s := State{Installed: statErr == nil, IntervalSeconds: intervalFromPlist(path)}
	res, err := exec.RunBounded(context.Background(), "launchctl", []string{"list", label},
		exec.Bounds{Timeout: launchctlTimeout, Label: "launchctl list " + label})
	if err != nil {
		return s
	}
	s.Loaded = true
	s.Pid = numberFrom(res.Stdout, "PID")
	s.LastExitStatus = numberFrom(res.Stdout, "LastExitStatus")
	return s
}

func Current() State { return StateFor(Label) }

func BootstrapCommand(label string) string {
	return "launchctl bootstrap gui/$(id -u) " + PlistPathFor(label)
}

func BootoutCommand(label string) string {
	return "launchctl bootout gui/$(id -u)/" + label
}

// Describe names what is wrong and the exact command that fixes it in every branch.
// "Overdue" and "wedged" are different diagnoses with different fixes, which is why the
// live lock holder is passed in: an agent launchd never fired needs a bootstrap, a live
// process holding the lock needs killing.
func Describe(s State, lastTickAt *epoch.Millis, now epoch.Millis, lockedBy *LockHolder) string {
	if !s.Installed {
		return "no launchd agent has been written, so nothing runs on a schedule. Fix: drovr service install"
	}
	if !s.Loaded {
		return "the launchd agent file exists but launchd has not loaded it, so no tick will ever fire. Fix: " + BootstrapCommand(Label)
	}
	every := ""
	if s.IntervalSeconds != nil {
		every = fmt.Sprintf(" and fires every %ds", *s.IntervalSeconds)
	}
	failed := failedSuffix(s.LastExitStatus)
	if lastTickAt == nil {
		return "loaded" + every + ", but no tick has completed yet" + failed
	}
	overdue := isOverdue(s, *lastTickAt, now)
	stalled := ""
	if overdue {
		stalled = fmt.Sprintf(" — that is overdue for a %ds interval, so the agent may be stalled", *s.IntervalSeconds)
	}
	wedged := ""
	// Only when actually late: a lock held during a healthy pass is the normal state.
	if overdue && lockedBy != nil {
		wedged = wedgedSuffix(*lockedBy)
	}
	return "loaded" + every + ". Last tick completed " + ago(now-*lastTickAt) + stalled + wedged + failed
}

// failedSuffix decodes launchd's raw wait() status, where a plain exit 1 shows up as 256.
func failedSuffix(lastExitStatus *int) string {
	if lastExitStatus == nil {
		return ""
	}
	code := *lastExitStatus
	if code >= 256 {
		code >>= 8
	}
	if code == 0 {
		return ""
	}
	return fmt.Sprintf(". Warning: the last tick failed (exit %d) — check %s", code, filepath.Join(home(), ".drovr/logs/tick.err"))
}

func ago(elapsed epoch.Millis) string {
	minutes := int64(jsnum.RoundHalfUp(float64(elapsed) / 60_000))
	if minutes < 60 {
		return fmt.Sprintf("%d minutes ago", minutes)
	}
	return fmt.Sprintf("%dh%dm ago", int64(math.Floor(float64(minutes)/60)), minutes%60)
}

func wedgedSuffix(h LockHolder) string {
	held := ""
	if h.HeldMs != nil {
		held = fmt.Sprintf(", held %dm", int64(jsnum.RoundHalfUp(float64(*h.HeldMs)/60_000)))
	}
	return fmt.Sprintf(". A live process still holds the tick lock (pid %d%s), so ticks are being skipped rather than not firing. Fix: kill %d", h.Pid, held, h.Pid)
}

func isOverdue(s State, lastTickAt, now epoch.Millis) bool {
	return s.IntervalSeconds != nil && now-lastTickAt > epoch.Millis(*s.IntervalSeconds)*3000
}

type Health string

const (
	NotInstalled Health = "not-installed"
	NotLoaded    Health = "not-loaded"
	NoTicksYet   Health = "no-ticks-yet"
	Stalled      Health = "stalled"
	Healthy      Health = "healthy"
)

// HealthOf is Describe's facts as a value, for a caller that branches rather than reads.
func HealthOf(s State, lastTickAt *epoch.Millis, now epoch.Millis) Health {
	switch {
	case !s.Installed:
		return NotInstalled
	case !s.Loaded:
		return NotLoaded
	case lastTickAt == nil:
		return NoTicksYet
	case isOverdue(s, *lastTickAt, now):
		return Stalled
	}
	return Healthy
}
