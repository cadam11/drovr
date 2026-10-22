package status

import (
	"math"
	"strconv"

	"github.com/cadam11/drovr/internal/allocation"
	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/decide"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/service"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// Evaluation is one program's verdict as its caller computed it, with its lock holder.
type Evaluation struct {
	Program  control.Program
	Decision decide.Decision
	Pid      *int
}

type ServiceInput struct {
	State      service.State       `json:"state"`
	LastTickAt *epoch.Millis       `json:"lastTickAt"`
	LockHolder *service.LockHolder `json:"lockHolder"`
}

type Input struct {
	// Control is what the pass ran under, after ApplyAwayMode; StoredMode is what
	// control.json holds, so the payload can say when the phone overrode it.
	Control     control.Control
	StoredMode  control.Mode
	Status      teamclaude.Status
	Cycles      []ledger.Cycle
	Now         epoch.Millis
	Evaluations []Evaluation
	Service     ServiceInput
}

type Payload struct {
	GeneratedAt        string                `json:"generatedAt"`
	Service            ServicePayload        `json:"service"`
	Mode               control.Mode          `json:"mode"`
	ModeFromPhone      bool                  `json:"modeFromPhone"`
	ModeMeaning        string                `json:"modeMeaning"`
	PausedUntil        *string               `json:"pausedUntil"`
	Paused             bool                  `json:"paused"`
	Pool               *PoolPayload          `json:"pool"`
	Capacity           *FundingPayload       `json:"capacity"`
	CapacityNote       *string               `json:"capacityNote"`
	Allocation         *AllocationPayload    `json:"allocation"`
	EstimatedCycleCost CostPayload           `json:"estimatedCycleCost"`
	InFlight           []InFlightPayload     `json:"inFlight"`
	Accounts           []AccountWithHeadroom `json:"accounts"`
	AccountsUnits      string                `json:"accountsUnits"`
	ConcurrencyCap     float64               `json:"concurrencyCap"`
	Programs           []ProgramPayload      `json:"programs"`
}

type ServicePayload struct {
	Health      service.Health `json:"health"`
	Explanation string         `json:"explanation"`
	LastTickAt  *string        `json:"lastTickAt"`
	// IntervalSeconds is launchd's StartInterval, nil with no plist; staleness is judged against it.
	IntervalSeconds *int `json:"intervalSeconds"`
}

type Resets struct {
	Fable   *string `json:"fable"`
	General *string `json:"general"`
	Session *string `json:"session"`
}

type PoolPayload struct {
	Fable              float64 `json:"fable"`
	General            float64 `json:"general"`
	Session            float64 `json:"session"`
	UsableAccounts     int     `json:"usableAccounts"`
	ResetAt            Resets  `json:"resetAt"`
	EarliestRecoveryAt *string `json:"earliestRecoveryAt"`
	Units              string  `json:"units"`
}

type FundingPayload struct {
	CyclesFundable  *float64            `json:"cyclesFundable"`
	BindingBucket   capacity.Bucket     `json:"bindingBucket"`
	FundingAccounts int                 `json:"fundingAccounts"`
	PerAccount      []PerAccountPayload `json:"perAccount"`
	Units           string              `json:"units"`
}

type PerAccountPayload struct {
	Name             string          `json:"name"`
	CyclesFundable   *float64        `json:"cyclesFundable"`
	BindingBucket    capacity.Bucket `json:"bindingBucket"`
	RoutableForFable bool            `json:"routableForFable"`
}

type AllocationPayload struct {
	Fable   allocation.Allocation `json:"fable"`
	General allocation.Allocation `json:"general"`
	Session allocation.Allocation `json:"session"`
	Units   string                `json:"units"`
}

type CostPayload struct {
	Fable   float64 `json:"fable"`
	General float64 `json:"general"`
	Session float64 `json:"session"`
	Units   string  `json:"units"`
}

type InFlightPayload struct {
	Program   string `json:"program"`
	StartedAt string `json:"startedAt"`
	Kind      string `json:"kind"`
}

// AccountWithHeadroom always carries the key: nil reads as "not in the pool" (disabled,
// throttled, or mode off), where 0 would read as spent and absent as "this writer has no pool".
type AccountWithHeadroom struct {
	Account
	Headroom *control.Cost `json:"headroom"`
}

type ProgramPayload struct {
	Name              string         `json:"name"`
	Cwd               string         `json:"cwd"`
	Host              *control.Host  `json:"host"`
	Enabled           bool           `json:"enabled"`
	Priority          float64        `json:"priority"`
	EffectivePriority float64        `json:"effectivePriority"`
	Deadline          *string        `json:"deadline"`
	Verdict           decide.Verdict `json:"verdict"`
	VerdictMeaning    string         `json:"verdictMeaning"`
	Reason            string         `json:"reason"`
	// PoolNote is identical across programs; kept separate so a consumer showing several is
	// not handed the same sentence N times.
	PoolNote       *string          `json:"poolNote"`
	BindingBucket  *capacity.Bucket `json:"bindingBucket"`
	CyclesFundable *float64         `json:"cyclesFundable"`
	RecoversAt     *string          `json:"recoversAt"`
	RunningPid     *int             `json:"runningPid"`
}

var verdictMeaning = map[decide.Verdict]string{
	"GO":   "a cycle would launch on the next tick",
	"WAIT": "transient — a later tick will retry, no action needed",
	"STOP": "needs a human: mode is off, or this program produced no yield for several cycles",
}

const (
	poolUnits       = "account-fractions of headroom; one usable account contributes at most 1.0"
	fundingUnits    = "whole delivery cycles, net of cycles already in flight; the total is the sum over accounts of each account’s own tightest bucket, never the min of the pool sums"
	allocationUnits = "account-units per bucket; yoursSpent + programsSpent + programsReserved + programsAvailable + yoursReserved = total, the stacked bar drovr watch draws"
	costUnits       = "account-fractions consumed by one typical delivery cycle"
	accountsUnits   = "per teamclaude account: each bucket’s used fraction of its own quota and its next reset; headroom is what the pool counts for it under the current ceilings, null when it is not usable; switchThresholds is the used fraction per bucket at which teamclaude stops routing to the account"
)

// roundFinite is nil for ±Inf, which only arises when every bucket's estimated cost is zero
// and which JSON cannot carry.
func roundFinite(v float64) *float64 {
	if math.IsInf(v, 0) || math.IsNaN(v) {
		return nil
	}
	r := jsnum.Round4(v)
	return &r
}

func roundCost(c control.Cost) control.Cost {
	return control.Cost{Fable: jsnum.Round4(c.Fable), General: jsnum.Round4(c.General), Session: jsnum.Round4(c.Session)}
}

func poolPayload(p capacity.Pool) *PoolPayload {
	r := roundCost(p.Snapshot())
	return &PoolPayload{
		Fable: r.Fable, General: r.General, Session: r.Session,
		UsableAccounts:     p.UsableAccounts,
		ResetAt:            Resets{iso(p.ResetAt.Fable), iso(p.ResetAt.General), iso(p.ResetAt.Session)},
		EarliestRecoveryAt: iso(p.EarliestRecoveryAt),
		Units:              poolUnits,
	}
}

// fundingPayload cannot be the pool sums divided by cost: an account is spendable only where
// it has room in all three buckets at once, so capacity is summed per account.
func fundingPayload(f decide.Funding) *FundingPayload {
	per := make([]PerAccountPayload, 0, len(f.Accounts))
	for _, a := range f.Accounts {
		per = append(per, PerAccountPayload{a.Name, roundFinite(float64(a.Cycles)), a.Binding, a.Routable})
	}
	return &FundingPayload{
		CyclesFundable:  roundFinite(float64(f.Cycles)),
		BindingBucket:   f.Binding,
		FundingAccounts: decide.ContributingAccounts(f),
		PerAccount:      per,
		Units:           fundingUnits,
	}
}

func accountsPayload(s teamclaude.Status, pool *capacity.Pool) []AccountWithHeadroom {
	accounts := AccountsFrom(s)
	out := make([]AccountWithHeadroom, 0, len(accounts))
	for _, a := range accounts {
		out = append(out, AccountWithHeadroom{Account: a, Headroom: headroomOf(pool, a.Name)})
	}
	return out
}

func headroomOf(pool *capacity.Pool, name string) *control.Cost {
	if pool == nil {
		return nil
	}
	for _, h := range pool.PerAccount {
		if h.Name == name {
			r := roundCost(control.Cost{Fable: h.Fable, General: h.General, Session: h.Session})
			return &r
		}
	}
	return nil
}

func modeMeaning(c control.Control, stored control.Mode) string {
	if c.Mode == "off" {
		return "no cycles will start"
	}
	share := jsnum.Round4(c.Ceilings[string(c.Mode)].Weekly * 100)
	phone := ""
	if c.Mode != stored {
		phone = "; away is the phone's toggle for this pass, the stored mode is " + string(stored)
	}
	return "programs may use up to " + strconv.FormatFloat(share, 'f', -1, 64) + "% of each account's weekly quota; the rest stays available to Craig" + phone
}

func inFlightPayload(running []ledger.Cycle) []InFlightPayload {
	out := make([]InFlightPayload, 0, len(running))
	for _, c := range running {
		out = append(out, InFlightPayload{c.Program, c.StartedAt, c.Kind})
	}
	return out
}

func programPayload(e Evaluation, c control.Control, now epoch.Millis) (ProgramPayload, error) {
	p, d := e.Program, e.Decision
	effective, err := control.EffectivePriority(p, now, c.DeadlineHorizonDays)
	if err != nil {
		return ProgramPayload{}, err
	}
	var fundable *float64
	if d.CyclesFundable != nil {
		fundable = roundFinite(float64(*d.CyclesFundable))
	}
	return ProgramPayload{
		Name: p.Name, Cwd: p.Cwd, Host: p.Host, Enabled: p.Enabled,
		Priority: p.Priority, EffectivePriority: effective, Deadline: p.Deadline,
		Verdict: d.Verdict, VerdictMeaning: verdictMeaning[d.Verdict], Reason: d.Reason,
		PoolNote: d.Note, BindingBucket: d.Binding, CyclesFundable: fundable,
		RecoversAt: iso(d.EarliestRecoveryAt), RunningPid: e.Pid,
	}, nil
}

func servicePayload(s ServiceInput, now epoch.Millis) ServicePayload {
	return ServicePayload{
		Health:          service.HealthOf(s.State, s.LastTickAt, now),
		Explanation:     service.Describe(s.State, s.LastTickAt, now, s.LockHolder),
		LastTickAt:      iso(s.LastTickAt),
		IntervalSeconds: s.State.IntervalSeconds,
	}
}

// pooled is everything that exists only while a mode has ceilings.
type pooled struct {
	pool       *PoolPayload
	capacity   *FundingPayload
	note       *string
	allocation *AllocationPayload
}

// fromPool charges in-flight cycles with ChargeForRunning, never the raw count: the same charge
// decide() applies, or this payload over-reports fundability against the verdicts printed in it.
func fromPool(in Input, pool capacity.Pool, running []ledger.Cycle, cost ledger.Cost) pooled {
	funding := decide.CyclesFundableFrom(pool, cost, ledger.ChargeForRunning(running, pool.Snapshot(), cost))
	note := decide.PoolContext(funding, pool, in.Now)
	seg := allocation.SegmentsFor(in.Status, pool, in.Cycles, len(running), cost, in.Now)
	return pooled{
		pool:       poolPayload(pool),
		capacity:   fundingPayload(funding),
		note:       &note,
		allocation: &AllocationPayload{seg.Fable, seg.General, seg.Session, allocationUnits},
	}
}

// Build arranges what the caller already read and decided, so the CLI and the tick cannot
// drift apart. It errors only where the TS throws.
func Build(in Input) (Payload, error) {
	c := in.Control
	ceilings, hasCeilings, err := control.CeilingsFor(c)
	if err != nil {
		return Payload{}, err
	}
	paused, err := control.IsPaused(c, in.Now)
	if err != nil {
		return Payload{}, err
	}
	// control.MaxCycleHours, never InFlight's own default: decide() cuts off there.
	running := ledger.InFlight(in.Cycles, in.Now, c.MaxCycleHours)
	cost := ledger.EstimateCycleCost(in.Cycles, c.SeedCycleCost, 3, 0.9)
	var pool *capacity.Pool
	var pp pooled
	if hasCeilings {
		p := capacity.PoolFrom(in.Status, ceilings, in.Now)
		pool = &p
		pp = fromPool(in, p, running, cost)
	}
	programs := make([]ProgramPayload, 0, len(in.Evaluations))
	for _, e := range in.Evaluations {
		prog, err := programPayload(e, c, in.Now)
		if err != nil {
			return Payload{}, err
		}
		programs = append(programs, prog)
	}
	rc := roundCost(cost)
	return Payload{
		GeneratedAt:        epoch.ISO(in.Now),
		Service:            servicePayload(in.Service, in.Now),
		Mode:               c.Mode,
		ModeFromPhone:      c.Mode != in.StoredMode,
		ModeMeaning:        modeMeaning(c, in.StoredMode),
		PausedUntil:        c.PauseUntil,
		Paused:             paused,
		Pool:               pp.pool,
		Capacity:           pp.capacity,
		CapacityNote:       pp.note,
		Allocation:         pp.allocation,
		EstimatedCycleCost: CostPayload{rc.Fable, rc.General, rc.Session, costUnits},
		InFlight:           inFlightPayload(running),
		Accounts:           accountsPayload(in.Status, pool),
		AccountsUnits:      accountsUnits,
		ConcurrencyCap:     c.MaxConcurrentCycles,
		Programs:           programs,
	}, nil
}
