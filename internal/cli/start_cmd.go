package cli

import (
	"errors"
	"fmt"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/tick"
)

// Start launches one cycle for a program, bypassing admission, and returns at once: the
// runner outlives its watcher, so waiting on the worker here would only hold the terminal.
func Start(env Env, rest []string) error {
	if len(rest) == 0 {
		return errors.New("usage: drovr start <program>")
	}
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	p, ok := c.Program(rest[0])
	if !ok {
		return fmt.Errorf("no program named \"%s\"", rest[0])
	}
	return tick.Launch(TickEnv(env, false), p.Name)
}
