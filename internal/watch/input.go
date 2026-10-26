package watch

import (
	"fmt"
	"strconv"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/state"
)

// MouseEvent is one SGR report; X is the 1-based column and Y the 1-based row.
type MouseEvent struct {
	Button, X, Y int
	Press        bool
}

type IntentKind int

const (
	IntentNone IntentKind = iota
	IntentQuit
	IntentHelp
	IntentMove
	IntentRefresh
	IntentSetMode
	IntentTogglePause
	IntentExtendPause
	IntentToggleEnabled
	IntentNudgePriority
	IntentAdjustConcurrency
	IntentNudgeReserve
	IntentArmStop
	IntentArmStart
	IntentCancel
	IntentTickNow
	IntentStartCycle
	IntentInterrupt
	IntentReleaseLeftover
	IntentOpenAsks
)

// Intent is what the runner has to do after a key or click. Where the TS sets its message
// only after I/O, the view comes back with the message untouched and the runner sets it;
// Redraw then means nothing here and the runner decides it from that outcome too.
type Intent struct {
	Kind    IntentKind
	Program string
	Delta   int
	Fresh   bool
	URL     string
	Redraw  bool
}

// ParseChunk honours at most MouseEventsPerChunk reports so a wheel flick cannot queue a
// burst of redraws, yet strips every report so none leaks into the key that remains.
func ParseChunk(chunk string) ([]MouseEvent, string) {
	var presses []MouseEvent
	for _, m := range MouseEvents.FindAllStringSubmatch(chunk, MouseEventsPerChunk) {
		if m[4] != "M" {
			continue // a release of a click already handled
		}
		ev, ok := mouseEvent(m[1], m[2], m[3])
		if ok {
			presses = append(presses, ev)
		}
	}
	return presses, MouseEvents.ReplaceAllString(chunk, "")
}

// mouseEvent reads a report's digits; one too long for an int names no real button or cell,
// so it is no press at all.
func mouseEvent(button, x, y string) (MouseEvent, bool) {
	b, errB := strconv.Atoi(button)
	cx, errX := strconv.Atoi(x)
	cy, errY := strconv.Atoi(y)
	if errB != nil || errX != nil || errY != nil {
		return MouseEvent{}, false
	}
	return MouseEvent{Button: b, X: cx, Y: cy, Press: true}, true
}

// ArmStart is the second half of 's': the runner calls it once the program lock shows no
// cycle running, which is I/O DecideKey cannot do.
func ArmStart(v View, name string) View {
	v.ConfirmStart = true
	v.Message = fmt.Sprintf("start %s now, past every gate? y to confirm, any other key to cancel", name)
	return v
}

func said(kind IntentKind, v View, message string, redraw bool) (Intent, View) {
	v.Message = message
	return Intent{Kind: kind, Redraw: redraw}, v
}

func at(programs []control.Program, i int) (control.Program, bool) {
	if i < 0 || i >= len(programs) {
		return control.Program{}, false
	}
	return programs[i], true
}

// DecideKey is the TS handle in its exact order; key is the whole chunk, so a pasted "jj"
// matches nothing. q and Ctrl-C come first because onKey quits before handle runs, armed or not.
func DecideKey(key string, v View, programs []control.Program, st *state.DrovrState) (Intent, View) {
	if key == CtrlC || key == "q" {
		return Intent{Kind: IntentQuit}, v
	}
	if v.ConfirmStop {
		v.ConfirmStop = false
		return confirmOrCancel(key, v, programs, "stop", IntentInterrupt)
	}
	if v.ConfirmStart {
		v.ConfirmStart = false
		return confirmOrCancel(key, v, programs, "start", IntentStartCycle)
	}
	switch {
	case key == "j" || key == Esc+"B":
		v.Selected = min(len(programs)-1, v.Selected+1) // -1 with no programs, as the TS does
		return said(IntentMove, v, "", true)
	case key == "k" || key == Esc+"A":
		v.Selected = max(0, v.Selected-1)
		return said(IntentMove, v, "", true)
	case key == "?" || (v.Help && key == "\x1b"):
		v.Help = !v.Help
		return said(IntentHelp, v, "", true)
	case v.Help:
		return said(IntentNone, v, "", false)
	}
	if intent, ok := settingsKey(key); ok {
		if intent.Kind == IntentRefresh {
			v.Message = "refreshed"
		}
		return intent, v
	}
	selected, ok := at(programs, v.Selected)
	if !ok {
		return said(IntentNone, v, "no programs configured", false)
	}
	return programKey(key, v, selected, st)
}

func confirmOrCancel(key string, v View, programs []control.Program, noun string, confirm IntentKind) (Intent, View) {
	if key != "y" {
		return said(IntentCancel, v, noun+" cancelled", true)
	}
	selected, ok := at(programs, v.Selected)
	if !ok {
		return said(IntentNone, v, "no program selected", false)
	}
	return Intent{Kind: confirm, Program: selected.Name}, v
}

// settingsKey covers the keys the TS answers before it looks for a selected program. '<' and
// '>' carry only a direction: the runner reads the mode's weekly ceiling (0.55 when the mode
// has none, which is how `off` gets a ceiling written — the TS quirk, kept) and calls SetReserve.
func settingsKey(key string) (Intent, bool) {
	switch key {
	case "r":
		return Intent{Kind: IntentRefresh, Fresh: true, Redraw: true}, true
	case "m":
		return Intent{Kind: IntentSetMode}, true
	case "p":
		return Intent{Kind: IntentTogglePause}, true
	case "P":
		return Intent{Kind: IntentExtendPause}, true
	case "<", ",":
		return Intent{Kind: IntentNudgeReserve, Delta: -1}, true
	case ">", ".":
		return Intent{Kind: IntentNudgeReserve, Delta: 1}, true
	case "+", "=":
		return Intent{Kind: IntentAdjustConcurrency, Delta: 1}, true
	case "-", "_":
		return Intent{Kind: IntentAdjustConcurrency, Delta: -1}, true
	case "t":
		return Intent{Kind: IntentTickNow}, true
	}
	return Intent{}, false
}

func programKey(key string, v View, selected control.Program, st *state.DrovrState) (Intent, View) {
	name := selected.Name
	switch key {
	case "o":
		url := asksURLFor(st, name)
		if url == nil {
			return said(IntentNone, v, name+" has no asks page configured", false)
		}
		return Intent{Kind: IntentOpenAsks, Program: name, URL: *url}, v
	case " ", "e":
		return Intent{Kind: IntentToggleEnabled, Program: name}, v
	case "[":
		return Intent{Kind: IntentNudgePriority, Program: name, Delta: -1}, v
	case "]":
		return Intent{Kind: IntentNudgePriority, Program: name, Delta: 1}, v
	case "x":
		v.ConfirmStop = true
		verb := "stop"
		if selected.Runner == "orca" {
			verb = "interrupt"
		}
		intent, v := said(IntentArmStop, v, fmt.Sprintf("%s %s? y to confirm, any other key to cancel", verb, name), true)
		intent.Program = name
		return intent, v
	case "l":
		if selected.Runner != "orca" {
			return said(IntentNone, v, name+" runs headless — no runner to release", false)
		}
		return Intent{Kind: IntentReleaseLeftover, Program: name}, v
	case "s":
		return Intent{Kind: IntentArmStart, Program: name}, v
	}
	return said(IntentNone, v, "", false)
}

// asksURLFor reads the URL from the last frame's state, as the TS does, so it may be a frame stale.
func asksURLFor(st *state.DrovrState, name string) *string {
	if st == nil {
		return nil
	}
	for _, p := range st.Programs {
		if p.Name == name {
			return p.AsksURL
		}
	}
	return nil
}

// DecideClick resolves a press against hits, the frame actually on screen: a layout
// recomputed now would select the wrong row after a resize. width and narrow are that same
// frame's, for the keybar. Modifier bits are not masked, as in the TS.
func DecideClick(ev MouseEvent, hits []*LineHit, width int, narrow bool, v View, programs []control.Program, st *state.DrovrState) (Intent, View) {
	if !ev.Press {
		return Intent{Kind: IntentNone}, v
	}
	if ev.Button&64 != 0 {
		step := -1
		if ev.Button&1 != 0 {
			step = 1
		}
		return selectProgram(v.Selected+step, v, st)
	}
	if ev.Button&3 != 0 || ev.Y < 1 || ev.Y > len(hits) || hits[ev.Y-1] == nil {
		return Intent{Kind: IntentNone}, v // right, middle and dead space leave a confirmation armed
	}
	hit := hits[ev.Y-1]
	switch {
	case hit.Program != nil:
		return selectProgram(*hit.Program, v, st)
	case hit.Asks != nil && (v.ConfirmStop || v.ConfirmStart):
		return selectProgram(*hit.Asks, v, st)
	case hit.Asks != nil:
		v.Selected = *hit.Asks
		return DecideKey("o", v, programs, st)
	case hit.Keybar != nil:
		if key, ok := KeybarKeyAt(width, narrow, *hit.Keybar, ev.X-1); ok {
			return DecideKey(key, v, programs, st)
		}
	}
	return Intent{Kind: IntentNone}, v
}

// selectProgram gives the mouse the keyboard's confirmation semantics: a stray click can
// cancel an interrupt or a forced start, never confirm one. It clamps against the frame's
// programs, not control.json's, as the TS does.
func selectProgram(index int, v View, st *state.DrovrState) (Intent, View) {
	if v.ConfirmStop {
		v.ConfirmStop = false
		return said(IntentCancel, v, "stop cancelled", true)
	}
	if v.ConfirmStart {
		v.ConfirmStart = false
		return said(IntentCancel, v, "start cancelled", true)
	}
	last := 0
	if st != nil {
		last = len(st.Programs) - 1
	}
	v.Selected = max(0, min(last, index))
	return said(IntentMove, v, "", true)
}
