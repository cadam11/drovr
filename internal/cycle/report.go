// Package cycle is one cycle's life: the report a runner writes to end it, where that report
// is read from, and the pure decisions the watch makes while it waits.
package cycle

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/shape"
)

// Report is written by the runner before it exits. Its absence after the process ends is
// how a crash is distinguished from a deliberate wind-down.
type Report struct {
	Exit          string        `json:"exit"` // context | capacity | seam | blocked
	StartupTokens *float64      `json:"startupTokens"`
	Yield         *ledger.Yield `json:"yield"`
	AsksRaised    float64       `json:"asksRaised"`
	// PauseUntil is an ISO timestamp: everything left is waiting on time, hold the program until then.
	PauseUntil *string `json:"pauseUntil"`
	// Cadence is a standing request: this program only needs a cycle every so often ("12h", "7d").
	Cadence *string `json:"cadence"`
}

var reportExits = []string{"context", "capacity", "seam", "blocked"}

var durationWord = regexp.MustCompile(`^\d+[mhd]$`)

// ParseReport is reportShape, strict. A JSON syntax error is returned as is, unlabelled, as
// JSON.parse throws it in the TS.
func ParseReport(data []byte, label string) (Report, error) {
	var raw json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		return Report{}, err
	}
	r, err := decodeReport(raw)
	if err != nil {
		return Report{}, fmt.Errorf("%s is not a valid cycle report: %w", label, err)
	}
	return r, nil
}

func decodeReport(raw json.RawMessage) (Report, error) {
	o, err := shape.Decode(raw, "")
	if err != nil {
		return Report{}, err
	}
	var r Report
	shape.Required(o, "exit", &r.Exit)
	shape.OneOf(o, "exit", r.Exit, reportExits)
	shape.NullableDefault(o, "startupTokens", &r.StartupTokens)
	var yield *json.RawMessage
	shape.NullableDefault(o, "yield", &yield)
	if yield != nil && o.Err == nil {
		y, err := decodeYield(*yield, o.At("yield"))
		o.Fail(err)
		r.Yield = &y
	}
	shape.Optional(o, "asksRaised", &r.AsksRaised)
	shape.NullableDefault(o, "pauseUntil", &r.PauseUntil)
	shape.NullableDefault(o, "cadence", &r.Cadence)
	if r.Cadence != nil {
		o.Check("cadence", durationWord.MatchString(*r.Cadence), fmt.Sprintf("invalid %q, expected /^\\d+[mhd]$/", *r.Cadence))
	}
	if o.Err != nil {
		return Report{}, o.Err
	}
	return r, nil
}

func decodeYield(raw json.RawMessage, path string) (ledger.Yield, error) {
	o, err := shape.Decode(raw, path)
	if err != nil {
		return ledger.Yield{}, err
	}
	var y ledger.Yield
	shape.Required(o, "ticketsMoved", &y.TicketsMoved)
	shape.Required(o, "prsOpened", &y.PrsOpened)
	shape.Required(o, "commits", &y.Commits)
	return y, o.Err
}

// ReportFromPoll is for the watch loop only. It polls while a direct writer may still be
// mid-write, so unparseable bytes mean "not yet" — the next poll sees the whole file.
// `drovr report` stages through a rename and can never be caught like this; the tolerance
// exists for runners briefed under the old write-the-file contract. Valid JSON with the
// wrong shape is a *complete* report that breaks the contract, and is still an error.
func ReportFromPoll(text *string, label string) (*Report, error) {
	// swallowed: a direct writer may be mid-write; the next poll sees the whole file
	if text == nil || !json.Valid([]byte(*text)) {
		return nil, nil
	}
	r, err := ParseReport([]byte(*text), label)
	if err != nil {
		return nil, err
	}
	return &r, nil
}

// WriteReport is the one writer that cannot leave a torn or invalid file: refused before
// anything touches disk, then staged through a rename so the watch's poll never sees half a
// report. The rename is also the commit — a report's existence ends the cycle.
func WriteReport(p paths.Paths, program string, r Report) (Report, error) {
	b, err := json.Marshal(r)
	if err != nil {
		return Report{}, err
	}
	parsed, err := ParseReport(b, "the given report")
	if err != nil {
		return Report{}, err
	}
	// Only the program's own directory: the report needs nothing else, and a caller without
	// a logs dir (a test's bare Paths) must not be refused over one.
	if err := os.MkdirAll(p.ProgramState(program), 0o755); err != nil {
		return Report{}, err
	}
	path := p.LastCycle(program)
	staged := path + ".staged"
	if err := os.WriteFile(staged, append(b, '\n'), 0o644); err != nil {
		return Report{}, err
	}
	if err := os.Rename(staged, path); err != nil {
		return Report{}, errors.Join(err, os.Remove(staged))
	}
	return parsed, nil
}

var reportFlags = []string{"--exit", "--startup-tokens", "--tickets-moved", "--prs-opened", "--commits", "--asks-raised", "--pause-until", "--cadence"}

func flagValue(args []string, name string) (string, bool) {
	i := slices.Index(args, "--"+name)
	if i == -1 {
		return "", false
	}
	if i+1 < len(args) {
		return args[i+1], true
	}
	return "", true
}

// stringFlag is cli.Flag's twin (internal/cli imports this package): a trailing flag with no
// value reads as absent, as the TS's stringArg does, where numberArg refuses it.
func stringFlag(args []string, name string) (string, bool) {
	i := slices.Index(args, "--"+name)
	if i == -1 || i+1 >= len(args) {
		return "", false
	}
	return args[i+1], true
}

func numberArg(args []string, name string) (*float64, error) {
	raw, ok := flagValue(args, name)
	if !ok {
		return nil, nil
	}
	value, ok := jsnum.ParseInt(raw)
	if !ok {
		return nil, fmt.Errorf("--%s needs a number, got %q", name, raw)
	}
	return &value, nil
}

const day = epoch.Millis(86_400_000)

// parsePauseUntil takes "48h" and "2026-08-30T09:00Z" alike: an agent asking to soak thinks
// in durations, one waiting for a release date thinks in dates. Bounded by MaxRestDays either
// way, and a pause that is already over is refused rather than silently inert.
func parsePauseUntil(raw string, now epoch.Millis) (string, error) {
	limit := now + control.MaxRestDays*day
	at, ok := epoch.Parse(raw)
	if durationWord.MatchString(raw) {
		d, err := control.ParseDuration(raw)
		// Too long to represent is JS's huge float, which the bound below refuses.
		at, ok = now+d, true
		if err != nil {
			at = limit + 1
		}
	}
	if !ok {
		return "", fmt.Errorf("--pause-until needs a duration (48h, 7d) or an ISO date, got %q", raw)
	}
	if at <= now {
		return "", fmt.Errorf("--pause-until %q is already in the past", raw)
	}
	if at > limit {
		return "", fmt.Errorf("--pause-until %q is more than %d days out — the maximum", raw, control.MaxRestDays)
	}
	return epoch.ISO(at), nil
}

func parseCadence(raw string) (string, error) {
	if !durationWord.MatchString(raw) {
		return "", fmt.Errorf("--cadence must look like 30m, 12h, or 7d — got %q", raw)
	}
	if d, err := control.ParseDuration(raw); err != nil || d > control.MaxRestDays*day {
		return "", fmt.Errorf("--cadence %q is longer than %d days — the maximum", raw, control.MaxRestDays)
	}
	return raw, nil
}

// ParseReportArgs is `drovr report`'s argument half, kept pure so the refusals an agent will
// actually see are testable. Unknown flags are refused rather than skipped: a typo that
// silently dropped a field would defeat the reason the command exists. The exit is not
// checked here; WriteReport refuses a bad one, as in the TS.
func ParseReportArgs(args []string, now epoch.Millis) (string, Report, error) {
	if len(args) == 0 || strings.HasPrefix(args[0], "--") {
		return "", Report{}, errors.New("usage: drovr report <program> --exit <context|capacity|seam|blocked> [flags]")
	}
	for _, arg := range args[1:] {
		if strings.HasPrefix(arg, "--") && !slices.Contains(reportFlags, arg) {
			return "", Report{}, fmt.Errorf("unknown flag %s — `drovr help report` lists them", arg)
		}
	}
	exit, ok := flagValue(args, "exit")
	if !ok {
		return "", Report{}, errors.New("--exit is required: context | capacity | seam | blocked")
	}
	// The yield flags are read first, as the TS does, so the same bad flag is named first.
	yield, err := yieldArgs(args)
	if err != nil {
		return "", Report{}, err
	}
	r := Report{Exit: exit, Yield: yield}
	if r.StartupTokens, err = numberArg(args, "startup-tokens"); err != nil {
		return "", Report{}, err
	}
	asks, err := numberArg(args, "asks-raised")
	if err != nil {
		return "", Report{}, err
	}
	if asks != nil {
		r.AsksRaised = *asks
	}
	if r.PauseUntil, err = optional(args, "pause-until", func(raw string) (string, error) { return parsePauseUntil(raw, now) }); err != nil {
		return "", Report{}, err
	}
	if r.Cadence, err = optional(args, "cadence", parseCadence); err != nil {
		return "", Report{}, err
	}
	return args[0], r, nil
}

// yieldArgs is nil when no yield flag was given — unknown, not zero — and defaults the
// others to zero once any one is.
func yieldArgs(args []string) (*ledger.Yield, error) {
	var values [3]*float64
	for i, name := range []string{"tickets-moved", "prs-opened", "commits"} {
		v, err := numberArg(args, name)
		if err != nil {
			return nil, err
		}
		values[i] = v
	}
	if values[0] == nil && values[1] == nil && values[2] == nil {
		return nil, nil
	}
	orZero := func(v *float64) float64 {
		if v == nil {
			return 0
		}
		return *v
	}
	return &ledger.Yield{TicketsMoved: orZero(values[0]), PrsOpened: orZero(values[1]), Commits: orZero(values[2])}, nil
}

func optional(args []string, name string, parse func(string) (string, error)) (*string, error) {
	raw, ok := stringFlag(args, name)
	if !ok {
		return nil, nil
	}
	value, err := parse(raw)
	if err != nil {
		return nil, err
	}
	return &value, nil
}
