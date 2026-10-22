// Package paths locates drovr's state directory; port of src/paths.ts.
package paths

import (
	"os"
	"path/filepath"
)

type Paths struct{ Base, Control, Cycles, Decisions, Usage, LastTick, TickFailure, TickLock, Logs string }

// Root honours a present-but-empty DROVR_HOME as empty, as Node's `??` does.
func Root() string {
	if v, ok := os.LookupEnv("DROVR_HOME"); ok {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		panic("paths: no home directory and DROVR_HOME unset: " + err.Error())
	}
	return filepath.Join(home, ".drovr")
}

func New() Paths {
	base := Root()
	return Paths{
		Base:        base,
		Control:     filepath.Join(base, "control.json"),
		Cycles:      filepath.Join(base, "cycles.jsonl"),
		Decisions:   filepath.Join(base, "decisions.jsonl"),
		Usage:       filepath.Join(base, "usage.jsonl"),
		LastTick:    filepath.Join(base, "last-tick.json"),
		TickFailure: filepath.Join(base, "tick-failure.json"),
		TickLock:    filepath.Join(base, "tick.lock"),
		Logs:        filepath.Join(base, "logs"),
	}
}

func (p Paths) ProgramState(program string) string { return filepath.Join(p.Base, "programs", program) }
func (p Paths) ProgramLock(program string) string {
	return filepath.Join(p.ProgramState(program), "cycle.lock")
}
func (p Paths) LastCycle(program string) string {
	return filepath.Join(p.ProgramState(program), "last-cycle.json")
}
func (p Paths) StateFile(program string) string {
	return filepath.Join(p.ProgramState(program), "state.json")
}

// EnsureDirs creates the logs dir and, for a non-empty program, its state dir.
func EnsureDirs(p Paths, program string) error {
	if err := os.MkdirAll(p.Logs, 0o755); err != nil {
		return err
	}
	if program == "" {
		return nil
	}
	return os.MkdirAll(p.ProgramState(program), 0o755)
}
