package cli

import (
	"errors"
	"io"
	"os"
	"time"

	"github.com/cadam11/drovr/internal/asks"
	"github.com/cadam11/drovr/internal/cycle"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/nudge"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/service"
	"github.com/cadam11/drovr/internal/tick"
)

// ErrPrinted is a failure whose line is already printed; main exits 1 without a second one.
var ErrPrinted = errors.New("already printed")

// NewEnv is the real world: this binary, this machine, this user.
func NewEnv(stdout, stderr io.Writer) (Env, error) {
	self, err := service.Self()
	if err != nil {
		return Env{}, err
	}
	host, err := os.Hostname()
	if err != nil {
		return Env{}, err
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return Env{}, err
	}
	return Env{Paths: paths.New(), Now: epoch.Now, Stdout: stdout, Stderr: stderr, Self: self, Host: host, Home: home}, nil
}

// callerOf is nudge.DefaultCaller unless a test supplied its own; the worker has no nil default.
func callerOf(env Env) nudge.CallerFunc {
	if env.Caller == nil {
		return nudge.DefaultCaller
	}
	return env.Caller
}

func channel(env Env, notifyTo *string) nudge.Channel {
	return nudge.Channel{NotifyTo: notifyTo, Caller: callerOf(env), Host: env.Host, Log: env.Stderr}
}

// TickEnv builds the shadow's orca client read-only: an adopted handle is used but
// cycle-terminal.json is not rewritten, so the shadow can never move the live tick's grip.
func TickEnv(env Env, shadow bool) tick.Env {
	client := orca.NewClient(env.Paths, env.Stderr)
	client.ReadOnly = shadow
	return tick.Env{
		Paths: env.Paths, Now: env.Now, Out: env.Stdout, Err: env.Stderr, Self: env.Self,
		TeamclaudeBin: env.TeamclaudeBin, Host: env.Host, Home: env.Home,
		Orca: client, Asks: asks.NewReader(), Caller: callerOf(env), Exit: os.Exit, Shadow: shadow,
	}
}

func Worker(env Env) cycle.Worker {
	return cycle.Worker{
		Paths: env.Paths, Orca: orca.NewClient(env.Paths, env.Stderr), Caller: callerOf(env),
		Host: env.Host, Home: env.Home, TeamclaudeBin: env.TeamclaudeBin,
		Out: env.Stdout, Err: env.Stderr, Now: env.Now, Sleep: time.Sleep,
	}
}
