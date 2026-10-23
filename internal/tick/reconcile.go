package tick

import (
	"context"
	"fmt"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/cycle"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/teamclaude"
	"github.com/cadam11/drovr/internal/transcript"
)

type Orphan string

// OrphanAction says what to do about an in-flight cycle whose worker is dead. The runner is an
// interactive session that outlives its watcher, so a dead lock says nothing about the cycle:
// while the runner is there a new watcher is attached; once it is gone the record is closed as
// abandoned — drovr stopped looking, not a claim that nothing was delivered. Unknown is left
// alone: a watcher attached while orca is unreachable could not see the runner either.
func OrphanAction(runnerPresent *bool) Orphan {
	if runnerPresent == nil {
		return "skip"
	}
	if *runnerPresent {
		return "reattach"
	}
	return "close"
}

// runnerStillThere is nil rather than false when orca cannot be reached: "no agent" and "no
// answer" are different facts, and only the first may refuse a cycle.
func runnerStillThere(ctx context.Context, env Env, program string) *bool {
	present, err := env.Orca.RunnerIsPresent(ctx, program)
	if err != nil {
		// swallowed: logged; unknown never refuses a cycle and never closes one
		fmt.Fprintf(env.Err, "%s: could not read its runner's state (%s) — admission proceeds as if there were none.\n", program, err)
		return nil
	}
	return &present
}

// reconcileAbandoned returns the records that close orphaned cycles and the programs whose
// runner needs a watcher re-attached; Tick appends and launches them. A worker takes its
// program lock before writing its start record, so an in-flight cycle whose lock has no live
// holder has lost its worker. Measured 2026-09-12: a run-cycle killed 37 minutes into a healthy
// cycle left its runner working for hours unwatched, and closing that as crash would have
// latched the program and thrown away the report. maxCycleHours is passed rather than
// InFlight's 24h default, or above 24 an orphan is never closed and blocks its program forever.
func reconcileAbandoned(ctx context.Context, env Env, now epoch.Millis, c control.Control, s teamclaude.Status, cycles []ledger.Cycle) ([]ledger.Cycle, []string, error) {
	poolNow, err := poolSnapshot(c, s, now)
	if err != nil {
		return nil, nil, err
	}
	var records []ledger.Cycle
	var reattach []string
	for _, open := range ledger.InFlight(cycles, now, c.MaxCycleHours) {
		_, held, err := lock.Holder(env.Paths.ProgramLock(open.Program))
		if err != nil {
			return nil, nil, err // an unreadable lock is never free
		}
		if held {
			continue
		}
		opened := fmt.Sprintf("%s: cycle started %s has no watcher", open.Program, open.StartedAt)
		switch OrphanAction(runnerStillThere(ctx, env, open.Program)) {
		case "skip":
			fmt.Fprintf(env.Err, "%s and orca cannot say whether its runner is alive — left open until it can\n", opened)
		case "reattach":
			fmt.Fprintf(env.Out, "%s but its runner is still there — attaching a new one\n", opened)
			reattach = append(reattach, open.Program)
		default:
			records = append(records, closedAsAbandoned(open, now, poolNow))
			fmt.Fprintf(env.Err, "%s and no runner — closed as abandoned; a report it left is reconciled next\n", opened)
		}
	}
	return records, reattach, nil
}

func poolSnapshot(c control.Control, s teamclaude.Status, now epoch.Millis) (*ledger.Cost, error) {
	ceilings, ok, err := control.CeilingsFor(c)
	if err != nil || !ok {
		return nil, err
	}
	snap := capacity.PoolFrom(s, ceilings, now).Snapshot()
	return &snap, nil
}

func closedAsAbandoned(open ledger.Cycle, now epoch.Millis, poolNow *ledger.Cost) ledger.Cycle {
	endedAt := epoch.ISO(now)
	open.EndedAt, open.Exit, open.PoolAfter = &endedAt, "abandoned", poolNow
	if poolNow == nil {
		before := open.PoolBefore
		open.PoolAfter = &before
	}
	return open
}

// reconcileLateReports returns the records that supersede an abandoned cycle with the report
// its runner wrote after drovr stopped watching; Tick appends them. Without this the ledger
// keeps a permanent "delivery unknown" for a cycle that plainly delivered, its yield lost and
// its real cost never reaching the estimate. Appended, never rewritten: LatestEnds makes the
// later record the operative one. Safe because runCycle clears the report before every
// attempt, so one sitting beside an abandoned record can only be that cycle's — and that is
// why it runs before admission: the next cycle's clearReport deletes the evidence.
func reconcileLateReports(ctx context.Context, env Env, now epoch.Millis, c control.Control, cycles []ledger.Cycle) ([]ledger.Cycle, error) {
	ends := ledger.LatestEnds(cycles)
	var records []ledger.Cycle
	for _, program := range c.Programs {
		last, ok := lastEnd(ends, program.Name)
		if !ok || last.Exit != "abandoned" {
			continue
		}
		// A malformed leftover file costs this program's reconciliation, never the tick.
		report := cycle.ReadReportOrWarn(ctx, env.Paths, program, env.Err)
		if report == nil {
			continue
		}
		rec, err := superseded(ctx, env, now, program, last, *report)
		if err != nil {
			return nil, err
		}
		records = append(records, rec)
		fmt.Fprintf(env.Out, "%s: cycle started %s reported \"%s\" after drovr stopped watching — record superseded, its yield and cost now count\n",
			program.Name, last.StartedAt, report.Exit)
	}
	return records, nil
}

func lastEnd(ends []ledger.Cycle, program string) (ledger.Cycle, bool) {
	for i := len(ends) - 1; i >= 0; i-- {
		if ends[i].Program == program {
			return ends[i], true
		}
	}
	return ledger.Cycle{}, false
}

func superseded(ctx context.Context, env Env, now epoch.Millis, program control.Program, last ledger.Cycle, r cycle.Report) (ledger.Cycle, error) {
	endedAt := epoch.ISO(now)
	last.EndedAt, last.Exit, last.StartupTokens, last.Yield, last.AsksRaised, last.PauseUntil = &endedAt, r.Exit, r.StartupTokens, r.Yield, r.AsksRaised, r.PauseUntil
	last.Closing = nil
	if last.SessionID == nil {
		return last, nil
	}
	closing, err := transcript.ClosingMessage(ctx, env.Home, *last.SessionID, program.Host, env.Err)
	last.Closing = closing
	return last, err
}
