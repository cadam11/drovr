package cli

import (
	"context"
	"fmt"
	"strings"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/help"
	"github.com/cadam11/drovr/internal/nudge"
)

type notifyResult struct {
	Sent      bool       `json:"sent"`
	ID        *string    `json:"id"`
	To        string     `json:"to"`
	Message   string     `json:"message"`
	Note      string     `json:"note"`
	UsingThis help.Notes `json:"usingThis"`
}

// Notify is `drovr notify`: one send through the same path every alert takes. Not sent is
// ErrPrinted, because the reason is already on stderr.
func Notify(ctx context.Context, env Env, args []string, asJSON bool) error {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	var words []string
	for _, a := range args {
		if a != "--json" {
			words = append(words, a)
		}
	}
	message := strings.Join(words, " ")
	if len(words) == 0 {
		message = fmt.Sprintf("drovr: notification test from %s at %s", env.Host, epoch.ISO(env.Now()))
	}
	if c.NotifyTo == nil {
		fmt.Fprintln(env.Stderr, `notifyTo is not set in ~/.drovr/control.json — set it to a hey handle, e.g. "craig" (see infra/users.tf).`)
		return ErrPrinted
	}
	result := channel(env, c.NotifyTo).TextCraig(ctx, message, nudge.AlertFrom(nil, env.Host))
	if err := printNotify(env, *c.NotifyTo, message, result, asJSON); err != nil {
		return err
	}
	if !result.Sent {
		return ErrPrinted
	}
	return nil
}

func printNotify(env Env, to, message string, r nudge.SendResult, asJSON bool) error {
	if asJSON {
		return encodeJSON(env.Stdout, notifyResult{
			Sent: r.Sent, ID: r.MessageID, To: to, Message: message,
			Note:      "sent means the row exists in the hey table; the app shows it on its next refresh or push",
			UsingThis: help.AgentNotes,
		})
	}
	if r.Sent {
		fmt.Fprintf(env.Stdout, "sent %s to %s\n", *r.MessageID, to)
		return nil
	}
	reason := "no reason given"
	if r.Reason != nil {
		reason = *r.Reason
	}
	fmt.Fprintf(env.Stderr, "the send failed: %s\n", reason)
	return nil
}
