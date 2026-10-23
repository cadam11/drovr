// Package decide is the one place judgement lives: whether a program may start a cycle now.
// It is pure — every input arrives in Input and all I/O stays with the caller — so it can be
// replayed against recorded status JSON.
package decide

import (
	"encoding/json"
	"fmt"
	"math"
	"strings"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/teamclaude"
)

const (
	weeklyWindowHours = 168
	dayMs             = 86_400_000
	// paceBurstCycles is what drovr may always run right after a reset. Linear entitlement
	// from zero refuses the first cycle of every window, turning a gate meant to smooth the
	// week into one that never lets it start.
	paceBurstCycles = 2
)

type Verdict string

// Cycles is a count of fundable cycles, Infinity when a bucket costs nothing; JSON has no
// Infinity, so it travels as the string the TS recorder writes.
type Cycles float64

func (c Cycles) MarshalJSON() ([]byte, error) {
	switch {
	case math.IsInf(float64(c), 1):
		return []byte(`"Infinity"`), nil
	case math.IsInf(float64(c), -1):
		return []byte(`"-Infinity"`), nil
	}
	return json.Marshal(float64(c))
}

func (c *Cycles) UnmarshalJSON(data []byte) error {
	switch string(data) {
	case `"Infinity"`:
		*c = Cycles(math.Inf(1))
		return nil
	case `"-Infinity"`:
		*c = Cycles(math.Inf(-1))
		return nil
	}
	var f float64
	if err := json.Unmarshal(data, &f); err != nil {
		return fmt.Errorf("cycles: %w", err)
	}
	*c = Cycles(f)
	return nil
}

// AccountFunding is what one account could fund alone, and which of its buckets stopped it.
type AccountFunding struct {
	Name     string          `json:"name"`
	Cycles   Cycles          `json:"cycles"`
	Binding  capacity.Bucket `json:"binding"`
	Routable bool            `json:"routable"`
}

type Funding struct {
	Cycles   Cycles           `json:"cycles"`
	Binding  capacity.Bucket  `json:"binding"`
	Accounts []AccountFunding `json:"accounts"`
}

// Decision keeps the per-program half in Reason and the pool context, identical for every
// program in a pass, in Note: reasons carrying the whole picture were rewritten
// near-identically on every row of `drovr status` and `drovr watch`.
type Decision struct {
	Verdict            Verdict          `json:"verdict"`
	Reason             string           `json:"reason"`
	Note               *string          `json:"note"`
	Pool               *capacity.Pool   `json:"pool"`
	CyclesFundable     *Cycles          `json:"cyclesFundable"`
	Binding            *capacity.Bucket `json:"binding"`
	EarliestRecoveryAt *epoch.Millis    `json:"earliestRecoveryAt"`
}

type Input struct {
	Status     teamclaude.Status
	Control    control.Control
	Cycles     []ledger.Cycle // every program's: quota is one shared pool
	Program    string
	Now        epoch.Millis
	AnsweredAt *epoch.Millis
	AsksShared *bool
	// RunnerPresent nil is unknown (orca unreachable, a headless runner), which must never
	// refuse a cycle; only true holds.
	RunnerPresent *bool
}

// FullReason reattaches the pool context for surfaces where a line must stand alone.
func FullReason(d Decision) string {
	if d.Note == nil {
		return d.Reason
	}
	return d.Reason + " — " + *d.Note
}

func ratio(available, cost float64) float64 {
	if cost <= 0 {
		return math.Inf(1)
	}
	return available / cost
}

// fundingFor takes the tightest bucket: one Fable token decrements all three on the account
// that served it, so they bind simultaneously. An account teamclaude will not route Fable to
// funds nothing, but keeps its bucket — that is what has to reset before it comes back.
func fundingFor(a capacity.AccountHeadroom, cost ledger.Cost) AccountFunding {
	var best AccountFunding
	for i, b := range capacity.Buckets {
		c := Cycles(ratio(a.Of(b), cost.Of(b)))
		if i == 0 || c < best.Cycles {
			best = AccountFunding{Name: a.Name, Cycles: c, Binding: b, Routable: a.Routable}
		}
	}
	if !a.Routable {
		best.Cycles = 0
	}
	return best
}

func resetOrder(pool capacity.Pool, b capacity.Bucket) float64 {
	if at := pool.ResetAt.Of(b); at != nil {
		return float64(*at)
	}
	return math.Inf(1)
}

// bindingOf: above zero, the bucket pinning the account that would serve next. At zero, the
// bucket that frees an account first — a 5h hold is hours, a weekly one days, and naming the
// wrong one turns a short wait into an apparent write-off.
func bindingOf(accounts []AccountFunding, pool capacity.Pool) capacity.Bucket {
	best := accounts[0]
	for _, a := range accounts[1:] {
		if a.Cycles > best.Cycles {
			best = a
		}
	}
	if best.Cycles > 0 {
		return best.Binding
	}
	soonest := accounts[0].Binding
	for _, a := range accounts[1:] {
		if resetOrder(pool, a.Binding) < resetOrder(pool, soonest) {
			soonest = a.Binding
		}
	}
	return soonest
}

// CyclesFundableFrom sums each account's own tightest bucket — never the min of per-bucket
// sums, which lets an exhausted account donate headroom it cannot spend. `running` comes off
// the cycle count: in-flight cycles have not shown up as spent quota yet.
func CyclesFundableFrom(pool capacity.Pool, cost ledger.Cost, running float64) Funding {
	accounts := make([]AccountFunding, 0, len(pool.PerAccount))
	gross := 0.0
	for _, a := range pool.PerAccount {
		f := fundingFor(a, cost)
		accounts = append(accounts, f)
		gross += float64(f.Cycles)
	}
	// No usable accounts still has to name a bucket; session is the shortest wait.
	if len(accounts) == 0 {
		return Funding{Cycles: 0, Binding: "session", Accounts: accounts}
	}
	return Funding{Cycles: Cycles(math.Max(0, gross-running)), Binding: bindingOf(accounts, pool), Accounts: accounts}
}

func ContributingAccounts(f Funding) int {
	n := 0
	for _, a := range f.Accounts {
		if a.Cycles > 0 {
			n++
		}
	}
	return n
}

// PoolContext is the pool-level half of a capacity verdict, shared by every program in a
// pass, so the line renderers draw can never disagree with the note decisions carry.
func PoolContext(f Funding, pool capacity.Pool, now epoch.Millis) string {
	s := fmt.Sprintf("%s is tightest, more room in %s", f.Binding, untilText(pool.ResetAt.Of(f.Binding), now))
	var notes []string
	for _, n := range []*string{couplingNote(f), concentrationNote(f, pool.UsableAccounts)} {
		if n != nil {
			notes = append(notes, *n)
		}
	}
	if len(notes) == 0 {
		return s
	}
	return s + " — " + strings.Join(notes, "; ")
}

// paceExceeded asks whether the loop is ahead of a linear burn of its weekly allowance,
// `pool + spent` — what is still reachable plus what drovr already spent. Granting the
// ceiling as though drovr owned it all let the gate fire zero times in 1008 decisions to
// 2026-08-26. Session is absent: a five-hour window has no week to pace across.
func paceExceeded(in Input, pool capacity.Pool, cost ledger.Cost) (string, bool) {
	hoursLeft, ok := capacity.HoursToWeeklyReset(in.Status, in.Now)
	if !ok {
		return "", false
	}
	elapsed := math.Min(1, math.Max(0, (weeklyWindowHours-hoursLeft)/weeklyWindowHours))
	windowStart := float64(in.Now) - (weeklyWindowHours-hoursLeft)*3_600_000
	spent := ledger.SpentSince(in.Cycles, windowStart, math.MaxInt64)
	for _, b := range []capacity.Bucket{"fable", "general"} {
		used := spent.Of(b)
		allowance := pool.Of(b) + used
		if used > math.Max(allowance*elapsed, cost.Of(b)*paceBurstCycles) {
			return paceMessage(b, used, allowance, elapsed, hoursLeft), true
		}
	}
	return "", false
}

func halt(reason string) Decision {
	return Decision{Verdict: "STOP", Reason: reason}
}

// hold reads recovery from the binding bucket's own reset, not the soonest of all three.
func hold(reason string, pool *capacity.Pool, funding *Funding, note *string) Decision {
	d := Decision{Verdict: "WAIT", Reason: reason, Note: note, Pool: pool}
	if pool != nil {
		d.EarliestRecoveryAt = pool.EarliestRecoveryAt
	}
	if funding == nil {
		return d
	}
	cycles, binding := funding.Cycles, funding.Binding
	d.CyclesFundable, d.Binding = &cycles, &binding
	if pool != nil {
		d.EarliestRecoveryAt = pool.ResetAt.Of(binding)
	}
	return d
}

func cyclesOf(cycles []ledger.Cycle, program string) []ledger.Cycle {
	mine := []ledger.Cycle{}
	for _, c := range cycles {
		if c.Program == program {
			mine = append(mine, c)
		}
	}
	return mine
}

// ProgramReadiness asks whether the program is fit to run at all; nil means yes. It reads no
// pool — that is the test of the seam (docs/allocation-review.md, finding 5): a program that
// is disabled, latched, paused or owed an answer will not run however much quota exists.
func ProgramReadiness(in Input) (*Decision, error) {
	c, mine := in.Control, cyclesOf(in.Cycles, in.Program)
	entry, found := c.Program(in.Program)
	// Tick skips disabled programs; anything but STOP would promise a cycle that never starts.
	if found && !entry.Enabled {
		return ptr(halt("disabled — enable it to let cycles start")), nil
	}
	if stuck := ledger.ConsecutiveZeroYield(mine); float64(stuck) >= c.StuckCycleThreshold {
		return ptr(halt(fmt.Sprintf("%d consecutive cycles produced no yield — escalating instead of looping", stuck))), nil
	}
	// Only recent failures latch, so a fixed cause resumes without anyone clearing it.
	if failures := ledger.ConsecutiveFailures(mine, in.Now, c.CrashWindowMinutes); float64(failures) >= c.StuckCycleThreshold {
		return ptr(halt(fmt.Sprintf("%d cycles crashed or stalled in the last %sm — see ", failures, num(c.CrashWindowMinutes)) +
			fmt.Sprintf("~/.drovr/logs/%s-worker.log. Retries on its own once those age out, ", in.Program) +
			fmt.Sprintf(`or run "drovr run-cycle %s" to try immediately.`, in.Program))), nil
	}
	paused, err := control.IsPaused(c, in.Now)
	if err != nil {
		return nil, err
	}
	if paused {
		return ptr(hold("paused until "+*c.PauseUntil, nil, nil, nil)), nil
	}
	if found {
		if d, err := timeHold(in, entry, mine); d != nil || err != nil {
			return d, err
		}
	}
	return blockedHold(in, mine), nil
}

// timeHold is a program waiting on the world: a rest its own last cycle declared, because
// everything left was waiting on time, or a cadence window not yet open.
func timeHold(in Input, entry control.Program, mine []ledger.Cycle) (*Decision, error) {
	_, resting, err := control.ProgramPausedUntil(entry, in.Now)
	if err != nil {
		return nil, err
	}
	if resting {
		return ptr(hold(fmt.Sprintf("resting until %s at its own request — resume early: drovr resume %s", *entry.PauseUntil, in.Program), nil, nil, nil)), nil
	}
	last, hasLast := ledger.LastStartedAt(mine)
	opens, held, err := control.NextCadenceStart(entry, last, hasLast)
	if err != nil {
		return nil, err
	}
	if held && opens > in.Now {
		return ptr(hold(fmt.Sprintf("on a %s cadence — next window in %s; ", *entry.Cadence, untilText(&opens, in.Now))+
			fmt.Sprintf("change it: drovr cadence %s off", in.Program), nil, nil, nil)), nil
	}
	return nil, nil
}

// blockedHold backs off after a blocked cycle: every remaining item waits on a human answer,
// so starting another straight away only pays to rediscover that. An answer on the asks page
// ends the wait at once — it is the event the backoff was standing in for.
func blockedHold(in Input, mine []ledger.Cycle) *Decision {
	last, ok := ledger.LastFinished(mine)
	if !ok || last.Exit != "blocked" || last.EndedAt == nil {
		return nil
	}
	ended, ok := epoch.Parse(*last.EndedAt)
	if !ok {
		return nil // NaN in the TS: neither answered nor due, so no hold
	}
	retryAt := float64(ended) + in.Control.BlockedBackoffMinutes*60_000
	if answeredAt(in) > ended || retryAt <= float64(in.Now) {
		return nil
	}
	mins := math.Ceil((retryAt - float64(in.Now)) / 60_000)
	// Shared notes being off is the reason an answer goes unnoticed, so name it.
	unnoticed := ""
	if asksUnshared(in) {
		unnoticed = ". Shared notes are off on that page, so drovr cannot see your reply"
	}
	return ptr(hold(fmt.Sprintf("waiting on you — the last cycle was blocked on unanswered asks. Retries in %sm, ", num(mins))+
		fmt.Sprintf(`or answer them and run "drovr start %s"%s`, in.Program, unnoticed), nil, nil, nil))
}

func answeredAt(in Input) epoch.Millis {
	if in.AnsweredAt == nil {
		return 0
	}
	return *in.AnsweredAt
}

func asksUnshared(in Input) bool { return in.AsksShared != nil && !*in.AsksShared }

func ptr[T any](v T) *T { return &v }

// admissionLimits are about sharing rather than quota: one cycle per program and per
// checkout, a leftover runner, the concurrency and daily caps, an answer Craig owes. They
// take the pool only to attach it to the hold, so every WAIT carries the numbers renderers draw.
func admissionLimits(in Input, pool *capacity.Pool, running []ledger.Cycle) *Decision {
	if d := sharingLimit(in, pool, running); d != nil {
		return d
	}
	c := in.Control
	if float64(len(running)) >= c.MaxConcurrentCycles {
		return ptr(hold(fmt.Sprintf("%d cycles ahead of it, cap is %s", len(running), num(c.MaxConcurrentCycles)), pool, nil, nil))
	}
	limit := c.MaxCyclesPerDay
	if entry, ok := c.Program(in.Program); ok && entry.MaxCyclesPerDay != nil {
		limit = *entry.MaxCyclesPerDay
	}
	mine := cyclesOf(in.Cycles, in.Program)
	if today := ledger.CyclesStartedSince(mine, in.Now-dayMs); float64(today) >= limit {
		return ptr(hold(fmt.Sprintf("daily cap reached (%d/%s cycles that did work). Raise it with ", today, num(limit))+
			fmt.Sprintf(`"drovr cap %s <n>"`, in.Program), pool, nil, nil))
	}
	return owedHold(in, pool, mine)
}

// sharingLimit holds a program whose own cycle, or a same-checkout sibling's, is running, or
// whose previous runner is still in its pane.
func sharingLimit(in Input, pool *capacity.Pool, running []ledger.Cycle) *Decision {
	entry, found := in.Control.Program(in.Program)
	for _, r := range running {
		if r.Program == in.Program {
			return ptr(hold("a cycle for this program is already in flight", pool, nil, nil))
		}
	}
	// Programs may share a directory, but never a moment: two interactive runners in one
	// checkout race the git index and commit each other's half-done work. A disabled
	// sibling's runner is just as real, and tick folds same-pass launches into `running`.
	for _, r := range running {
		other, ok := in.Control.Program(r.Program)
		if ok && found && other.Cwd == entry.Cwd {
			return ptr(hold(fmt.Sprintf("%s's cycle is running in the same directory (%s) — ", r.Program, entry.Cwd)+
				"one runner per checkout; starts when it ends", pool, nil, nil))
		}
	}
	// Before anything computes funding: an admitted leftover refuses its launch with
	// PaneBusy, yet tick books it as launched and charges a full cycle for the rest of the
	// pass — measured 2026-08-27, 38 deferrals each taking two programs from 1.35 to 0.35.
	if in.RunnerPresent != nil && *in.RunnerPresent {
		return ptr(hold("its previous runner outlived its cycle and still holds its cycle terminal in Orca. "+
			fmt.Sprintf(`Once its tab shows a report and nothing running in the background, "drovr release %s"`, in.Program), pool, nil, nil))
	}
	return nil
}

// owedHold comes last because everything above is harder: a program otherwise ready and
// sitting on unanswered asks is waiting on Craig, and saying so beats naming whichever
// check happened to fire.
func owedHold(in Input, pool *capacity.Pool, mine []ledger.Cycle) *Decision {
	owed, ok := ledger.UnansweredAsks(mine)
	if !ok || answeredAt(in) > owed.At {
		return nil
	}
	tail := ""
	if asksUnshared(in) {
		tail = fmt.Sprintf(`. Shared notes are off on that page, so answer and run "drovr start %s"`, in.Program)
	}
	ago := roundInt(float64(in.Now-owed.At) / 60_000)
	return ptr(hold(fmt.Sprintf("waiting on you — %s ask(s) raised %dm ago ", num(owed.Asks), ago)+
		"and every cycle since has come back blocked"+tail, pool, nil, nil))
}

// RequiredCycles is the runway a start must see. reserveCycles applies to the weekly buckets
// only: a dry weekly bucket can kill a cycle mid-flight, while a dry 5h window refills and
// only makes a runner wait — and `1 + reserveCycles` of session was unsatisfiable (measured
// 2026-08-26, p90 session 0.390 demanding 0.585 of a 0.400 window). Session still needs one
// whole cycle, or a cycle starts and idles on a held pane. Each step down the drain order
// raises the bar by priorityStepCycles, so the last fundable cycle goes to the top program
// (measured 2026-08-27, aice-x took the pool's final cycle while sunnyt waited 5h).
func RequiredCycles(binding capacity.Bucket, c control.Control, rank int) float64 {
	base := 1 + c.ReserveCycles
	if binding == "session" {
		base = 1
	}
	return base + float64(rank)*c.PriorityStepCycles
}

// capacityVerdict is the only layer that reads quota, and the only one that can return GO.
func capacityVerdict(in Input, pool capacity.Pool, running []ledger.Cycle) (Decision, error) {
	cost := ledger.EstimateCycleCost(in.Cycles, in.Control.SeedCycleCost, 3, 0.9)
	if offPace, over := paceExceeded(in, pool, cost); over {
		return hold(offPace, &pool, nil, nil), nil
	}
	// Charged, not counted: a cycle draining more than its price has to stop admission
	// while it happens, not once it has finished and been measured.
	funding := CyclesFundableFrom(pool, cost, ledger.ChargeForRunning(running, pool.Snapshot(), cost))
	lastStartFor := func(name string) (epoch.Millis, bool) { return ledger.LastStartedAt(cyclesOf(in.Cycles, name)) }
	rank, err := control.PriorityRank(in.Control, in.Program, in.Now, lastStartFor)
	if err != nil {
		return Decision{}, err
	}
	required := RequiredCycles(funding.Binding, in.Control, rank.Rank)
	context := PoolContext(funding, pool, in.Now)
	cycles := float64(funding.Cycles)
	if cycles >= required {
		return Decision{
			Verdict:            "GO",
			Reason:             fmt.Sprintf("room for %s more cycles %s (%d running)", jsnum.ToFixed(cycles, 2), sourcedFrom(funding, pool.UsableAccounts), len(running)),
			Note:               &context,
			Pool:               &pool,
			CyclesFundable:     &funding.Cycles,
			Binding:            &funding.Binding,
			EarliestRecoveryAt: pool.EarliestRecoveryAt,
		}, nil
	}
	// Room that would admit this program at rank 0 is held by priority alone — the one
	// raised bar worth explaining, since the reader sees room and needs to know for whom.
	if rank.Rank > 0 && cycles >= RequiredCycles(funding.Binding, in.Control, 0) {
		return hold(fmt.Sprintf("room for %s cycles, held back for %s — ", jsnum.ToFixed(cycles, 2), listOf(rank.Above))+
			fmt.Sprintf("%s starts above %s", in.Program, jsnum.ToFixed(required, 2)), &pool, &funding, &context), nil
	}
	return hold(fmt.Sprintf("a start needs %s and the pool has room for ", jsnum.ToFixed(required, 2))+
		fmt.Sprintf("%s cycles (%d running)", jsnum.ToFixed(cycles, 2), len(running)), &pool, &funding, &context), nil
}

// Decide composes the three layers in hardness order: is the program fit to run, is it
// allowed a slot, can the pool afford it.
func Decide(in Input) (Decision, error) {
	ceilings, on, err := control.CeilingsFor(in.Control)
	if err != nil {
		return Decision{}, err
	}
	if !on {
		return halt("mode is off"), nil
	}
	notReady, err := ProgramReadiness(in)
	if err != nil || notReady != nil {
		return deref(notReady), err
	}
	pool := capacity.PoolFrom(in.Status, ceilings, in.Now)
	if pool.UsableAccounts == 0 {
		return hold("no usable accounts", &pool, nil, nil), nil
	}
	running := ledger.InFlight(in.Cycles, in.Now, in.Control.MaxCycleHours)
	if limited := admissionLimits(in, &pool, running); limited != nil {
		return *limited, nil
	}
	return capacityVerdict(in, pool, running)
}

func deref(d *Decision) Decision {
	if d == nil {
		return Decision{}
	}
	return *d
}
