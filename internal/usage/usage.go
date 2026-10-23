// Package usage records one pool sample per tick. It records and reads; it feeds no gate,
// because an admission decision that moved with Craig's measured behaviour would be a
// feedback loop nobody asked for.
package usage

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/shape"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// MaxBytes bounds the log by size, not age: the tick schedule can change, so a line count
// would drift with it. 8 MB is roughly four months at ten-minute ticks and three accounts.
const MaxBytes int64 = 8 << 20

type AccountSample struct {
	Name    string  `json:"name"`
	Usable  bool    `json:"usable"`
	Fable   float64 `json:"fable"`
	General float64 `json:"general"`
	Session float64 `json:"session"`
	// Null when no window is open, i.e. nothing spent in that bucket yet.
	FableReset   *epoch.Millis `json:"fableReset"`
	GeneralReset *epoch.Millis `json:"generalReset"`
	SessionReset *epoch.Millis `json:"sessionReset"`
}

type Sample struct {
	V        int             `json:"v"`
	At       string          `json:"at"`
	Accounts []AccountSample `json:"accounts"`
}

func orZero(p *float64) float64 {
	if p == nil {
		return 0
	}
	return *p
}

// SampleOf is pure: what teamclaude was reporting at now. A disabled account is recorded,
// not dropped, and a null bucket reads as nothing spent.
func SampleOf(s teamclaude.Status, now epoch.Millis) Sample {
	out := Sample{V: 1, At: epoch.ISO(now), Accounts: make([]AccountSample, 0, len(s.Accounts))}
	for _, a := range s.Accounts {
		q := a.Quota
		out.Accounts = append(out.Accounts, AccountSample{
			Name: a.Name, Usable: capacity.IsUsable(a, now),
			Fable: orZero(q.Unified7dFable), General: orZero(q.Unified7d), Session: orZero(q.Unified5h),
			FableReset: q.Unified7dFableReset, GeneralReset: q.Unified7dReset, SessionReset: q.Unified5hReset,
		})
	}
	return out
}

// Append writes one line, then prunes. The prune error is returned: the caller (the tick)
// decides that a full disk costs the measurement and nothing more.
func Append(path string, s Sample, maxBytes int64) error {
	if err := ledger.AppendRecord(path, s); err != nil {
		return err
	}
	return prune(path, maxBytes)
}

// prune keeps the newest half, rewritten through a staging file and a rename so a reader
// never catches a half-pruned log.
func prune(path string, maxBytes int64) error {
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() <= maxBytes {
		return nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	lines := nonBlank(string(raw))
	keep := lines[len(lines)/2:]
	staging := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(staging, []byte(strings.Join(keep, "\n")+"\n"), 0o644); err != nil {
		os.Remove(staging)
		return err
	}
	if err := os.Rename(staging, path); err != nil {
		os.Remove(staging)
		return err
	}
	return nil
}

func nonBlank(text string) []string {
	var out []string
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) != "" {
			out = append(out, line)
		}
	}
	return out
}

// ReadSamples is strict: drovr writes this file itself, so an unrecognised line is a
// defect, not input. An absent log is empty.
func ReadSamples(path string) ([]Sample, error) {
	raw, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []Sample
	for i, line := range nonBlank(string(raw)) {
		s, err := parseSample([]byte(line))
		if err != nil {
			return nil, fmt.Errorf("%s:%d is not a valid usage sample: %v", path, i+1, err)
		}
		out = append(out, s)
	}
	return out, nil
}

func parseSample(data []byte) (Sample, error) {
	o, err := shape.Decode(data, "")
	if err != nil {
		return Sample{}, err
	}
	s := Sample{V: 1}
	var v float64
	var accounts json.RawMessage
	shape.Required(o, "v", &v)
	o.Check("v", o.Err != nil || v == 1, "invalid literal value, expected 1")
	shape.Required(o, "at", &s.At)
	shape.Required(o, "accounts", &accounts)
	s.Accounts = shape.Each(o, "accounts", accounts, parseAccount)
	return s, o.Err
}

func parseAccount(raw json.RawMessage, path string) (AccountSample, error) {
	o, err := shape.Decode(raw, path)
	if err != nil {
		return AccountSample{}, err
	}
	var a AccountSample
	shape.Required(o, "name", &a.Name)
	shape.Required(o, "usable", &a.Usable)
	shape.Required(o, "fable", &a.Fable)
	shape.Required(o, "general", &a.General)
	shape.Required(o, "session", &a.Session)
	shape.RequiredNullable(o, "fableReset", &a.FableReset)
	shape.RequiredNullable(o, "generalReset", &a.GeneralReset)
	shape.RequiredNullable(o, "sessionReset", &a.SessionReset)
	return a, o.Err
}
