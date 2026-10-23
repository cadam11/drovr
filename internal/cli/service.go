package cli

import (
	"context"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/service"
)

// agent is one launchd agent drovr can install: the live tick, or the shadow beside it.
type agent struct {
	label, logName string
	args           []string
	interval       int
}

func agentFor(shadow bool) agent {
	if shadow {
		return agent{label: service.ShadowLabel, logName: service.ShadowLogName, args: []string{"tick", "--shadow"}, interval: service.ShadowIntervalSeconds}
	}
	return agent{label: service.Label, logName: "tick", args: []string{"tick"}, interval: 600}
}

// Service is `drovr service status|install|uninstall|print`; `--shadow` picks the shadow agent
// for install, uninstall and print. status reports the live tick only: the shadow stamps no
// heartbeat, so its health would always read as never having run.
func Service(ctx context.Context, env Env, args []string, asJSON bool) error {
	a := agentFor(slices.Contains(args, "--shadow"))
	args = slices.DeleteFunc(slices.Clone(args), func(s string) bool { return s == "--shadow" })
	sub := ""
	if len(args) > 0 {
		sub = args[0]
	}
	switch sub {
	case "status":
		return showService(env, asJSON)
	case "uninstall":
		return uninstallService(env, a)
	case "install":
		return installService(ctx, env, a, args)
	case "print":
		in, err := plistInput(env, a, args)
		if err != nil {
			return err
		}
		fmt.Fprintln(env.Stdout, service.Plist(in))
		return nil
	}
	return fmt.Errorf(`unknown service subcommand "%s" — expected status, install, uninstall or print (label: %s)`, sub, a.label)
}

var leadingDigits = regexp.MustCompile(`^\s*[+-]?\d+`)

// plistInput reads the interval as parseInt does. The TS wrote NaN into the plist for a word;
// refusing it is the one deliberate difference.
func plistInput(env Env, a agent, args []string) (service.PlistInput, error) {
	seconds := a.interval
	if len(args) > 1 {
		n, err := strconv.Atoi(strings.TrimSpace(leadingDigits.FindString(args[1])))
		if err != nil {
			return service.PlistInput{}, fmt.Errorf("the interval is a number of seconds, got %q", args[1])
		}
		seconds = n
	}
	return service.PlistInput{
		Label: a.label, Binary: env.Self, Args: a.args, LogName: a.logName, IntervalSeconds: seconds,
		LogDir: env.Paths.Logs, Path: service.AgentPath(os.Getenv("PATH")),
	}, nil
}

func installService(ctx context.Context, env Env, a agent, args []string) error {
	in, err := plistInput(env, a, args)
	if err != nil {
		return err
	}
	if err := paths.EnsureDirs(env.Paths, ""); err != nil {
		return err
	}
	warnings, err := installWarnings(a, in.IntervalSeconds, service.PlistPathFor(service.ShadowLabel))
	if err != nil {
		return err
	}
	for _, w := range warnings {
		fmt.Fprintln(env.Stderr, w)
	}
	outcome, err := service.InstallAgent(ctx, in)
	if err != nil {
		return err
	}
	fmt.Fprintf(env.Stdout, "wrote %s\n", service.PlistPathFor(a.label))
	switch outcome {
	case service.Reloaded:
		fmt.Fprintf(env.Stdout, "  %s: reloaded so it picks up this plist\n", a.label)
	case service.Loaded:
		fmt.Fprintf(env.Stdout, "  %s: loaded — starts on its next interval\n", a.label)
	default:
		fmt.Fprintf(env.Stderr, "  %s: could not load automatically. Run: %s\n", a.label, service.BootstrapCommand(a.label))
		return ErrPrinted
	}
	return nil
}

// installWarnings names what an install is about to disturb; the install proceeds either way.
// A live install over an installed shadow ends the shadow period, and a shadow slower than
// the shadow-diff pairing window leaves live decisions with nothing to pair against.
func installWarnings(a agent, seconds int, shadowPlist string) ([]string, error) {
	var out []string
	if a.label == service.ShadowLabel && seconds > service.ShadowIntervalSeconds {
		out = append(out, fmt.Sprintf("warning: the shadow-diff pairing window assumes %d s or less; %d s will leave live decisions unpaired", service.ShadowIntervalSeconds, seconds))
	}
	if a.label != service.Label {
		return out, nil
	}
	_, err := os.Stat(shadowPlist)
	if errors.Is(err, os.ErrNotExist) {
		return out, nil
	}
	if err != nil {
		return nil, err
	}
	return append(out, "warning: the shadow label "+service.ShadowLabel+" is installed; this replaces the live tick"), nil
}

func uninstallService(env Env, a agent) error {
	target := service.PlistPathFor(a.label)
	if _, err := os.Stat(target); errors.Is(err, os.ErrNotExist) {
		fmt.Fprintf(env.Stdout, "%s: not installed\n", a.label)
		return nil
	}
	fmt.Fprintf(env.Stdout, "%s: unload it with:  %s\n", a.label, service.BootoutCommand(a.label))
	fmt.Fprintf(env.Stdout, "%s: then remove:     rm %s\n", a.label, target)
	return nil
}

type serviceJSON struct {
	Tick serviceTick `json:"tick"`
}

type serviceTick struct {
	Health      service.Health `json:"health"`
	Explanation string         `json:"explanation"`
	LastTickAt  *string        `json:"lastTickAt"`
	service.State
	PlistPath     string `json:"plistPath"`
	LoadCommand   string `json:"loadCommand"`
	UnloadCommand string `json:"unloadCommand"`
}

func showService(env Env, asJSON bool) error {
	state := service.Current()
	now := env.Now()
	last := lastTickAt(env.Paths)
	holder, err := tickLockHolder(env.Paths, now)
	if err != nil {
		return err
	}
	explanation := service.Describe(state, last, now, holder)
	if asJSON {
		var at *string
		if last != nil {
			iso := epoch.ISO(*last)
			at = &iso
		}
		return encodeJSON(env.Stdout, serviceJSON{serviceTick{
			Health: service.HealthOf(state, last, now), Explanation: explanation, LastTickAt: at, State: state,
			PlistPath: service.PlistPath(), LoadCommand: service.BootstrapCommand(service.Label), UnloadCommand: service.BootoutCommand(service.Label),
		}})
	}
	warnBinaryMismatch(env)
	fmt.Fprintf(env.Stdout, "tick: %s\n", explanation)
	if state.Pid != nil {
		fmt.Fprintf(env.Stdout, "  a tick is executing right now (pid %d)\n", *state.Pid)
	}
	fmt.Fprintf(env.Stdout, "plist: %s\n", service.PlistPath())
	fmt.Fprintf(env.Stdout, "logs:  %s\n", env.Paths.Logs)
	return nil
}

func warnBinaryMismatch(env Env) {
	if note, ok := service.BinaryMismatch(service.PlistPath(), env.Self); ok {
		fmt.Fprintln(env.Stderr, note)
	}
}
