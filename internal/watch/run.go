package watch

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
	"syscall"
	"time"

	"golang.org/x/term"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/state"
)

const (
	// ?1000 reports clicks and wheel, ?1006 makes the reports SGR; a terminal supporting
	// neither never sends one. The alternate screen keeps frames out of the shell's scrollback.
	enterBytes = Esc + "?1049h" + Esc + "?25l" + Esc + "?1000h" + Esc + "?1006h"
	// Mouse reporting off first — a shell fed SGR reports pastes them as text. The alternate
	// screen goes last, so the shell's own scrollback comes back intact.
	restoreBytes = Esc + "?1000l" + Esc + "?1006l" + Esc + "?25h" + Esc + "?1049l"
)

// errLeave is the operator's own exit: q, Ctrl-C or a signal. Run reports it as nil.
var errLeave = errors.New("leave")

// Terminal is the part of the TTY the loop needs, so a test can stand in for it.
type Terminal interface {
	Size() (cols, rows int, err error)
	MakeRaw() (restore func() error, err error)
	IsTerminal() bool
}

type tty struct{ in, out int }

func NewTerminal(in, out *os.File) Terminal { return tty{int(in.Fd()), int(out.Fd())} }

func (t tty) Size() (int, int, error) { return term.GetSize(t.out) }
func (t tty) IsTerminal() bool        { return term.IsTerminal(t.in) }

func (t tty) MakeRaw() (func() error, error) {
	old, err := term.MakeRaw(t.in)
	if err != nil {
		return nil, err
	}
	return func() error { return term.Restore(t.in, old) }, nil
}

// Ticker is the real clock behind Deps.Tick.
func Ticker(d time.Duration) (<-chan time.Time, func()) {
	t := time.NewTicker(d)
	return t.C, t.Stop
}

// Deps is everything Run touches outside its own memory. Collect is state.Collector.Collect;
// Launch, Detach and Run are the three ways a key reaches a process, injected so a test sees
// the call without spawning one.
type Deps struct {
	In      io.Reader
	Out     io.Writer
	Term    Terminal
	Collect func(ctx context.Context, onWarning func(string), probeMaxAge time.Duration) (state.DrovrState, error)
	Orca    *orca.Client
	Paths   paths.Paths
	Self    string
	Now     func() epoch.Millis
	Signals <-chan os.Signal
	Loc     *time.Location
	Tick    func(time.Duration) (<-chan time.Time, func())
	Launch  func(program string) error
	Detach  func(bin string, args []string, logPath, cwd string, env []string) (int, error)
	Run     func(ctx context.Context, bin string, args []string, b exec.Bounds) (exec.Result, error)
}

// watcher is owned by Run's goroutine alone: draws happen inline, one after another, so two
// can never paint over each other and a stale one never lands after a fresher one.
type watcher struct {
	deps     Deps
	interval time.Duration
	view     View
	last     *state.DrovrState
	// What the mouse is over: the hits of the frame on screen and the width it was laid out
	// at — a click resolves against what was drawn, never a layout recomputed after a resize.
	hits   []*LineHit
	width  int
	narrow bool
	// results carries slow intents' outcomes back; they run detached so keys stay live.
	results chan landed
	// probes carries a draw's state back from its Collect goroutine, so a probe of seconds
	// never stands between the operator and q. One draw is in flight at a time — the
	// Collector serves one caller — and requests made meanwhile fold into one pending draw.
	probes       chan probed
	drawing      bool
	pending      bool
	pendingFresh bool
}

// probed is one Collect's result: the warning is carried back rather than written into the
// view from the probe's goroutine.
type probed struct {
	st      state.DrovrState
	warning *string
	err     error
}

type input struct {
	chunk string
	err   error
}

// Run draws until the operator leaves, restoring the terminal on every exit path — a panic
// included, since the restore is deferred. Only the first draw failing is fatal to a frame;
// a setter that cannot write control.json ends the session, as the TS's die did.
func Run(ctx context.Context, deps Deps, intervalSeconds int) (err error) {
	w := &watcher{deps: deps, interval: time.Duration(max(2, intervalSeconds)) * time.Second, width: 100, results: make(chan landed), probes: make(chan probed)}
	if _, err := io.WriteString(deps.Out, enterBytes); err != nil {
		return err
	}
	rawOff := func() error { return nil }
	tty := deps.Term.IsTerminal()
	if tty {
		off, rawErr := deps.Term.MakeRaw()
		if rawErr != nil {
			_, writeErr := io.WriteString(deps.Out, restoreBytes)
			return errors.Join(rawErr, writeErr)
		}
		rawOff = off
	}
	defer func() {
		_, writeErr := io.WriteString(deps.Out, restoreBytes)
		if errors.Is(err, errLeave) {
			err = nil
		}
		err = errors.Join(err, rawOff(), writeErr)
	}()
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()
	var chunks chan input
	if tty {
		chunks = make(chan input)
		go readChunks(ctx, deps.In, chunks)
	}
	w.draw(ctx, false)
	return w.loop(ctx, chunks)
}

// loop never returns on its own: the ticker is what keeps a watch alive between keys, so
// only a leave, a fatal error or the context ends it.
func (w *watcher) loop(ctx context.Context, chunks chan input) error {
	ticks, stop := w.deps.Tick(w.interval)
	defer stop()
	for {
		var err error
		select {
		case <-ctx.Done():
			return ctx.Err()
		case sig := <-w.deps.Signals:
			err = w.signal(ctx, sig)
		case <-ticks:
			w.draw(ctx, false)
		case p := <-w.probes:
			err = w.landedProbe(ctx, p)
		case in := <-chunks:
			err = w.input(ctx, in)
		case r := <-w.results:
			err = w.apply(ctx, r.out, r.err)
		}
		if err != nil {
			return err
		}
	}
}

// readChunks ends on EOF, a read error, or Run returning. A Read blocked on a terminal cannot
// be cancelled, so after Run returns this ends at its next Read and never blocks on a send.
// It never closes out: stdin ending leaves the ticker drawing, as the TS's interval did.
func readChunks(ctx context.Context, in io.Reader, out chan<- input) {
	buf := make([]byte, 4096)
	for ctx.Err() == nil {
		n, err := in.Read(buf)
		next := input{chunk: string(buf[:n])}
		if err != nil && !errors.Is(err, io.EOF) {
			next = input{err: err}
		}
		if (n > 0 || next.err != nil) && !send(ctx, out, next) {
			return
		}
		if err != nil {
			return
		}
	}
}

func send(ctx context.Context, out chan<- input, in input) bool {
	select {
	case out <- in:
		return true
	case <-ctx.Done():
		return false
	}
}

// signal: SIGWINCH redraws at the new size; INT, TERM and HUP leave with the terminal
// restored (R2 — the TS left raw mode and the alternate screen behind on TERM and HUP).
func (w *watcher) signal(ctx context.Context, sig os.Signal) error {
	if sig == syscall.SIGWINCH {
		w.draw(ctx, false)
		return nil
	}
	return errLeave
}

// draw asks for a frame. With none in flight it starts one; otherwise the request waits as
// the one pending draw, which is fresh if any request folded into it was. The TS chained
// every request instead; folding them draws the same final state with fewer probes.
func (w *watcher) draw(ctx context.Context, fresh bool) {
	if w.drawing {
		w.pending, w.pendingFresh = true, w.pendingFresh || fresh
		return
	}
	w.drawing = true
	go w.probe(ctx, fresh)
}

// probe runs Collect off the loop. It probes no more often than one interval, so a keystroke
// redraw costs no subprocess while the ticker's own draw always falls outside the window.
// Leaving cancels ctx, which abandons the probe and drops a state that lands after.
func (w *watcher) probe(ctx context.Context, fresh bool) {
	window := w.interval
	if fresh {
		window = 0
	}
	var warning *string
	st, err := w.deps.Collect(ctx, func(text string) { warning = &text }, window)
	select {
	case w.probes <- probed{st, warning, err}:
	case <-ctx.Done():
	}
}

// landedProbe paints what a probe brought back, then starts the pending draw if one folded
// up meanwhile. The warning replaces the last one, so a since-fixed preview stops complaining.
func (w *watcher) landedProbe(ctx context.Context, p probed) error {
	w.drawing = false
	w.view.PreviewWarning = p.warning
	err := p.err
	if err == nil {
		err = w.paint(p.st)
	}
	if err != nil {
		if err := w.drawFailed(err); err != nil {
			return err
		}
	}
	if w.pending {
		w.pending = false
		fresh := w.pendingFresh
		w.pendingFresh = false
		w.draw(ctx, fresh)
	}
	return nil
}

// drawFailed keeps the last good frame and says why on the message line: teamclaude and orca
// both fail transiently, and a supervisor must not lose its display over someone else's
// hiccup. Before the first frame there is nothing to keep, so that one is fatal.
func (w *watcher) drawFailed(err error) error {
	if w.last == nil {
		return err
	}
	w.view.Message = "could not refresh: " + ChildReason(err.Error())
	return w.paint(*w.last)
}

// paint homes the cursor and clears each line as it is written: a full clear flickers, and
// a trailing newline on a full frame scrolls the top away one row per redraw.
func (w *watcher) paint(st state.DrovrState) error {
	cols, rows, err := w.deps.Term.Size()
	if err != nil {
		cols, rows = 100, 40 // not a terminal: the TS's `?? 100` and `?? 40`
	}
	text, hits, err := render(st, w.view, cols, max(6, rows), w.deps.Loc)
	if err != nil {
		return err
	}
	w.last, w.hits = &st, hits
	w.width = max(24, min(cols, 120))
	w.narrow = w.width < 72
	lines := strings.Split(text, "\n")
	for i := range lines {
		lines[i] += Esc + "K"
	}
	_, err = io.WriteString(w.deps.Out, Esc+"H"+strings.Join(lines, "\r\n")+Esc+"0J")
	return err
}

// render turns a panic in the pure half (WrapText and repeat refuse an impossible width)
// into an error for drawFailed, where the TS's throw landed in the same catch.
func render(st state.DrovrState, v View, cols, rows int, loc *time.Location) (text string, hits []*LineHit, err error) {
	defer func() {
		if r := recover(); r != nil {
			err = fmt.Errorf("%v", r)
		}
	}()
	text, hits = FrameWithHits(st, v, cols, rows, loc)
	return text, hits, nil
}

// input handles a chunk's mouse reports, then whatever text remains as one key: a wheel
// flick arrives as many reports in one chunk, and rarely shares it with a keystroke.
func (w *watcher) input(ctx context.Context, in input) error {
	if in.err != nil {
		return in.err
	}
	presses, rest := ParseChunk(in.chunk)
	for _, ev := range presses {
		if err := w.click(ctx, ev); err != nil {
			return err
		}
	}
	if rest == "" {
		return nil
	}
	return w.key(ctx, rest)
}

func (w *watcher) key(ctx context.Context, key string) error {
	if key == CtrlC || key == "q" {
		return errLeave // before control.json is read, so a broken file cannot trap the operator
	}
	ctl, programs, err := w.programs()
	if err != nil {
		w.view.Message = err.Error()
		w.draw(ctx, false)
		return nil
	}
	intent, view := DecideKey(key, w.view, programs, w.last)
	w.view = view
	return w.act(ctx, intent, ctl, programs)
}

// click reads nothing before deciding, as the TS's onMouse did: a row or the wheel selects
// from the frame alone, so a broken control.json cannot take the mouse away. A keybar key and
// an asks link were the TS's two hops into onKey, so they take the typed-key path here —
// q leaves before anything is read.
func (w *watcher) click(ctx context.Context, ev MouseEvent) error {
	if key, asks, ok := w.forwarded(ev); ok {
		if asks >= 0 {
			w.view.Selected = asks
		}
		return w.key(ctx, key)
	}
	intent, view := DecideClick(ev, w.hits, w.width, w.narrow, w.view, nil, w.last)
	w.view = view
	return w.act(ctx, intent, control.Control{}, nil)
}

// forwarded is the key a left press stands for on the frame on screen: a keybar label, or
// 'o' for an asks link (asks is then the program it selects first) unless a confirmation is
// armed, where the link only cancels. Everything else DecideClick settles without programs.
func (w *watcher) forwarded(ev MouseEvent) (key string, asks int, ok bool) {
	if !ev.Press || ev.Button&(64|3) != 0 || ev.Y < 1 || ev.Y > len(w.hits) || w.hits[ev.Y-1] == nil {
		return "", -1, false
	}
	hit := w.hits[ev.Y-1]
	if hit.Keybar != nil {
		key, ok = KeybarKeyAt(w.width, w.narrow, *hit.Keybar, ev.X-1)
		return key, -1, ok
	}
	if hit.Asks != nil && !w.view.ConfirmStop && !w.view.ConfirmStart {
		return "o", *hit.Asks, true
	}
	return "", -1, false
}

// programs is re-read on every key: view.Selected indexes this list, and the frame's own
// list was ordered the same way when its state was built.
func (w *watcher) programs() (control.Control, []control.Program, error) {
	ctl, err := control.Read(w.deps.Paths.Control)
	if err != nil {
		return ctl, nil, err
	}
	programs, err := control.ByPriority(ctl.Programs, w.deps.Now(), ctl.DeadlineHorizonDays)
	return ctl, programs, err
}

// act runs what the intent needs; where that is I/O, its outcome replaces the message
// DecideKey left alone, exactly as the TS set view.message from the awaited action.
func (w *watcher) act(ctx context.Context, in Intent, ctl control.Control, programs []control.Program) error {
	if in.Kind == IntentQuit {
		return errLeave
	}
	if isSlow(in.Kind) {
		go w.background(ctx, in, programs, w.results)
		return nil
	}
	out, ran, err := w.execute(in, ctl)
	if !ran || err != nil {
		return w.apply(ctx, outcome{message: w.view.Message, redraw: in.Redraw, fresh: in.Fresh}, err)
	}
	return w.apply(ctx, out, nil)
}

// apply is the TS's `.then`: the message lands whatever the redraw, and an error is die.
func (w *watcher) apply(ctx context.Context, out outcome, err error) error {
	if err != nil {
		return err
	}
	w.view.Message = out.message
	if out.redraw {
		w.draw(ctx, out.fresh)
	}
	return nil
}
