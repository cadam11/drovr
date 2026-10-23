// Package orca is drovr's one interface to the runner's terminal. This half is pure: it
// reads the envelopes orca prints and decides what they mean; the live calls feed it.
package orca

import (
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"

	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/shape"
)

// Refused is an `ok: false` envelope. Orca answers a refusal on stdout with a non-zero
// exit, so the envelope is the interface and its code is what drovr branches on — never
// the exit code (measured 2026-09-10: from an interactive zsh the exit looked like 0).
type Refused struct{ Shown, Code string }

func (r *Refused) Error() string { return r.Shown + " refused: " + r.Code }

// Unwrap returns an ok envelope's result, a *Refused for a refusal, and an error for
// anything that is neither rather than reading it as either.
func Unwrap(payload json.RawMessage, shown string) (json.RawMessage, error) {
	var env struct {
		OK     *bool           `json:"ok"`
		Result json.RawMessage `json:"result"`
		Error  *struct {
			Code *string `json:"code"`
		} `json:"error"`
	}
	bad := fmt.Errorf("%s did not answer with an orca envelope: %s", shown, jsnum.Slice(string(payload), 300))
	if err := json.Unmarshal(payload, &env); err != nil || env.OK == nil {
		return nil, bad
	}
	if *env.OK {
		return env.Result, nil
	}
	if env.Error == nil || env.Error.Code == nil {
		return nil, bad
	}
	return nil, &Refused{Shown: shown, Code: *env.Error.Code}
}

// goneCodes all mean "there is no such terminal": the handle is stale or the tab is closed.
var goneCodes = []string{"terminal_handle_stale", "terminal_not_found", "selector_not_found"}

func IsGone(err error) bool {
	var r *Refused
	return errors.As(err, &r) && slices.Contains(goneCodes, r.Code)
}

func isTimeout(err error) bool {
	var r *Refused
	return errors.As(err, &r) && r.Code == "timeout"
}

// shownTerminal is `terminal show`'s inner terminal; nil means orca says there is none.
type shownTerminal struct {
	Handle string
	// `show` omits agentIdentity for a terminal with no agent where `list` sends an explicit
	// null (measured 2026-09-11 on three live terminals of one runtime). Absent is orca
	// saying "no agent", not "never looked", so both read as nil.
	AgentIdentity *string
	// Present and non-null is blocked; null is orca looked and found none; absent is an
	// older host that never looked — evidence of nothing.
	Blocked bool
	// Null on a restored terminal nothing has written to yet (measured 2026-09-12, when
	// refusing it crashed nine sunnyt cycles before any terminal existed).
	Title        *string
	WorktreePath *string
}

// readShown errors name the failing field path: a payload prefix hid `title: null` past
// its 300-character cut for a whole day.
func readShown(show json.RawMessage) (*shownTerminal, error) {
	result, err := Unwrap(show, "orca terminal show")
	if IsGone(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	t, err := decodeShown(result)
	if err != nil {
		return nil, fmt.Errorf("orca terminal show did not match the expected shape — %v", err)
	}
	return t, nil
}

func decodeShown(result json.RawMessage) (*shownTerminal, error) {
	outer, err := shape.Decode(result, "")
	if err != nil {
		return nil, err
	}
	var raw json.RawMessage
	shape.Required(outer, "terminal", &raw)
	if outer.Err != nil {
		return nil, outer.Err
	}
	o, err := shape.Decode(raw, "terminal")
	if err != nil {
		return nil, err
	}
	var t shownTerminal
	shape.Required(o, "handle", &t.Handle)
	shape.NullableDefault(o, "agentIdentity", &t.AgentIdentity)
	_, t.Blocked = o.Present("agentWait")
	shape.NullableDefault(o, "title", &t.Title)
	shape.Optional(o, "worktreePath", &t.WorktreePath)
	return &t, o.Err
}

// waitSatisfied reads `terminal wait`; a probe that ran out of time is the normal answer
// for a working claude or a live pty, so `timeout` is false rather than an error.
func waitSatisfied(wait json.RawMessage) (bool, error) {
	result, err := Unwrap(wait, "orca terminal wait")
	if isTimeout(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var w struct {
		Wait *struct {
			Satisfied *bool `json:"satisfied"`
		} `json:"wait"`
	}
	if json.Unmarshal(result, &w) != nil || w.Wait == nil || w.Wait.Satisfied == nil {
		return false, fmt.Errorf("orca terminal wait did not report satisfied: %s", jsnum.Slice(string(result), 300))
	}
	return *w.Wait.Satisfied, nil
}

func PreviewText(read json.RawMessage) (string, error) {
	result, err := Unwrap(read, "orca terminal read")
	if err != nil {
		return "", err
	}
	var r struct {
		Terminal *struct {
			Tail *[]string `json:"tail"`
		} `json:"terminal"`
	}
	if err := json.Unmarshal(result, &r); err != nil || r.Terminal == nil || r.Terminal.Tail == nil {
		return "", fmt.Errorf("orca terminal read did not carry terminal.tail: %s", jsnum.Slice(string(result), 300))
	}
	return strings.Join(*r.Terminal.Tail, "\n"), nil
}

// AdoptHandle finds a terminal by tab id. Handles are runtime-scoped and an Orca restart
// invalidates every one, while the tab is restored with the claude session resumed in it;
// losing that terminal is how a runner ends up un-watched and its program admitted again
// on top of it.
func AdoptHandle(list json.RawMessage, tabID string) (string, bool, error) {
	result, err := Unwrap(list, "orca terminal list")
	if err != nil {
		return "", false, err
	}
	var l struct {
		Terminals *[]struct {
			Handle *string `json:"handle"`
			TabID  *string `json:"tabId"`
		} `json:"terminals"`
	}
	if err := json.Unmarshal(result, &l); err != nil || l.Terminals == nil {
		return "", false, fmt.Errorf("orca terminal list did not carry terminals: %s", jsnum.Slice(string(result), 300))
	}
	for i, t := range *l.Terminals {
		if t.Handle == nil || t.TabID == nil {
			return "", false, fmt.Errorf("orca terminal list: terminals[%d] needs handle and tabId strings", i)
		}
	}
	for _, t := range *l.Terminals {
		if *t.TabID == tabID {
			return *t.Handle, true, nil
		}
	}
	return "", false, nil
}
