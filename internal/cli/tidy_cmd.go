package cli

import (
	"context"
	"fmt"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/orca"
)

// Tidy closes each idle program's empty cycle terminal. The orca client decides what is
// empty; this prints its answer, and stops at the first orca failure like the TS does.
func Tidy(ctx context.Context, env Env) error {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	cycles, err := ledger.ReadCycles(env.Paths.Cycles)
	if err != nil {
		return err
	}
	running := map[string]bool{}
	for _, r := range ledger.InFlight(cycles, env.Now(), c.MaxCycleHours) {
		running[r.Program] = true
	}
	client := orca.NewClient(env.Paths, env.Stderr)
	for _, p := range c.Programs {
		if running[p.Name] {
			fmt.Fprintf(env.Stdout, "%s: cycle in flight, left alone\n", p.Name)
			continue
		}
		closed, err := client.TidyRunnerTerminal(ctx, p.Name)
		if err != nil {
			return err
		}
		if closed == nil {
			fmt.Fprintf(env.Stdout, "%s: no empty cycle terminal\n", p.Name)
			continue
		}
		fmt.Fprintf(env.Stdout, "%s: closed %s\n", p.Name, *closed)
	}
	return nil
}
