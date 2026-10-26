package watch

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"syscall"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/exec"
	keyset "github.com/cadam11/drovr/internal/keys"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/paths"
)

// openTimeout bounds macOS `open`, which hands the URL to the browser and returns at once;
// the TS fired it detached and never waited at all.
const openTimeout = 5 * time.Second

// outcome is the TS Action of an intent whose message is only known after its I/O.
type outcome struct {
	message       string
	redraw, fresh bool
}

// execute does the I/O half of an intent; ran is false for the pure intents, whose view
// DecideKey already settled. An error is fatal: the TS let these throw into die.
func (w *watcher) execute(ctx context.Context, in Intent, ctl control.Control, programs []control.Program) (outcome, bool, error) {
	var out outcome
	var err error
	switch in.Kind {
	case IntentSetMode, IntentTogglePause, IntentExtendPause, IntentToggleEnabled,
		IntentNudgePriority, IntentAdjustConcurrency, IntentNudgeReserve:
		out, err = w.setting(in, ctl)
	case IntentTickNow:
		out, err = w.tickNow()
	case IntentStartCycle:
		out, err = w.startCycle(in.Program)
	case IntentInterrupt:
		out, err = w.stop(ctx, in.Program, programs)
	case IntentReleaseLeftover:
		out, err = w.release(ctx, in.Program)
	case IntentArmStart:
		out, err = w.armStart(in.Program)
	case IntentOpenAsks:
		out, err = w.open(ctx, in.URL)
	default:
		return outcome{}, false, nil
	}
	return out, true, err
}

func (w *watcher) setting(in Intent, ctl control.Control) (outcome, error) {
	path := w.deps.Paths.Control
	var a keyset.Action
	var err error
	switch in.Kind {
	case IntentSetMode:
		a, err = keyset.CycleMode(path, ctl.Mode)
	case IntentTogglePause:
		a, err = keyset.CyclePause(path, ctl.PauseUntil, w.deps.Now())
	case IntentExtendPause:
		a, err = keyset.ExtendPause(path, ctl.PauseUntil, w.deps.Now())
	case IntentToggleEnabled:
		a, err = keyset.ToggleEnabled(path, in.Program)
	case IntentNudgePriority:
		a, err = keyset.NudgePriority(path, in.Program, float64(in.Delta))
	case IntentAdjustConcurrency:
		a, err = keyset.AdjustConcurrency(path, float64(in.Delta))
	case IntentNudgeReserve:
		a, err = keyset.SetReserve(path, string(ctl.Mode), reserveFor(ctl, in.Delta))
	}
	return outcome{message: a.Message, redraw: a.Redraw, fresh: a.Fresh}, err
}

// reserveFor is the TS's `ceilings[mode]?.weekly ?? 0.55`: `off` has no ceiling, so a
// reserve key there writes one — a quirk kept, not a ruling.
func reserveFor(ctl control.Control, delta int) float64 {
	weekly := 0.55
	if c, ok := ctl.Ceilings[string(ctl.Mode)]; ok {
		weekly = c.Weekly
	}
	if delta < 0 {
		return 1 - weekly - 0.05
	}
	return 1 - weekly + 0.05
}

// tickNow detaches a live tick into the tick log (R3); it takes the tick lock like any
// launchd firing.
func (w *watcher) tickNow() (outcome, error) {
	if err := paths.EnsureDirs(w.deps.Paths, ""); err != nil {
		return outcome{}, err
	}
	if _, err := w.deps.Detach(w.deps.Self, []string{"tick"}, filepath.Join(w.deps.Paths.Logs, "tick.log"), "", nil); err != nil {
		return outcome{}, err
	}
	return outcome{message: "tick launched", redraw: true}, nil
}

// startCycle is `drovr start` past every gate, behind its y-confirmation (R3: the worker
// directly, without the `drovr start` hop).
func (w *watcher) startCycle(name string) (outcome, error) {
	if err := w.deps.Launch(name); err != nil {
		return outcome{}, err
	}
	return outcome{message: name + ": cycle launched", redraw: true}, nil
}

// stop interrupts an orca runner rather than killing it, so it can wind down and report;
// a headless runner has no such affordance, so its process group is signalled.
func (w *watcher) stop(ctx context.Context, name string, programs []control.Program) (outcome, error) {
	i := slices.IndexFunc(programs, func(p control.Program) bool { return p.Name == name })
	if i < 0 {
		return outcome{}, fmt.Errorf("no program named \"%s\"", name)
	}
	if programs[i].Runner == "orca" {
		if err := w.deps.Orca.InterruptRunner(ctx, name); err != nil {
			return outcome{message: fmt.Sprintf("could not interrupt %s: %s", name, err)}, nil
		}
		return outcome{message: fmt.Sprintf("interrupted %s — it can still wind down cleanly", name), redraw: true}, nil
	}
	pid, held, err := lock.Holder(w.deps.Paths.ProgramLock(name))
	if err != nil {
		return outcome{}, err
	}
	if !held {
		return outcome{message: name + " has no cycle running"}, nil
	}
	if err := syscall.Kill(-pid, syscall.SIGTERM); err != nil {
		return outcome{message: fmt.Sprintf("could not stop %s: %s", name, err)}, nil
	}
	return outcome{message: fmt.Sprintf("sent SIGTERM to %s (pid %d)", name, pid), redraw: true}, nil
}

// release is the tick's own leftover rule on demand; refused while a cycle runs, since
// that runner is the cycle's. The headless refusal is DecideKey's.
func (w *watcher) release(ctx context.Context, name string) (outcome, error) {
	_, held, err := lock.Holder(w.deps.Paths.ProgramLock(name))
	if err != nil {
		return outcome{}, err
	}
	if held {
		return outcome{message: name + " has a cycle running — its runner is released when it reports"}, nil
	}
	released, err := w.releaseIfSafe(ctx, name)
	if err != nil {
		return outcome{message: fmt.Sprintf("could not release %s: %s", name, err)}, nil
	}
	if released {
		return outcome{message: fmt.Sprintf("released %s's runner — the next tick can start a cycle", name), redraw: true, fresh: true}, nil
	}
	return outcome{message: fmt.Sprintf("left %s's runner alone — it is busy, its cycle never reported, or it already "+
		"ignored one /exit. Check its tab; \"drovr release %s\" overrides", name, name)}, nil
}

func (w *watcher) releaseIfSafe(ctx context.Context, name string) (bool, error) {
	cycles, err := ledger.ReadCycles(w.deps.Paths.Cycles)
	if err != nil {
		return false, err
	}
	mine := slices.DeleteFunc(cycles, func(c ledger.Cycle) bool { return c.Program != name })
	return w.deps.Orca.ReleaseLeftover(ctx, name, ledger.LastCycleReported(mine))
}

// armStart refuses to arm over a running cycle: the lock is I/O DecideKey cannot do.
func (w *watcher) armStart(name string) (outcome, error) {
	pid, held, err := lock.Holder(w.deps.Paths.ProgramLock(name))
	if err != nil {
		return outcome{}, err
	}
	if held {
		return outcome{message: fmt.Sprintf("%s already has a cycle running (pid %d)", name, pid)}, nil
	}
	w.view = ArmStart(w.view, name)
	return outcome{message: w.view.Message, redraw: true}, nil
}

func (w *watcher) open(ctx context.Context, url string) (outcome, error) {
	if _, err := w.deps.Run(ctx, "open", []string{url}, exec.Bounds{Timeout: openTimeout, Label: "open " + url}); err != nil {
		return outcome{}, err
	}
	return outcome{message: "opened " + url, redraw: true}, nil
}
