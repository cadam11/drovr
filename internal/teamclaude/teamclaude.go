// Package teamclaude reads `teamclaude status --json`. Read-only: drovr never mutates
// teamclaude state, which is global and shared with Craig's own foreground sessions.
package teamclaude

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/shape"
)

// statusTimeout: Read runs first in both tick and collectState, so an unbounded one was the
// most reachable way to wedge the supervisor. 20s is generous for a sub-second local read and
// leaves room for teamclaude to probe an account before answering.
const statusTimeout = 20 * time.Second

const maxStatusBytes = 8 << 20

// Quota is each bucket's used-fraction (0..1) and epoch-ms reset. A nil bucket means no
// window is open, i.e. nothing used yet.
type Quota struct {
	Unified5h           *float64
	Unified5hReset      *epoch.Millis
	Unified7d           *float64
	Unified7dReset      *epoch.Millis
	Unified7dFable      *float64
	Unified7dFableReset *epoch.Millis
	UnifiedStatus       *string
}

type Account struct {
	Name     string
	Type     string
	OrgName  *string
	Status   *string
	Sessions float64
	Disabled bool
	Quota    Quota
	Usage    struct{ LastUsed *string }
	// RateLimitedUntil and PausedUntil stay nil until an account is actually throttled.
	RateLimitedUntil, PausedUntil *epoch.Millis
	// SwitchThreshold is this account's own (teamclaude #409); nil means the fleet's applies.
	SwitchThreshold *float64
}

type RouteAccount struct {
	Name     string
	Eligible bool
}

// Route keeps only eligibility and target: the match globs and colours are teamclaude's
// business, not drovr's.
type Route struct {
	Name     string
	Accounts []RouteAccount
	// Target is the account the route will serve next, teamclaude's own ► mark.
	Target *string
}

type Status struct {
	CurrentAccount   *string
	Accounts         []Account
	Routes           []Route
	SwitchThreshold  *float64
	SwitchThresholds map[string]float64
}

type Thresholds struct {
	Session *float64 `json:"session"`
	General *float64 `json:"general"`
	Fable   *float64 `json:"fable"`
}

// SwitchThresholds resolves as teamclaude's own thresholdFor does: the account's own, else
// the fleet's per-bucket table, else the fleet number. Nil when teamclaude reports none.
func SwitchThresholds(s Status, a Account) Thresholds {
	resolve := func(key string) *float64 {
		if a.SwitchThreshold != nil {
			return a.SwitchThreshold
		}
		if v, ok := s.SwitchThresholds[key]; ok {
			return &v
		}
		return s.SwitchThreshold
	}
	return Thresholds{Session: resolve("unified5h"), General: resolve("unified7d"), Fable: resolve("unified7dFable")}
}

// FableEligible: the runner is always Fable, so an account the fable route refuses will never
// serve it however healthy its buckets look. false when no fable route names any account —
// "no restriction known", very different from "nothing is eligible".
func FableEligible(s Status) (map[string]bool, bool) {
	for _, r := range s.Routes {
		if r.Name != "fable" {
			continue
		}
		if len(r.Accounts) == 0 {
			return nil, false
		}
		eligible := map[string]bool{}
		for _, a := range r.Accounts {
			if a.Eligible {
				eligible[a.Name] = true
			}
		}
		return eligible, true
	}
	return nil, false
}

func Parse(data []byte) (Status, error) {
	s, err := parseStatus(data)
	if err != nil {
		return Status{}, fmt.Errorf("teamclaude status did not match expected shape: %w", err)
	}
	return s, nil
}

func Read(ctx context.Context, bin string) (Status, error) {
	if bin == "" {
		bin = "teamclaude"
	}
	r, err := exec.RunBounded(ctx, bin, []string{"status", "--json"}, exec.Bounds{Timeout: statusTimeout})
	if err != nil {
		return Status{}, err
	}
	if len(r.Stdout) > maxStatusBytes {
		return Status{}, errors.New("teamclaude status printed more than 8 MiB")
	}
	return Parse([]byte(r.Stdout))
}

var digits = regexp.MustCompile(`^\d+$`)

// epochMs coerces rather than widens. On 2026-09-14 five consecutive ticks died refusing a
// string at accounts[2].pausedUntil; and a string left as a string compares false against
// now in capacity, marking a throttled account usable — the direction that reads as free
// capacity. An unparseable value reads as nil, already this field's "no limit known".
type epochMs struct{ v *epoch.Millis }

func (e *epochMs) UnmarshalJSON(b []byte) error {
	var value any
	if err := json.Unmarshal(b, &value); err != nil {
		return err
	}
	switch x := value.(type) {
	case nil:
		return nil
	case float64:
		if !math.IsInf(x, 0) && !math.IsNaN(x) {
			v := epoch.Millis(x)
			e.v = &v
		}
		return nil
	case string:
		e.v = parseEpochText(strings.TrimSpace(x))
		return nil
	}
	return fmt.Errorf("expected number or string")
}

// Both forms are plausible out of a JSON round-trip; a date parser rejects a bare epoch, so
// digits are tried first.
func parseEpochText(text string) *epoch.Millis {
	if digits.MatchString(text) {
		n, err := strconv.ParseInt(text, 10, 64)
		if err != nil {
			return nil
		}
		return &n
	}
	if ms, ok := epoch.Parse(text); ok {
		return &ms
	}
	return nil
}

func requiredNullableEpoch(d *shape.Object, key string) *epoch.Millis {
	var e epochMs
	shape.RequiredNullable(d, key, &e)
	return e.v
}

func parseStatus(raw json.RawMessage) (Status, error) {
	d, err := shape.Decode(raw, "")
	if err != nil {
		return Status{}, err
	}
	var s Status
	shape.RequiredNullable(d, "currentAccount", &s.CurrentAccount)
	var accounts json.RawMessage
	shape.Required(d, "accounts", &accounts)
	if d.Err == nil {
		s.Accounts = shape.Each(d, "accounts", accounts, parseAccount)
	}
	var routes json.RawMessage
	shape.Optional(d, "routes", &routes)
	s.Routes = []Route{}
	if routes != nil && d.Err == nil {
		s.Routes = shape.Each(d, "routes", routes, parseRoute)
	}
	shape.NullableDefault(d, "switchThreshold", &s.SwitchThreshold)
	s.SwitchThresholds = parseThresholdTable(d)
	return s, d.Err
}

// parseThresholdTable decodes through pointers because a JSON null inside a
// map[string]float64 silently becomes 0, where zod's record of numbers refuses it.
func parseThresholdTable(d *shape.Object) map[string]float64 {
	var raw map[string]*float64
	shape.NullableDefault(d, "switchThresholds", &raw)
	if raw == nil || d.Err != nil {
		return nil
	}
	out := make(map[string]float64, len(raw))
	for _, key := range slices.Sorted(maps.Keys(raw)) {
		if raw[key] == nil {
			d.Fail(fmt.Errorf("%s.%s: expected number", d.At("switchThresholds"), key))
			return nil
		}
		out[key] = *raw[key]
	}
	return out
}

func parseAccount(raw json.RawMessage, path string) (Account, error) {
	d, err := shape.Decode(raw, path)
	if err != nil {
		return Account{}, err
	}
	a := Account{Type: "oauth"}
	shape.Required(d, "name", &a.Name)
	shape.Optional(d, "type", &a.Type)
	shape.NullableDefault(d, "orgName", &a.OrgName)
	shape.NullableDefault(d, "status", &a.Status)
	shape.Optional(d, "sessions", &a.Sessions)
	shape.Required(d, "disabled", &a.Disabled)
	var quota json.RawMessage
	shape.Required(d, "quota", &quota)
	if d.Err == nil {
		q, err := parseQuota(quota, d.At("quota"))
		d.Fail(err)
		a.Quota = q
	}
	parseUsage(d, &a)
	a.RateLimitedUntil = requiredNullableEpoch(d, "rateLimitedUntil")
	a.PausedUntil = requiredNullableEpoch(d, "pausedUntil")
	shape.NullableDefault(d, "switchThreshold", &a.SwitchThreshold)
	return a, d.Err
}

func parseUsage(d *shape.Object, a *Account) {
	var usage json.RawMessage
	shape.Optional(d, "usage", &usage)
	if usage == nil || d.Err != nil {
		return
	}
	u, err := shape.Decode(usage, d.At("usage"))
	if err != nil {
		d.Fail(err)
		return
	}
	shape.NullableDefault(u, "lastUsed", &a.Usage.LastUsed)
	d.Fail(u.Err)
}

func parseQuota(raw json.RawMessage, path string) (Quota, error) {
	d, err := shape.Decode(raw, path)
	if err != nil {
		return Quota{}, err
	}
	var q Quota
	shape.RequiredNullable(d, "unified5h", &q.Unified5h)
	q.Unified5hReset = requiredNullableEpoch(d, "unified5hReset")
	shape.RequiredNullable(d, "unified7d", &q.Unified7d)
	q.Unified7dReset = requiredNullableEpoch(d, "unified7dReset")
	shape.RequiredNullable(d, "unified7dFable", &q.Unified7dFable)
	q.Unified7dFableReset = requiredNullableEpoch(d, "unified7dFableReset")
	shape.NullableDefault(d, "unifiedStatus", &q.UnifiedStatus)
	return q, d.Err
}

func parseRoute(raw json.RawMessage, path string) (Route, error) {
	d, err := shape.Decode(raw, path)
	if err != nil {
		return Route{}, err
	}
	r := Route{Accounts: []RouteAccount{}}
	shape.Required(d, "name", &r.Name)
	var accounts json.RawMessage
	shape.Optional(d, "accounts", &accounts)
	if accounts != nil && d.Err == nil {
		r.Accounts = shape.Each(d, "accounts", accounts, parseRouteAccount)
	}
	shape.NullableDefault(d, "target", &r.Target)
	return r, d.Err
}

func parseRouteAccount(raw json.RawMessage, path string) (RouteAccount, error) {
	d, err := shape.Decode(raw, path)
	if err != nil {
		return RouteAccount{}, err
	}
	var a RouteAccount
	shape.Required(d, "name", &a.Name)
	shape.Required(d, "eligible", &a.Eligible)
	return a, d.Err
}
