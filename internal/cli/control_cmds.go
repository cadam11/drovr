package cli

import (
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/keys"
	"github.com/cadam11/drovr/internal/paths"
)

// The ten commands here write control.json the way cli.ts does: in place through
// keys.MutateInPlace, validated before the write. Only reserve stages its write, because
// the TS routes it through keys.ts. Every refusal text is the TS's, byte for byte.

const hostUsage = "usage: drovr host <program> --environment <orca env id> --ssh <user@host> --cwd </path/on/box> " +
	"[--drovr-home <path>] [--claude <path>] [--wake '<local command>']  |  drovr host <program> --clear"

// defaultControlJSON carries the dead sessionId/closing keys on purpose: the TS writes them.
const defaultControlJSON = `{
  "mode": "normal",
  "pauseUntil": null,
  "sessionId": null,
  "closing": null,
  "programs": []
}
`

var bareDuration = regexp.MustCompile(`^\d+[mhd]$`)

func Init(env Env, _ []string) error {
	if err := paths.EnsureDirs(env.Paths, ""); err != nil {
		return err
	}
	if _, err := os.Stat(env.Paths.Control); err == nil {
		fmt.Fprintf(env.Stdout, "%s already exists\n", env.Paths.Control)
		return nil
	}
	if err := os.WriteFile(env.Paths.Control, []byte(defaultControlJSON), 0o666); err != nil {
		return err
	}
	fmt.Fprintf(env.Stdout, "wrote %s — add a program entry, then `drovr service install`\n", env.Paths.Control)
	return nil
}

// obj builds an ordered object from alternating key, value arguments.
func obj(kv ...any) *keys.Doc {
	d := &keys.Doc{}
	for i := 0; i+1 < len(kv); i += 2 {
		d.Set(kv[i].(string), kv[i+1])
	}
	return d
}

// optional is the TS `flag(...) ?? null`: a missing or trailing flag is JSON null.
func optional(rest []string, name string) any {
	if v, ok := Flag(rest, name); ok {
		return v
	}
	return nil
}

// jsInt is Number.parseInt as stored: NaN has no JSON form, so it becomes null, which
// the schema then refuses just as it refuses the TS's NaN.
func jsInt(s string) any {
	if n, ok := jsnum.ParseInt(s); ok {
		return n
	}
	return nil
}

func programList(d *keys.Doc) []any {
	v, _ := d.Get("programs")
	list, _ := v.([]any)
	return list
}

func hasProgram(d *keys.Doc, name string) bool {
	return slices.ContainsFunc(programList(d), func(entry any) bool {
		p, ok := entry.(*keys.Doc)
		if !ok {
			return false
		}
		n, _ := p.Get("name")
		return n == name
	})
}

func expandHome(cwd, home string) string {
	if cwd == "~" || strings.HasPrefix(cwd, "~/") {
		return home + cwd[1:]
	}
	return cwd
}

func Add(env Env, rest []string) error {
	if len(rest) < 2 {
		return errors.New("usage: drovr add <name> <path> [--priority n] [--deadline YYYY-MM-DD] ...")
	}
	name := rest[0]
	absolute, err := filepath.Abs(expandHome(rest[1], env.Home))
	if err != nil {
		return err
	}
	if _, err := os.Stat(absolute); err != nil {
		return fmt.Errorf("%s does not exist", absolute)
	}
	noAice := slices.Contains(rest, "--no-aice")
	_, err = keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		if hasProgram(d, name) {
			return fmt.Errorf("a program named \"%s\" already exists", name)
		}
		d.Set("programs", append(programList(d), newProgram(rest, name, absolute, noAice)))
		return nil
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(env.Stdout, "added %s → %s\n", name, absolute)
	fmt.Fprintln(env.Stdout, "first tick will onboard it: reconstruct state, raise one ask, then stop")
	return nil
}

// newProgram keeps the TS's key order: name, cwd, priority, deadline, [model], [useDirenv], aice, asksFile.
func newProgram(rest []string, name, cwd string, noAice bool) *keys.Doc {
	priority := "0"
	if v, ok := Flag(rest, "priority"); ok {
		priority = v
	}
	p := obj("name", name, "cwd", cwd, "priority", jsInt(priority), "deadline", optional(rest, "deadline"))
	if model, ok := Flag(rest, "model"); ok {
		p.Set("model", model)
	}
	if slices.Contains(rest, "--no-direnv") {
		p.Set("useDirenv", false)
	}
	asksFile := optional(rest, "asks-file")
	if noAice {
		p.Set("aice", nil)
		if asksFile == nil {
			asksFile = ".drovr/asks.md"
		}
	} else {
		p.Set("aice", obj("asksPage", optional(rest, "asks")))
	}
	p.Set("asksFile", asksFile)
	return p
}

func Host(env Env, rest []string) error {
	if len(rest) == 0 || strings.HasPrefix(rest[0], "--") {
		return errors.New(hostUsage)
	}
	name := rest[0]
	var host *keys.Doc
	if !slices.Contains(rest, "--clear") {
		var err error
		if host, err = newHost(rest); err != nil {
			return err
		}
	}
	_, err := keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		entry, err := keys.ProgramAt(d, name)
		if err != nil {
			return err
		}
		if host == nil {
			entry.Set("host", nil) // a typed-nil *Doc would not encode as null
		} else {
			entry.Set("host", host)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if host == nil {
		fmt.Fprintf(env.Stdout, "%s runs on this Mac again\n", name)
		return nil
	}
	ssh, _ := host.Get("ssh")
	environment, _ := host.Get("environment")
	cwd, _ := host.Get("cwd")
	fmt.Fprintf(env.Stdout, "%s now runs on %s (orca environment %s) in %s\n", name, ssh, environment, cwd)
	fmt.Fprintf(env.Stdout, "the box needs drovr on PATH with a program named \"%s\" in its own control.json — the runner's `drovr report` checks the name\n", name)
	return nil
}

// newHost checks environment, ssh, cwd in that order, so the first missing one is the one named.
func newHost(rest []string) (*keys.Doc, error) {
	var vals [3]string
	for i, name := range []string{"environment", "ssh", "cwd"} {
		v, err := RequiredFlag(rest, name, hostUsage)
		if err != nil {
			return nil, err
		}
		vals[i] = v
	}
	h := obj("environment", vals[0], "ssh", vals[1], "cwd", vals[2])
	for _, name := range []string{"drovr-home", "claude"} {
		if v, ok := Flag(rest, name); ok {
			h.Set(map[string]string{"drovr-home": "drovrHome", "claude": "claude"}[name], v)
		}
	}
	h.Set("wake", optional(rest, "wake"))
	return h, nil
}

func Remove(env Env, rest []string) error {
	if len(rest) == 0 {
		return errors.New("usage: drovr rm <name>")
	}
	name := rest[0]
	_, err := keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		programs := programList(d)
		kept := []any{}
		for _, entry := range programs {
			if p, ok := entry.(*keys.Doc); ok {
				if n, _ := p.Get("name"); n == name {
					continue
				}
			}
			kept = append(kept, entry)
		}
		if len(kept) == len(programs) {
			return fmt.Errorf("no program named \"%s\"", name)
		}
		d.Set("programs", kept)
		return nil
	})
	if err != nil {
		return err
	}
	// The literal ~/.drovr is the TS's wording whatever DROVR_HOME is.
	fmt.Fprintf(env.Stdout, "removed %s (its ledger history and ~/.drovr/programs/%s are left alone)\n", name, name)
	return nil
}

func Cap(env Env, rest []string) error {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		printCaps(env, c)
		return nil
	}
	name, value, hasValue := rest[0], "", len(rest) > 1
	if hasValue {
		value = rest[1]
	}
	_, nameIsInt := jsnum.ParseInt(name)
	globalOnly := !hasValue && nameIsInt
	_, err = keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		if globalOnly {
			n, _ := jsnum.ParseInt(name)
			d.Set("maxCyclesPerDay", n)
			return nil
		}
		return setProgramCap(d, name, value)
	})
	if err != nil {
		return err
	}
	if globalOnly {
		fmt.Fprintf(env.Stdout, "global daily cap → %s\n", name)
		return nil
	}
	fmt.Fprintf(env.Stdout, "%s daily cap → %s\n", name, value)
	return nil
}

func setProgramCap(d *keys.Doc, name, value string) error {
	entry, err := keys.ProgramAt(d, name)
	if err != nil {
		return err
	}
	if value == "global" {
		entry.Set("maxCyclesPerDay", nil)
		return nil
	}
	n, ok := jsnum.ParseInt(value)
	if !ok {
		return errors.New("usage: drovr cap <program> <n|global>")
	}
	entry.Set("maxCyclesPerDay", n)
	return nil
}

func printCaps(env Env, c control.Control) {
	fmt.Fprintf(env.Stdout, "global daily cap: %s\n", jsnum.String(c.MaxCyclesPerDay))
	for _, p := range c.Programs {
		own := fmt.Sprintf("%s (global)", jsnum.String(c.MaxCyclesPerDay))
		if p.MaxCyclesPerDay != nil {
			own = jsnum.String(*p.MaxCyclesPerDay)
		}
		fmt.Fprintf(env.Stdout, "  %s: %s\n", p.Name, own)
	}
	fmt.Fprintln(env.Stdout, "set with: drovr cap <n>  |  drovr cap <program> <n>  |  drovr cap <program> global")
}

// Mode has no membership check of its own: the schema's enum refuses a bad value, as in the TS.
func Mode(env Env, rest []string) error {
	if len(rest) == 0 {
		return errors.New("mode needs one of: off, low, normal, away")
	}
	_, err := keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		d.Set("mode", rest[0])
		return nil
	})
	if err != nil {
		return err
	}
	fmt.Fprintf(env.Stdout, "mode set to %s\n", rest[0])
	return nil
}

func Reserve(env Env, rest []string) error {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	if c.Mode == "off" {
		return errors.New("mode is off — nothing is being spent to reserve against")
	}
	if len(rest) == 0 {
		held := 1 - c.Ceilings[string(c.Mode)].Weekly
		fmt.Fprintf(env.Stdout, "%s%% of each account's weekly quota is held for you in mode \"%s\"\n", jsnum.String(jsnum.RoundHalfUp(held*100)), c.Mode)
		fmt.Fprintln(env.Stdout, "set it with: drovr reserve <percent>")
		return nil
	}
	percent, ok := jsnum.ParseFloat(strings.Replace(rest[0], "%", "", 1))
	if !ok || math.IsInf(percent, 0) {
		return errors.New("reserve needs a percentage, e.g. `drovr reserve 45`")
	}
	action, err := keys.SetReserve(env.Paths.Control, string(c.Mode), percent/100)
	if err != nil {
		return err
	}
	fmt.Fprintln(env.Stdout, action.Message)
	return nil
}

func Pause(env Env, rest []string) error {
	if len(rest) == 0 {
		return errors.New("usage: drovr pause <duration>  |  drovr pause <program> <duration>")
	}
	first := rest[0]
	scoped := !bareDuration.MatchString(first)
	spec := first
	if scoped {
		if len(rest) < 2 {
			return fmt.Errorf("pause needs a duration, e.g. `drovr pause %s 3h`", first)
		}
		spec = rest[1]
	}
	ms, err := control.ParseDuration(spec)
	if err != nil {
		return err
	}
	until := epoch.ISO(env.Now() + ms)
	_, err = keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		if !scoped {
			d.Set("pauseUntil", until)
			return nil
		}
		entry, err := keys.ProgramAt(d, first)
		if err != nil {
			return err
		}
		entry.Set("pauseUntil", until)
		return nil
	})
	if err != nil {
		return err
	}
	if scoped {
		fmt.Fprintf(env.Stdout, "%s paused until %s\n", first, until)
		return nil
	}
	fmt.Fprintf(env.Stdout, "paused until %s\n", until)
	return nil
}

// Resume names the first argument that is not a flag; unlike its siblings it filters dashes.
func Resume(env Env, rest []string) error {
	i := slices.IndexFunc(rest, func(a string) bool { return !strings.HasPrefix(a, "-") })
	_, err := keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		if i < 0 {
			d.Set("pauseUntil", nil)
			return nil
		}
		entry, err := keys.ProgramAt(d, rest[i])
		if err != nil {
			return err
		}
		entry.Set("pauseUntil", nil)
		return nil
	})
	if err != nil {
		return err
	}
	if i < 0 {
		fmt.Fprintln(env.Stdout, "resumed")
		return nil
	}
	fmt.Fprintf(env.Stdout, "%s resumed\n", rest[i])
	return nil
}

func Cadence(env Env, rest []string) error {
	c, err := control.Read(env.Paths.Control)
	if err != nil {
		return err
	}
	if len(rest) == 0 {
		for _, p := range c.Programs {
			every := "every tick is a candidate"
			if p.Cadence != nil {
				every = *p.Cadence
			}
			fmt.Fprintf(env.Stdout, "  %s: %s\n", p.Name, every)
		}
		fmt.Fprintln(env.Stdout, "set with: drovr cadence <program> <every, e.g. 12h or 7d>  |  drovr cadence <program> off")
		return nil
	}
	if len(rest) < 2 {
		return errors.New("usage: drovr cadence <program> <every|off>")
	}
	name, value := rest[0], rest[1]
	if value != "off" {
		if _, err := control.ParseDuration(value); err != nil {
			return err
		}
	}
	_, err = keys.MutateInPlace(env.Paths.Control, func(d *keys.Doc) error {
		entry, err := keys.ProgramAt(d, name)
		if err != nil {
			return err
		}
		if value == "off" {
			entry.Set("cadence", nil)
		} else {
			entry.Set("cadence", value)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if value == "off" {
		fmt.Fprintf(env.Stdout, "%s: cadence cleared\n", name)
		return nil
	}
	fmt.Fprintf(env.Stdout, "%s: at most one cycle per %s\n", name, value)
	return nil
}
