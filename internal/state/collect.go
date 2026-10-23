package state

import (
	"context"
	"fmt"
	"io"
	"net/url"
	"path/filepath"
	"slices"
	"sync"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/lock"
	"github.com/cadam11/drovr/internal/nudge"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/preview"
	"github.com/cadam11/drovr/internal/service"
	"github.com/cadam11/drovr/internal/teamclaude"
)

// probes is the subprocess half of a frame: 0.03ms to render against 2366ms to probe, measured
// 2026-09-17. It is held only as long as the caller's window allows.
type probes struct {
	at       epoch.Millis
	status   teamclaude.Status
	previews map[string]preview.Preview
	runners  map[string]bool
	// warnings are kept as well as reported, so a reused probe replays them rather than
	// letting a live warning blink out of the frame between probes.
	warnings []string
	phone    nudge.PhonePrefs
}

// Collector holds the last probe set between calls; it is meant for one caller at a time.
type Collector struct {
	Paths         paths.Paths
	Orca          *orca.Client
	Caller        nudge.CallerFunc // nil is nudge.DefaultCaller
	Host          string
	TeamclaudeBin string
	Now           func() epoch.Millis // nil is epoch.Now

	last *probes
}

// slot is one program's probe results, written only by that program's goroutine.
type slot struct {
	asksURL  *string
	runner   *bool
	preview  *preview.Preview
	warnings []string
}

// Collect reads the world and builds the state. onWarning is required: fold it into a frame,
// print it, or pass func(string){} to drop it on purpose — never by omission. probeMaxAge 0
// probes fresh; only watch passes more, since quota seconds old is admission deciding against
// room already gone. control.json, cycles, locks and the service are re-read every call
// whatever the window, so a keystroke that wrote control.json shows in the next frame.
func (c *Collector) Collect(ctx context.Context, onWarning func(string), probeMaxAge time.Duration) (DrovrState, error) {
	if onWarning == nil {
		panic("state: Collect needs an onWarning sink; pass func(string){} to drop warnings on purpose")
	}
	now := c.now()
	ctl, err := control.Read(c.Paths.Control)
	if err != nil {
		return DrovrState{}, err
	}
	cycles, err := ledger.ReadCycles(c.Paths.Cycles)
	if err != nil {
		return DrovrState{}, err
	}
	locks, err := c.locks(ctl)
	if err != nil {
		return DrovrState{}, err
	}
	var reused *probes
	if c.last != nil && time.Duration(now-c.last.at)*time.Millisecond < probeMaxAge {
		reused = c.last
	}
	pr, asksURLs, err := c.probe(ctx, ctl, cycles, now, reused)
	if err != nil {
		return DrovrState{}, err
	}
	for _, w := range pr.warnings {
		onWarning(w)
	}
	if reused == nil {
		c.last = &pr
	}
	return Build(Input{
		Status: pr.status, Control: ctl, Cycles: cycles, Now: now, Service: c.service(),
		Previews: pr.previews, Runners: pr.runners, AwayFromPhone: pr.phone.Away,
		Locks: locks, AsksURLs: asksURLs,
	})
}

func (c *Collector) now() epoch.Millis {
	if c.Now == nil {
		return epoch.Now()
	}
	return c.Now()
}

// locks propagates an unreadable lock: one that cannot be read is never free.
func (c *Collector) locks(ctl control.Control) (map[string]int, error) {
	out := map[string]int{}
	for _, p := range ctl.Programs {
		pid, held, err := lock.Holder(c.Paths.ProgramLock(p.Name))
		if err != nil {
			return nil, err
		}
		if held {
			out[p.Name] = pid
		}
	}
	return out, nil
}

// service reads liveness as "a tick completed", falling back to the decision log for an
// install that predates the heartbeat.
func (c *Collector) service() ServiceInput {
	s := service.Current()
	in := ServiceInput{Loaded: s.Loaded, IntervalSeconds: s.IntervalSeconds}
	if at, ok := ledger.ReadTickStamp(c.Paths.LastTick); ok {
		in.LastTickAt = &at
	} else if at, ok := ledger.LastDecisionAt(c.Paths.Decisions); ok {
		in.LastTickAt = &at
	}
	return in
}

// probe reuses the whole probe set inside the window; asks links are rebuilt every call because
// AiceBaseURL keeps its own cache and a program added mid-session must still get one.
func (c *Collector) probe(ctx context.Context, ctl control.Control, cycles []ledger.Cycle, now epoch.Millis, reused *probes) (probes, map[string]string, error) {
	pr := probes{at: now, previews: map[string]preview.Preview{}, runners: map[string]bool{}}
	if reused != nil {
		pr = *reused
		pr.warnings = slices.Clone(reused.warnings)
	} else {
		status, err := teamclaude.Read(ctx, c.TeamclaudeBin)
		if err != nil {
			return probes{}, nil, err
		}
		pr.status = status
		// Cached with the quota probe: a bounded hey call per frame would be the whole cost of it.
		pr.phone = c.channel(ctl).PhonePrefs(ctx)
	}
	running := ledger.InFlight(cycles, now, ctl.MaxCycleHours)
	asksURLs := map[string]string{}
	for i, s := range c.fanOut(ctx, ctl.Programs, running, reused == nil) {
		name := ctl.Programs[i].Name
		if s.asksURL != nil {
			asksURLs[name] = *s.asksURL
		}
		if s.runner != nil {
			pr.runners[name] = *s.runner
		}
		if s.preview != nil {
			pr.previews[name] = *s.preview
		}
		pr.warnings = append(pr.warnings, s.warnings...)
	}
	if reused == nil && pr.phone.Warning != nil {
		pr.warnings = append(pr.warnings, *pr.phone.Warning)
	}
	return pr, asksURLs, nil
}

func (c *Collector) channel(ctl control.Control) nudge.Channel {
	caller := c.Caller
	if caller == nil {
		caller = nudge.DefaultCaller
	}
	// PhonePrefs returns its warning rather than logging it, so nothing reaches Log.
	return nudge.Channel{NotifyTo: ctl.NotifyTo, Caller: caller, Host: c.Host, Log: io.Discard}
}

// fanOut is the TS Promise.all: one goroutine per program, each writing only its own slot.
func (c *Collector) fanOut(ctx context.Context, programs []control.Program, running []ledger.Cycle, fresh bool) []slot {
	slots := make([]slot, len(programs))
	var wg sync.WaitGroup
	for i, p := range programs {
		wg.Go(func() { slots[i] = c.probeProgram(ctx, p, running, fresh) })
	}
	wg.Wait()
	return slots
}

func (c *Collector) probeProgram(ctx context.Context, p control.Program, running []ledger.Cycle, fresh bool) slot {
	var s slot
	u, err := c.asksURL(ctx, p)
	if err != nil {
		s.warnings = append(s.warnings, fmt.Sprintf("could not link %s's asks: %s", p.Name, err))
	}
	s.asksURL = u
	if !fresh {
		return s
	}
	if p.Runner == "orca" {
		// Left unset on an error, not false: "no agent" and "no answer" are different facts
		// and only the first may refuse a cycle.
		present, err := c.Orca.RunnerIsPresent(ctx, p.Name)
		if err != nil {
			s.warnings = append(s.warnings, fmt.Sprintf("could not read %s's runner state: %s", p.Name, err))
		} else {
			s.runner = &present
		}
	}
	if liveCycle(running, p.Name) == nil {
		return s
	}
	pv, warning := c.Orca.ReadPreview(ctx, p.Name)
	s.preview = pv
	if warning != nil {
		s.warnings = append(s.warnings, *warning)
	}
	return s
}

// asksURL: an aice page with no resolvable base gets no link rather than falling back to a file.
func (c *Collector) asksURL(ctx context.Context, p control.Program) (*string, error) {
	if p.Aice != nil && p.Aice.AsksPage != nil {
		base := c.Orca.AiceBaseURL(ctx, p)
		if base == nil {
			return nil, nil
		}
		u := *base + "/" + *p.Aice.AsksPage
		return &u, nil
	}
	if p.AsksFile == nil || p.Host != nil {
		return nil, nil
	}
	f := *p.AsksFile
	if !filepath.IsAbs(f) {
		f = filepath.Join(p.Cwd, f)
	}
	abs, err := filepath.Abs(f)
	if err != nil {
		return nil, err
	}
	u := (&url.URL{Scheme: "file", Path: abs}).String()
	return &u, nil
}
