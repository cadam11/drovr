package control

import (
	"bytes"
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"
)

var cadencePattern = regexp.MustCompile(`^\d+[mhd]$`)

// Parse mirrors controlShape: defaults fill absent keys, unknown keys are stripped (zod's
// default for .object()), and the first refusal names its field path.
func Parse(data []byte) (Control, error) {
	c, err := parseControl(data)
	if err != nil {
		return Control{}, fmt.Errorf("control file is invalid: %w", err)
	}
	return c, nil
}

// ParseProgram decodes one program on its own, as a recorded TS Program is.
func ParseProgram(raw json.RawMessage) (Program, error) {
	p, err := parseProgram(raw, "program")
	if err != nil {
		return Program{}, fmt.Errorf("control file is invalid: %w", err)
	}
	return p, nil
}

func Read(path string) (Control, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Control{}, err
	}
	return Parse(data)
}

// decoder keeps the first refusal so a shape reads as one straight list of fields.
type decoder struct {
	fields map[string]json.RawMessage
	path   string
	err    error
}

func newDecoder(raw json.RawMessage, path string) (*decoder, error) {
	var fields map[string]json.RawMessage
	if isNull(raw) {
		return nil, fmt.Errorf("%s: expected object, received null", orRoot(path))
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("%s: expected object: %v", orRoot(path), err)
	}
	return &decoder{fields: fields, path: path}, nil
}

func orRoot(path string) string {
	if path == "" {
		return "(root)"
	}
	return path
}

func (d *decoder) at(key string) string {
	if d.path == "" {
		return key
	}
	return d.path + "." + key
}

func (d *decoder) fail(err error) {
	if d.err == nil {
		d.err = err
	}
}

// present is false for absent and for null; callers that must refuse null check first.
func (d *decoder) present(key string) (json.RawMessage, bool) {
	raw, ok := d.fields[key]
	return raw, ok && !isNull(raw) && d.err == nil
}

func (d *decoder) check(key string, ok bool, why string) {
	if !ok {
		d.fail(fmt.Errorf("%s: %s", d.at(key), why))
	}
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func into[T any](d *decoder, key string, raw json.RawMessage, dst *T) {
	if err := json.Unmarshal(raw, dst); err != nil {
		d.fail(fmt.Errorf("%s: %v", d.at(key), err))
	}
}

// required refuses absent and null alike, as zod does for a field with no default.
func required[T any](d *decoder, key string, dst *T) {
	raw, ok := d.fields[key]
	if !ok || isNull(raw) {
		d.fail(fmt.Errorf("%s: required", d.at(key)))
		return
	}
	if d.err == nil {
		into(d, key, raw, dst)
	}
}

// optional keeps dst's default when absent; null is refused because the field is not nullable.
func optional[T any](d *decoder, key string, dst *T) {
	raw, ok := d.fields[key]
	if !ok || d.err != nil {
		return
	}
	if isNull(raw) {
		d.fail(fmt.Errorf("%s: expected a value, received null", d.at(key)))
		return
	}
	into(d, key, raw, dst)
}

// nullable decodes into a pointer, so JSON null and absent both leave the default nil.
func nullable[T any](d *decoder, key string, dst **T) {
	if raw, ok := d.present(key); ok {
		into(d, key, raw, dst)
	}
}

func parseControl(raw json.RawMessage) (Control, error) {
	d, err := newDecoder(raw, "")
	if err != nil {
		return Control{}, err
	}
	c := defaultControl()
	optional(d, "mode", &c.Mode)
	d.check("mode", slices.Contains(Modes, c.Mode), fmt.Sprintf("invalid enum value %q, expected off | low | normal | away", c.Mode))
	nullable(d, "pauseUntil", &c.PauseUntil)
	parseCeilings(d, &c)
	optional(d, "reserveCycles", &c.ReserveCycles)
	optional(d, "priorityStepCycles", &c.PriorityStepCycles)
	optional(d, "maxCyclesPerDay", &c.MaxCyclesPerDay)
	optional(d, "maxCycleHours", &c.MaxCycleHours)
	optional(d, "tickBudgetMinutes", &c.TickBudgetMinutes)
	optional(d, "maxConcurrentCycles", &c.MaxConcurrentCycles)
	optional(d, "deadlineHorizonDays", &c.DeadlineHorizonDays)
	optional(d, "contextCeilingTokens", &c.ContextCeilingTokens)
	optional(d, "crashWindowMinutes", &c.CrashWindowMinutes)
	nullable(d, "notifyTo", &c.NotifyTo)
	optional(d, "nudgeAfterMinutes", &c.NudgeAfterMinutes)
	optional(d, "blockedBackoffMinutes", &c.BlockedBackoffMinutes)
	optional(d, "stuckCycleThreshold", &c.StuckCycleThreshold)
	optional(d, "stallNudgeMinutes", &c.StallNudgeMinutes)
	optional(d, "maxStallNudges", &c.MaxStallNudges)
	optional(d, "blockedAlertMinutes", &c.BlockedAlertMinutes)
	parseSeedCost(d, &c)
	parsePrograms(d, &c)
	return c, d.err
}

func defaultControl() Control {
	return Control{
		Mode: "normal", Ceilings: maps.Clone(DefaultCeilings), ReserveCycles: 0.5, PriorityStepCycles: 0.25,
		MaxCyclesPerDay: 8, MaxCycleHours: 12, TickBudgetMinutes: 8, MaxConcurrentCycles: 2,
		DeadlineHorizonDays: 21, ContextCeilingTokens: 250_000, CrashWindowMinutes: 60,
		NudgeAfterMinutes: 240, BlockedBackoffMinutes: 60, StuckCycleThreshold: 3,
		StallNudgeMinutes: 10, MaxStallNudges: 3, BlockedAlertMinutes: 20,
		SeedCycleCost: Cost{Fable: 0.1, General: 0.08, Session: 0.25}, Programs: []Program{},
	}
}

func parseCeilings(d *decoder, c *Control) {
	var entries map[string]json.RawMessage
	optional(d, "ceilings", &entries)
	if entries == nil || d.err != nil {
		return
	}
	c.Ceilings = make(map[string]Ceiling, len(entries))
	for mode, raw := range entries {
		ceiling, err := parseCeiling(raw, d.at("ceilings")+"."+mode)
		d.fail(err)
		c.Ceilings[mode] = ceiling
	}
}

func parseCeiling(raw json.RawMessage, path string) (Ceiling, error) {
	d, err := newDecoder(raw, path)
	if err != nil {
		return Ceiling{}, err
	}
	var c Ceiling
	required(d, "weekly", &c.Weekly)
	required(d, "session", &c.Session)
	return c, d.err
}

func parseSeedCost(d *decoder, c *Control) {
	var raw json.RawMessage
	optional(d, "seedCycleCost", &raw)
	if raw == nil || d.err != nil {
		return
	}
	seed, err := newDecoder(raw, d.at("seedCycleCost"))
	if err != nil {
		d.fail(err)
		return
	}
	required(seed, "fable", &c.SeedCycleCost.Fable)
	required(seed, "general", &c.SeedCycleCost.General)
	required(seed, "session", &c.SeedCycleCost.Session)
	d.fail(seed.err)
}

func parsePrograms(d *decoder, c *Control) {
	var entries []json.RawMessage
	optional(d, "programs", &entries)
	if entries == nil || d.err != nil {
		return
	}
	c.Programs = make([]Program, 0, len(entries))
	for i, raw := range entries {
		p, err := parseProgram(raw, fmt.Sprintf("%s[%d]", d.at("programs"), i))
		d.fail(err)
		c.Programs = append(c.Programs, p)
	}
}

func parseProgram(raw json.RawMessage, path string) (Program, error) {
	d, err := newDecoder(raw, path)
	if err != nil {
		return Program{}, err
	}
	p := Program{
		CycleCommand: `teamclaude run -- --model {model} -p "/project-loop {program}"`, Enabled: true,
		Model: "fable", UseDirenv: true, Runner: "orca", CyclePrompt: "/project-loop {program}",
		SessionName: "{program} program runner",
	}
	required(d, "name", &p.Name)
	required(d, "cwd", &p.Cwd)
	nullable(d, "description", &p.Description)
	d.check("description", p.Description == nil || len(utf16.Encode([]rune(*p.Description))) <= 500, "must contain at most 500 character(s)")
	p.Host = parseHostField(d)
	optional(d, "cycleCommand", &p.CycleCommand)
	optional(d, "enabled", &p.Enabled)
	optional(d, "model", &p.Model)
	optional(d, "useDirenv", &p.UseDirenv)
	optional(d, "runner", &p.Runner)
	d.check("runner", p.Runner == "orca" || p.Runner == "headless", fmt.Sprintf("invalid enum value %q, expected orca | headless", p.Runner))
	optional(d, "cyclePrompt", &p.CyclePrompt)
	optional(d, "sessionName", &p.SessionName)
	nullable(d, "maxCyclesPerDay", &p.MaxCyclesPerDay)
	optional(d, "priority", &p.Priority)
	nullable(d, "deadline", &p.Deadline)
	nullable(d, "pauseUntil", &p.PauseUntil)
	nullable(d, "cadence", &p.Cadence)
	d.check("cadence", p.Cadence == nil || cadencePattern.MatchString(*p.Cadence), "cadence must look like 30m, 12h, or 7d")
	p.Aice = parseAiceField(d)
	nullable(d, "asksFile", &p.AsksFile)
	return p, d.err
}

func parseHostField(d *decoder) *Host {
	raw, ok := d.present("host")
	if !ok {
		return nil
	}
	h, err := parseHost(raw, d.at("host"))
	d.fail(err)
	return &h
}

func parseHost(raw json.RawMessage, path string) (Host, error) {
	d, err := newDecoder(raw, path)
	if err != nil {
		return Host{}, err
	}
	h := Host{DrovrHome: "~/.drovr", Claude: "~/.local/bin/claude"}
	required(d, "environment", &h.Environment)
	required(d, "ssh", &h.SSH)
	required(d, "cwd", &h.Cwd)
	d.check("cwd", d.err != nil || strings.HasPrefix(h.Cwd, "/"), "host.cwd must be an absolute path on the box")
	optional(d, "drovrHome", &h.DrovrHome)
	optional(d, "claude", &h.Claude)
	nullable(d, "wake", &h.Wake)
	return h, d.err
}

func parseAiceField(d *decoder) *Aice {
	raw, ok := d.present("aice")
	if !ok {
		return nil
	}
	a, err := newDecoder(raw, d.at("aice"))
	if err != nil {
		d.fail(err)
		return nil
	}
	var out Aice
	nullable(a, "asksPage", &out.AsksPage)
	d.fail(a.err)
	return &out
}
