// Package allocation divides each quota bucket into the five stacked-bar segments, from the
// same Pool decide() uses so the picture cannot contradict the verdict printed beneath it.
package allocation

import (
	"math"
	"strconv"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// Allocation is one bucket in account-units (N usable accounts = N.0); the five segments
// always sum to Total.
type Allocation struct {
	Bucket capacity.Bucket `json:"bucket"`
	Total  float64         `json:"total"`
	// YoursSpent is spent outside drovr: Craig's own foreground work.
	YoursSpent float64 `json:"yoursSpent"`
	// ProgramsSpent is spent by completed drovr cycles inside the current window.
	ProgramsSpent float64 `json:"programsSpent"`
	// ProgramsReserved is claimed by in-flight cycles not yet visible as usage.
	ProgramsReserved float64 `json:"programsReserved"`
	// ProgramsAvailable is still spendable by programs before the ceiling.
	ProgramsAvailable float64 `json:"programsAvailable"`
	// YoursReserved is held above the ceiling and never touched by drovr.
	YoursReserved float64 `json:"yoursReserved"`
}

type Input struct {
	Status          teamclaude.Status
	Pool            capacity.Pool
	Bucket          capacity.Bucket
	SpentByPrograms float64
	RunningCycles   int
	CycleCost       ledger.Cost
	Now             epoch.Millis
}

type Segments struct {
	Fable   Allocation `json:"fable"`
	General Allocation `json:"general"`
	Session Allocation `json:"session"`
}

func quotaOf(q teamclaude.Quota, b capacity.Bucket) *float64 {
	switch b {
	case "fable":
		return q.Unified7dFable
	case "general":
		return q.Unified7d
	case "session":
		return q.Unified5h
	}
	panic("allocation: unknown bucket " + string(b))
}

func usedTotal(s teamclaude.Status, b capacity.Bucket, now epoch.Millis) float64 {
	total := 0.0
	for _, a := range s.Accounts {
		if !capacity.IsUsable(a, now) {
			continue
		}
		if used := quotaOf(a.Quota, b); used != nil {
			total += *used
		}
	}
	return total
}

func For(in Input) Allocation {
	total := float64(in.Pool.UsableAccounts)
	used := math.Min(usedTotal(in.Status, in.Bucket, in.Now), total)

	// The ledger can over-report against a shrunken pool (an account dropped out mid-window),
	// so programs never claim more of `used` than actually exists.
	programsSpent := math.Max(0, math.Min(in.SpentByPrograms, used))

	// Headroom comes from the pool, which clamps each account at its own ceiling; deriving it
	// from ceiling x accounts - used would let one account's overspend eat another's.
	headroom := math.Min(in.Pool.Of(in.Bucket), math.Max(0, total-used))
	reserved := math.Min(float64(in.RunningCycles)*in.CycleCost.Of(in.Bucket), headroom)

	return Allocation{
		Bucket:            in.Bucket,
		Total:             total,
		YoursSpent:        used - programsSpent,
		ProgramsSpent:     programsSpent,
		ProgramsReserved:  reserved,
		ProgramsAvailable: headroom - reserved,
		YoursReserved:     math.Max(0, total-used-headroom),
	}
}

// round4 is Number(x.toFixed(4)); the parse cannot fail on ToFixed's output.
func round4(x float64) float64 {
	v, err := strconv.ParseFloat(jsnum.ToFixed(x, 4), 64)
	if err != nil {
		panic("allocation: ToFixed produced unparseable " + err.Error())
	}
	return v
}

// roundAllocation: the division and multiplication over quota fractions is the biggest
// source of float noise in a payload.
func roundAllocation(a Allocation) Allocation {
	return Allocation{
		Bucket:            a.Bucket,
		Total:             round4(a.Total),
		YoursSpent:        round4(a.YoursSpent),
		ProgramsSpent:     round4(a.ProgramsSpent),
		ProgramsReserved:  round4(a.ProgramsReserved),
		ProgramsAvailable: round4(a.ProgramsAvailable),
		YoursReserved:     round4(a.YoursReserved),
	}
}

// SegmentsFor is the three bars over the current weekly window; one function for every
// payload so a remote bar cannot disagree with the TUI's.
func SegmentsFor(status teamclaude.Status, pool capacity.Pool, cycles []ledger.Cycle, runningCycles int, cost ledger.Cost, now epoch.Millis) Segments {
	windowStart := float64(now)
	if hoursLeft, ok := capacity.HoursToWeeklyReset(status, now); ok {
		windowStart = float64(now) - (168-hoursLeft)*3_600_000
	}
	spent := ledger.SpentSince(cycles, windowStart, math.MaxInt64)
	bar := func(b capacity.Bucket) Allocation {
		return roundAllocation(For(Input{
			Status: status, Pool: pool, Bucket: b, SpentByPrograms: spent.Of(b),
			RunningCycles: runningCycles, CycleCost: cost, Now: now,
		}))
	}
	return Segments{Fable: bar("fable"), General: bar("general"), Session: bar("session")}
}
