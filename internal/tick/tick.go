// Package tick is the unattended pass: one launchd firing decides which programs may start a
// cycle, starts them detached, and returns in seconds. Port of src/tick.ts.
package tick

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/cadam11/drovr/internal/asks"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/nudge"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/service"
	"github.com/cadam11/drovr/internal/status"
	"github.com/cadam11/drovr/internal/teamclaude"
	"github.com/cadam11/drovr/internal/usage"
)

type Env struct {
	Paths    paths.Paths
	Now      func() epoch.Millis
	Out, Err io.Writer
	Self     string // the drovr binary that `run-cycle <program>` is detached from
	// TeamclaudeBin "" is teamclaude on PATH.
	TeamclaudeBin, Host string
	Home                string // for transcripts (closing messages of reconciled cycles)
	Orca                *orca.Client
	Asks                *asks.Reader
	Caller              nudge.CallerFunc // nil is nudge.DefaultCaller
	Exit                func(code int)   // os.Exit when nil; the watchdog's last act
	Shadow              bool             // Task 16: every effect turned inward
}

// pass is what one tick read before deciding anything; every phase after begin reads it.
type pass struct {
	env     Env
	now     epoch.Millis
	stored  control.Control // control.json as written
	control control.Control // what this pass runs under, after the phone's Away
	status  teamclaude.Status
	channel nudge.Channel
}

// Tick is one pass. A busy lock is reported and returns nil having stamped nothing: a pass
// that never ran has completed nothing.
func Tick(ctx context.Context, env Env) (err error) {
	if err := paths.EnsureDirs(env.Paths, ""); err != nil {
		return err
	}
	acquired, err := lock.Acquire(env.Paths.TickLock)
	if err != nil {
		return err
	}
	if !acquired {
		return reportBusy(env)
	}
	// Released on every return, the budget read included: the TS left that one to the process
	// exiting, which a long-lived caller (a test, the shadow) would not.
	defer func() { err = errors.Join(err, lock.Release(env.Paths.TickLock)) }()
	stop, err := armWatchdog(env)
	if err != nil {
		return err
	}
	defer stop()
	return runPass(ctx, env)
}

// reportBusy names the holder's age, which is the difference between "busy" and "wedged". One
// read, not three: the holder can change between them, and a message naming a pid that no
// longer holds the lock is worse than one naming none.
func reportBusy(env Env) error {
	held, ok, err := lock.HeldBy(env.Paths.TickLock)
	if err != nil {
		return err // an unreadable lock is never free
	}
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	pid, age, heldMs := "unknown", "unknown age", int64(-1)
	if ok {
		pid = strconv.Itoa(held.Pid)
		if held.At != nil {
			heldMs = max(0, env.Now()-*held.At)
			age = DurationText(heldMs)
		}
	}
	line := fmt.Sprintf("another tick is still evaluating (pid %s, held %s)", pid, age)
	budget := budgetOf(c)
	if heldMs >= 0 && heldMs > budget.Milliseconds() {
		fmt.Fprintf(env.Err, "%s — longer than the %s budget, so it is wedged rather than busy. Clear it with \"kill %s\"; the next firing then runs.\n",
			line, DurationText(budget.Milliseconds()), pid)
		return nil
	}
	fmt.Fprintln(env.Out, line)
	return nil
}

// budgetOf is control.tickBudgetMinutes: 8 by default against a 600s schedule, comfortably
// longer than a healthy pass (around 8s) and short enough that at most one firing is skipped.
// Too loose only delays recovery; too tight aborts healthy passes.
func budgetOf(c control.Control) time.Duration {
	return time.Duration(c.TickBudgetMinutes * float64(time.Minute))
}

// armWatchdog is the hard wall-clock ceiling that makes the tick lock impossible to hold
// forever. Bounding every subprocess removed the known causes of a wedge; this removes the
// consequence of an unknown one. The budget is read here, before arming, so a control file
// that becomes unreadable mid-pass cannot disarm it. AfterFunc runs on its own goroutine, so it
// fires while the pass is blocked in a subprocess; exiting skips every defer, which is why
// ReleaseOverrunningTick releases explicitly.
func armWatchdog(env Env) (func(), error) {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return nil, err
	}
	budget := budgetOf(c)
	exit := env.Exit
	if exit == nil {
		exit = os.Exit
	}
	timer := time.AfterFunc(budget, func() {
		ReleaseOverrunningTick(context.Background(), env, env.Paths.TickLock, budget)
		exit(1)
	})
	return func() { timer.Stop() }, nil
}

func runPass(ctx context.Context, env Env) error {
	ps, err := begin(ctx, env)
	if err != nil {
		return err
	}
	if err := reconcile(ctx, ps); err != nil {
		return err
	}
	launched, evaluated, err := admit(ctx, ps)
	if err != nil {
		return err
	}
	// The window onto the tick comes last, after admission, and cannot close it.
	sampleUsage(ps)
	publish(ctx, ps, launched, evaluated)
	// A completed pass, whether or not any program was enabled. The marker is cleared here and
	// nowhere else, which is what makes "once per episode" mean an episode.
	if err := ledger.StampTick(env.Paths.LastTick, env.Now()); err != nil {
		return err
	}
	return ClearTickFailure(env.Paths.TickFailure)
}

// begin reads the world. The phone's Away is applied to this pass's Control and never written:
// a pass that wrote it would make the toggle sticky after Craig turned it off.
func begin(ctx context.Context, env Env) (pass, error) {
	ps := pass{env: env, now: env.Now()}
	stored, err := control.Read(env.Paths.Control)
	if err != nil {
		return pass{}, err
	}
	ps.stored, ps.channel = stored, channel(env, stored.NotifyTo)
	phone := ps.channel.PhonePrefs(ctx)
	if phone.Warning != nil {
		fmt.Fprintln(env.Err, *phone.Warning)
	}
	ps.control = control.ApplyAwayMode(stored, phone.Away)
	if ps.control.Mode != stored.Mode {
		fmt.Fprintf(env.Out, "mode %s → away for this pass: the phone says away\n", stored.Mode)
	}
	if ps.status, err = teamclaude.Read(ctx, env.TeamclaudeBin); err != nil {
		return pass{}, err
	}
	return ps, nil
}

// reconcile closes or re-attaches orphans, then supersedes abandoned records with late reports
// — before admission, because the next cycle's clearReport deletes the very report this reads,
// so a late outcome has exactly one tick in which to be recovered.
func reconcile(ctx context.Context, ps pass) error {
	p := ps.env.Paths
	cycles, err := ledger.ReadCycles(p.Cycles)
	if err != nil {
		return err
	}
	closed, reattach, err := reconcileAbandoned(ctx, ps.env, ps.now, ps.control, ps.status, cycles)
	if err != nil {
		return err
	}
	if err := appendCycles(p.Cycles, closed); err != nil {
		return err
	}
	for _, program := range reattach {
		if err := Launch(ps.env, program); err != nil {
			return err
		}
	}
	late, err := reconcileLateReports(ctx, ps.env, ps.now, ps.stored, append(cycles, closed...))
	if err != nil {
		return err
	}
	return appendCycles(p.Cycles, late)
}

func appendCycles(path string, records []ledger.Cycle) error {
	for _, rec := range records {
		if err := ledger.AppendRecord(path, rec); err != nil {
			return err
		}
	}
	return nil
}

// sampleUsage records Craig's share of the pool, which nothing reconstructs afterwards — both
// terms are fractions of a window that resets. It feeds no gate.
func sampleUsage(ps pass) {
	if err := usage.Append(ps.env.Paths.Usage, usage.SampleOf(ps.status, ps.now), usage.MaxBytes); err != nil {
		// swallowed: a full disk must cost the measurement, never the tick
		fmt.Fprintf(ps.env.Err, "usage sample not recorded: %s. Admission is unaffected.\n", err)
	}
}

// publish sends `drovr status --json` as the one hey row for the phone's drovr card. Its cycles
// include this pass's launches, so a just-admitted program reads as in flight. The lock holder
// is nil on purpose: the publisher is the holder, so "a tick is evaluating" is true of every row.
func publish(ctx context.Context, ps pass, launched []ledger.Cycle, evaluated map[string]status.Evaluation) {
	text, at, err := statusText(ps, launched, evaluated)
	if err != nil {
		// swallowed: a window onto the tick must not be able to close it
		fmt.Fprintf(ps.env.Err, "status not published: %s. Admission is unaffected.\n", err)
		return
	}
	if ps.channel.PublishStatus(ctx, at, text).Sent {
		// UTF-16 units, as the TS's text.length.
		fmt.Fprintf(ps.env.Out, "status published to hey (%d bytes)\n", len(utf16.Encode([]rune(text))))
	}
}

func statusText(ps pass, launched []ledger.Cycle, evaluated map[string]status.Evaluation) (string, string, error) {
	p := ps.env.Paths
	cycles, err := ledger.ReadCycles(p.Cycles)
	if err != nil {
		return "", "", err
	}
	cycles = append(cycles, launched...)
	evaluations, err := everyEvaluation(p, ps.control, ps.status, cycles, ps.now, evaluated)
	if err != nil {
		return "", "", err
	}
	svc := status.ServiceInput{State: service.Current()}
	if at, ok := ledger.ReadTickStamp(p.LastTick); ok {
		svc.LastTickAt = &at
	}
	payload, err := status.Build(status.Input{
		Control: ps.control, StoredMode: ps.stored.Mode, Status: ps.status, Cycles: cycles,
		Now: ps.env.Now(), Evaluations: evaluations, Service: svc,
	})
	if err != nil {
		return "", "", err
	}
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(payload); err != nil {
		return "", "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), payload.GeneratedAt, nil
}

// admit decides each enabled program in priority order and launches every GO. A same-pass
// launch is folded into the cycles the next program is decided against, which is what
// serializes two admissions in one tick — the concurrency cap, the reservations and the
// same-cwd gate all depend on it.
func admit(ctx context.Context, ps pass) ([]ledger.Cycle, map[string]status.Evaluation, error) {
	c := ps.control
	ordered, err := control.ByPriority(c.Programs, ps.now, c.DeadlineHorizonDays)
	if err != nil {
		return nil, nil, err
	}
	var launched []ledger.Cycle
	evaluated := map[string]status.Evaluation{}
	for _, program := range ordered {
		if !program.Enabled {
			continue
		}
		cycles, err := ledger.ReadCycles(ps.env.Paths.Cycles)
		if err != nil {
			return nil, nil, err
		}
		e, ok, err := evaluate(ctx, ps, program, append(cycles, launched...))
		if err != nil {
			return nil, nil, err
		}
		if !ok {
			continue
		}
		evaluated[program.Name] = e
		if e.Decision.Verdict != "GO" || e.Decision.Pool == nil {
			continue
		}
		if err := Launch(ps.env, program.Name); err != nil {
			return nil, nil, err
		}
		launched = append(launched, projectedStart(program.Name, ps.now, e.Decision.Pool.Snapshot()))
	}
	return launched, evaluated, nil
}

// evaluate decides one program and writes its decision line. ok is false only when the pass
// skipped it (see owedAsks).
func evaluate(ctx context.Context, ps pass, program control.Program, cycles []ledger.Cycle) (status.Evaluation, bool, error) {
	env := ps.env
	var mine []ledger.Cycle
	for _, cy := range cycles {
		if cy.Program == program.Name {
			mine = append(mine, cy)
		}
	}
	answers, ok, err := owedAsks(ctx, ps, program, mine)
	if err != nil || !ok {
		return status.Evaluation{}, false, err
	}
	in := decide.Input{Status: ps.status, Control: ps.control, Cycles: cycles, Program: program.Name, Now: ps.now}
	if answers != nil {
		shared := answers.Shared
		in.AnsweredAt, in.AsksShared = answers.LatestAt, &shared
	}
	// Only the orca runner has an agent to find; a headless one stays unknown, never absent.
	if program.Runner == "orca" {
		inFlight := len(ledger.InFlight(mine, ps.now, ps.control.MaxCycleHours)) > 0
		in.RunnerPresent = runnerAfterLeftover(ctx, env, program.Name, mine, inFlight)
	}
	d, err := decide.Decide(in)
	if err != nil {
		return status.Evaluation{}, false, err
	}
	if err := ledger.AppendRecord(env.Paths.Decisions, DecisionRecord(program.Name, d, ps.now)); err != nil {
		return status.Evaluation{}, false, err
	}
	pid, err := lockPid(env.Paths, program.Name)
	if err != nil {
		return status.Evaluation{}, false, err
	}
	fmt.Fprintf(env.Out, "%s: %s — %s\n", program.Name, d.Verdict, decide.FullReason(d))
	return status.Evaluation{Program: program, Decision: d, Pid: pid}, true, nil
}

// owedAsks polls the asks page only for a program actually waiting on one, and nudges Craig
// when it has waited too long. ok false is a corrupt nudged.json: the TS threw there and lost
// the whole pass; here the one program is skipped with a line saying why — a deliberate small
// improvement, since one program's memory must not stop admission for every program.
func owedAsks(ctx context.Context, ps pass, program control.Program, mine []ledger.Cycle) (*asks.State, bool, error) {
	owed, isOwed := ledger.UnansweredAsks(mine)
	if !isOwed {
		return nil, true, nil
	}
	answers, err := ps.env.Asks.Read(ctx, program, ps.now)
	if err != nil {
		return nil, false, err
	}
	_, err = ps.channel.NudgeIfNeglected(ctx, ps.env.Paths, ps.env.Out, nudge.Neglect{
		Program: program.Name, Asks: owed.Asks, AskedAt: owed.At, Now: ps.now, AfterMinutes: ps.control.NudgeAfterMinutes,
	})
	if err != nil {
		fmt.Fprintf(ps.env.Err, "%s: could not decide whether to nudge about its asks (%s) — skipped this pass; fix or delete %s\n",
			program.Name, err, ps.env.Paths.Nudged(program.Name))
		return nil, false, nil
	}
	return answers, true, nil
}

// runnerAfterLeftover is presence for decide(), after releasing whatever leftoverAction says
// is safe: a runner of a cycle in flight is that cycle's, and anything else is left for Craig.
// Holding a program on a leftover that reported made `drovr release` a daily chore — 100 to
// 250 held ticks a day from 2026-09-23.
func runnerAfterLeftover(ctx context.Context, env Env, program string, mine []ledger.Cycle, cycleInFlight bool) *bool {
	present := runnerStillThere(ctx, env, program)
	if present == nil || !*present || cycleInFlight {
		return present
	}
	held, gone := true, false
	released, err := env.Orca.ReleaseLeftover(ctx, program, ledger.LastCycleReported(mine))
	if err != nil {
		// swallowed: logged; the runner stays present, which holds the program
		fmt.Fprintf(env.Err, "%s: could not release its leftover runner (%s)\n", program, err)
		return &held
	}
	if !released {
		return &held
	}
	fmt.Fprintf(env.Out, "%s: released the runner its last cycle left behind\n", program)
	return &gone
}
