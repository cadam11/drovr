// Package keys is every write to control.json. Edits go through the file rather than
// in-memory state: launchd ticks read the same file, so a change made here applies to the
// next tick even if the watch session closes a second later.
package keys

import (
	"errors"
	"fmt"
	"math"
	"os"
	"strings"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
)

type Action struct {
	Message string
	Redraw  bool
	Quit    bool
	Fresh   bool // redraw past state's probe window rather than reusing it — `r` alone
}

type pause struct {
	label string
	ms    epoch.Millis
}

var pauses = []pause{{"1h", 3_600_000}, {"3h", 10_800_000}, {"8h", 28_800_000}, {"24h", 86_400_000}}

// edit reads, applies and validates; a refused edit returns before anything touches disk.
func edit(path string, change func(*Doc) error) ([]byte, control.Control, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, control.Control{}, err
	}
	v, err := decode(data)
	if err != nil {
		return nil, control.Control{}, fmt.Errorf("%s: %w", path, err)
	}
	raw, ok := v.(*Doc)
	if !ok {
		return nil, control.Control{}, fmt.Errorf("%s is not a JSON object", path)
	}
	if err := change(raw); err != nil {
		return nil, control.Control{}, err
	}
	out, err := encode(raw)
	if err != nil {
		return nil, control.Control{}, err
	}
	validated, err := control.Parse(out)
	return out, validated, err
}

// Mutate stages and renames rather than truncating in place: rename is atomic within a
// filesystem, so no reader catches a half-written control file. It does not order
// concurrent writers (the tick, watch and the CLI each call it) — a lost update costs a
// re-pressed key, so there is deliberately no lock.
func Mutate(path string, change func(*Doc) error) (control.Control, error) {
	out, validated, err := edit(path, change)
	if err != nil {
		return control.Control{}, err
	}
	staging := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(staging, out, 0o666); err != nil {
		return control.Control{}, errors.Join(err, removeStaging(staging))
	}
	if err := os.Rename(staging, path); err != nil {
		return control.Control{}, errors.Join(err, removeStaging(staging))
	}
	return validated, nil
}

func removeStaging(staging string) error {
	if err := os.Remove(staging); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// MutateInPlace is cli.ts's own mutate, which writes the file in place rather than staging it.
func MutateInPlace(path string, change func(*Doc) error) (control.Control, error) {
	out, validated, err := edit(path, change)
	if err != nil {
		return control.Control{}, err
	}
	if err := os.WriteFile(path, out, 0o666); err != nil {
		return control.Control{}, err
	}
	return validated, nil
}

func ProgramAt(d *Doc, name string) (*Doc, error) {
	v, _ := d.Get("programs")
	programs, ok := v.([]any)
	if !ok {
		return nil, errors.New("control.programs is not an array")
	}
	for _, entry := range programs {
		p, ok := entry.(*Doc)
		if !ok {
			continue
		}
		if n, _ := p.Get("name"); n == name {
			return p, nil
		}
	}
	return nil, fmt.Errorf("no program named %q", name)
}

func set(key string, v any) func(*Doc) error {
	return func(d *Doc) error {
		d.Set(key, v)
		return nil
	}
}

func numberOr(d *Doc, key string, fallback float64) float64 {
	if v, ok := d.Get(key); ok {
		if n, ok := v.(float64); ok {
			return n
		}
	}
	return fallback
}

func clamp(v, lo, hi float64) float64 { return math.Max(lo, math.Min(hi, v)) }

func CycleMode(path string, current control.Mode) (Action, error) {
	i := -1
	for j, m := range control.Modes {
		if m == current {
			i = j
		}
	}
	next := control.Modes[(i+1)%len(control.Modes)]
	if _, err := Mutate(path, set("mode", string(next))); err != nil {
		return Action{}, err
	}
	return Action{Message: "mode → " + string(next), Redraw: true}, nil
}

func CyclePause(path string, current *string, now epoch.Millis) (Action, error) {
	if current != nil {
		if until, ok := epoch.Parse(*current); ok && until > now {
			if _, err := Mutate(path, set("pauseUntil", nil)); err != nil {
				return Action{}, err
			}
			return Action{Message: "pause cleared", Redraw: true}, nil
		}
	}
	return pauseFor(path, pauses[0], now)
}

func pauseFor(path string, step pause, now epoch.Millis) (Action, error) {
	if _, err := Mutate(path, set("pauseUntil", epoch.ISO(now+step.ms))); err != nil {
		return Action{}, err
	}
	return Action{Message: "paused " + step.label, Redraw: true}, nil
}

// ExtendPause steps to the next pause longer than what is left; an unparseable current
// pause is NaN in the TS, which no step exceeds, so it lands on the longest.
func ExtendPause(path string, current *string, now epoch.Millis) (Action, error) {
	elapsed, known := epoch.Millis(0), true
	if current != nil {
		until, ok := epoch.Parse(*current)
		elapsed, known = max(now, until)-now, ok
	}
	next := pauses[len(pauses)-1]
	for _, step := range pauses {
		if known && step.ms > elapsed+60_000 {
			next = step
			break
		}
	}
	return pauseFor(path, next, now)
}

func ToggleEnabled(path, name string) (Action, error) {
	enabled := true
	_, err := Mutate(path, func(d *Doc) error {
		p, err := ProgramAt(d, name)
		if err != nil {
			return err
		}
		v, _ := p.Get("enabled")
		enabled = v == false
		p.Set("enabled", enabled)
		return nil
	})
	if err != nil {
		return Action{}, err
	}
	return Action{Message: name + " " + enabledWord(enabled), Redraw: true}, nil
}

func enabledWord(enabled bool) string {
	if enabled {
		return "enabled"
	}
	return "disabled"
}

func NudgePriority(path, name string, delta float64) (Action, error) {
	var priority float64
	_, err := Mutate(path, func(d *Doc) error {
		p, err := ProgramAt(d, name)
		if err != nil {
			return err
		}
		priority = clamp(numberOr(p, "priority", 0)+delta, -9, 9)
		p.Set("priority", priority)
		return nil
	})
	if err != nil {
		return Action{}, err
	}
	return Action{Message: fmt.Sprintf("%s priority → %s", name, jsnum.String(priority)), Redraw: true}, nil
}

func AdjustConcurrency(path string, delta float64) (Action, error) {
	var limit float64
	_, err := Mutate(path, func(d *Doc) error {
		limit = clamp(numberOr(d, "maxConcurrentCycles", 2)+delta, 1, 8)
		d.Set("maxConcurrentCycles", limit)
		return nil
	})
	if err != nil {
		return Action{}, err
	}
	return Action{Message: "concurrency cap → " + jsnum.String(limit), Redraw: true}, nil
}

// SetMode, PauseForHours and SetEnabled name a target where the TUI's keys cycle. Bounds
// are checked here, at the write, so the TUI and the CLI are held to the same range.
func SetMode(path, mode string) (Action, error) {
	names := make([]string, len(control.Modes))
	known := false
	for i, m := range control.Modes {
		names[i] = string(m)
		known = known || string(m) == mode
	}
	if !known {
		return Action{}, fmt.Errorf("unknown mode %q — expected one of: %s", mode, strings.Join(names, ", "))
	}
	if _, err := Mutate(path, set("mode", mode)); err != nil {
		return Action{}, err
	}
	return Action{Message: "mode → " + mode, Redraw: true}, nil
}

func PauseForHours(path string, hours float64, now epoch.Millis) (Action, error) {
	if math.IsNaN(hours) || math.IsInf(hours, 0) || hours < 1 || hours > 72 {
		return Action{}, fmt.Errorf("pause of %sh is out of range — expected 1h to 72h", jsnum.String(hours))
	}
	// new Date(x) truncates a fractional millisecond toward zero, as the conversion does.
	until := epoch.Millis(float64(now) + hours*3_600_000)
	if _, err := Mutate(path, set("pauseUntil", epoch.ISO(until))); err != nil {
		return Action{}, err
	}
	return Action{Message: "paused " + jsnum.String(hours) + "h", Redraw: true}, nil
}

func SetEnabled(path, name string, enabled bool) (Action, error) {
	_, err := Mutate(path, func(d *Doc) error {
		p, err := ProgramAt(d, name)
		if err != nil {
			return err
		}
		p.Set("enabled", enabled)
		return nil
	})
	if err != nil {
		return Action{}, err
	}
	return Action{Message: name + " " + enabledWord(enabled), Redraw: true}, nil
}

// SetReserve takes the reserve Craig thinks in — the inverse of the ceiling programs may
// spend up to. The 5h ceiling keeps its ratio to the weekly one, so tightening the reserve
// cannot silently widen bursts.
func SetReserve(path, mode string, fraction float64) (Action, error) {
	reserve := clamp(fraction, 0.05, 0.95)
	weekly := 1 - reserve
	var session float64
	_, err := Mutate(path, func(d *Doc) error {
		ceilings, err := seededCeilings(d)
		if err != nil {
			return err
		}
		current, ok := ceilings.Get(mode)
		if !ok {
			current = ceilingDoc(control.DefaultCeilings["normal"])
		}
		c, err := ceilingFrom(current, mode)
		if err != nil {
			return err
		}
		ratio := 1.0
		if c.Weekly != 0 {
			ratio = c.Session / c.Weekly
		}
		session = clamp(weekly*ratio, 0.05, 1)
		ceilings.Set(mode, ceilingDoc(control.Ceiling{Weekly: weekly, Session: session}))
		d.Set("ceilings", ceilings)
		return orderInPlace(ceilings, mode)
	})
	if err != nil {
		return Action{}, err
	}
	msg := fmt.Sprintf("%s: %s held for you — programs up to %s weekly, %s per 5h", mode, pct(reserve), pct(weekly), pct(session))
	return Action{Message: msg, Redraw: true}, nil
}

func pct(v float64) string { return jsnum.String(jsnum.RoundHalfUp(v*100)) + "%" }

var rankedModes = []string{"low", "normal", "away"}

// seededCeilings is {...DEFAULT_CEILINGS, ...raw.ceilings}: writing back only the edited
// mode would leave the others missing, and the next `drovr mode <other>` without a ceiling.
func seededCeilings(d *Doc) (*Doc, error) {
	out := &Doc{}
	for _, mode := range rankedModes {
		out.Set(mode, ceilingDoc(control.DefaultCeilings[mode]))
	}
	v, _ := d.Get("ceilings")
	if v == nil {
		return out, nil
	}
	file, ok := v.(*Doc)
	if !ok {
		return nil, errors.New("control.ceilings is not an object")
	}
	for _, mode := range file.keys {
		out.Set(mode, file.vals[mode])
	}
	return out, nil
}

// orderInPlace applies control.OrderCeilings back onto the docs, so a mode that moves keeps
// its own key order and any extra keys — the TS spreads each one rather than rebuilding it.
func orderInPlace(ceilings *Doc, edited string) error {
	values := map[string]control.Ceiling{}
	for _, mode := range ceilings.keys {
		c, err := ceilingFrom(ceilings.vals[mode], mode)
		if err != nil {
			return err
		}
		values[mode] = c
	}
	ordered := control.OrderCeilings(values, edited)
	for _, mode := range rankedModes {
		doc, _ := ceilings.vals[mode].(*Doc)
		if mode == edited || doc == nil {
			continue
		}
		doc.Set("weekly", ordered[mode].Weekly)
		doc.Set("session", ordered[mode].Session)
	}
	return nil
}

func ceilingDoc(c control.Ceiling) *Doc {
	d := &Doc{}
	d.Set("weekly", c.Weekly)
	d.Set("session", c.Session)
	return d
}

func ceilingFrom(v any, mode string) (control.Ceiling, error) {
	d, ok := v.(*Doc)
	if !ok {
		return control.Ceiling{}, fmt.Errorf("control.ceilings.%s is not an object", mode)
	}
	weekly, okW := d.vals["weekly"].(float64)
	session, okS := d.vals["session"].(float64)
	if !okW || !okS {
		return control.Ceiling{}, fmt.Errorf("control.ceilings.%s needs numeric weekly and session", mode)
	}
	return control.Ceiling{Weekly: weekly, Session: session}, nil
}

// NudgeReserve moves the reserve by a delta. Refused while the mode is off: no ceiling is in
// force to move, and writing an `off` entry would create a number CeilingsFor never reads.
func NudgeReserve(path string, delta float64) (Action, error) {
	if math.IsNaN(delta) || math.IsInf(delta, 0) || delta < -0.95 || delta > 0.95 {
		return Action{}, fmt.Errorf("reserve delta %s is out of range — expected -0.95 to 0.95", jsnum.String(delta))
	}
	c, err := control.Read(path)
	if err != nil {
		return Action{}, err
	}
	if c.Mode == "off" {
		return Action{}, errors.New("mode is off, so no ceiling is in force — set a mode before moving the reserve")
	}
	fallback, ok := control.DefaultCeilings[string(c.Mode)]
	if !ok {
		fallback = control.DefaultCeilings["normal"]
	}
	weekly := fallback.Weekly
	if current, ok := c.Ceilings[string(c.Mode)]; ok {
		weekly = current.Weekly
	}
	return SetReserve(path, string(c.Mode), 1-weekly+delta)
}
