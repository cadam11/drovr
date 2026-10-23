package control

import (
	"encoding/json"
	"fmt"
	"maps"
	"os"
	"regexp"
	"strings"
	"unicode/utf16"

	"github.com/cadam11/drovr/internal/shape"
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

func parseControl(raw json.RawMessage) (Control, error) {
	d, err := shape.Decode(raw, "")
	if err != nil {
		return Control{}, err
	}
	c := defaultControl()
	shape.Optional(d, "mode", &c.Mode)
	shape.OneOf(d, "mode", c.Mode, Modes)
	shape.NullableDefault(d, "pauseUntil", &c.PauseUntil)
	parseCeilings(d, &c)
	shape.Optional(d, "reserveCycles", &c.ReserveCycles)
	shape.Optional(d, "priorityStepCycles", &c.PriorityStepCycles)
	shape.Optional(d, "maxCyclesPerDay", &c.MaxCyclesPerDay)
	shape.Optional(d, "maxCycleHours", &c.MaxCycleHours)
	shape.Optional(d, "tickBudgetMinutes", &c.TickBudgetMinutes)
	shape.Optional(d, "maxConcurrentCycles", &c.MaxConcurrentCycles)
	shape.Optional(d, "deadlineHorizonDays", &c.DeadlineHorizonDays)
	shape.Optional(d, "contextCeilingTokens", &c.ContextCeilingTokens)
	shape.Optional(d, "crashWindowMinutes", &c.CrashWindowMinutes)
	shape.NullableDefault(d, "notifyTo", &c.NotifyTo)
	shape.Optional(d, "nudgeAfterMinutes", &c.NudgeAfterMinutes)
	shape.Optional(d, "blockedBackoffMinutes", &c.BlockedBackoffMinutes)
	shape.Optional(d, "stuckCycleThreshold", &c.StuckCycleThreshold)
	shape.Optional(d, "stallNudgeMinutes", &c.StallNudgeMinutes)
	shape.Optional(d, "maxStallNudges", &c.MaxStallNudges)
	shape.Optional(d, "blockedAlertMinutes", &c.BlockedAlertMinutes)
	parseSeedCost(d, &c)
	parsePrograms(d, &c)
	return c, d.Err
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

func parseCeilings(d *shape.Object, c *Control) {
	var entries map[string]json.RawMessage
	shape.Optional(d, "ceilings", &entries)
	if entries == nil || d.Err != nil {
		return
	}
	c.Ceilings = make(map[string]Ceiling, len(entries))
	for mode, raw := range entries {
		ceiling, err := parseCeiling(raw, d.At("ceilings")+"."+mode)
		d.Fail(err)
		c.Ceilings[mode] = ceiling
	}
}

func parseCeiling(raw json.RawMessage, path string) (Ceiling, error) {
	d, err := shape.Decode(raw, path)
	if err != nil {
		return Ceiling{}, err
	}
	var c Ceiling
	shape.Required(d, "weekly", &c.Weekly)
	shape.Required(d, "session", &c.Session)
	return c, d.Err
}

func parseSeedCost(d *shape.Object, c *Control) {
	var raw json.RawMessage
	shape.Optional(d, "seedCycleCost", &raw)
	if raw == nil || d.Err != nil {
		return
	}
	seed, err := shape.Decode(raw, d.At("seedCycleCost"))
	if err != nil {
		d.Fail(err)
		return
	}
	shape.Required(seed, "fable", &c.SeedCycleCost.Fable)
	shape.Required(seed, "general", &c.SeedCycleCost.General)
	shape.Required(seed, "session", &c.SeedCycleCost.Session)
	d.Fail(seed.Err)
}

func parsePrograms(d *shape.Object, c *Control) {
	var entries []json.RawMessage
	shape.Optional(d, "programs", &entries)
	if entries == nil || d.Err != nil {
		return
	}
	c.Programs = make([]Program, 0, len(entries))
	for i, raw := range entries {
		p, err := parseProgram(raw, fmt.Sprintf("%s[%d]", d.At("programs"), i))
		d.Fail(err)
		c.Programs = append(c.Programs, p)
	}
}

func parseProgram(raw json.RawMessage, path string) (Program, error) {
	d, err := shape.Decode(raw, path)
	if err != nil {
		return Program{}, err
	}
	p := Program{
		CycleCommand: `teamclaude run -- --model {model} -p "/project-loop {program}"`, Enabled: true,
		Model: "fable", UseDirenv: true, Runner: "orca", CyclePrompt: "/project-loop {program}",
		SessionName: "{program} program runner",
	}
	shape.Required(d, "name", &p.Name)
	shape.Required(d, "cwd", &p.Cwd)
	shape.NullableDefault(d, "description", &p.Description)
	d.Check("description", p.Description == nil || len(utf16.Encode([]rune(*p.Description))) <= 500, "must contain at most 500 character(s)")
	p.Host = parseHostField(d)
	shape.Optional(d, "cycleCommand", &p.CycleCommand)
	shape.Optional(d, "enabled", &p.Enabled)
	shape.Optional(d, "model", &p.Model)
	shape.Optional(d, "useDirenv", &p.UseDirenv)
	shape.Optional(d, "runner", &p.Runner)
	shape.OneOf(d, "runner", p.Runner, []string{"orca", "headless"})
	shape.Optional(d, "cyclePrompt", &p.CyclePrompt)
	shape.Optional(d, "sessionName", &p.SessionName)
	shape.NullableDefault(d, "maxCyclesPerDay", &p.MaxCyclesPerDay)
	shape.Optional(d, "priority", &p.Priority)
	shape.NullableDefault(d, "deadline", &p.Deadline)
	shape.NullableDefault(d, "pauseUntil", &p.PauseUntil)
	shape.NullableDefault(d, "cadence", &p.Cadence)
	d.Check("cadence", p.Cadence == nil || cadencePattern.MatchString(*p.Cadence), "cadence must look like 30m, 12h, or 7d")
	p.Aice = parseAiceField(d)
	shape.NullableDefault(d, "asksFile", &p.AsksFile)
	return p, d.Err
}

func parseHostField(d *shape.Object) *Host {
	raw, ok := d.Present("host")
	if !ok {
		return nil
	}
	h, err := parseHost(raw, d.At("host"))
	d.Fail(err)
	return &h
}

func parseHost(raw json.RawMessage, path string) (Host, error) {
	d, err := shape.Decode(raw, path)
	if err != nil {
		return Host{}, err
	}
	h := Host{DrovrHome: "~/.drovr", Claude: "~/.local/bin/claude"}
	shape.Required(d, "environment", &h.Environment)
	shape.Required(d, "ssh", &h.SSH)
	shape.Required(d, "cwd", &h.Cwd)
	d.Check("cwd", d.Err != nil || strings.HasPrefix(h.Cwd, "/"), "host.cwd must be an absolute path on the box")
	shape.Optional(d, "drovrHome", &h.DrovrHome)
	shape.Optional(d, "claude", &h.Claude)
	shape.NullableDefault(d, "wake", &h.Wake)
	return h, d.Err
}

func parseAiceField(d *shape.Object) *Aice {
	raw, ok := d.Present("aice")
	if !ok {
		return nil
	}
	a, err := shape.Decode(raw, d.At("aice"))
	if err != nil {
		d.Fail(err)
		return nil
	}
	var out Aice
	shape.NullableDefault(a, "asksPage", &out.AsksPage)
	d.Fail(a.Err)
	return &out
}
