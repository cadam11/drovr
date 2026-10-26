package cli

import (
	"context"
	"errors"
	"fmt"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/orca"
)

// releaseSettleAttempts is how many 3 s polls a release waits for a runner to settle.
const releaseSettleAttempts = 10

// Release frees a program's pane once its runner has outlived its cycle. Manual on purpose:
// an idle runner with no report may hold unsaved work, and /exit is only ever sent to a
// settled agent, so a working or blocked runner is reported and left alone.
func Release(ctx context.Context, env Env, rest []string) error {
	return release(ctx, env, orca.NewClient(env.Paths, env.Stderr), rest)
}

func release(ctx context.Context, env Env, client *orca.Client, rest []string) error {
	if len(rest) == 0 {
		return errors.New("release needs a program, e.g. `drovr release sunnyt`")
	}
	name := rest[0]
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	if _, ok := c.Program(name); !ok {
		return fmt.Errorf("no program named \"%s\" in %s", name, env.Paths.Control)
	}
	state, err := client.RunnerState(ctx, name)
	if err != nil {
		return err
	}
	if state == orca.Gone {
		// No claude to ask out, but the tab it left may still be remembered.
		if _, err := client.ReleaseRunner(ctx, name, releaseSettleAttempts); err != nil {
			return err
		}
		fmt.Fprintf(env.Stdout, "%s: no runner to release — its terminal is free\n", name)
		return nil
	}
	address := client.RunnerAddress(ctx, name)
	if !orca.IsSettled(state) {
		fmt.Fprintf(env.Stderr, "%s: its runner is %s, so it was left alone — /exit typed into a live "+
			"turn is swallowed and the terminal stays held. Open %s and answer what it is waiting on, "+
			"then run this again.%s\n", name, state, address.Where, openLine(address, "\n  open it:  "))
		return ErrPrinted
	}
	released, err := client.ReleaseRunner(ctx, name, releaseSettleAttempts)
	if err != nil {
		return err
	}
	if released {
		fmt.Fprintf(env.Stdout, "%s: released its runner — the next tick can start a cycle\n", name)
		return nil
	}
	fmt.Fprintf(env.Stdout, "%s: the runner did not exit; it still holds %s. Run this again, or close the tab%s\n",
		name, address.Where, openLine(address, ":  "))
	return ErrPrinted
}

func openLine(a orca.PaneAddress, prefix string) string {
	if a.Open == nil {
		return ""
	}
	return prefix + *a.Open
}
