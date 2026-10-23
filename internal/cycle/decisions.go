package cycle

import (
	"crypto/rand"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
)

type Stall string // "wait" | "nudge" | "give-up" | "alert"

type StallInput struct {
	State      orca.AgentState
	HasReport  bool
	IdleFor    time.Duration
	NudgesSent int
	NudgeAfter time.Duration
	MaxNudges  int
	BlockedFor time.Duration
	// BlockedAlertAfter is how long a runner may sit on a dialog before Craig is asked to clear it.
	BlockedAlertAfter time.Duration
	// Alerted is whether this cycle has already asked for a human, so it asks exactly once.
	Alerted bool
}

// StallAction: an idle runner that has written no report will never move again on its own —
// an interactive session finishes its turn and sits at the prompt forever. Nudging it is far
// cheaper than a fresh cycle, which pays full onboarding for context this one already has,
// but it is bounded, or a wedged runner is nudged every ten minutes until maxHours.
//
// `blocked` is never nudged — it waits on a dialog only Craig can answer, and a prompt queues
// behind it — and never silent: measured 2026-08-27, sunnyt sat at a bash-permission prompt
// for most of a 12.8h run while drovr told nobody. Alert rather than give up, once per cycle:
// a blocked runner's work is intact, merely paused.
func StallAction(in StallInput) Stall {
	// Once the report exists the cycle has declared itself done, and idling at the prompt is
	// exactly what it should be doing — that is the release path, not a stall.
	if in.HasReport {
		return "wait"
	}
	if in.State == orca.Blocked {
		if !in.Alerted && in.BlockedFor >= in.BlockedAlertAfter {
			return "alert"
		}
		return "wait"
	}
	if in.State != orca.Idle || in.IdleFor < in.NudgeAfter {
		return "wait"
	}
	if in.NudgesSent < in.MaxNudges {
		return "nudge"
	}
	return "give-up"
}

// LaunchArgv is the full launch argv for the cycle terminal. --model per session, so the
// runner is always Fable without touching Craig's default; --name makes it obvious in the
// prompt box and /resume which program a session belongs to; --session-id is what lets the
// ledger find this cycle's transcript afterwards.
//
// On the Mac the proxy comes from `teamclaude run`, as Craig's own alias does. A host has no
// teamclaude server — its pool is Mac-local — and the box's `claude` alias routes through
// one anyway, so there the launch names the configured binary and runs direnv against the
// box's checkout.
func LaunchArgv(program control.Program, sessionName, sessionID string) []string {
	claude := []string{"--model", program.Model, "--name", sessionName, "--session-id", sessionID}
	argv := append([]string{"teamclaude", "run", "--"}, claude...)
	cwd := program.Cwd
	if program.Host != nil {
		argv = append([]string{program.Host.Claude}, claude...)
		cwd = program.Host.Cwd
	}
	if !program.UseDirenv {
		return argv
	}
	return append([]string{"direnv", "exec", cwd}, argv...)
}

// WakeDecision: a stopped box is the normal state between cycles, not a fault.
func WakeDecision(reachable bool, wake *string) string {
	if reachable {
		return "proceed"
	}
	if wake == nil {
		return "fail"
	}
	return "run-wake"
}

var tailscaleLink = regexp.MustCompile(`https://login\.tailscale\.com/a/\S+`)

// TailscaleCheckLink: Tailscale SSH in check mode holds every connection until a human visits
// a link, so the box is up and no wake can help; the link is the only useful thing to say.
func TailscaleCheckLink(reason *string) *string {
	if reason == nil {
		return nil
	}
	link := tailscaleLink.FindString(*reason)
	if link == "" {
		return nil
	}
	return &link
}

func Substitute(command string, program control.Program, onboarding bool) string {
	mode := "deliver"
	if onboarding {
		mode = "onboard"
	}
	return strings.NewReplacer("{program}", program.Name, "{model}", program.Model, "{mode}", mode).Replace(command)
}

// IsOnboarding: a program with no state file has never finished onboarding.
func IsOnboarding(p paths.Paths, program string) bool {
	_, err := os.Stat(p.StateFile(program))
	return err != nil
}

// NewSessionID is RFC 4122 v4 from crypto/rand, lowercase: what randomUUID() returns.
func NewSessionID() (string, error) {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return "", err
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16]), nil
}

// UnreportedExit names a cycle that ended without a report: deferred before it started,
// stalled through its nudges, abandoned by its watch, or else crashed.
func UnreportedExit(deferred, stalled, abandoned bool) string {
	switch {
	case deferred:
		return "deferred"
	case stalled:
		return "stalled"
	case abandoned:
		return "abandoned"
	}
	return "crash"
}
