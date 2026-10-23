package orca

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"

	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/shape"
)

// Remembered is one program's runner terminal, on disk because the process that started a
// cycle is not the one that watches it on the next tick.
type Remembered struct {
	Handle     string `json:"handle"`
	TabID      string `json:"tabId"`
	WorktreeID string `json:"worktreeId"`
	// The paired runtime the terminal lives on; empty for one on this Mac.
	Environment string `json:"environment,omitempty"`
	// `/exit` was sent and the runner stayed — a second would land in whatever answered it.
	ExitSent bool `json:"exitSent,omitempty"`
}

// RememberedTerminal is reached from inside the tick, so an unreadable file costs the
// identity, never the pass. A wrong shape is nil silently, so a stale id is never sent to orca.
func RememberedTerminal(p paths.Paths, program string, log io.Writer) *Remembered {
	path := p.CycleTerminal(program)
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err == nil {
		var probe any
		err = json.Unmarshal(raw, &probe)
	}
	if err != nil {
		fmt.Fprintf(log, "could not read %s, treating %s as having no runner terminal: %v\n", path, program, err)
		return nil
	}
	o, err := shape.Decode(raw, "")
	if err != nil {
		return nil
	}
	var r Remembered
	shape.Required(o, "handle", &r.Handle)
	shape.Required(o, "tabId", &r.TabID)
	shape.Required(o, "worktreeId", &r.WorktreeID)
	shape.Optional(o, "environment", &r.Environment)
	shape.Optional(o, "exitSent", &r.ExitSent)
	if o.Err != nil {
		return nil
	}
	return &r
}

// RememberTerminal writes in place, as the TS does; the program's state directory exists
// by the time a cycle has a terminal to remember.
func RememberTerminal(p paths.Paths, program string, r Remembered) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(r); err != nil {
		return err
	}
	return os.WriteFile(p.CycleTerminal(program), buf.Bytes(), 0o644)
}

func ForgetTerminal(p paths.Paths, program string) error {
	err := os.Remove(p.CycleTerminal(program))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
