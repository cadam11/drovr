// Package nudge is drovr's one alert channel to Craig, over hey; port of src/nudge.ts.
// Every call is best-effort: an unreachable shim must never take down a tick or a cycle, so
// failure is logged and reported as a reason rather than returned as an error. Each request is
// bounded by the hey client's own 15 s and a call is at most refresh+call+refresh+call.
package nudge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/user"
	"strconv"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/paths"
)

type CallerFunc func() (hey.Call, error)

// DefaultCaller signs in from the user's HOME: the tick runs as Craig under launchd, so its
// HOME is the one a terminal's `hey login` wrote.
func DefaultCaller() (hey.Call, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil, err
	}
	return hey.DefaultCaller(home)
}

// Channel is a Recipient plus what a send needs. The Caller is built inside every guard,
// because a malformed ~/.config/hey.json must be a reason, never a throw into the tick.
type Channel struct {
	NotifyTo *string
	Caller   CallerFunc
	Host     string
	Log      io.Writer
}

// SendResult.Via is always "hey"; Reason says why Sent is false, so no caller prints "see above".
type SendResult struct {
	Sent      bool
	MessageID *string
	Via       string
	Reason    *string
}

type PublishResult struct {
	Sent   bool
	Reason *string
}

type PhonePrefs struct {
	Away    bool
	Warning *string
}

type Neglect struct {
	Program      string
	Asks         float64
	AskedAt, Now epoch.Millis
	AfterMinutes float64
	AsksURL      *string
}

// AlertFrom is the `from` label the app groups a thread by: the program, or drovr on this machine.
func AlertFrom(program *string, host string) string {
	if program != nil {
		return *program
	}
	return "drovr on " + host
}

func signInHint(err error) string {
	if !errors.Is(err, hey.ErrNotSignedIn) {
		return ""
	}
	// swallowed: a hint is decoration on an error already being reported; $USER stands in when the lookup fails
	name := os.Getenv("USER")
	if u, uerr := user.Current(); uerr == nil {
		name = u.Username
	}
	return " — run hey login in a terminal as " + name + ", so the tick's HOME has the credentials file"
}

func ptr(s string) *string { return &s }

// TextCraig is the one place drovr alerts Craig. `from` is required, never defaulted: a caller
// that forgets it would file every alert under one anonymous thread. A send is never retried.
func (c Channel) TextCraig(ctx context.Context, message, from string) SendResult {
	if c.NotifyTo == nil {
		reason := "notifyTo is null in control.json, so the alert was dropped"
		fmt.Fprintf(c.Log, "%s: %s\n", reason, jsnum.Slice(message, 80))
		return SendResult{Via: "hey", Reason: &reason}
	}
	sent, err := c.send(ctx, message, from)
	if err != nil {
		// swallowed: best-effort, an unreachable shim must never take down a tick or a cycle
		fmt.Fprintf(c.Log, "could not send through hey: %s%s\n", err, signInHint(err))
		return SendResult{Via: "hey", Reason: ptr(err.Error())}
	}
	if !sent.Pushed {
		reason := "no reason given"
		if sent.Reason != nil {
			reason = *sent.Reason
		}
		fmt.Fprintf(c.Log, "sent %s, but push failed: %s\n", sent.ID, reason)
	}
	return SendResult{Sent: true, MessageID: ptr(sent.ID), Via: "hey"}
}

func (c Channel) send(ctx context.Context, message, from string) (hey.Sent, error) {
	call, err := c.Caller()
	if err != nil {
		return hey.Sent{}, err
	}
	return hey.Send(ctx, call, hey.SendInput{To: *c.NotifyTo, From: from, Host: c.Host, Cwd: from, Text: message})
}

// PublishStatus sends the tick's status row. A nil NotifyTo is a configuration, not a failure,
// and this runs every tick, so it returns a reason without a log line.
func (c Channel) PublishStatus(ctx context.Context, at, payload string) PublishResult {
	if c.NotifyTo == nil {
		return PublishResult{Reason: ptr("notifyTo is null in control.json")}
	}
	err := c.putStatus(ctx, at, payload)
	if err != nil {
		// swallowed: best-effort, a window onto the tick must never take it down
		fmt.Fprintf(c.Log, "could not publish status through hey: %s%s\n", err, signInHint(err))
		return PublishResult{Reason: ptr(err.Error())}
	}
	return PublishResult{Sent: true}
}

func (c Channel) putStatus(ctx context.Context, at, payload string) error {
	call, err := c.Caller()
	if err != nil {
		return err
	}
	return hey.PutStatus(ctx, call, hey.StatusInput{To: *c.NotifyTo, Host: c.Host, At: at, Payload: payload})
}

// PhonePrefs is one bounded read per pass. A phone that cannot be asked means the pass runs on
// the stored mode; the warning is the caller's to place. No handle is no phone, not a warning.
func (c Channel) PhonePrefs(ctx context.Context) PhonePrefs {
	if c.NotifyTo == nil {
		return PhonePrefs{}
	}
	prefs, err := c.readPrefs(ctx)
	if err != nil {
		// swallowed: best-effort, a window onto the tick must never take it down; the warning carries it
		return PhonePrefs{Warning: ptr(fmt.Sprintf("could not read the phone's prefs (%s) — this pass runs on the stored mode", err))}
	}
	return PhonePrefs{Away: prefs.Away}
}

func (c Channel) readPrefs(ctx context.Context) (hey.Prefs, error) {
	call, err := c.Caller()
	if err != nil {
		return hey.Prefs{}, err
	}
	return hey.ReadPrefs(ctx, call, *c.NotifyTo)
}

type nudged struct {
	AskedAt *float64 `json:"askedAt"`
	SentAt  *float64 `json:"sentAt"`
}

// alreadyNudged keeps it to one nudge per ask, not one per tick. An unparseable file is an
// error, as the TS JSON.parse throws; a parseable one of the wrong shape is "not yet".
func alreadyNudged(p paths.Paths, program string, askedAt epoch.Millis) (bool, error) {
	raw, err := os.ReadFile(p.Nudged(program))
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var n nudged
	if err := json.Unmarshal(raw, &n); err != nil {
		var syntax *json.SyntaxError
		if errors.As(err, &syntax) {
			return false, fmt.Errorf("%s: %w", p.Nudged(program), err)
		}
		return false, nil
	}
	return n.AskedAt != nil && n.SentAt != nil && *n.AskedAt == float64(askedAt), nil
}

func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// NudgeIfNeglected texts Craig once about an ask left unanswered past AfterMinutes. A runner
// exits after raising an ask, so it cannot watch the clock on its own question; drovr can.
func (c Channel) NudgeIfNeglected(ctx context.Context, p paths.Paths, out io.Writer, n Neglect) (bool, error) {
	if c.NotifyTo == nil || float64(n.Now-n.AskedAt) < n.AfterMinutes*60_000 {
		return false, nil
	}
	done, err := alreadyNudged(p, n.Program, n.AskedAt)
	if err != nil || done {
		return false, err
	}
	hours := num(jsnum.RoundHalfUp(float64(n.Now-n.AskedAt) / 3_600_000))
	message := fmt.Sprintf("drovr: %s has been blocked %sh on %s unanswered ask(s).", n.Program, hours, num(n.Asks))
	if n.AsksURL != nil {
		message += " " + *n.AsksURL
	}
	if !c.TextCraig(ctx, message, AlertFrom(&n.Program, c.Host)).Sent {
		return false, nil
	}
	if err := paths.EnsureDirs(p, n.Program); err != nil {
		return false, err
	}
	record := fmt.Sprintf("{\"askedAt\":%d,\"sentAt\":%d}\n", n.AskedAt, n.Now)
	if err := os.WriteFile(p.Nudged(n.Program), []byte(record), 0o644); err != nil {
		return false, err
	}
	fmt.Fprintf(out, "sent hey about %s (%s ask(s), blocked %sh)\n", n.Program, num(n.Asks), hours)
	return true, nil
}
