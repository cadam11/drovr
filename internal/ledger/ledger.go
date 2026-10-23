// Package ledger is cycles.jsonl and decisions.jsonl: the records, and every measurement
// read off them — what a cycle costs, what is in flight, and the streaks that latch a program.
package ledger

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"slices"
	"strings"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
)

type Cost = control.Cost

type Yield struct {
	TicketsMoved float64 `json:"ticketsMoved"`
	PrsOpened    float64 `json:"prsOpened"`
	Commits      float64 `json:"commits"`
}

type Cycle struct {
	V             int      `json:"v"`
	Kind          string   `json:"kind"`
	Program       string   `json:"program"`
	StartedAt     string   `json:"startedAt"`
	EndedAt       *string  `json:"endedAt"`
	Exit          string   `json:"exit"`
	PoolBefore    Cost     `json:"poolBefore"`
	PoolAfter     *Cost    `json:"poolAfter"`
	StartupTokens *float64 `json:"startupTokens"`
	Yield         *Yield   `json:"yield"`
	AsksRaised    float64  `json:"asksRaised"`
	PauseUntil    *string  `json:"pauseUntil"`
	SessionID     *string  `json:"sessionId"`
	Closing       *string  `json:"closing"`
}

type Decision struct {
	V              int      `json:"v"`
	At             string   `json:"at"`
	Program        string   `json:"program"`
	Verdict        string   `json:"verdict"`
	Reason         string   `json:"reason"`
	Pool           *Cost    `json:"pool"`
	CyclesFundable *float64 `json:"cyclesFundable"`
}

// Exits: `abandoned` is the honest answer where `crash` used to be guessed — the watch hit
// maxCycleHours while the runner was still alive, which says nothing about delivery.
var Exits = []string{"context", "capacity", "seam", "blocked", "crash", "stalled", "deferred", "abandoned", "running"}

var kinds = []string{"delivery", "onboarding"}
var verdicts = []string{"GO", "WAIT", "STOP"}

// didNotDeliver never started or went nowhere: not cost samples, and no daily-cap spend.
var didNotDeliver = []string{"crash", "stalled", "deferred"}

// deliveryUnknown says nothing about delivery, so it must not burn a day on a guess — but its
// quota spend is real and measured, so unlike didNotDeliver it is a cost sample.
var deliveryUnknown = []string{"abandoned"}

var reported = []string{"context", "capacity", "seam", "blocked"}

var failed = []string{"crash", "stalled"}

func identity(c Cycle) string { return c.Program + "|" + c.StartedAt }

// fields is one JSON object being checked against a zod shape; unknown keys are ignored,
// which is zod's strip.
type fields map[string]json.RawMessage

func objectOf(raw json.RawMessage, path string) (fields, error) {
	var f fields
	if isNull(raw) {
		return nil, fmt.Errorf("%s: expected object, received null", path)
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("%s: expected object: %v", path, err)
	}
	return f, nil
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func into[T any](raw json.RawMessage, key string, dst *T) error {
	if err := json.Unmarshal(raw, dst); err != nil {
		return fmt.Errorf("%s: %v", key, err)
	}
	return nil
}

// required refuses absent and null alike, as zod does for a field with no default.
func required[T any](f fields, key string, dst *T) error {
	raw, ok := f[key]
	if !ok || isNull(raw) {
		return fmt.Errorf("%s: required", key)
	}
	return into(raw, key, dst)
}

// nullableRequired is zod's `.nullable()` with no default: null is a value, absent is not.
func nullableRequired[T any](f fields, key string, dst **T) error {
	raw, ok := f[key]
	if !ok {
		return fmt.Errorf("%s: required", key)
	}
	if isNull(raw) {
		return nil
	}
	return into(raw, key, dst)
}

// nullableDefault is `.nullable().default(null)`: absent and null both leave nil.
func nullableDefault[T any](f fields, key string, dst **T) error {
	raw, ok := f[key]
	if !ok || isNull(raw) {
		return nil
	}
	return into(raw, key, dst)
}

// optional keeps dst's default when absent; null is refused because the field is not nullable.
func optional[T any](f fields, key string, dst *T) error {
	raw, ok := f[key]
	if !ok {
		return nil
	}
	if isNull(raw) {
		return fmt.Errorf("%s: expected a value, received null", key)
	}
	return into(raw, key, dst)
}

func oneOf(key, value string, allowed []string) error {
	if slices.Contains(allowed, value) {
		return nil
	}
	return fmt.Errorf("%s: invalid enum value %q, expected %s", key, value, strings.Join(allowed, " | "))
}

func literalOne(f fields) error {
	var v float64
	if err := required(f, "v", &v); err != nil {
		return err
	}
	if v != 1 {
		return fmt.Errorf("v: invalid literal value, expected 1")
	}
	return nil
}

func parseCost(raw json.RawMessage, path string) (Cost, error) {
	var c Cost
	f, err := objectOf(raw, path)
	if err != nil {
		return c, err
	}
	return c, firstErr(
		prefixed(path, required(f, "fable", &c.Fable)),
		prefixed(path, required(f, "general", &c.General)),
		prefixed(path, required(f, "session", &c.Session)),
	)
}

func parseYield(raw json.RawMessage) (Yield, error) {
	var y Yield
	f, err := objectOf(raw, "yield")
	if err != nil {
		return y, err
	}
	return y, firstErr(
		prefixed("yield", required(f, "ticketsMoved", &y.TicketsMoved)),
		prefixed("yield", required(f, "prsOpened", &y.PrsOpened)),
		prefixed("yield", required(f, "commits", &y.Commits)),
	)
}

func prefixed(path string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s.%w", path, err)
}

func firstErr(errs ...error) error {
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// nested decodes a nullable sub-object through its own shape, leaving nil for null.
func nested[T any](f fields, key string, dst **T, parse func(json.RawMessage) (T, error)) error {
	var raw *json.RawMessage
	if err := nullableRequired(f, key, &raw); err != nil || raw == nil {
		return err
	}
	value, err := parse(*raw)
	*dst = &value
	return err
}

// ParseCycle mirrors cycleShape: known fields strictly, unknown keys stripped, defaults filled.
func ParseCycle(data []byte) (Cycle, error) {
	var c Cycle
	f, err := objectOf(data, "(root)")
	if err != nil {
		return Cycle{}, err
	}
	c.V = 1
	var poolBefore json.RawMessage
	err = firstErr(
		literalOne(f),
		required(f, "kind", &c.Kind),
		required(f, "program", &c.Program),
		required(f, "startedAt", &c.StartedAt),
		nullableRequired(f, "endedAt", &c.EndedAt),
		required(f, "exit", &c.Exit),
		required(f, "poolBefore", &poolBefore),
		nested(f, "poolAfter", &c.PoolAfter, func(raw json.RawMessage) (Cost, error) { return parseCost(raw, "poolAfter") }),
		nullableRequired(f, "startupTokens", &c.StartupTokens),
		nested(f, "yield", &c.Yield, parseYield),
		optional(f, "asksRaised", &c.AsksRaised),
		nullableDefault(f, "pauseUntil", &c.PauseUntil),
		nullableDefault(f, "sessionId", &c.SessionID),
		nullableDefault(f, "closing", &c.Closing),
	)
	if err != nil {
		return Cycle{}, err
	}
	if err := firstErr(oneOf("kind", c.Kind, kinds), oneOf("exit", c.Exit, Exits)); err != nil {
		return Cycle{}, err
	}
	c.PoolBefore, err = parseCost(poolBefore, "poolBefore")
	if err != nil {
		return Cycle{}, err
	}
	return c, nil
}

func parseDecision(data []byte) (Decision, error) {
	var d Decision
	f, err := objectOf(data, "(root)")
	if err != nil {
		return d, err
	}
	d.V = 1
	err = firstErr(
		literalOne(f),
		required(f, "at", &d.At),
		required(f, "program", &d.Program),
		required(f, "verdict", &d.Verdict),
		required(f, "reason", &d.Reason),
		nested(f, "pool", &d.Pool, func(raw json.RawMessage) (Cost, error) { return parseCost(raw, "pool") }),
		nullableRequired(f, "cyclesFundable", &d.CyclesFundable),
	)
	if err != nil {
		return d, err
	}
	return d, oneOf("verdict", d.Verdict, verdicts)
}

// nonBlankLines numbers lines among the non-blank ones, as readCycles' filter-then-map does.
func nonBlankLines(data []byte) []string {
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// ReadCycles surfaces malformed lines rather than skipping them — a silently truncated
// ledger skews every estimate.
func ReadCycles(path string) ([]Cycle, error) {
	data, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	lines := nonBlankLines(data)
	cycles := make([]Cycle, 0, len(lines))
	for index, line := range lines {
		c, err := ParseCycle([]byte(line))
		if err != nil {
			return nil, fmt.Errorf("%s:%d is not a valid cycle record: %v", path, index+1, err)
		}
		cycles = append(cycles, c)
	}
	return cycles, nil
}

func AppendRecord(path string, record any) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(record); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(buf.Bytes())
	closeErr := file.Close()
	return firstErr(writeErr, closeErr)
}

// LatestEnds is the last end record per cycle identity, in first-seen order. Reconciliation
// appends the truth rather than rewriting history, so an abandoned cycle that later reported
// has two end records; counting both would price it twice — and those are exactly the long
// expensive cycles the percentile is there to catch. Start records carry no outcome.
func LatestEnds(cycles []Cycle) []Cycle {
	byIdentity := map[string]Cycle{}
	var order []string
	for _, c := range cycles {
		if c.EndedAt == nil {
			continue
		}
		key := identity(c)
		if _, seen := byIdentity[key]; !seen {
			order = append(order, key)
		}
		byIdentity[key] = c
	}
	out := make([]Cycle, 0, len(order))
	for _, key := range order {
		out = append(out, byIdentity[key])
	}
	return out
}

// LastCycleReported: a report is the only evidence a runner declared itself done. An idle
// runner proves nothing — it idles while its background shells run.
func LastCycleReported(cycles []Cycle) bool {
	ends := LatestEnds(cycles)
	return len(ends) > 0 && slices.Contains(reported, ends[len(ends)-1].Exit)
}

// buckets orders a Cost so the per-bucket arithmetic is one loop rather than three copies.
func buckets(c Cost) [3]float64 { return [3]float64{c.Fable, c.General, c.Session} }

func costFrom(b [3]float64) Cost { return Cost{Fable: b[0], General: b[1], Session: b[2]} }

// costOf discards a bucket that grew over the cycle: the 5h window resets mid-cycle as a
// matter of course, and recording that as zero would drag the price toward nothing.
func costOf(c Cycle) ([3]*float64, bool) {
	var out [3]*float64
	if c.PoolAfter == nil {
		return out, false
	}
	before, after := buckets(c.PoolBefore), buckets(*c.PoolAfter)
	for i := range out {
		if after[i] <= before[i] {
			d := before[i] - after[i]
			out[i] = &d
		}
	}
	return out, true
}

// spendOf counts a reset-corrupted bucket as nothing rather than a zero sample.
func spendOf(c Cycle) [3]float64 {
	var out [3]float64
	cost, _ := costOf(c)
	for i, d := range cost {
		if d != nil {
			out[i] = *d
		}
	}
	return out
}

// Percentile is nearest-rank, so the answer is a cost a real cycle actually had rather than
// an interpolation between two of them.
func Percentile(values []float64, fraction float64) float64 {
	if len(values) == 0 {
		panic("ledger.Percentile: no values")
	}
	sorted := slices.Clone(values)
	slices.Sort(sorted)
	rank := int(math.Ceil(fraction * float64(len(sorted))))
	return sorted[min(len(sorted)-1, max(0, rank-1))]
}

// EstimateCycleCost prices a cycle at a high percentile, not the median: cost is badly
// right-skewed (2026-08-26, 33 samples: median 0.10 session, mean 0.16, max 0.58), so a median
// under-prices half of all cycles by construction, and the reserve is denominated in this.
// Onboarding is read-heavy and Fable-light, so only delivery cycles are samples. Each bucket
// keeps its own count: the 5h window resets mid-cycle far more often than the weekly ones.
func EstimateCycleCost(cycles []Cycle, seed Cost, minSamples int, fraction float64) Cost {
	var samples [3][]float64
	for _, c := range LatestEnds(cycles) {
		if c.Kind != "delivery" || slices.Contains(didNotDeliver, c.Exit) {
			continue
		}
		cost, ok := costOf(c)
		if !ok {
			continue
		}
		for i, d := range cost {
			if d != nil {
				samples[i] = append(samples[i], *d)
			}
		}
	}
	seeds := buckets(seed)
	var out [3]float64
	for i := range out {
		out[i] = seeds[i]
		if len(samples[i]) >= minSamples {
			out[i] = math.Max(Percentile(samples[i], fraction), seeds[i]/4)
		}
	}
	return costFrom(out)
}

// ChargeForRunning counts in-flight cycles in cycles, each at whichever is worse: the price,
// or what the pool has actually lost since it started. A flat estimate is how three cycles
// pinned three accounts on 2026-08-25. Floored at one: a cycle seconds old has drained
// nothing yet and is about to drain plenty.
func ChargeForRunning(running []Cycle, poolNow Cost, cost Cost) float64 {
	now, price := buckets(poolNow), buckets(cost)
	total := 0.0
	for _, c := range running {
		before := buckets(c.PoolBefore)
		charge := 1.0
		for i := range before {
			drained := before[i] - now[i]
			if drained > 0 && price[i] > 0 {
				charge = math.Max(charge, drained/price[i])
			}
		}
		total += charge
	}
	return total
}

// SpentSince is drovr's own spend in the window. `until` bounds it to cycles finished by a
// past instant, which a historical usage sample needs: a cycle still running then had not
// yet shown in the quota it recorded. math.MaxInt64 is unbounded.
func SpentSince(cycles []Cycle, windowStart float64, until epoch.Millis) Cost {
	var total [3]float64
	for _, c := range LatestEnds(cycles) {
		started, ok := epoch.Parse(c.StartedAt)
		if !ok || float64(started) < windowStart {
			continue
		}
		ended, ok := epoch.Parse(*c.EndedAt)
		if !ok || ended > until {
			continue
		}
		spend := spendOf(c)
		for i := range total {
			total[i] += spend[i]
		}
	}
	return costFrom(total)
}

// InFlight reads running work from the ledger rather than locks, so a decision in any
// process sees every program's. The maxHours cutoff is for a SIGKILLed worker that never
// wrote its end record, which would otherwise hold a slot until hand-edited away.
func InFlight(cycles []Cycle, now epoch.Millis, maxHours float64) []Cycle {
	ended := map[string]bool{}
	for _, c := range cycles {
		if c.EndedAt != nil {
			ended[identity(c)] = true
		}
	}
	cutoff := float64(now) - maxHours*3_600_000
	out := []Cycle{}
	for _, c := range cycles {
		started, ok := epoch.Parse(c.StartedAt)
		if c.Exit == "running" && !ended[identity(c)] && ok && float64(started) >= cutoff {
			out = append(out, c)
		}
	}
	return out
}

// CyclesStartedSince counts identities, not rows. A crash never ran, a deferral never
// started, a stall sat at its prompt, a blocked cycle only rediscovered an unanswered ask,
// and an abandoned one may or may not have delivered — none of them costs a program its day.
// Only the latest exit counts: an abandoned cycle later reconciled to a seam did deliver.
func CyclesStartedSince(cycles []Cycle, since epoch.Millis) int {
	unspent := map[string]bool{}
	for _, c := range LatestEnds(cycles) {
		if slices.Contains(didNotDeliver, c.Exit) || slices.Contains(deliveryUnknown, c.Exit) || c.Exit == "blocked" {
			unspent[identity(c)] = true
		}
	}
	counted := map[string]bool{}
	for _, c := range cycles {
		started, ok := epoch.Parse(c.StartedAt)
		if ok && started >= since && !unspent[identity(c)] {
			counted[identity(c)] = true
		}
	}
	return len(counted)
}

// ConsecutiveFailures counts only recent failures, so a cause fixed twenty minutes ago
// resumes on its own instead of latching until someone clears it. Stalls count with crashes:
// a program that stalls every time would otherwise pay full onboarding round after round.
func ConsecutiveFailures(cycles []Cycle, now epoch.Millis, windowMinutes float64) int {
	cutoff := float64(now) - windowMinutes*60_000
	streak := 0
	for i := len(cycles) - 1; i >= 0; i-- {
		c := cycles[i]
		if c.EndedAt == nil || c.Exit == "deferred" {
			continue
		}
		if !slices.Contains(failed, c.Exit) {
			break
		}
		// An unparseable time is NaN in the TS, and NaN < cutoff is false: the streak goes on.
		if ended, ok := epoch.Parse(*c.EndedAt); ok && float64(ended) < cutoff {
			break
		}
		streak++
	}
	return streak
}

// ConsecutiveZeroYield skips blocked cycles and declared rests: both said why they produced
// nothing, and counting them reports a malfunction where someone owes a reply or it waited well.
func ConsecutiveZeroYield(cycles []Cycle) int {
	streak := 0
	for i := len(cycles) - 1; i >= 0; i-- {
		c := cycles[i]
		if c.Kind != "delivery" || c.EndedAt == nil || c.Exit == "blocked" || c.PauseUntil != nil {
			continue
		}
		if c.Yield == nil || c.Yield.TicketsMoved+c.Yield.PrsOpened+c.Yield.Commits > 0 {
			break
		}
		streak++
	}
	return streak
}

// LastStartedAt includes a cycle in flight: it opens its cadence window too.
func LastStartedAt(cycles []Cycle) (epoch.Millis, bool) {
	var latest epoch.Millis
	found := false
	for _, c := range cycles {
		started, ok := epoch.Parse(c.StartedAt)
		if ok && (!found || started > latest) {
			latest, found = started, true
		}
	}
	return latest, found
}

func LastFinished(cycles []Cycle) (Cycle, bool) {
	for i := len(cycles) - 1; i >= 0; i-- {
		if cycles[i].EndedAt != nil {
			return cycles[i], true
		}
	}
	return Cycle{}, false
}

type Owed struct {
	Asks float64      `json:"asks"`
	At   epoch.Millis `json:"at"`
}

// UnansweredAsks: the last productive cycle raised asks and every cycle since came back
// blocked. The program is not stalled or broken — it is owed a reply.
func UnansweredAsks(cycles []Cycle) (Owed, bool) {
	var finished []Cycle
	for _, c := range cycles {
		if c.EndedAt != nil && c.Exit != "deferred" && c.Exit != "crash" {
			finished = append(finished, c)
		}
	}
	last := len(finished) - 1
	raiser := last
	for raiser >= 0 && finished[raiser].Exit == "blocked" {
		raiser--
	}
	if raiser < 0 || raiser == last || finished[raiser].AsksRaised == 0 {
		return Owed{}, false
	}
	// The TS would report NaN here; no time at all is the nearer truth than epoch zero.
	at, ok := epoch.Parse(*finished[raiser].EndedAt)
	if !ok {
		return Owed{}, false
	}
	return Owed{Asks: finished[raiser].AsksRaised, At: at}, true
}

// StampTick is liveness, kept apart from the decision log: lastDecisionAt only advances
// when an enabled program is evaluated, so disabling every program read as a stalled agent.
func StampTick(path string, now epoch.Millis) error {
	return os.WriteFile(path, []byte(`{"at":"`+epoch.ISO(now)+"\"}\n"), 0o644)
}

func ReadTickStamp(path string) (epoch.Millis, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	var stamp fields
	var raw string
	if json.Unmarshal(data, &stamp) != nil || required(stamp, "at", &raw) != nil {
		return 0, false
	}
	return epoch.Parse(raw)
}

// LastDecisionAt is when a tick last recorded a decision.
func LastDecisionAt(path string) (epoch.Millis, bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		return 0, false
	}
	lines := nonBlankLines(data)
	if len(lines) == 0 {
		return 0, false
	}
	d, err := parseDecision([]byte(lines[len(lines)-1]))
	if err != nil {
		return 0, false
	}
	return epoch.Parse(d.At)
}
