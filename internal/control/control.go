// Package control is control.json: its shape, defaults and refusals, and the pure rules
// that read it — mode ceilings, pauses, cadence and the priority drain order.
package control

import (
	"fmt"
	"maps"
	"math"
	"regexp"
	"sort"
	"strconv"

	"github.com/cadam11/drovr/internal/epoch"
)

type Mode string

var Modes = []Mode{"off", "low", "normal", "away"}

type Ceiling struct {
	Weekly  float64 `json:"weekly"`
	Session float64 `json:"session"`
}

// DefaultCeilings is exported so an edit to one mode cannot silently drop the others —
// writing back a partial ceilings map would leave the next `drovr mode <other>` with no entry.
var DefaultCeilings = map[string]Ceiling{
	"low":    {Weekly: 0.25, Session: 0.25},
	"normal": {Weekly: 0.55, Session: 0.4},
	"away":   {Weekly: 0.85, Session: 0.6},
}

// Host is a cycle run on a paired remote Orca runtime; drovr and its ledger stay on this Mac.
type Host struct {
	Environment string  `json:"environment"`
	SSH         string  `json:"ssh"`
	Cwd         string  `json:"cwd"`
	DrovrHome   string  `json:"drovrHome"`
	Claude      string  `json:"claude"`
	Wake        *string `json:"wake"`
}

type Aice struct {
	AsksPage *string `json:"asksPage"`
}

type Program struct {
	Name            string   `json:"name"`
	Cwd             string   `json:"cwd"`
	Description     *string  `json:"description"`
	Host            *Host    `json:"host"`
	CycleCommand    string   `json:"cycleCommand"`
	Enabled         bool     `json:"enabled"`
	Model           string   `json:"model"`
	UseDirenv       bool     `json:"useDirenv"`
	Runner          string   `json:"runner"`
	CyclePrompt     string   `json:"cyclePrompt"`
	SessionName     string   `json:"sessionName"`
	MaxCyclesPerDay *float64 `json:"maxCyclesPerDay"`
	Priority        float64  `json:"priority"`
	Deadline        *string  `json:"deadline"`
	PauseUntil      *string  `json:"pauseUntil"`
	Cadence         *string  `json:"cadence"`
	Aice            *Aice    `json:"aice"`
	AsksFile        *string  `json:"asksFile"`
}

// Cost is ledger.CycleCost, defined here so control does not import ledger.
type Cost struct {
	Fable   float64 `json:"fable"`
	General float64 `json:"general"`
	Session float64 `json:"session"`
}

type Control struct {
	Mode                  Mode               `json:"mode"`
	PauseUntil            *string            `json:"pauseUntil"`
	Ceilings              map[string]Ceiling `json:"ceilings"`
	ReserveCycles         float64            `json:"reserveCycles"`
	PriorityStepCycles    float64            `json:"priorityStepCycles"`
	MaxCyclesPerDay       float64            `json:"maxCyclesPerDay"`
	MaxCycleHours         float64            `json:"maxCycleHours"`
	TickBudgetMinutes     float64            `json:"tickBudgetMinutes"`
	MaxConcurrentCycles   float64            `json:"maxConcurrentCycles"`
	DeadlineHorizonDays   float64            `json:"deadlineHorizonDays"`
	ContextCeilingTokens  float64            `json:"contextCeilingTokens"`
	CrashWindowMinutes    float64            `json:"crashWindowMinutes"`
	NotifyTo              *string            `json:"notifyTo"`
	NudgeAfterMinutes     float64            `json:"nudgeAfterMinutes"`
	BlockedBackoffMinutes float64            `json:"blockedBackoffMinutes"`
	StuckCycleThreshold   float64            `json:"stuckCycleThreshold"`
	StallNudgeMinutes     float64            `json:"stallNudgeMinutes"`
	MaxStallNudges        float64            `json:"maxStallNudges"`
	BlockedAlertMinutes   float64            `json:"blockedAlertMinutes"`
	SeedCycleCost         Cost               `json:"seedCycleCost"`
	Programs              []Program          `json:"programs"`
}

func (c Control) Program(name string) (Program, bool) {
	for _, p := range c.Programs {
		if p.Name == name {
			return p, true
		}
	}
	return Program{}, false
}

func CeilingsFor(c Control) (Ceiling, bool, error) {
	if c.Mode == "off" {
		return Ceiling{}, false, nil
	}
	ceiling, ok := c.Ceilings[string(c.Mode)]
	if !ok {
		return Ceiling{}, false, fmt.Errorf("control.ceilings has no entry for mode %q", c.Mode)
	}
	return ceiling, true, nil
}

// ApplyAwayMode is the phone's Away toggle for one pass. Returned, never written: a pass
// that wrote `away` back would make the toggle sticky after Craig turned it off. `off` is
// left alone — it is a stop, not a ceiling to loosen.
func ApplyAwayMode(c Control, away bool) Control {
	if away && c.Mode != "off" {
		c.Mode = "away"
	}
	return c
}

// EffectivePriority promotes a calendar-bound program one step as its date closes in, and
// keeps it while overdue — a deadline that has passed is more urgent, not less.
func EffectivePriority(p Program, now epoch.Millis, horizonDays float64) (float64, error) {
	if p.Deadline == nil {
		return p.Priority, nil
	}
	at, ok := epoch.Parse(*p.Deadline)
	if !ok {
		return 0, fmt.Errorf("program %q has an invalid deadline: %s", p.Name, *p.Deadline)
	}
	if float64(at-now)/86_400_000 <= horizonDays {
		return p.Priority - 1, nil
	}
	return p.Priority, nil
}

// ByPriority sorts by effective priority, name as a deterministic tie-break. TS breaks the
// tie with localeCompare, which is byte order only for ASCII names — program names are.
func ByPriority(ps []Program, now epoch.Millis, horizonDays float64) ([]Program, error) {
	type keyed struct {
		p        Program
		priority float64
	}
	sorted := make([]keyed, 0, len(ps))
	for _, p := range ps {
		priority, err := EffectivePriority(p, now, horizonDays)
		if err != nil {
			return nil, err
		}
		sorted = append(sorted, keyed{p, priority})
	}
	sort.SliceStable(sorted, func(i, j int) bool {
		a, b := sorted[i], sorted[j]
		return a.priority < b.priority || (a.priority == b.priority && a.p.Name < b.p.Name)
	})
	out := make([]Program, 0, len(sorted))
	for _, k := range sorted {
		out = append(out, k.p)
	}
	return out, nil
}

type Rank struct {
	Rank  int      `json:"rank"`
	Above []string `json:"above"`
}

// PriorityRank is where a program sits in the drain order and who outranks it. Counted over
// distinct priorities so equal-priority programs face the same bar, and only over programs
// that could take a cycle now: disabled, resting or outside its cadence window spends
// nothing, and holding room for it shadowed others (measured 2026-08-29, sunnyt resting 20h
// over aice-x). A blocked program still counts — an answer can arrive any second.
func PriorityRank(c Control, program string, now epoch.Millis, lastStartFor func(string) (epoch.Millis, bool)) (Rank, error) {
	enabled := make([]Program, 0, len(c.Programs))
	for _, p := range c.Programs {
		if p.Enabled {
			enabled = append(enabled, p)
		}
	}
	mine, found := Control{Programs: enabled}.Program(program)
	if !found {
		return Rank{Rank: 0, Above: []string{}}, nil
	}
	startable, err := startablePrograms(enabled, now, lastStartFor)
	if err != nil {
		return Rank{}, err
	}
	higher, err := outranking(startable, mine, now, c.DeadlineHorizonDays)
	if err != nil {
		return Rank{}, err
	}
	return rankOf(higher, now, c.DeadlineHorizonDays)
}

func startablePrograms(ps []Program, now epoch.Millis, lastStartFor func(string) (epoch.Millis, bool)) ([]Program, error) {
	out := make([]Program, 0, len(ps))
	for _, p := range ps {
		_, paused, err := ProgramPausedUntil(p, now)
		if err != nil {
			return nil, err
		}
		if paused {
			continue
		}
		last, hasLast := lastStartFor(p.Name)
		opens, held, err := NextCadenceStart(p, last, hasLast)
		if err != nil {
			return nil, err
		}
		if !held || opens <= now {
			out = append(out, p)
		}
	}
	return out, nil
}

// outranking evaluates entry before mine for each candidate, matching the TS's throw order.
func outranking(startable []Program, mine Program, now epoch.Millis, horizonDays float64) ([]Program, error) {
	higher := make([]Program, 0, len(startable))
	for _, p := range startable {
		theirs, err := EffectivePriority(p, now, horizonDays)
		if err != nil {
			return nil, err
		}
		own, err := EffectivePriority(mine, now, horizonDays)
		if err != nil {
			return nil, err
		}
		if theirs < own {
			higher = append(higher, p)
		}
	}
	return higher, nil
}

func rankOf(higher []Program, now epoch.Millis, horizonDays float64) (Rank, error) {
	sorted, err := ByPriority(higher, now, horizonDays)
	if err != nil {
		return Rank{}, err
	}
	distinct := map[float64]bool{}
	above := make([]string, 0, len(sorted))
	for _, p := range sorted {
		priority, err := EffectivePriority(p, now, horizonDays)
		if err != nil {
			return Rank{}, err
		}
		distinct[priority] = true
		above = append(above, p.Name)
	}
	return Rank{Rank: len(distinct), Above: above}, nil
}

var durationPattern = regexp.MustCompile(`^(\d+)([mhd])$`)

func ParseDuration(s string) (epoch.Millis, error) {
	m := durationPattern.FindStringSubmatch(s)
	if m == nil {
		return 0, fmt.Errorf("duration must look like 30m, 3h, or 2d — got %q", s)
	}
	value, err := strconv.ParseInt(m[1], 10, 64)
	if err != nil {
		return 0, fmt.Errorf("duration %q: %w", s, err)
	}
	unit := map[string]epoch.Millis{"m": 60_000, "h": 3_600_000, "d": 86_400_000}[m[2]]
	// JS yields a huge float here; a wrapped int64 could read as negative, opening a cadence
	// window TS holds shut or slipping a rest under MaxRestDays.
	if value > math.MaxInt64/unit {
		return 0, fmt.Errorf("duration %q is too long to represent", s)
	}
	return value * unit, nil
}

// MaxRestDays caps a self-rest, so a confused agent cannot dark a program for a season.
const MaxRestDays = 35

// ProgramPausedUntil reads a lapsed pause as no pause: only a future timestamp holds.
func ProgramPausedUntil(p Program, now epoch.Millis) (epoch.Millis, bool, error) {
	if p.PauseUntil == nil {
		return 0, false, nil
	}
	until, ok := epoch.Parse(*p.PauseUntil)
	if !ok {
		return 0, false, fmt.Errorf("%s.pauseUntil is not a valid timestamp: %s", p.Name, *p.PauseUntil)
	}
	if until <= now {
		return 0, false, nil
	}
	return until, true, nil
}

// NextCadenceStart measures from the last start — a cycle in flight opens its window too,
// or a long cycle plus its cadence would drift the schedule. A cadence never holds a
// program that has not run.
func NextCadenceStart(p Program, lastStartedAt epoch.Millis, hasLast bool) (epoch.Millis, bool, error) {
	if p.Cadence == nil || !hasLast {
		return 0, false, nil
	}
	d, err := ParseDuration(*p.Cadence)
	if err != nil {
		return 0, false, err
	}
	return lastStartedAt + d, true, nil
}

func IsPaused(c Control, now epoch.Millis) (bool, error) {
	if c.PauseUntil == nil {
		return false, nil
	}
	until, ok := epoch.Parse(*c.PauseUntil)
	if !ok {
		return false, fmt.Errorf("control.pauseUntil is not a valid timestamp: %s", *c.PauseUntil)
	}
	return until > now, nil
}

// ranked is ascending permissiveness; `off` spends nothing, so it has no ceilings to rank.
var ranked = []string{"low", "normal", "away"}

// OrderCeilings keeps the modes meaning what they say: `low` drifted above `away` on
// 2026-08-25 because each edit was clamped only against itself. The edited mode is
// authoritative and the others give way around it.
func OrderCeilings(ceilings map[string]Ceiling, edited string) map[string]Ceiling {
	anchor := -1
	for i, mode := range ranked {
		if mode == edited {
			anchor = i
		}
	}
	if anchor == -1 {
		return ceilings
	}
	out := maps.Clone(ceilings)
	if out == nil {
		out = map[string]Ceiling{}
	}
	for i := anchor - 1; i >= 0; i-- {
		out[ranked[i]] = clampCeiling(ceilingOf(out, ranked[i]), ceilingOf(out, ranked[i+1]), math.Min)
	}
	for i := anchor + 1; i < len(ranked); i++ {
		out[ranked[i]] = clampCeiling(ceilingOf(out, ranked[i]), ceilingOf(out, ranked[i-1]), math.Max)
	}
	return out
}

func ceilingOf(ceilings map[string]Ceiling, mode string) Ceiling {
	if c, ok := ceilings[mode]; ok {
		return c
	}
	return DefaultCeilings[mode]
}

func clampCeiling(c, neighbour Ceiling, pick func(a, b float64) float64) Ceiling {
	return Ceiling{Weekly: pick(c.Weekly, neighbour.Weekly), Session: pick(c.Session, neighbour.Session)}
}
