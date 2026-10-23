package cycle

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/nudge"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/profile"
	"github.com/cadam11/drovr/internal/teamclaude"
	"github.com/cadam11/drovr/internal/transcript"
)

const (
	pollInterval    = 30 * time.Second
	maxPollFailures = 20
	// A wake starts a stopped box (a cloud VM, a sleeping Mac); minutes, not seconds.
	wakeTimeout = 6 * time.Minute
	stallPrompt = "[drovr] You have been idle for ten minutes without writing this cycle's report. If the cycle is still viable, continue it. If it is finished or cannot proceed, write your cycle report and stand down."
)

var ErrAlreadyRunning = errors.New("a cycle is already running") // already printed; main exits 1 without a second line

type Limits struct {
	MaxHours                 float64
	StallNudge, BlockedAlert time.Duration
	MaxStallNudges           int
	NotifyTo                 *string
}

func LimitsOf(c control.Control) Limits {
	return Limits{
		MaxHours:       c.MaxCycleHours,
		StallNudge:     time.Duration(c.StallNudgeMinutes * float64(time.Minute)),
		BlockedAlert:   time.Duration(c.BlockedAlertMinutes * float64(time.Minute)),
		MaxStallNudges: int(c.MaxStallNudges),
		NotifyTo:       c.NotifyTo,
	}
}

type Outcome struct {
	Finished                     bool
	Detail                       string
	Stalled, Abandoned, Deferred bool
}

type Worker struct {
	Paths         paths.Paths
	Orca          *orca.Client
	Caller        nudge.CallerFunc
	Host          string
	Home          string // whose ~/.claude/projects holds the transcripts
	TeamclaudeBin string
	Out, Err      io.Writer
	Now           func() epoch.Millis
	Sleep         func(time.Duration)
}

func (w Worker) channel(notifyTo *string) nudge.Channel {
	return nudge.Channel{NotifyTo: notifyTo, Caller: w.Caller, Host: w.Host, Log: w.Err}
}

// RunProgram is the `run-cycle` worker: one cycle of one program, start record to end record.
func (w Worker) RunProgram(ctx context.Context, name string) error {
	if err := paths.EnsureDirs(w.Paths, name); err != nil {
		return err
	}
	path := w.Paths.ProgramLock(name)
	acquired, err := lock.Acquire(path)
	if err != nil {
		return err
	}
	if !acquired {
		pid, _, err := lock.Holder(path)
		if err != nil {
			return err
		}
		fmt.Fprintf(w.Err, "a cycle for %s is already running (pid %d)\n", name, pid)
		return ErrAlreadyRunning
	}
	runErr := w.runProgram(ctx, name)
	if err := lock.Release(path); err != nil {
		return errors.Join(runErr, err)
	}
	return runErr
}

// opened is the identity of the cycle a worker records: a fresh one, or the open record of
// one whose watcher died with its runner still there.
type opened struct {
	startedAt, sessionID, kind string
	before                     control.Cost
	resumed                    bool
}

func (w Worker) runProgram(ctx context.Context, name string) error {
	c, err := control.Read(w.Paths.Control)
	if err != nil {
		return err
	}
	program, ok := c.Program(name)
	if !ok {
		return fmt.Errorf("no program named %q in %s", name, w.Paths.Control)
	}
	ceilings, on, err := control.CeilingsFor(c)
	if err != nil {
		return err
	}
	if !on {
		return errors.New("mode is off")
	}
	o, err := w.open(ctx, c, name, ceilings)
	if err != nil {
		return err
	}
	if !o.resumed {
		if err := ledger.AppendRecord(w.Paths.Cycles, startRecord(name, o)); err != nil {
			return err
		}
	} else {
		fmt.Fprintf(w.Out, "%s: re-attaching to the cycle started %s — its watcher died with the runner still there\n", name, o.startedAt)
	}
	// Anything between the start record and the end record can fail — a missing binary, an
	// orca error, a lost worktree. Without an end record the cycle stays "in flight" forever,
	// blocking its own program and holding a concurrency slot.
	outcome := w.watchOrRun(ctx, program, o, LimitsOf(c))
	return w.finish(ctx, c, program, ceilings, o, outcome)
}

// open: an open record with nobody holding the lock is a cycle that lost its watcher, not its
// runner, so its record is picked back up rather than a second opened on top of it.
func (w Worker) open(ctx context.Context, c control.Control, name string, ceilings control.Ceiling) (opened, error) {
	cycles, err := ledger.ReadCycles(w.Paths.Cycles)
	if err != nil {
		return opened{}, err
	}
	for _, r := range ledger.InFlight(cycles, w.Now(), c.MaxCycleHours) {
		if r.Program != name {
			continue
		}
		o := opened{startedAt: r.StartedAt, kind: r.Kind, before: r.PoolBefore, resumed: true}
		if r.SessionID != nil {
			o.sessionID = *r.SessionID
			return o, nil
		}
		// The TS mints a fresh id when the open record carries none (?? randomUUID()).
		o.sessionID, err = NewSessionID()
		return o, err
	}
	sessionID, err := NewSessionID()
	if err != nil {
		return opened{}, err
	}
	kind := "delivery"
	if IsOnboarding(w.Paths, name) {
		kind = "onboarding"
	}
	before, err := w.poolSnapshot(ctx, ceilings)
	return opened{startedAt: epoch.ISO(w.Now()), sessionID: sessionID, kind: kind, before: before}, err
}

func (w Worker) poolSnapshot(ctx context.Context, ceilings control.Ceiling) (control.Cost, error) {
	status, err := teamclaude.Read(ctx, w.TeamclaudeBin)
	if err != nil {
		return control.Cost{}, err
	}
	return capacity.PoolFrom(status, ceilings, w.Now()).Snapshot(), nil
}

func startRecord(name string, o opened) ledger.Cycle {
	sessionID := o.sessionID
	return ledger.Cycle{V: 1, Kind: o.kind, Program: name, StartedAt: o.startedAt, Exit: "running", PoolBefore: o.before, SessionID: &sessionID}
}

// watchOrRun turns every failure into an outcome, so the end record is always written.
func (w Worker) watchOrRun(ctx context.Context, program control.Program, o opened, l Limits) Outcome {
	var outcome Outcome
	var err error
	if o.resumed {
		outcome, err = w.ResumeCycle(ctx, program, l)
	} else {
		outcome, err = w.RunCycle(ctx, program, o.startedAt, o.sessionID, l)
	}
	if err == nil {
		return outcome
	}
	// A busy pane is not a failure: the cycle never started and nothing is wrong.
	if busy, ok := errors.AsType[*orca.PaneBusy](err); ok {
		fmt.Fprintf(w.Out, "%s: %s\n", program.Name, busy.Error())
		return Outcome{Detail: busy.Error(), Deferred: true}
	}
	fmt.Fprintf(w.Err, "cycle for %s failed to run: %s\n", program.Name, err)
	return Outcome{Finished: true, Detail: err.Error()}
}

func (w Worker) readReportOrWarn(ctx context.Context, program control.Program) *Report {
	return ReadReportOrWarn(ctx, w.Paths, program, w.Err)
}

// ReadReportOrWarn is both tick-side readers' and the worker's: each must make progress past a
// malformed last-cycle.json. In the worker a throw skips the end record and charges the cycle
// as running forever; in the tick it stops everything after it, admission included, every
// tick until someone deletes the file by hand. Logged and read as absent.
func ReadReportOrWarn(ctx context.Context, p paths.Paths, program control.Program, log io.Writer) *Report {
	r, err := ReadReport(ctx, SourceFor(p, program))
	if err != nil {
		// swallowed: logged; a malformed report costs one program's reading, never the pass
		fmt.Fprintf(log, "ignoring unreadable cycle report for %s: %s\n", program.Name, err)
		return nil
	}
	return r
}

func (w Worker) finish(ctx context.Context, c control.Control, program control.Program, ceilings control.Ceiling, o opened, outcome Outcome) error {
	name := program.Name
	report := w.readReportOrWarn(ctx, program)
	after, err := w.poolSnapshot(ctx, ceilings)
	if err != nil {
		return err
	}
	end := startRecord(name, o)
	endedAt := epoch.ISO(w.Now())
	end.EndedAt, end.PoolAfter = &endedAt, &after
	end.Exit = UnreportedExit(outcome.Deferred, outcome.Stalled, outcome.Abandoned)
	if report != nil {
		end.Exit, end.StartupTokens, end.Yield, end.AsksRaised, end.PauseUntil = report.Exit, report.StartupTokens, report.Yield, report.AsksRaised, report.PauseUntil
	}
	// Only a cycle drovr saw end has a closing; an abandoned runner is still talking.
	if outcome.Finished {
		if end.Closing, err = transcript.ClosingMessage(ctx, w.Home, o.sessionID, program.Host, w.Err); err != nil {
			return err
		}
	}
	if err := ledger.AppendRecord(w.Paths.Cycles, end); err != nil {
		return err
	}
	// A stalled runner was nudged and stayed silent, so Craig is the only one left who can
	// tell whether the program is wedged or simply had nothing to say.
	if outcome.Stalled {
		fmt.Fprintf(w.Err, "cycle for %s stalled — recorded as stalled. %s\n", name, outcome.Detail)
		message := fmt.Sprintf("drovr: %s stalled — its runner idled through %v nudges without writing a report. Its pane is free and the next tick starts a fresh cycle.", name, c.MaxStallNudges)
		w.channel(c.NotifyTo).TextCraig(ctx, message, name) // swallowed: best-effort; TextCraig logs its own failure
	}
	if report == nil && !outcome.Deferred && !outcome.Stalled && !outcome.Abandoned {
		fmt.Fprintf(w.Err, "cycle for %s produced no report — recorded as crash. %s\n", name, outcome.Detail)
	}
	return nil
}

// RunCycle returns once the cycle finishes or the watch window expires; cycles run for hours.
func (w Worker) RunCycle(ctx context.Context, program control.Program, startedAt, sessionID string, l Limits) (Outcome, error) {
	if err := paths.EnsureDirs(w.Paths, program.Name); err != nil {
		return Outcome{}, err
	}
	// The box must be up before anything touches it: the report clear below rides ssh too.
	if program.Host != nil {
		if err := w.ensureReachable(ctx, program, *program.Host); err != nil {
			return Outcome{}, err
		}
	}
	if err := SourceFor(w.Paths, program).Clear(ctx); err != nil {
		return Outcome{}, err
	}
	if program.Runner == "headless" {
		return w.runHeadless(ctx, program, startedAt, l)
	}
	return w.runInOrca(ctx, program, startedAt, sessionID, l)
}

// ResumeCycle picks the watch back up for a cycle whose worker died with its runner still
// there. No clear: a report the runner has written since is this cycle's outcome, not a
// leftover. No start record and no new terminal either.
func (w Worker) ResumeCycle(ctx context.Context, program control.Program, l Limits) (Outcome, error) {
	return w.watchCycle(ctx, program.Name, SourceFor(w.Paths, program), l)
}

// unreachableReason is nil when `ssh <target> true` answered; otherwise why it did not.
func unreachableReason(ctx context.Context, h control.Host) *string {
	if _, err := exec.RunSsh(ctx, h.SSH, "true", sshTimeout); err != nil {
		reason := err.Error()
		return &reason
	}
	return nil
}

// ensureReachable: a stopped box is the normal state between cycles, not a fault, so the wake
// runs here before anything asks orca for the worktree. Probed once more afterwards; still
// dark is an error the crash path records.
func (w Worker) ensureReachable(ctx context.Context, program control.Program, h control.Host) error {
	reason := unreachableReason(ctx, h)
	if link := TailscaleCheckLink(reason); link != nil {
		return fmt.Errorf("%s holds ssh on a Tailscale SSH check; visit %s, or set the box's ssh rule to \"accept\" in the tailnet ACL so unattended wakes work", h.SSH, *link)
	}
	switch WakeDecision(reason == nil, h.Wake) {
	case "proceed":
		return nil
	case "fail":
		return fmt.Errorf("%s is unreachable (%s) and %s has no wake command. Start the box, or set one:  drovr host %s --wake '<command>'", h.SSH, *reason, program.Name, program.Name)
	}
	wake := *h.Wake
	fmt.Fprintf(w.Out, "%s: %s is unreachable (%s) — waking it: %s\n", program.Name, h.SSH, *reason, wake)
	if _, err := exec.RunBounded(ctx, "sh", []string{"-c", wake}, exec.Bounds{Timeout: wakeTimeout, Label: wake}); err != nil {
		return err
	}
	if after := unreachableReason(ctx, h); after != nil {
		return fmt.Errorf("%s is still unreachable after `%s` returned: %s", h.SSH, wake, *after)
	}
	return nil
}

// runHeadless is the fallback: claude -p to a log file, nothing to talk to. The child is
// detached and watched, never bounded: drovr never kills a cycle, so at maxCycleHours the
// watch ends as abandoned and the child keeps running, exactly as an orca runner does.
func (w Worker) runHeadless(ctx context.Context, program control.Program, startedAt string, l Limits) (Outcome, error) {
	logPath := filepath.Join(w.Paths.Logs, program.Name+"-"+strings.ReplaceAll(startedAt, ":", "-")+".log")
	argv := []string{"sh", "-c", Substitute(program.CycleCommand, program, IsOnboarding(w.Paths, program.Name))}
	if program.UseDirenv {
		argv = append([]string{"direnv", "exec", program.Cwd}, argv...)
	}
	pid, err := exec.Detach(argv[0], argv[1:], logPath, program.Cwd, []string{"DROVR_PROGRAM=" + program.Name})
	if err != nil {
		return Outcome{}, err
	}
	return w.watchHeadless(ctx, program, pid, logPath, l)
}

// watchHeadless polls on the orca watch's cadence for the report or the child being gone.
func (w Worker) watchHeadless(ctx context.Context, program control.Program, pid int, logPath string, l Limits) (Outcome, error) {
	source := SourceFor(w.Paths, program)
	deadline := w.Now() + epoch.Millis(l.MaxHours*3_600_000)
	maxPolls := int(l.MaxHours*3600/pollInterval.Seconds()) + 1
	for range maxPolls {
		if w.Now() >= deadline {
			break
		}
		w.Sleep(pollInterval)
		text, err := source.Read(ctx)
		if err != nil {
			return Outcome{}, err
		}
		report, err := ReportFromPoll(text, source.Label)
		if err != nil {
			return Outcome{}, err
		}
		if report != nil {
			return Outcome{Finished: true, Detail: "headless runner reported, log at " + logPath}, nil
		}
		exited, code, err := exec.Reap(pid)
		if err != nil {
			return Outcome{}, err
		}
		if exited {
			return Outcome{Finished: true, Detail: fmt.Sprintf("headless runner exited %d, log at %s", code, logPath)}, nil
		}
	}
	return outlivedWatch(l.MaxHours, fmt.Sprintf("its headless runner (pid %d, log at %s)", pid, logPath)), nil
}

type currentCycle struct {
	Handle     string `json:"handle"`
	TabID      string `json:"tabId"`
	WorktreeID string `json:"worktreeId"`
	Prompt     string `json:"prompt"`
	StartedAt  string `json:"startedAt"`
}

// runInOrca opens the cycle as an interactive claude in a terminal of the program's own Orca
// worktree, so Craig can read it and talk to it mid-cycle. drovr does not own the process, so
// completion is detected from the runner's own report or the agent disappearing — never by
// killing anything.
func (w Worker) runInOrca(ctx context.Context, program control.Program, startedAt, sessionID string, l Limits) (Outcome, error) {
	worktreeID, err := w.Orca.ResolveWorktree(ctx, program)
	if err != nil {
		return Outcome{}, err
	}
	onboarding := IsOnboarding(w.Paths, program.Name)
	prompt := Substitute(program.CyclePrompt, program, onboarding)
	command := LaunchArgv(program, Substitute(program.SessionName, program, onboarding), sessionID)
	started, err := w.Orca.StartCycleAgent(ctx, orca.StartInput{Program: program, WorktreeID: worktreeID, Command: command, Prompt: prompt})
	if err != nil {
		return Outcome{}, err
	}
	body, err := json.MarshalIndent(currentCycle{started.Handle, started.TabID, worktreeID, prompt, startedAt}, "", "  ")
	if err != nil {
		return Outcome{}, err
	}
	if err := os.WriteFile(w.Paths.CurrentCycle(program.Name), append(body, '\n'), 0o644); err != nil {
		return Outcome{}, err
	}
	// After the terminal is up, before the watch: the profile is for the thread this cycle's
	// alerts land in, and nothing about it may delay the launch.
	profile.Seed(ctx, profile.SeedInput{Paths: w.Paths, Orca: w.Orca, Caller: w.Caller, NotifyTo: l.NotifyTo, Program: program, Out: w.Out, Err: w.Err, Now: w.Now()})
	return w.watchCycle(ctx, program.Name, SourceFor(w.Paths, program), l)
}
