// Package cli holds the Go port of src/cli.ts's commands, one file per command.
package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/service"
	"github.com/cadam11/drovr/internal/status"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// Env is everything a command touches outside its arguments, so tests can point it elsewhere.
type Env struct {
	Paths          paths.Paths
	Now            func() epoch.Millis
	Stdout, Stderr io.Writer
	// TeamclaudeBin "" means `teamclaude` on PATH.
	TeamclaudeBin string
}

// inputs is one read of the world; status and status --json render the same read.
type inputs struct {
	control control.Control
	status  teamclaude.Status
	cycles  []ledger.Cycle
	now     epoch.Millis
	service status.ServiceInput
}

func Status(ctx context.Context, env Env, asJSON bool) error {
	in, err := readInputs(ctx, env)
	if err != nil {
		return err
	}
	fmt.Fprint(env.Stderr, unreadCaveat(in.control))
	var lockErr error
	lockPid := func(name string) *int {
		pid, ok, err := lock.Holder(env.Paths.ProgramLock(name))
		if err != nil {
			lockErr = errors.Join(lockErr, err)
		}
		if !ok {
			return nil
		}
		return &pid
	}
	evaluations, err := EvaluateAll(in.control, in.status, in.cycles, in.now, lockPid)
	if err == nil {
		err = lockErr
	}
	if err != nil {
		return err
	}
	if asJSON {
		return renderJSON(env.Stdout, in, evaluations)
	}
	return renderText(env.Stdout, in, evaluations)
}

// unreadCaveat names the inputs the tick reads that this build skips until plan E2 ports
// them; silent, it would print GO for a program the tick holds on a leftover runner.
func unreadCaveat(c control.Control) string {
	var skipped []string
	if c.NotifyTo != nil {
		skipped = append(skipped, "the phone's Away mode")
	}
	orca, asks := false, false
	for _, p := range c.Programs {
		orca = orca || (p.Enabled && p.Runner == "orca")
		asks = asks || (p.Enabled && (p.Aice != nil || p.AsksFile != nil))
	}
	if orca {
		skipped = append(skipped, "orca runner state")
	}
	if asks {
		skipped = append(skipped, "asks pages")
	}
	if len(skipped) == 0 {
		return ""
	}
	list := skipped[len(skipped)-1]
	if len(skipped) > 1 {
		list = strings.Join(skipped[:len(skipped)-1], ", ") + " or " + list
	}
	return "note: this Go build does not yet read " + list + "; verdicts may differ from the launchd tick (see plan E2)\n"
}

func readInputs(ctx context.Context, env Env) (inputs, error) {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return inputs{}, err
	}
	s, err := teamclaude.Read(ctx, env.TeamclaudeBin)
	if err != nil {
		return inputs{}, err
	}
	cycles, err := ledger.ReadCycles(env.Paths.Cycles)
	if err != nil {
		return inputs{}, err
	}
	now := env.Now()
	holder, err := tickLockHolder(env.Paths, now)
	if err != nil {
		return inputs{}, err
	}
	return inputs{
		control: c,
		status:  s,
		cycles:  cycles,
		now:     now,
		service: status.ServiceInput{State: service.Current(), LastTickAt: lastTickAt(env.Paths), LockHolder: holder},
	}, nil
}

// lastTickAt prefers the heartbeat; the decision log is the fallback for an install that
// predates it, so an upgrade does not read as "no tick has ever run".
func lastTickAt(p paths.Paths) *epoch.Millis {
	if at, ok := ledger.ReadTickStamp(p.LastTick); ok {
		return &at
	}
	if at, ok := ledger.LastDecisionAt(p.Decisions); ok {
		return &at
	}
	return nil
}

func tickLockHolder(p paths.Paths, now epoch.Millis) (*service.LockHolder, error) {
	held, ok, err := lock.HeldBy(p.TickLock)
	if err != nil || !ok {
		return nil, err
	}
	h := &service.LockHolder{Pid: held.Pid}
	if held.At != nil {
		ms := max(0, now-*held.At)
		h.HeldMs = &ms
	}
	return h, nil
}

// EvaluateAll decides in priority order, booking each admitted program as in flight, so the
// list says what a tick would actually do rather than judging every program against an
// empty pool. E1 has no asks or orca: nil is the TS's undefined, which never refuses.
func EvaluateAll(c control.Control, s teamclaude.Status, cycles []ledger.Cycle, now epoch.Millis, lockPid func(string) *int) ([]status.Evaluation, error) {
	ordered, err := control.ByPriority(c.Programs, now, c.DeadlineHorizonDays)
	if err != nil {
		return nil, err
	}
	seen := append([]ledger.Cycle{}, cycles...)
	out := make([]status.Evaluation, 0, len(ordered))
	for _, program := range ordered {
		d, err := decide.Decide(decide.Input{Status: s, Control: c, Cycles: seen, Program: program.Name, Now: now})
		if err != nil {
			return nil, err
		}
		if d.Verdict == "GO" && program.Enabled {
			seen = append(seen, projectedStart(program.Name, now))
		}
		out = append(out, status.Evaluation{Program: program, Decision: d, Pid: lockPid(program.Name)})
	}
	return out, nil
}

func projectedStart(program string, now epoch.Millis) ledger.Cycle {
	return ledger.Cycle{V: 1, Kind: "delivery", Program: program, StartedAt: epoch.ISO(now), Exit: "running"}
}

func renderJSON(w io.Writer, in inputs, evaluations []status.Evaluation) error {
	payload, err := status.Build(status.Input{
		Control: in.control, StoredMode: in.control.Mode, Status: in.status, Cycles: in.cycles,
		Now: in.now, Evaluations: evaluations, Service: in.service,
	})
	if err != nil {
		return err
	}
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(payload)
}

func renderText(w io.Writer, in inputs, evaluations []status.Evaluation) error {
	c := in.control
	fmt.Fprintf(w, "service: %s\n", service.Describe(in.service.State, in.service.LastTickAt, in.now, in.service.LockHolder))
	// IsPaused, not a nil check: a lapsed pause printed "paused until" for hours above
	// verdicts naming a different reason.
	paused, err := control.IsPaused(c, in.now)
	if err != nil {
		return err
	}
	pause := ""
	if paused {
		pause = fmt.Sprintf(" (paused until %s)", *c.PauseUntil)
	}
	fmt.Fprintf(w, "mode: %s%s\n", c.Mode, pause)
	running := ledger.InFlight(in.cycles, in.now, c.MaxCycleHours)
	if err := renderCapacity(w, in, running); err != nil {
		return err
	}
	fmt.Fprintf(w, "cycles recorded: %d · zero-yield streak: %d\n", len(in.cycles), ledger.ConsecutiveZeroYield(in.cycles))
	fmt.Fprintf(w, "in flight: %d/%s%s\n", len(running), num(c.MaxConcurrentCycles), runningNames(running))
	return renderPrograms(w, c, in.now, evaluations)
}

// renderCapacity charges running cycles as decide() does — ChargeForRunning, never the raw
// count — or this line over-reports fundability against the verdicts beneath it.
func renderCapacity(w io.Writer, in inputs, running []ledger.Cycle) error {
	ceilings, ok, err := control.CeilingsFor(in.control)
	if err != nil || !ok {
		return err
	}
	pool := capacity.PoolFrom(in.status, ceilings, in.now)
	cost := ledger.EstimateCycleCost(in.cycles, in.control.SeedCycleCost, 3, 0.9)
	// Account-units, never a percentage: 0.81 across 3 accounts is 27% of the pool, not 81%.
	fmt.Fprintf(w, "pool: fable %s · general %s · session %s account-units of headroom across %d accounts (1.00 = one whole account)\n",
		jsnum.ToFixed(pool.Fable, 2), jsnum.ToFixed(pool.General, 2), jsnum.ToFixed(pool.Session, 2), pool.UsableAccounts)
	fmt.Fprintf(w, "cycle cost estimate: fable %s · general %s · session %s\n",
		jsnum.ToFixed(cost.Fable, 3), jsnum.ToFixed(cost.General, 3), jsnum.ToFixed(cost.Session, 3))
	funding := decide.CyclesFundableFrom(pool, cost, ledger.ChargeForRunning(running, pool.Snapshot(), cost))
	fmt.Fprintf(w, "capacity: %s\n", describeFunding(funding))
	fmt.Fprintf(w, "  %s\n", decide.PoolContext(funding, pool, in.now))
	return nil
}

func describeFunding(f decide.Funding) string {
	perAccount := make([]string, 0, len(f.Accounts))
	for _, a := range f.Accounts {
		// Naming the bucket of an account teamclaude will not route to blames the wrong thing.
		why := string(a.Binding)
		if !a.Routable {
			why += ", not routed"
		}
		perAccount = append(perAccount, fmt.Sprintf("%s %s (%s)", a.Name, jsnum.ToFixed(float64(a.Cycles), 2), why))
	}
	spread := ""
	if carrying := decide.ContributingAccounts(f); carrying != len(f.Accounts) {
		spread = fmt.Sprintf(" from %d of %d accounts", carrying, len(f.Accounts))
	}
	return fmt.Sprintf("%s cycles fundable%s, %s binding — %s", jsnum.ToFixed(float64(f.Cycles), 2), spread, f.Binding, strings.Join(perAccount, " · "))
}

func runningNames(running []ledger.Cycle) string {
	if len(running) == 0 {
		return ""
	}
	names := make([]string, len(running))
	for i, c := range running {
		names[i] = c.Program
	}
	return " (" + strings.Join(names, ", ") + ")"
}

func renderPrograms(w io.Writer, c control.Control, now epoch.Millis, evaluations []status.Evaluation) error {
	for _, e := range evaluations {
		shown, err := control.EffectivePriority(e.Program, now, c.DeadlineHorizonDays)
		if err != nil {
			return err
		}
		flags := ""
		if !e.Program.Enabled {
			flags += " [disabled]"
		}
		if e.Pid != nil {
			flags += fmt.Sprintf(" [pid %d]", *e.Pid)
		}
		fmt.Fprintf(w, "  [p%s] %s%s: %s — %s\n", num(shown), e.Program.Name, flags, e.Decision.Verdict, e.Decision.Reason)
		if h := e.Program.Host; h != nil {
			fmt.Fprintf(w, "      runs on %s (orca environment %s) in %s\n", h.SSH, h.Environment, h.Cwd)
		}
	}
	return nil
}

// num is JS's String(number) for the values printed here: small integers and short decimals.
func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }
