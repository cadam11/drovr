// Package capacity turns a teamclaude status into headroom, in quota-fractions: teamclaude
// never exposes an absolute quota size, so a cycle's cost is only knowable as a pool delta.
package capacity

import (
	"math"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/teamclaude"
)

type Bucket = control.Bucket

var Buckets = control.Buckets

type Ceilings = control.Ceiling

// AccountHeadroom is one account's room. Routable is false when teamclaude's fable route will
// not serve it: headroom is still reported honestly (the bars show pool-wide spend) but
// decide must not fund a cycle from it.
type AccountHeadroom struct {
	Name     string  `json:"name"`
	Fable    float64 `json:"fable"`
	General  float64 `json:"general"`
	Session  float64 `json:"session"`
	Routable bool    `json:"routable"`
}

func (a AccountHeadroom) Of(b Bucket) float64 {
	switch b {
	case "fable":
		return a.Fable
	case "general":
		return a.General
	}
	return a.Session
}

// Resets holds the soonest future reset per bucket; nil when none is in the future.
type Resets struct {
	Fable   *epoch.Millis `json:"fable"`
	General *epoch.Millis `json:"general"`
	Session *epoch.Millis `json:"session"`
}

func (r Resets) Of(b Bucket) *epoch.Millis {
	switch b {
	case "fable":
		return r.Fable
	case "general":
		return r.General
	}
	return r.Session
}

// Pool's per-bucket sums are a display figure. PerAccount stays unsummed because
// min-of-sums is not sum-of-mins: fundability can only be computed per account.
type Pool struct {
	Fable              float64           `json:"fable"`
	General            float64           `json:"general"`
	Session            float64           `json:"session"`
	UsableAccounts     int               `json:"usableAccounts"`
	PerAccount         []AccountHeadroom `json:"perAccount"`
	ResetAt            Resets            `json:"resetAt"`
	EarliestRecoveryAt *epoch.Millis     `json:"earliestRecoveryAt"`
}

func (p Pool) Of(b Bucket) float64 {
	switch b {
	case "fable":
		return p.Fable
	case "general":
		return p.General
	}
	return p.Session
}

// Snapshot is ledger.ts's snapshot(pool); it lives here because ledger cannot import capacity
// without a cycle.
func (p Pool) Snapshot() control.Cost {
	return control.Cost{Fable: p.Fable, General: p.General, Session: p.Session}
}

func headroom(used *float64, ceiling float64) float64 {
	u := 0.0
	if used != nil {
		u = *used
	}
	return math.Max(0, ceiling-u)
}

func IsUsable(a teamclaude.Account, now epoch.Millis) bool {
	if a.Disabled {
		return false
	}
	if a.RateLimitedUntil != nil && *a.RateLimitedUntil > now {
		return false
	}
	if a.PausedUntil != nil && *a.PausedUntil > now {
		return false
	}
	return true
}

func soonest(times []*epoch.Millis, now epoch.Millis) *epoch.Millis {
	var best *epoch.Millis
	for _, at := range times {
		if at == nil || *at <= now || (best != nil && *at >= *best) {
			continue
		}
		v := *at
		best = &v
	}
	return best
}

func usableAccounts(s teamclaude.Status, now epoch.Millis) []teamclaude.Account {
	var out []teamclaude.Account
	for _, a := range s.Accounts {
		if IsUsable(a, now) {
			out = append(out, a)
		}
	}
	return out
}

func PoolFrom(s teamclaude.Status, c Ceilings, now epoch.Millis) Pool {
	usable := usableAccounts(s, now)
	var fableAt, generalAt, sessionAt []*epoch.Millis
	for _, a := range usable {
		fableAt = append(fableAt, a.Quota.Unified7dFableReset)
		generalAt = append(generalAt, a.Quota.Unified7dReset)
		sessionAt = append(sessionAt, a.Quota.Unified5hReset)
	}
	resets := Resets{soonest(fableAt, now), soonest(generalAt, now), soonest(sessionAt, now)}

	// Ineligible accounts stay in PerAccount: they still own the resets that say when the
	// pool recovers, and dropping them would hide why their headroom is ignored.
	eligible, declared := teamclaude.FableEligible(s)
	p := Pool{
		UsableAccounts:     len(usable),
		PerAccount:         make([]AccountHeadroom, 0, len(usable)),
		ResetAt:            resets,
		EarliestRecoveryAt: soonest([]*epoch.Millis{resets.Fable, resets.General, resets.Session}, now),
	}
	for _, a := range usable {
		h := AccountHeadroom{
			Name:     a.Name,
			Fable:    headroom(a.Quota.Unified7dFable, c.Weekly),
			General:  headroom(a.Quota.Unified7d, c.Weekly),
			Session:  headroom(a.Quota.Unified5h, c.Session),
			Routable: !declared || eligible[a.Name],
		}
		p.PerAccount = append(p.PerAccount, h)
		p.Fable += h.Fable
		p.General += h.General
		p.Session += h.Session
	}
	return p
}

// HoursToWeeklyReset is for pace-keeping; false when no usable account has a future reset.
func HoursToWeeklyReset(s teamclaude.Status, now epoch.Millis) (float64, bool) {
	var resets []*epoch.Millis
	for _, a := range usableAccounts(s, now) {
		resets = append(resets, a.Quota.Unified7dReset)
	}
	at := soonest(resets, now)
	if at == nil {
		return 0, false
	}
	return float64(*at-now) / 3_600_000, true
}
