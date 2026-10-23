// Package state is the frame `drovr watch` draws: the same pool, funding and verdicts decide()
// computes, gathered once so no renderer re-derives them and drifts.
package state

import (
	"strconv"

	"github.com/cadam11/drovr/internal/allocation"
	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/preview"
	"github.com/cadam11/drovr/internal/status"
	"github.com/cadam11/drovr/internal/teamclaude"
)

const overdueIntervals = 3

type Context struct {
	Percent   *float64 `json:"percent"`
	Tokens    *float64 `json:"tokens"`
	Subagents *float64 `json:"subagents"`
}

type ProgramState struct {
	Name      string   `json:"name"`
	Enabled   bool     `json:"enabled"`
	Priority  float64  `json:"priority"`
	Verdict   string   `json:"verdict"` // decide's verdict, or RUN while a cycle is in flight
	Reason    string   `json:"reason"`
	Kind      *string  `json:"kind"`
	StartedAt *string  `json:"startedAt"`
	Pid       *int     `json:"pid"`
	AsksURL   *string  `json:"asksUrl"`
	Context   *Context `json:"context"`
	Preview   []string `json:"preview"`
}

type ServiceState struct {
	Loaded          bool    `json:"loaded"`
	IntervalSeconds *int    `json:"intervalSeconds"`
	LastTickAt      *string `json:"lastTickAt"`
	Overdue         bool    `json:"overdue"`
}

type PoolState struct {
	UsableAccounts int `json:"usableAccounts"`
	// FundingAccounts below UsableAccounts means the pool has no fallback.
	FundingAccounts int     `json:"fundingAccounts"`
	Fable           float64 `json:"fable"`
	General         float64 `json:"general"`
	Session         float64 `json:"session"`
}

type RecentCycle struct {
	StartedAt  string  `json:"startedAt"`
	Program    string  `json:"program"`
	Kind       string  `json:"kind"`
	Exit       string  `json:"exit"`
	AsksRaised float64 `json:"asksRaised"`
}

type DrovrState struct {
	SchemaVersion int          `json:"schemaVersion"`
	GeneratedAt   string       `json:"generatedAt"`
	Mode          control.Mode `json:"mode"`
	ModeFromPhone bool         `json:"modeFromPhone"`
	PauseUntil    *string      `json:"pauseUntil"`
	// MaxConcurrentCycles and Reserve: Reserve is 1 - the weekly ceiling, the knob itself, never
	// allocation's yoursReserved, which drifts as capacity is spent while the knob never moved.
	MaxConcurrentCycles float64 `json:"maxConcurrentCycles"`
	Reserve             float64 `json:"reserve"`
	// CyclesInFlight counts the ledger, not Programs: a running cycle whose program left
	// control.json still holds capacity decide() reserves against.
	CyclesInFlight int             `json:"cyclesInFlight"`
	Service        ServiceState    `json:"service"`
	Pool           PoolState       `json:"pool"`
	BindingBucket  capacity.Bucket `json:"bindingBucket"`
	CyclesFundable float64         `json:"cyclesFundable"`
	// BindingRecoveryAt is the binding bucket's own reset: a 5h hold shown beside the weekly
	// reset turns a two-hour wait into an apparent write-off.
	BindingRecoveryAt *string `json:"bindingRecoveryAt"`
	// CapacityNote is identical for every program, so a multi-program renderer prints it once.
	CapacityNote       string              `json:"capacityNote"`
	HoursToWeeklyReset *float64            `json:"hoursToWeeklyReset"`
	Allocation         allocation.Segments `json:"allocation"`
	Programs           []ProgramState      `json:"programs"`
	Accounts           []status.Account    `json:"accounts"`
	RecentCycles       []RecentCycle       `json:"recentCycles"`
}

type ServiceInput struct {
	Loaded          bool
	IntervalSeconds *int
	LastTickAt      *epoch.Millis
}

type Input struct {
	Status   teamclaude.Status
	Control  control.Control
	Cycles   []ledger.Cycle
	Now      epoch.Millis
	Service  ServiceInput
	Previews map[string]preview.Preview
	Runners  map[string]bool // absent key = unknown, which must never refuse a cycle
	// AwayFromPhone is applied to Control for this state only, never written.
	AwayFromPhone bool
	Locks         map[string]int
	AsksURLs      map[string]string
}

// r rounds at the edge so the JSON carries meanings, not float noise.
func r(v float64, places int) float64 {
	f, err := strconv.ParseFloat(jsnum.ToFixed(v, places), 64)
	if err != nil {
		panic(err) // ToFixed only prints what ParseFloat reads
	}
	return f
}

func iso(at *epoch.Millis) *string {
	if at == nil {
		return nil
	}
	s := epoch.ISO(*at)
	return &s
}

func isOverdue(s ServiceInput, now epoch.Millis) bool {
	if s.IntervalSeconds == nil || s.LastTickAt == nil {
		return false
	}
	return now-*s.LastTickAt > epoch.Millis(*s.IntervalSeconds)*1000*overdueIntervals
}

// Build is pure: every read already happened in Collect.
func Build(in Input) (DrovrState, error) {
	c := control.ApplyAwayMode(in.Control, in.AwayFromPhone)
	ceilings, _, err := control.CeilingsFor(c) // off has none: a zero ceiling is no room
	if err != nil {
		return DrovrState{}, err
	}
	pool := capacity.PoolFrom(in.Status, ceilings, in.Now)
	// decide()'s window (MaxCycleHours), so the reservation never disagrees with the verdict.
	inFlight := ledger.InFlight(in.Cycles, in.Now, c.MaxCycleHours)
	cost := ledger.EstimateCycleCost(in.Cycles, c.SeedCycleCost, 3, 0.9)
	// Charged as decide() charges, never the raw count: the count over-reports fundability
	// against the verdict printed beside it.
	funding := decide.CyclesFundableFrom(pool, cost, ledger.ChargeForRunning(inFlight, pool.Snapshot(), cost))
	programs, err := programsOf(in, c)
	if err != nil {
		return DrovrState{}, err
	}
	var hoursLeft *float64
	if h, ok := capacity.HoursToWeeklyReset(in.Status, in.Now); ok {
		h = r(h, 1)
		hoursLeft = &h
	}
	return DrovrState{
		SchemaVersion: 1, GeneratedAt: epoch.ISO(in.Now),
		Mode: c.Mode, ModeFromPhone: c.Mode != in.Control.Mode, PauseUntil: c.PauseUntil,
		MaxConcurrentCycles: c.MaxConcurrentCycles, Reserve: r(1-ceilings.Weekly, 4),
		CyclesInFlight: len(inFlight),
		Service: ServiceState{
			Loaded: in.Service.Loaded, IntervalSeconds: in.Service.IntervalSeconds,
			LastTickAt: iso(in.Service.LastTickAt), Overdue: isOverdue(in.Service, in.Now),
		},
		Pool: PoolState{
			UsableAccounts: pool.UsableAccounts, FundingAccounts: decide.ContributingAccounts(funding),
			Fable: r(pool.Fable, 4), General: r(pool.General, 4), Session: r(pool.Session, 4),
		},
		BindingBucket:      funding.Binding,
		CyclesFundable:     r(float64(funding.Cycles), 2),
		BindingRecoveryAt:  iso(pool.ResetAt.Of(funding.Binding)),
		CapacityNote:       decide.PoolContext(funding, pool, in.Now),
		HoursToWeeklyReset: hoursLeft,
		Allocation:         allocation.SegmentsFor(in.Status, pool, in.Cycles, len(inFlight), cost, in.Now),
		Programs:           programs,
		Accounts:           status.AccountsFrom(in.Status),
		RecentCycles:       recentCycles(in.Cycles),
	}, nil
}

func recentCycles(cycles []ledger.Cycle) []RecentCycle {
	out := []RecentCycle{}
	for i := len(cycles) - 1; i >= 0 && len(out) < 8; i-- {
		if cycles[i].EndedAt == nil {
			continue
		}
		cy := cycles[i]
		out = append(out, RecentCycle{cy.StartedAt, cy.Program, cy.Kind, cy.Exit, cy.AsksRaised})
	}
	return out
}

// programsOf books a projected start for each program it admits, so the next one in priority
// order sees that capacity as spoken for; without it every independently fundable program
// would see the whole pool and report GO.
func programsOf(in Input, c control.Control) ([]ProgramState, error) {
	running := ledger.InFlight(in.Cycles, in.Now, c.MaxCycleHours)
	ordered, err := control.ByPriority(c.Programs, in.Now, c.DeadlineHorizonDays)
	if err != nil {
		return nil, err
	}
	cycles := append([]ledger.Cycle(nil), in.Cycles...)
	out := make([]ProgramState, 0, len(ordered))
	for _, p := range ordered {
		live := liveCycle(running, p.Name)
		di := decide.Input{Status: in.Status, Control: c, Cycles: cycles, Program: p.Name, Now: in.Now}
		if present, ok := in.Runners[p.Name]; ok {
			di.RunnerPresent = &present
		}
		d, err := decide.Decide(di)
		if err != nil {
			return nil, err
		}
		if d.Verdict == "GO" && p.Enabled && live == nil {
			cycles = append(cycles, ledger.Cycle{V: 1, Kind: "delivery", Program: p.Name, StartedAt: epoch.ISO(in.Now), Exit: "running"})
		}
		ps, err := programState(in, c, p, d, live)
		if err != nil {
			return nil, err
		}
		out = append(out, ps)
	}
	return out, nil
}

func liveCycle(running []ledger.Cycle, program string) *ledger.Cycle {
	for i := range running {
		if running[i].Program == program {
			return &running[i]
		}
	}
	return nil
}

func programState(in Input, c control.Control, p control.Program, d decide.Decision, live *ledger.Cycle) (ProgramState, error) {
	priority, err := control.EffectivePriority(p, in.Now, c.DeadlineHorizonDays)
	if err != nil {
		return ProgramState{}, err
	}
	ps := ProgramState{Name: p.Name, Enabled: p.Enabled, Priority: priority, Verdict: string(d.Verdict), Reason: d.Reason}
	if live != nil {
		ps.Verdict, ps.Kind, ps.StartedAt = "RUN", &live.Kind, &live.StartedAt
	}
	if pid, ok := in.Locks[p.Name]; ok {
		ps.Pid = &pid
	}
	if u, ok := in.AsksURLs[p.Name]; ok {
		ps.AsksURL = &u
	}
	if pv, ok := in.Previews[p.Name]; ok {
		ps.Context = &Context{pv.ContextPercent, pv.ContextTokens, pv.Subagents}
		ps.Preview = pv.Lines
	}
	return ps, nil
}
