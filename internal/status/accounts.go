// Package status is the one shape `drovr status --json` prints and the tick publishes, and
// the per-account lines every status writer shares with the phone's accounts grid.
package status

import (
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/teamclaude"
)

type Bucket struct {
	UsedFraction *float64 `json:"usedFraction"`
	ResetsAt     *string  `json:"resetsAt"`
}

type Buckets struct {
	Session Bucket `json:"session"`
	General Bucket `json:"general"`
	Fable   Bucket `json:"fable"`
}

// Account is one teamclaude account as every status writer puts it on the wire. It has no
// headroom: only drovr has a pool, so only the payload adds one (AccountWithHeadroom).
type Account struct {
	Name       string  `json:"name"`
	Org        *string `json:"org"`
	Status     *string `json:"status"`
	Sessions   float64 `json:"sessions"`
	Disabled   bool    `json:"disabled"`
	Current    bool    `json:"current"`
	LastUsedAt *string `json:"lastUsedAt"`
	// FableEligible is nil when teamclaude declares no fable route: no restriction known,
	// not none eligible.
	FableEligible    *bool                  `json:"fableEligible"`
	FableTarget      bool                   `json:"fableTarget"`
	Buckets          Buckets                `json:"buckets"`
	SwitchThresholds *teamclaude.Thresholds `json:"switchThresholds"`
}

func iso(at *epoch.Millis) *string {
	if at == nil {
		return nil
	}
	s := epoch.ISO(*at)
	return &s
}

func fableTarget(s teamclaude.Status) *string {
	for _, r := range s.Routes {
		if r.Name == "fable" {
			return r.Target
		}
	}
	return nil
}

// AccountsFrom is the ACCOUNTS block of `drovr watch`, per account. Pure.
func AccountsFrom(s teamclaude.Status) []Account {
	eligible, routed := teamclaude.FableEligible(s)
	target := fableTarget(s)
	out := make([]Account, 0, len(s.Accounts))
	for _, a := range s.Accounts {
		entry := Account{
			Name: a.Name, Org: a.OrgName, Status: a.Status, Sessions: a.Sessions, Disabled: a.Disabled,
			Current:     s.CurrentAccount != nil && *s.CurrentAccount == a.Name,
			LastUsedAt:  a.Usage.LastUsed,
			FableTarget: target != nil && *target == a.Name,
			Buckets: Buckets{
				Session: Bucket{a.Quota.Unified5h, iso(a.Quota.Unified5hReset)},
				General: Bucket{a.Quota.Unified7d, iso(a.Quota.Unified7dReset)},
				Fable:   Bucket{a.Quota.Unified7dFable, iso(a.Quota.Unified7dFableReset)},
			},
		}
		if routed {
			e := eligible[a.Name]
			entry.FableEligible = &e
		}
		t := teamclaude.SwitchThresholds(s, a)
		entry.SwitchThresholds = &t
		out = append(out, entry)
	}
	return out
}
