// Package teamclaude reads `teamclaude status --json`. Read-only: drovr never mutates
// teamclaude state, which is global and shared with Craig's own foreground sessions.
package teamclaude

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
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

type Thresholds struct{ Session, General, Fable *float64 }

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

// decoder keeps the first refusal so each shape reads as one straight list of fields in
// zod's order; unknown keys are stripped, as zod's .object() does.
type decoder struct {
	fields map[string]json.RawMessage
	path   string
	err    error
}

func newDecoder(raw json.RawMessage, path string) (*decoder, error) {
	var fields map[string]json.RawMessage
	if isNull(raw) {
		return nil, fmt.Errorf("%s: expected object, received null", orRoot(path))
	}
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, fmt.Errorf("%s: expected object: %v", orRoot(path), err)
	}
	return &decoder{fields: fields, path: path}, nil
}

func orRoot(path string) string {
	if path == "" {
		return "(root)"
	}
	return path
}

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

func (d *decoder) at(key string) string {
	if d.path == "" {
		return key
	}
	return d.path + "." + key
}

func (d *decoder) fail(err error) {
	if d.err == nil {
		d.err = err
	}
}

func into[T any](d *decoder, key string, raw json.RawMessage, dst *T) {
	if err := json.Unmarshal(raw, dst); err != nil {
		d.fail(fmt.Errorf("%s: %v", d.at(key), err))
	}
}

// required refuses absent and null alike: a zod field with no default and no .nullable().
func required[T any](d *decoder, key string, dst *T) {
	raw, ok := d.fields[key]
	if d.err != nil {
		return
	}
	if !ok || isNull(raw) {
		d.fail(fmt.Errorf("%s: required", d.at(key)))
		return
	}
	into(d, key, raw, dst)
}

// present refuses absence only; null decodes to the zero value (nil for pointers, and for
// epochMs its own null).
func present[T any](d *decoder, key string, dst *T) {
	raw, ok := d.fields[key]
	if d.err != nil {
		return
	}
	if !ok {
		d.fail(fmt.Errorf("%s: required", d.at(key)))
		return
	}
	into(d, key, raw, dst)
}

// optional keeps dst's default when absent; null is refused, the field not being nullable.
func optional[T any](d *decoder, key string, dst *T) {
	raw, ok := d.fields[key]
	if !ok || d.err != nil {
		return
	}
	if isNull(raw) {
		d.fail(fmt.Errorf("%s: expected a value, received null", d.at(key)))
		return
	}
	into(d, key, raw, dst)
}

// nullable: absent and null both leave dst at its nil default.
func nullable[T any](d *decoder, key string, dst *T) {
	if raw, ok := d.fields[key]; ok && d.err == nil {
		into(d, key, raw, dst)
	}
}

func presentEpoch(d *decoder, key string) *epoch.Millis {
	var e epochMs
	present(d, key, &e)
	return e.v
}

// each decodes a required array element by element, naming the failing index.
func each[T any](d *decoder, key string, raw json.RawMessage, parse func(json.RawMessage, string) (T, error)) []T {
	var items []json.RawMessage
	into(d, key, raw, &items)
	out := make([]T, 0, len(items))
	for i, item := range items {
		if d.err != nil {
			return nil
		}
		v, err := parse(item, fmt.Sprintf("%s[%d]", d.at(key), i))
		d.fail(err)
		out = append(out, v)
	}
	return out
}

func parseStatus(raw json.RawMessage) (Status, error) {
	d, err := newDecoder(raw, "")
	if err != nil {
		return Status{}, err
	}
	var s Status
	present(d, "currentAccount", &s.CurrentAccount)
	var accounts json.RawMessage
	required(d, "accounts", &accounts)
	if d.err == nil {
		s.Accounts = each(d, "accounts", accounts, parseAccount)
	}
	var routes json.RawMessage
	optional(d, "routes", &routes)
	s.Routes = []Route{}
	if routes != nil && d.err == nil {
		s.Routes = each(d, "routes", routes, parseRoute)
	}
	nullable(d, "switchThreshold", &s.SwitchThreshold)
	nullable(d, "switchThresholds", &s.SwitchThresholds)
	return s, d.err
}

func parseAccount(raw json.RawMessage, path string) (Account, error) {
	d, err := newDecoder(raw, path)
	if err != nil {
		return Account{}, err
	}
	a := Account{Type: "oauth"}
	required(d, "name", &a.Name)
	optional(d, "type", &a.Type)
	nullable(d, "orgName", &a.OrgName)
	nullable(d, "status", &a.Status)
	optional(d, "sessions", &a.Sessions)
	required(d, "disabled", &a.Disabled)
	var quota json.RawMessage
	required(d, "quota", &quota)
	if d.err == nil {
		q, err := parseQuota(quota, d.at("quota"))
		d.fail(err)
		a.Quota = q
	}
	parseUsage(d, &a)
	a.RateLimitedUntil = presentEpoch(d, "rateLimitedUntil")
	a.PausedUntil = presentEpoch(d, "pausedUntil")
	nullable(d, "switchThreshold", &a.SwitchThreshold)
	return a, d.err
}

func parseUsage(d *decoder, a *Account) {
	var usage json.RawMessage
	optional(d, "usage", &usage)
	if usage == nil || d.err != nil {
		return
	}
	u, err := newDecoder(usage, d.at("usage"))
	if err != nil {
		d.fail(err)
		return
	}
	nullable(u, "lastUsed", &a.Usage.LastUsed)
	d.fail(u.err)
}

func parseQuota(raw json.RawMessage, path string) (Quota, error) {
	d, err := newDecoder(raw, path)
	if err != nil {
		return Quota{}, err
	}
	var q Quota
	present(d, "unified5h", &q.Unified5h)
	q.Unified5hReset = presentEpoch(d, "unified5hReset")
	present(d, "unified7d", &q.Unified7d)
	q.Unified7dReset = presentEpoch(d, "unified7dReset")
	present(d, "unified7dFable", &q.Unified7dFable)
	q.Unified7dFableReset = presentEpoch(d, "unified7dFableReset")
	nullable(d, "unifiedStatus", &q.UnifiedStatus)
	return q, d.err
}

func parseRoute(raw json.RawMessage, path string) (Route, error) {
	d, err := newDecoder(raw, path)
	if err != nil {
		return Route{}, err
	}
	r := Route{Accounts: []RouteAccount{}}
	required(d, "name", &r.Name)
	var accounts json.RawMessage
	optional(d, "accounts", &accounts)
	if accounts != nil && d.err == nil {
		r.Accounts = each(d, "accounts", accounts, parseRouteAccount)
	}
	nullable(d, "target", &r.Target)
	return r, d.err
}

func parseRouteAccount(raw json.RawMessage, path string) (RouteAccount, error) {
	d, err := newDecoder(raw, path)
	if err != nil {
		return RouteAccount{}, err
	}
	var a RouteAccount
	required(d, "name", &a.Name)
	required(d, "eligible", &a.Eligible)
	return a, d.err
}
