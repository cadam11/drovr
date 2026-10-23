package tick

import (
	"fmt"
	"math"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/status"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// DecisionRecord is one decisions.jsonl line. The reason is recombined: each line is read
// alone, so it carries the pool context the multi-program renderers print only once. An
// infinite fundability is null, as JSON.stringify writes Infinity.
func DecisionRecord(program string, d decide.Decision, now epoch.Millis) ledger.Decision {
	rec := ledger.Decision{V: 1, At: epoch.ISO(now), Program: program, Verdict: string(d.Verdict), Reason: decide.FullReason(d)}
	if d.Pool != nil {
		snap := d.Pool.Snapshot()
		rec.Pool = &snap
	}
	if d.CyclesFundable != nil {
		f := float64(*d.CyclesFundable)
		if !math.IsInf(f, 0) && !math.IsNaN(f) {
			rec.CyclesFundable = &f
		}
	}
	return rec
}

// Launch hands a program to a detached `run-cycle`, which owns that program's lock and ledger
// entries. Cycles run for hours, so the tick must not wait on one: it returns in seconds and
// the next firing evaluates the other programs.
func Launch(env Env, program string) error {
	log := env.Paths.WorkerLog(program)
	pid, err := exec.Detach(env.Self, []string{"run-cycle", program}, log)
	if err != nil {
		return err
	}
	fmt.Fprintf(env.Out, "%s: launched cycle (pid %d, log %s)\n", program, pid, log)
	return nil
}

// projectedStart books a launch the worker has not yet recorded. Workers write their own start
// record, so within one pass the earlier launches are not in the ledger; without this the
// concurrency cap and the reservations would not apply until the next tick, and every program
// would be admitted at once.
func projectedStart(program string, now epoch.Millis, poolBefore ledger.Cost) ledger.Cycle {
	return ledger.Cycle{V: 1, Kind: "delivery", Program: program, StartedAt: epoch.ISO(now), Exit: "running", PoolBefore: poolBefore}
}

func lockPid(p paths.Paths, program string) (*int, error) {
	pid, held, err := lock.Holder(p.ProgramLock(program))
	if err != nil || !held {
		return nil, err
	}
	return &pid, nil
}

// everyEvaluation lists every configured program in priority order. The pass only evaluates
// enabled ones; a disabled program's verdict is still worth publishing (STOP, "disabled") and
// decide() answers it without I/O — its runner left unknown, as state does.
func everyEvaluation(p paths.Paths, c control.Control, s teamclaude.Status, cycles []ledger.Cycle, now epoch.Millis, evaluated map[string]status.Evaluation) ([]status.Evaluation, error) {
	ordered, err := control.ByPriority(c.Programs, now, c.DeadlineHorizonDays)
	if err != nil {
		return nil, err
	}
	out := make([]status.Evaluation, 0, len(ordered))
	for _, program := range ordered {
		if e, ok := evaluated[program.Name]; ok {
			out = append(out, e)
			continue
		}
		d, err := decide.Decide(decide.Input{Status: s, Control: c, Cycles: cycles, Program: program.Name, Now: now})
		if err != nil {
			return nil, err
		}
		pid, err := lockPid(p, program.Name)
		if err != nil {
			return nil, err
		}
		out = append(out, status.Evaluation{Program: program, Decision: d, Pid: pid})
	}
	return out, nil
}
