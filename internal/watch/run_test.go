package watch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/state"
)

const (
	enter   = "\x1b[?1049h\x1b[?25l\x1b[?1000h\x1b[?1006h"
	restore = "\x1b[?1000l\x1b[?1006l\x1b[?25h\x1b[?1049l"
	threeUp = `{"notifyTo":null,"programs":[` +
		`{"name":"drovr","cwd":"/tmp/d","runner":"orca"},` +
		`{"name":"joinery","cwd":"/tmp/j","runner":"orca"},` +
		`{"name":"sunnyt","cwd":"/tmp/s","runner":"orca"}]}`
)

// recorded is a 100x40 frame's state with three programs and their asks links.
func recorded(t *testing.T) state.DrovrState {
	t.Helper()
	for _, c := range fixtures.Load(t, "watch.frameWithHits") {
		var in frameInput
		decodeInput(t, c.Name, c.Input, &in)
		if in.Columns == 100 && in.rows() == 40 && !in.View.Help && len(in.State.Programs) == 3 {
			return in.State
		}
	}
	t.Fatal("no recorded 100x40 frame with three programs")
	return state.DrovrState{}
}

type screen struct {
	mu sync.Mutex
	b  strings.Builder
}

func (s *screen) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}

func (s *screen) String() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.String()
}

type fakeTerm struct {
	mu         sync.Mutex
	cols, rows int
	raws       int
	restores   int
}

func (f *fakeTerm) Size() (int, int, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cols, f.rows, nil
}

func (f *fakeTerm) IsTerminal() bool { return true }

func (f *fakeTerm) MakeRaw() (func() error, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.raws++
	return func() error {
		f.mu.Lock()
		defer f.mu.Unlock()
		f.restores++
		return nil
	}, nil
}

func (f *fakeTerm) resize(cols, rows int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cols, f.rows = cols, rows
}

func (f *fakeTerm) counts() (int, int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.raws, f.restores
}

type fakeCollect struct {
	mu   sync.Mutex
	st   state.DrovrState
	ages []time.Duration
	fail map[int]error
	gate map[int]chan struct{}
	boom map[int]bool // the n-th call panics, as a bug in the probe would
	warn string
}

// Collect holds the n-th call on gate[n] when one is set, as a slow probe would.
func (c *fakeCollect) Collect(ctx context.Context, onWarning func(string), age time.Duration) (state.DrovrState, error) {
	c.mu.Lock()
	n := len(c.ages)
	c.ages = append(c.ages, age)
	warn, fail, st, gate, boom := c.warn, c.fail[n], c.st, c.gate[n], c.boom[n]
	c.mu.Unlock()
	if boom {
		panic(fmt.Sprintf("probe %d blew up", n))
	}
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return state.DrovrState{}, ctx.Err()
		}
	}
	if warn != "" {
		onWarning(warn)
	}
	if fail != nil {
		return state.DrovrState{}, fail
	}
	return st, nil
}

func (c *fakeCollect) seen() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Duration(nil), c.ages...)
}

type opened struct {
	bin  string
	args []string
	b    exec.Bounds
}

type harness struct {
	t       *testing.T
	in      *io.PipeWriter
	out     *screen
	term    *fakeTerm
	collect *fakeCollect
	sigs    chan os.Signal
	ticks   chan time.Time
	opens   chan opened
	hold    chan error // when set, the fake `open` waits for its outcome here
	done    chan error
}

func start(t *testing.T, interval int, control string) *harness {
	t.Helper()
	h, deps := rig(t, interval, control)
	return h.run(deps, interval)
}

// rig builds the harness without running it, for a test that changes a fake first.
func rig(t *testing.T, interval int, control string) (*harness, Deps) {
	t.Helper()
	home := t.TempDir()
	t.Setenv("DROVR_HOME", home)
	p := paths.New()
	if err := os.WriteFile(p.Control, []byte(control), 0o644); err != nil {
		t.Fatal(err)
	}
	pr, pw := io.Pipe()
	h := &harness{
		t: t, in: pw, out: &screen{}, term: &fakeTerm{cols: 100, rows: 40},
		collect: &fakeCollect{st: recorded(t), fail: map[int]error{}, gate: map[int]chan struct{}{}},
		sigs:    make(chan os.Signal, 1), ticks: make(chan time.Time), opens: make(chan opened, 1), done: make(chan error, 1),
	}
	t.Cleanup(func() { pw.Close() })
	deps := Deps{
		In: pr, Out: h.out, Term: h.term, Collect: h.collect.Collect, Orca: orca.NewClient(p, io.Discard),
		Paths: p, Self: "/nonexistent/drovr", Now: func() epoch.Millis { return 1_790_000_000_000 },
		Signals: h.sigs, Loc: time.UTC,
		Tick: func(d time.Duration) (<-chan time.Time, func()) {
			if want := time.Duration(max(2, interval)) * time.Second; d != want {
				t.Errorf("ticker at %v, want %v", d, want)
			}
			return h.ticks, func() {}
		},
		Launch: func(string) error { return errors.New("no launch in this test") },
		Detach: func(string, []string, string, string, []string) (int, error) {
			return 0, errors.New("no detach in this test")
		},
		Run: func(_ context.Context, bin string, args []string, b exec.Bounds) (exec.Result, error) {
			h.opens <- opened{bin, args, b}
			if h.hold == nil {
				return exec.Result{}, nil
			}
			return exec.Result{}, <-h.hold
		},
	}
	return h, deps
}

func (h *harness) run(deps Deps, interval int) *harness {
	go func() { h.done <- Run(context.Background(), deps, interval) }()
	return h
}

func (h *harness) key(k string) {
	h.t.Helper()
	if _, err := io.WriteString(h.in, k); err != nil {
		h.t.Fatal(err)
	}
}

func (h *harness) frames() []string {
	parts := strings.Split(h.out.String(), "\x1b[H")
	return parts[1:]
}

func (h *harness) waitFrames(n int) {
	h.t.Helper()
	for range 400 {
		if len(h.frames()) >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("%d frames painted, want %d", len(h.frames()), n)
}

func (h *harness) wait() error {
	h.t.Helper()
	select {
	case err := <-h.done:
		return err
	case <-time.After(2 * time.Second):
		h.t.Fatal("Run did not return")
		return nil
	}
}

func painted(st state.DrovrState, v View, cols, rows int) string {
	text, _ := FrameWithHits(st, v, cols, rows, time.UTC)
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] += "\x1b[K"
	}
	return "\x1b[H" + strings.Join(lines, "\r\n") + "\x1b[0J"
}

func TestPaintBytes(t *testing.T) {
	h := start(t, 15, threeUp)
	h.waitFrames(1)
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	want := enter + painted(h.collect.st, View{}, 100, 40) + restore
	if got := h.out.String(); got != want {
		t.Errorf("bytes:\n got  %q\n want %q", got, want)
	}
}

func TestRunRestoresOnEveryExit(t *testing.T) {
	exits := map[string]func(h *harness){
		"quit":    func(h *harness) { h.key("q") },
		"ctrl-c":  func(h *harness) { h.key("\x03") },
		"SIGINT":  func(h *harness) { h.sigs <- syscall.SIGINT },
		"SIGTERM": func(h *harness) { h.sigs <- syscall.SIGTERM },
		"SIGHUP":  func(h *harness) { h.sigs <- syscall.SIGHUP },
	}
	for name, exit := range exits {
		t.Run(name, func(t *testing.T) {
			h := start(t, 15, threeUp)
			h.waitFrames(1)
			exit(h)
			if err := h.wait(); err != nil {
				t.Fatal(err)
			}
			checkRestored(t, h)
		})
	}
	t.Run("fatal first draw", func(t *testing.T) {
		h, deps := rig(t, 15, threeUp)
		h.collect.fail[0] = errors.New("teamclaude is not on PATH")
		h.run(deps, 15)
		if err := h.wait(); err == nil || err.Error() != "teamclaude is not on PATH" {
			t.Fatalf("err %v", err)
		}
		if got := h.out.String(); got != enter+restore {
			t.Errorf("bytes %q", got)
		}
		checkRestored(t, h)
	})
}

func checkRestored(t *testing.T, h *harness) {
	t.Helper()
	out := h.out.String()
	if !strings.HasPrefix(out, enter) || strings.Count(out, enter) != 1 || !strings.HasSuffix(out, restore) || strings.Count(out, restore) != 1 {
		t.Errorf("enter/restore bytes wrong: %q", out)
	}
	if raws, restores := h.term.counts(); raws != 1 || restores != 1 {
		t.Errorf("raw mode entered %d, restored %d times", raws, restores)
	}
}

func TestDrawFailedKeepsTheLastFrame(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	h.collect.fail[1] = errors.New("Command failed: teamclaude status --json\nProxy at localhost:3456 did not answer status within 5000ms.")
	h.run(deps, 15)
	h.waitFrames(1)
	h.ticks <- time.Now()
	h.waitFrames(2)
	want := View{Message: "could not refresh: Proxy at localhost:3456 did not answer status within 5000ms."}
	if got := h.frames()[1]; "\x1b[H"+got != painted(h.collect.st, want, 100, 40) {
		t.Errorf("second frame is not the last state with the message:\n%q", got)
	}
	h.ticks <- time.Now() // the next draw recovers
	h.waitFrames(3)
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}

func TestOnlyRAndLProbeFresh(t *testing.T) {
	h := start(t, 1, threeUp)
	h.waitFrames(1)
	h.ticks <- time.Now()
	h.waitFrames(2)
	h.key("r")
	h.waitFrames(3)
	h.key("l")
	h.waitFrames(4)
	h.key("?")
	h.waitFrames(5)
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	window := 2 * time.Second
	want := []time.Duration{window, window, 0, 0, window}
	if got := h.collect.seen(); !equalAges(got, want) {
		t.Errorf("probe windows %v, want %v", got, want)
	}
	if !strings.Contains(h.frames()[3], "released drovr's runner — the next tick can start a cycle") {
		t.Errorf("l did not report the release: %q", h.frames()[3])
	}
}

func equalAges(a, b []time.Duration) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func TestClickUsesTheFrameOnScreen(t *testing.T) {
	h := start(t, 15, threeUp)
	h.waitFrames(1)
	_, hits := FrameWithHits(h.collect.st, View{}, 100, 40, time.UTC)
	row := -1
	for i, hit := range hits {
		if hit != nil && hit.Program != nil && *hit.Program == 2 {
			row = i
		}
	}
	_, after := FrameWithHits(h.collect.st, View{}, 30, 10, time.UTC)
	if row < 0 || (row < len(after) && after[row] != nil && after[row].Program != nil && *after[row].Program == 2) {
		t.Fatalf("row %d does not tell the two layouts apart", row)
	}
	h.term.resize(30, 10) // no SIGWINCH: the frame on screen is still the 100x40 one
	h.key("\x1b[<0;5;" + strconv.Itoa(row+1) + "M\x1b[<0;5;" + strconv.Itoa(row+1) + "m")
	h.waitFrames(2)
	if got := "\x1b[H" + h.frames()[1]; got != painted(h.collect.st, View{Selected: 2}, 30, 10) {
		t.Errorf("click did not select program 2:\n%q", got)
	}
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}

func TestAsksClickOpensTheUrl(t *testing.T) {
	h := start(t, 15, threeUp)
	h.waitFrames(1)
	_, hits := FrameWithHits(h.collect.st, View{}, 100, 40, time.UTC)
	row := -1
	for i, hit := range hits {
		if hit != nil && hit.Asks != nil && *hit.Asks == 1 {
			row = i
		}
	}
	if row < 0 {
		t.Fatal("no asks link for program 1")
	}
	h.key("\x1b[<0;9;" + strconv.Itoa(row+1) + "M")
	got := <-h.opens
	url := *h.collect.st.Programs[1].AsksURL
	if got.bin != "open" || len(got.args) != 1 || got.args[0] != url || got.b.Timeout != openTimeout {
		t.Errorf("ran %+v", got)
	}
	h.waitFrames(2)
	if !strings.Contains(h.frames()[1], "opened "+url) {
		t.Errorf("no opened message: %q", h.frames()[1])
	}
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}

func TestWarningsLandOnThePreviewLine(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	h.collect.warn = "could not read sunnyt's runner state: orca timed out"
	h.run(deps, 15)
	h.waitFrames(1)
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	warning := h.collect.warn
	if got := "\x1b[H" + h.frames()[0]; !strings.HasPrefix(got, painted(h.collect.st, View{PreviewWarning: &warning}, 100, 40)) {
		t.Errorf("warning not on the preview line:\n%q", got)
	}
}

func TestTickerIsNotUnrefd(t *testing.T) {
	h := start(t, 15, threeUp)
	h.waitFrames(1)
	h.ticks <- time.Now()
	h.waitFrames(2)
	select {
	case err := <-h.done:
		t.Fatalf("Run returned before quit: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}

func TestSetterFailureIsFatal(t *testing.T) {
	h := start(t, 15, threeUp)
	h.waitFrames(1)
	dir := filepath.Dir(paths.New().Control)
	if err := os.Chmod(dir, 0o500); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := os.Chmod(dir, 0o700); err != nil {
			t.Error(err)
		}
	})
	h.key("m")
	if err := h.wait(); err == nil {
		t.Fatal("a setter that cannot write must end the session")
	}
	checkRestored(t, h)
}

// A slow orca: the shim records its call and then sleeps far past the test's budget, so Run
// can only return in time if the interrupt is not on its goroutine.
func TestQuitIsNotBlockedByASlowIntent(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	bin := t.TempDir()
	calls := filepath.Join(bin, "calls.log")
	shim := "#!/bin/sh\necho \"$*\" >> " + calls + "\nexec sleep 30\n"
	if err := os.WriteFile(filepath.Join(bin, "orca"), []byte(shim), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	if err := os.MkdirAll(deps.Paths.ProgramState("drovr"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := orca.RememberTerminal(deps.Paths, "drovr", orca.Remembered{Handle: "term_1", TabID: "tab-1", WorktreeID: "wt-1"}); err != nil {
		t.Fatal(err)
	}
	h.run(deps, 15)
	h.waitFrames(1)
	h.key("x")
	h.waitFrames(2)
	h.key("y")
	for range 400 {
		if _, err := os.Stat(calls); err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := os.Stat(calls); err != nil {
		t.Fatal("the interrupt never reached orca")
	}
	began := time.Now()
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took > time.Second {
		t.Errorf("q waited %v behind the interrupt", took)
	}
	checkRestored(t, h)
}

func TestSlowIntentMessageLandsAfterCompletion(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	h.hold = make(chan error)
	h.run(deps, 15)
	h.waitFrames(1)
	h.key("o")
	first := <-h.opens
	h.key("j") // keys stay live while open runs
	h.waitFrames(2)
	if want := "\x1b[H" + h.frames()[1]; want != painted(h.collect.st, View{Selected: 1}, 100, 40) {
		t.Errorf("j did not draw while open was running:\n%q", want)
	}
	h.hold <- nil
	h.waitFrames(3)
	if !strings.Contains(h.frames()[2], "opened "+first.args[0]) {
		t.Errorf("the message did not land: %q", h.frames()[2])
	}

	h.key("o") // a failed open says so and the session carries on
	second := <-h.opens
	h.hold <- errors.New("Command failed: open " + second.args[0] + "\nerror -10814")
	// The failure does not redraw, as the TS's could-not messages do not, so ticks show it; the
	// outcome and a tick can arrive in either order, so tick until it lands.
	want := "could not open " + second.args[0] + ": error -10814"
	for n := 4; n < 50 && !strings.Contains(h.frames()[len(h.frames())-1], want); n++ {
		h.ticks <- time.Now()
		h.waitFrames(n)
	}
	if last := h.frames()[len(h.frames())-1]; !strings.Contains(last, want) {
		t.Errorf("no failure message %q in %q", want, last)
	}
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}

func (h *harness) waitCalls(n int) {
	h.t.Helper()
	for range 400 {
		if len(h.collect.seen()) >= n {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	h.t.Fatalf("%d probes, want %d", len(h.collect.seen()), n)
}

func TestQuitIsNotBlockedByAProbe(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	h.collect.gate[1] = make(chan struct{}) // never opened: a probe that hangs
	h.run(deps, 15)
	h.waitFrames(1)
	h.ticks <- time.Now()
	h.waitCalls(2)
	began := time.Now()
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	if took := time.Since(began); took > time.Second {
		t.Errorf("q waited %v behind the probe", took)
	}
	if len(h.frames()) != 1 {
		t.Errorf("painted %d frames, want only the first", len(h.frames()))
	}
	checkRestored(t, h)
}

// Pipe writes are synchronous with the reader, and the reader takes its next chunk only once
// the loop has the last one — so each key() returning proves the key before it was handled.
func TestDrawsCoalesce(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	gate := make(chan struct{})
	h.collect.gate[1] = gate
	h.run(deps, 15)
	h.waitFrames(1)
	h.ticks <- time.Now() // probe 1 starts and hangs
	h.waitCalls(2)
	h.ticks <- time.Now() // three requests while it is in flight: non-fresh, fresh, non-fresh
	h.key("r")
	h.key("k")
	h.key("z") // draws nothing; proves k was handled
	close(gate)
	h.waitFrames(3)
	h.key("z")
	h.key("z")
	want := []time.Duration{15 * time.Second, 15 * time.Second, 0}
	if got := h.collect.seen(); !equalAges(got, want) {
		t.Errorf("probes %v, want %v: one more, and fresh", got, want)
	}
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}

// keybarQ finds where q is drawn on the keybar of the frame on screen.
func keybarQ(t *testing.T, hits []*LineHit) (row, column int) {
	t.Helper()
	for i, hit := range hits {
		if hit == nil || hit.Keybar == nil {
			continue
		}
		for c := range 100 {
			if key, ok := KeybarKeyAt(100, false, *hit.Keybar, c); ok && key == "q" {
				return i, c
			}
		}
	}
	t.Fatal("no q on the keybar")
	return 0, 0
}

func TestAClickReadsNothingBeforeDeciding(t *testing.T) {
	h := start(t, 15, "{not json")
	h.waitFrames(1)
	_, hits := FrameWithHits(h.collect.st, View{}, 100, 40, time.UTC)
	row := -1
	for i, hit := range hits {
		if hit != nil && hit.Program != nil && *hit.Program == 2 {
			row = i
		}
	}
	h.key("\x1b[<0;5;" + strconv.Itoa(row+1) + "M")
	h.waitFrames(2)
	if got := "\x1b[H" + h.frames()[1]; got != painted(h.collect.st, View{Selected: 2}, 100, 40) {
		t.Errorf("a row click did not select with control.json unreadable:\n%q", got)
	}
	qRow, qColumn := keybarQ(t, hits)
	h.key("\x1b[<0;" + strconv.Itoa(qColumn+1) + ";" + strconv.Itoa(qRow+1) + "M")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
	checkRestored(t, h)
}

// tickUntil ticks until the last frame shows want: a could-not message does not redraw, so
// ticks show it, and the outcome and a tick can arrive in either order.
func (h *harness) tickUntil(want string) {
	h.t.Helper()
	for n := len(h.frames()) + 1; n < 50 && !strings.Contains(h.frames()[len(h.frames())-1], want); n++ {
		select {
		case h.ticks <- time.Now():
		case err := <-h.done:
			h.t.Fatalf("Run returned before %q landed: %v", want, err)
		}
		h.waitFrames(n)
	}
	if last := h.frames()[len(h.frames())-1]; !strings.Contains(last, want) {
		h.t.Errorf("no message %q in %q", want, last)
	}
}

// The harness's Detach and Launch both fail, as a detached spawn of a missing binary would.
func TestTickAndStartFailuresLandOnTheMessageLine(t *testing.T) {
	h := start(t, 15, threeUp)
	h.waitFrames(1)
	h.key("t")
	h.tickUntil("could not launch tick: no detach in this test")
	name := h.collect.st.Programs[0].Name
	n := len(h.frames())
	h.key("s")
	h.waitFrames(n + 1)
	h.key("y")
	h.tickUntil("could not start " + name + ": no launch in this test")
	select {
	case err := <-h.done:
		t.Fatalf("Run returned before quit: %v", err)
	default:
	}
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}

// A panic off Run's goroutine would skip its deferred restore, so it comes back as an error.
func TestAProbePanicRestoresAndEndsTheSession(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	h.collect.boom = map[int]bool{1: true}
	h.run(deps, 15)
	h.waitFrames(1)
	h.ticks <- time.Now()
	if err := h.wait(); err == nil || !strings.Contains(err.Error(), "panic: probe 1 blew up") {
		t.Fatalf("err %v", err)
	}
	checkRestored(t, h)
}

func TestAnIntentPanicRestoresAndEndsTheSession(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	deps.Detach = func(string, []string, string, string, []string) (int, error) { panic("detach blew up") }
	h.run(deps, 15)
	h.waitFrames(1)
	h.key("t")
	if err := h.wait(); err == nil || !strings.Contains(err.Error(), "panic: detach blew up") {
		t.Fatalf("err %v", err)
	}
	checkRestored(t, h)
}

// A probe is a subprocess and never sits in the key path: while one is in flight a key paints
// the frame already on screen with the new view, and the probe's state lands when it lands.
func TestAKeyPaintsWithoutWaitingForTheProbe(t *testing.T) {
	h, deps := rig(t, 15, threeUp)
	gate := make(chan struct{})
	h.collect.gate[1] = gate
	h.run(deps, 15)
	h.waitFrames(1)
	h.ticks <- time.Now() // probe 1 starts and hangs
	h.waitCalls(2)
	h.key("j")
	h.waitFrames(2) // painted while the probe is still held
	want := painted(h.collect.st, View{Selected: 1}, 100, 40)[len("\x1b[H"):]
	if got := h.frames()[1]; got != want {
		t.Errorf("frame after j while probing:\n got  %q\n want %q", got, want)
	}
	close(gate)
	h.key("q")
	if err := h.wait(); err != nil {
		t.Fatal(err)
	}
}
