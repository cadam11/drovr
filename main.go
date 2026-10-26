// Command drovr is the Go port of src/cli.ts. The TypeScript is the oracle until cut-over:
// conformance_test.go diffs the two on the same DROVR_HOME.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strings"

	"github.com/cadam11/drovr/internal/cli"
	"github.com/cadam11/drovr/internal/cycle"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/help"
	"github.com/cadam11/drovr/internal/tick"
)

// version is stamped by scripts/release.sh with -ldflags "-X main.version=<VERSION>".
var version = "dev"

// exitOne is a failure whose message has already been printed, so main exits 1 without adding a line.
type exitOne struct{}

func (exitOne) Error() string { return "exit 1" }

func main() {
	err := run(os.Args[1:], os.Stdout, os.Stderr)
	if err == nil {
		return
	}
	if !errors.As(err, new(exitOne)) && !errors.Is(err, cli.ErrPrinted) && !errors.Is(err, cycle.ErrAlreadyRunning) {
		fmt.Fprintln(os.Stderr, err)
	}
	os.Exit(1)
}

func run(args []string, stdout, stderr io.Writer) error {
	if len(args) == 0 {
		fmt.Fprintln(stderr, "")
		fmt.Fprintln(stdout, help.RenderList())
		return nil
	}
	cmd, rest := args[0], args[1:]
	asJSON := slices.Contains(rest, "--json")
	// `drovr <cmd> --help` reaches the same detail page as `drovr help <cmd>`.
	if _, ok := help.Find(cmd); ok && slices.Contains(rest, "--help") {
		return showHelp(stdout, &cmd, asJSON)
	}
	switch cmd {
	case "help", "--help", "-h":
		return showHelp(stdout, firstNonFlag(rest), asJSON)
	case "version", "--version":
		fmt.Fprintln(stdout, version)
		return nil
	case "status", "report", "notify", "service", "tick", "run-cycle",
		"init", "add", "host", "rm", "cap", "mode", "pause", "resume", "cadence", "reserve",
		"ledger", "usage", "tidy":
		return dispatch(cmd, rest, asJSON, stdout, stderr)
	}
	if _, ok := help.Find(cmd); ok {
		return notPorted(cmd, rest)
	}
	fmt.Fprintf(stderr, "unknown command \"%s\"\n\n", cmd)
	fmt.Fprintln(stdout, help.RenderList())
	return exitOne{}
}

func dispatch(cmd string, rest []string, asJSON bool, stdout, stderr io.Writer) error {
	ctx := context.Background()
	if cmd == "run-cycle" && len(rest) == 0 {
		return errors.New("run-cycle needs a program name")
	}
	// A misspelt --shadow must not fall through to a live tick that admits real cycles.
	if cmd == "tick" && slices.ContainsFunc(rest, func(a string) bool { return a != "--shadow" }) {
		return errors.New("tick takes no arguments but --shadow")
	}
	if cmd == "tick" || cmd == "run-cycle" {
		// The two commands that never run in front of a human: their lines land in a launchd
		// log or a worker log, where an undated line cannot be matched to the ledger.
		stdout, stderr = epoch.Stamped(stdout, epoch.Now), epoch.Stamped(stderr, epoch.Now)
	}
	env, err := cli.NewEnv(stdout, stderr)
	if err != nil {
		return err
	}
	switch cmd {
	case "status":
		return cli.Status(ctx, env, asJSON)
	case "report":
		return cli.Report(env, rest)
	case "init":
		return cli.Init(env, rest)
	case "add":
		return cli.Add(env, rest)
	case "host":
		return cli.Host(env, rest)
	case "rm":
		return cli.Remove(env, rest)
	case "cap":
		return cli.Cap(env, rest)
	case "mode":
		return cli.Mode(env, rest)
	case "pause":
		return cli.Pause(env, rest)
	case "resume":
		return cli.Resume(env, rest)
	case "cadence":
		return cli.Cadence(env, rest)
	case "reserve":
		return cli.Reserve(env, rest)
	case "ledger":
		return cli.Ledger(env, rest, asJSON)
	case "usage":
		return cli.Usage(env, rest, asJSON)
	case "tidy":
		return cli.Tidy(ctx, env)
	case "notify":
		return cli.Notify(ctx, env, rest, asJSON)
	case "service":
		return cli.Service(ctx, env, rest, asJSON)
	case "tick":
		return stampedFailure(stderr, tick.Run(ctx, cli.TickEnv(env, slices.Contains(rest, "--shadow"))))
	}
	return stampedFailure(stderr, cli.Worker(env).RunProgram(ctx, rest[0]))
}

// stampedFailure prints a tick or worker failure through the stamped writer, as the TS's
// console.error does once stampConsole has run.
func stampedFailure(stderr io.Writer, err error) error {
	if err == nil || errors.Is(err, cycle.ErrAlreadyRunning) {
		return err
	}
	fmt.Fprintln(stderr, err)
	return exitOne{}
}

func firstNonFlag(rest []string) *string {
	for i, a := range rest {
		if !strings.HasPrefix(a, "-") {
			return &rest[i]
		}
	}
	return nil
}

func showHelp(stdout io.Writer, topic *string, asJSON bool) error {
	if topic == nil && asJSON {
		return encode(stdout, help.TreeOf())
	}
	if topic == nil {
		fmt.Fprintln(stdout, help.RenderList())
		return nil
	}
	c, ok := help.Find(*topic)
	if !ok && asJSON {
		// The TS prints JSON.stringify(undefined) here, which console.log writes as "undefined", exit 0.
		fmt.Fprintln(stdout, "undefined")
		return nil
	}
	if !ok {
		return fmt.Errorf("no command named \"%s\" — run `drovr help` for the list", *topic)
	}
	if asJSON {
		return encode(stdout, c)
	}
	fmt.Fprintln(stdout, help.RenderCommand(c))
	return nil
}

// encode matches JSON.stringify(v, null, 2) plus console.log's newline: no HTML escaping, two-space indent.
func encode(w io.Writer, v any) error {
	enc := json.NewEncoder(w)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	return enc.Encode(v)
}

func notPorted(cmd string, rest []string) error {
	return fmt.Errorf("drovr %s is not ported to Go yet — run: node src/cli.ts %s", cmd, strings.Join(append([]string{cmd}, rest...), " "))
}
