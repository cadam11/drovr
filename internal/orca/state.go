package orca

import "encoding/json"

// AgentState is what a live claude in a terminal is doing; Gone is drovr's own: no claude
// there at all.
type AgentState string

const (
	Idle    AgentState = "idle"
	Working AgentState = "working"
	Blocked AgentState = "blocked"
	Gone    AgentState = "gone"
)

type occupancy string

const (
	vacant   occupancy = "gone"
	held     occupancy = "blocked"
	occupied occupancy = "occupied"
)

// occupancyFrom is what `terminal show` alone can decide.
func occupancyFrom(show json.RawMessage) (occupancy, error) {
	t, err := readShown(show)
	if err != nil {
		return "", err
	}
	if t == nil || t.AgentIdentity == nil {
		return vacant, nil
	}
	if t.Blocked {
		return held, nil
	}
	return occupied, nil
}

// liveExitProbe is what a live pty answers to an exit probe: the default when a caller
// has not asked.
var liveExitProbe = json.RawMessage(`{"ok":false,"error":{"code":"timeout"}}`)

// TerminalExited reads `wait --for exit`, satisfied the instant the pty has ended. It is
// asked because `show` keeps naming the claude that was there after its shell has exited
// (measured 2026-09-15), and a tui-idle probe on a dead pty times out — which read as
// working, so the runner was never released and its program was refused every tick.
func TerminalExited(wait json.RawMessage) (bool, error) { return waitSatisfied(wait) }

// AgentStateFrom takes the `terminal show`, `wait --for tui-idle` and `wait --for exit`
// envelopes; exit nil is a live pty, and it is consulted only when show says occupied.
func AgentStateFrom(show, idle, exit json.RawMessage) (AgentState, error) {
	occ, err := occupancyFrom(show)
	if err != nil || occ != occupied {
		return AgentState(occ), err
	}
	if exit == nil {
		exit = liveExitProbe
	}
	if gone, err := TerminalExited(exit); err != nil || gone {
		return goneOr(err)
	}
	settled, err := waitSatisfied(idle)
	if err != nil {
		return "", err
	}
	if settled {
		return Idle, nil
	}
	return Working, nil
}

// goneOr: a refusal on the exit probe that is not a timeout is orca failing, not the pty
// ending, so it carries no state a careless caller could act on.
func goneOr(err error) (AgentState, error) {
	if err != nil {
		return "", err
	}
	return Gone, nil
}

// PresentFrom is AgentStateFrom without the idle probe, which bills its full ceiling on a
// working claude for a distinction neither presence caller reads. Blocked is present: a
// runner waiting on Craig is a held pane, not an empty one.
func PresentFrom(show, exit json.RawMessage) (bool, error) {
	occ, err := occupancyFrom(show)
	if err != nil || occ != occupied {
		return occ == held, err
	}
	if exit == nil {
		exit = liveExitProbe
	}
	gone, err := TerminalExited(exit)
	return !gone && err == nil, err
}

// IsSettled: only a settled session can act on `/exit`. Typed into a running turn it is
// swallowed by that turn, and typed at a dialog it is not read at all.
func IsSettled(s AgentState) bool { return s == Idle || s == Gone }

type Leftover string

const (
	LeftoverClose Leftover = "close"
	LeftoverExit  Leftover = "exit"
	LeftoverHold  Leftover = "hold"
)

// LeftoverAction is what the tick may do with a runner its cycle left behind. Idle is not
// done (measured 2026-10-05: a relliq runner idle mid-cycle over a background e2e run), so
// an idle one exits only once its cycle reported — and only once, because a runner with
// background work answers `/exit` with a "stop tasks?" dialog a second `/exit` would land in.
func LeftoverAction(state AgentState, reported, exitSent bool) Leftover {
	if state == Gone {
		return LeftoverClose
	}
	if state == Idle && reported && !exitSent {
		return LeftoverExit
	}
	return LeftoverHold
}
