package tick

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/nudge"
)

// DurationText is minutes until a minute is the wrong unit — decide's untilText rule. "held
// 0m" for a ten-second hold and "overran 1m" for a thirty-second budget would both contradict
// the number they were given.
func DurationText(ms int64) string {
	if ms < 60_000 {
		return fmt.Sprintf("%ss", jsnum.String(jsnum.RoundHalfUp(float64(ms)/1000)))
	}
	return fmt.Sprintf("%sm", jsnum.String(jsnum.RoundHalfUp(float64(ms)/60_000)))
}

// FailedTickText is what a failed pass says on a lock screen: one line, naming what stopped,
// what it costs, and the literal command that shows the rest. A status-shape failure's own
// message is multi-line JSON, so only its first line survives.
func FailedTickText(err error) string {
	first, _, _ := strings.Cut(err.Error(), "\n")
	return "drovr: a tick failed, so no program can start until one completes — " + jsnum.Slice(first, 140) +
		" See it: tail -40 ~/.drovr/logs/tick.err"
}

// RecordTickFailure writes the episode marker and answers whether this failure began the
// episode. Once per episode, never per tick: launchd fires every ten minutes, so an afternoon's
// outage would otherwise be an afternoon of texts. O_EXCL makes "exists" and "write" one step.
func RecordTickFailure(markerPath string, at epoch.Millis, err error) (bool, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if encErr := enc.Encode(struct {
		At     string `json:"at"`
		Reason string `json:"reason"`
	}{epoch.ISO(at), err.Error()}); encErr != nil {
		return false, encErr
	}
	file, openErr := os.OpenFile(markerPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if errors.Is(openErr, fs.ErrExist) {
		return false, nil
	}
	if openErr != nil {
		return false, openErr
	}
	_, writeErr := file.Write(buf.Bytes())
	return true, errors.Join(writeErr, file.Close())
}

// ClearTickFailure ends the episode; most passes clear nothing, which is not an error.
func ClearTickFailure(markerPath string) error {
	if err := os.Remove(markerPath); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

func channel(env Env, notifyTo *string) nudge.Channel {
	caller := env.Caller
	if caller == nil {
		caller = nudge.DefaultCaller
	}
	return nudge.Channel{NotifyTo: notifyTo, Caller: caller, Host: env.Host, Log: env.Err}
}

// Run is Tick plus the alert a failed pass owes Craig. Measured 2026-09-14: five consecutive
// passes died on a teamclaude payload and drovr decided nothing for an hour, its only trace a
// line in tick.err. Wrapped around Tick rather than inside it so the tick lock is already
// released before the send, and the original error is returned so the exit code still fails —
// this reports the failure, it does not absorb it. A shadow failure is the error alone: the
// episode marker and the alert belong to the live tick, which Craig depends on.
func Run(ctx context.Context, env Env) error {
	err := Tick(ctx, env)
	if err == nil || env.Shadow {
		return err
	}
	began, markErr := RecordTickFailure(env.Paths.TickFailure, env.Now(), err)
	if markErr != nil {
		fmt.Fprintf(env.Err, "could not mark the failed tick: %s\n", markErr)
	}
	if began {
		alertFailedTick(ctx, env, err)
	}
	return err
}

// alertFailedTick's line is the point: tick.err records drovr having tried to speak, since the
// failure this exists for is the one nothing said anything about.
func alertFailedTick(ctx context.Context, env Env, failure error) {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		fmt.Fprintf(env.Err, "could not alert the failed tick: %s\n", err)
		return
	}
	sent := channel(env, c.NotifyTo).TextCraig(ctx, FailedTickText(failure), nudge.AlertFrom(nil, env.Host))
	if sent.Sent {
		id := ""
		if sent.MessageID != nil {
			id = *sent.MessageID
		}
		fmt.Fprintf(env.Err, "alerted the failed tick: hey %s.\n", id)
		return
	}
	reason := "hey did not take it"
	if sent.Reason != nil {
		reason = *sent.Reason
	}
	fmt.Fprintf(env.Err, "could not alert the failed tick: %s.\n", reason)
}

// ReleaseOverrunningTick is everything the watchdog does except exit. The order is the
// guarantee: freeing the lock is the job, so it comes first and each later step is separately
// guarded. An earlier draft read control.json for the phone number before releasing, so a
// malformed control file threw inside the timer and left the lock held — the state this
// exists to end. The holder releasing itself is the only way a wedged lock clears; lock never
// steals from a live holder, since two concurrent ticks race the ledger and double-launch.
func ReleaseOverrunningTick(ctx context.Context, env Env, lockPath string, budget time.Duration) string {
	message := fmt.Sprintf("drovr: a tick overran %s and was aborted (pid %d). Its lock is released, so the next firing runs. Check ~/.drovr/logs/tick.err.",
		DurationText(budget.Milliseconds()), os.Getpid())
	fmt.Fprintln(env.Err, message)
	if err := lock.Release(lockPath); err != nil {
		fmt.Fprintf(env.Err, "could not release the tick lock: %s\n", err)
	}
	if env.Shadow {
		return message // a stopped shadow costs a comparison, never a 4am text
	}
	// An unattended supervisor that has stopped must say so somewhere Craig sees at 4am.
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		fmt.Fprintf(env.Err, "could not text the overrun: %s\n", err)
		return message
	}
	channel(env, c.NotifyTo).TextCraig(ctx, message, nudge.AlertFrom(nil, env.Host))
	return message
}
