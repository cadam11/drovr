package cli

import (
	"fmt"
	"strings"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/cycle"
	"github.com/cadam11/drovr/internal/keys"
)

// Report is the loop agent's way to end its cycle: validated before anything touches disk,
// and written atomically, so drovr's watch never reads a torn or malformed report. The
// program-name check keeps a typo from stranding the report in a directory nothing watches
// while the real cycle runs on to a stall.
func Report(env Env, args []string) error {
	program, report, err := cycle.ParseReportArgs(args, env.Now())
	if err != nil {
		return err
	}
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	if _, ok := c.Program(program); !ok {
		known := make([]string, len(c.Programs))
		for i, p := range c.Programs {
			known[i] = p.Name
		}
		return fmt.Errorf(`no program named "%s" — tracked: %s`, program, strings.Join(known, ", "))
	}
	written, err := cycle.WriteReport(env.Paths, program, report)
	if err != nil {
		return err
	}
	fmt.Fprintf(env.Stdout, "reported %s: exit=%s → %s\n", program, written.Exit, env.Paths.LastCycle(program))
	if err := applyRest(env, program, written); err != nil {
		return err
	}
	fmt.Fprintln(env.Stdout, "the cycle is now over — drovr will close this session; start nothing new")
	return nil
}

// applyRest writes the rest and cadence here rather than leaving them to the tick, so the
// request takes effect the moment it is made, through the one path that validates control.json.
func applyRest(env Env, program string, r cycle.Report) error {
	if r.PauseUntil == nil && r.Cadence == nil {
		return nil
	}
	_, err := keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		entry, err := keys.ProgramAt(d, program)
		if err != nil {
			return fmt.Errorf(`no program named "%s" in control.json`, program)
		}
		if r.PauseUntil != nil {
			entry.Set("pauseUntil", *r.PauseUntil)
		}
		if r.Cadence != nil {
			entry.Set("cadence", *r.Cadence)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if r.PauseUntil != nil {
		fmt.Fprintf(env.Stdout, "%s rests until %s — resume early: drovr resume %s\n", program, *r.PauseUntil, program)
	}
	if r.Cadence != nil {
		fmt.Fprintf(env.Stdout, "%s now runs at most once per %s — change: drovr cadence %s off\n", program, *r.Cadence, program)
	}
	return nil
}
