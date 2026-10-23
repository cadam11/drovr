package cycle

import (
	"context"
	"fmt"
	"math"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/orca"
)

// watchState is what the watch remembers between polls.
type watchState struct {
	idleSince, blockedSince *epoch.Millis
	nudges, failures        int
	alerted                 bool
}

// watchCycle watches a started cycle until it reports, vanishes, stalls out, or runs out of
// clock. drovr does not own the process, so every one of those is observed rather than waited
// on: there is no exit code to read. Bounded by its deadline and, explicitly, by the number of
// polls that deadline allows: a wedged runner must not hold its capacity slot indefinitely.
func (w Worker) watchCycle(ctx context.Context, program string, source Source, l Limits) (Outcome, error) {
	deadline := w.Now() + epoch.Millis(l.MaxHours*3_600_000)
	maxPolls := int(l.MaxHours*3600/pollInterval.Seconds()) + 1
	s := &watchState{}
	for range maxPolls {
		if w.Now() >= deadline {
			break
		}
		w.Sleep(pollInterval)
		text, state, ok := w.poll(ctx, program, source)
		if !ok {
			s.failures++
			if s.failures >= maxPollFailures {
				return lostSight(program, s.failures), nil
			}
			continue
		}
		s.failures = 0
		report, err := ReportFromPoll(text, source.Label)
		if err != nil {
			return Outcome{}, err
		}
		if report != nil {
			return w.releaseFinished(ctx, program), nil
		}
		if state == orca.Gone {
			return Outcome{Finished: true, Detail: "the runner is no longer present in " + w.Orca.RunnerAddress(ctx, program).Where}, nil
		}
		if out, done := w.react(ctx, program, l, s, state); done {
			return out, nil
		}
	}
	// Not `crash`. The runner is alive and may still be minutes from writing its report;
	// drovr has simply run out of watch. Saying "crash" here asserted that a cycle which
	// often *had* delivered produced nothing, and discarded the quota sample of the longest
	// and most expensive cycles there are. The tick reconciles a report that lands later.
	return outlivedWatch(l.MaxHours, program+"'s terminal"), nil
}

func outlivedWatch(maxHours float64, leftInPlace string) Outcome {
	return Outcome{Abandoned: true, Detail: fmt.Sprintf("still watching after %vh and the runner is still alive — %s left in place. Recorded as abandoned, not crashed; if it writes a report the next tick supersedes this record with the real outcome", maxHours, leftInPlace)}
}

// poll reads the report, then the runner's state. Over ssh the report read can fail like an
// orca call can; both count as one lost poll. Logged, never swallowed: the caller counts it
// toward maxPollFailures, because one failed poll must not end the watch (measured
// 2026-10-01 to 10-05: six live cycles recorded as crash by one slow orca call each).
func (w Worker) poll(ctx context.Context, program string, source Source) (*string, orca.AgentState, bool) {
	text, err := source.Read(ctx)
	if err != nil {
		fmt.Fprintf(w.Err, "%s: could not read its report (%s) — still watching\n", program, err)
		return nil, "", false
	}
	state, err := w.Orca.RunnerState(ctx, program)
	if err != nil {
		fmt.Fprintf(w.Err, "%s: could not read its runner's state (%s) — still watching\n", program, err)
		return nil, "", false
	}
	return text, state, true
}

func since(now epoch.Millis, at *epoch.Millis) time.Duration {
	if at == nil {
		return 0
	}
	return time.Duration(now-*at) * time.Millisecond
}

// react is the stall policy for one poll of a live runner with no report: done when the watch ends.
func (w Worker) react(ctx context.Context, program string, l Limits, s *watchState, state orca.AgentState) (Outcome, bool) {
	now := w.Now()
	s.idleSince = sinceIf(state == orca.Idle, s.idleSince, now)
	// Cleared when it moves, so answering the dialog re-arms the alert for the next one. A
	// twelve-hour cycle can hit several, and only the first was ever going to be free.
	s.blockedSince = sinceIf(state == orca.Blocked, s.blockedSince, now)
	if state != orca.Blocked {
		s.alerted = false
	}
	action := StallAction(StallInput{
		State: state, IdleFor: since(now, s.idleSince), NudgesSent: s.nudges, NudgeAfter: l.StallNudge,
		MaxNudges: l.MaxStallNudges, BlockedFor: since(now, s.blockedSince), BlockedAlertAfter: l.BlockedAlert, Alerted: s.alerted,
	})
	switch action {
	case "give-up":
		return w.abandonStalled(ctx, program, s.nudges), true
	case "alert":
		// Marked before sending, not after: a send that fails must not turn a one-off request
		// for help into a text every poll for the rest of the cycle.
		s.alerted = true
		w.askForHuman(ctx, program, since(now, s.blockedSince), l)
	case "nudge":
		// Counted and the clock reset even when the send fails, so an orca that is refusing
		// prompts cannot turn the nudge budget into a 30-second retry loop.
		s.nudges++
		s.idleSince = nil
		if err := w.Orca.PromptRunner(ctx, program, stallPrompt); err != nil {
			fmt.Fprintf(w.Err, "could not nudge %s: %s\n", program, err)
		}
		fmt.Fprintf(w.Out, "%s: idle with no report — nudged it (%d/%d)\n", program, s.nudges, l.MaxStallNudges)
	}
	return Outcome{}, false
}

// sinceIf keeps the first instant a condition held, and forgets it once it stops holding.
func sinceIf(holds bool, at *epoch.Millis, now epoch.Millis) *epoch.Millis {
	if !holds {
		return nil
	}
	if at == nil {
		return &now
	}
	return at
}

// releaseFinished: the report exists, so the cycle has declared itself done and the terminal
// is cleanup. An interactive session cannot end itself; skip this and the pane stays occupied
// and the next cycle is refused.
func (w Worker) releaseFinished(ctx context.Context, program string) Outcome {
	released, err := w.Orca.ReleaseRunner(ctx, program, orca.DefaultSettleAttempts)
	if err == nil && released { // swallowed: TS .catch(() => false) — a failed release reads as not released
		return Outcome{Finished: true, Detail: "runner reported in and its terminal was released for the next cycle"}
	}
	a := w.Orca.RunnerAddress(ctx, program)
	return Outcome{Finished: true, Detail: fmt.Sprintf("runner reported in but its session still holds %s — the next cycle will refuse until it is freed with `drovr release %s`.%s", a.Where, program, orca.OpenLine(a))}
}

// abandonStalled: out of nudges. Free the terminal so the next tick starts clean rather than deferring.
func (w Worker) abandonStalled(ctx context.Context, program string, nudges int) Outcome {
	detail := fmt.Sprintf("runner sat idle through %d nudges without writing a report", nudges)
	released, err := w.Orca.ReleaseRunner(ctx, program, orca.DefaultSettleAttempts)
	if err == nil && released { // swallowed: TS .catch(() => false) — a failed release reads as not released
		detail += " — its terminal was released for a fresh cycle"
	} else {
		a := w.Orca.RunnerAddress(ctx, program)
		detail += " — its session still holds " + a.Where + orca.OpenLine(a)
	}
	return Outcome{Finished: true, Stalled: true, Detail: detail}
}

// askForHuman is the only escalation drovr has for a state it cannot resolve itself. A dialog
// in the pane stops the cycle dead and no amount of waiting or prompting clears it, so the
// message says where to go rather than what happened. The log line is written first — an
// alert that fails to reach a handset must still be recoverable from the worker log.
func (w Worker) askForHuman(ctx context.Context, program string, blockedFor time.Duration, l Limits) {
	minutes := int64(math.Round(blockedFor.Minutes()))
	a := w.Orca.RunnerAddress(ctx, program)
	message := fmt.Sprintf("drovr: %s has been waiting %dm on a dialog in its terminal — a permission prompt or a trust question. Only you can clear it. Open %s in orca and answer it; the cycle carries on from there. It holds its terminal until you do.%s", program, minutes, a.Where, orca.OpenLine(a))
	fmt.Fprintf(w.Err, "%s: blocked %dm on a dialog — asked Craig to clear it\n", program, minutes)
	// swallowed: an alert that fails must still be in the worker log, and the watch carries on — TextCraig logs its own failure
	w.channel(l.NotifyTo).TextCraig(ctx, message, program)
}

// lostSight: orca (or the host) stopped answering for long enough that drovr cannot say what
// the runner is doing. `abandoned`, like the deadline: a statement about the watch, not the
// cycle, so a report the runner writes later is reconciled by the next tick rather than lost
// under a crash.
func lostSight(program string, failures int) Outcome {
	return Outcome{Abandoned: true, Detail: fmt.Sprintf("lost sight of %s's runner after %d failed polls in a row — neither its report nor its terminal could be read. Recorded as abandoned, not crashed; if it writes a report the next tick supersedes this record with the real outcome", program, failures)}
}
