package cli

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/state"
	"github.com/cadam11/drovr/internal/tick"
	"github.com/cadam11/drovr/internal/watch"
)

// Watch is the live view: interactive and TTY-only, never for agents.
func Watch(ctx context.Context, env Env, rest []string) error {
	seconds, err := watchInterval(rest)
	if err != nil {
		return err
	}
	client := orca.NewClient(env.Paths, env.Stderr)
	collector := &state.Collector{Paths: env.Paths, Orca: client, Caller: env.Caller, Host: env.Host, TeamclaudeBin: env.TeamclaudeBin, Now: env.Now}
	signals := make(chan os.Signal, 1)
	signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP, syscall.SIGWINCH)
	defer signal.Stop(signals)
	launch := TickEnv(env, false)
	launch.Out = io.Discard // its "launched cycle" line would land in the middle of the frame
	return watch.Run(ctx, watch.Deps{
		In: os.Stdin, Out: env.Stdout, Term: watch.NewTerminal(os.Stdin, os.Stdout),
		Collect: collector.Collect, Orca: client, Paths: env.Paths, Self: env.Self, Now: env.Now,
		Signals: signals, Loc: time.Local, Tick: watch.Ticker,
		Launch: func(program string) error { return tick.Launch(launch, program) },
		Detach: exec.Detach, Run: exec.RunBounded,
	}, seconds)
}

// maxWatchIntervalSeconds is an R1-family bound: past it time.Duration overflows and
// NewTicker panics, where the TS would have set an absurd setInterval.
const maxWatchIntervalSeconds = 86_400 * 365

// watchInterval is the TS's parseInt with R1: where it got NaN and redrew every millisecond,
// a non-integer is refused. Zero and negatives pass, and Run floors them at two seconds.
func watchInterval(rest []string) (int, error) {
	if len(rest) == 0 {
		return 15, nil
	}
	n, ok := jsnum.ParseInt(rest[0])
	if !ok {
		return 0, fmt.Errorf("the interval is a number of seconds, got \"%s\"", rest[0])
	}
	if n > maxWatchIntervalSeconds {
		return 0, fmt.Errorf("the interval is too large: %s seconds", jsnum.String(n))
	}
	return int(n), nil
}
