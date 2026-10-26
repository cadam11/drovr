package watch

import (
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/state"
)

const asksURL = "https://sunnyt.aicex.app/craig/asks.html"

// fixture builds programs the way the runner will: control.json's list through ByPriority.
func fixture(t *testing.T) ([]control.Program, *state.DrovrState) {
	t.Helper()
	raw := []control.Program{
		{Name: "beta", Runner: "headless", Enabled: true, Priority: 1},
		{Name: "alpha", Runner: "orca", Enabled: true},
	}
	programs, err := control.ByPriority(raw, 1_790_000_000_000, 7)
	if err != nil {
		t.Fatal(err)
	}
	url := asksURL
	st := &state.DrovrState{Programs: []state.ProgramState{{Name: "alpha", AsksURL: &url}, {Name: "beta"}}}
	return programs, st
}

func intRef(i int) *int { return &i }

func TestChunkIsOneKey(t *testing.T) {
	programs, st := fixture(t)
	if got, _ := DecideKey("jj", View{}, programs, st); got.Kind != IntentNone {
		t.Fatalf(`"jj" = %v, want None`, got.Kind)
	}
	presses, rest := ParseChunk("\x1b[<0;5;3M\x1b[<0;5;3mq")
	if len(presses) != 1 || presses[0] != (MouseEvent{Button: 0, X: 5, Y: 3, Press: true}) || rest != "q" {
		t.Fatalf("got %+v rest %q", presses, rest)
	}
	presses, rest = ParseChunk(strings.Repeat("\x1b[<65;1;1M", 9))
	if len(presses) != 8 || rest != "" {
		t.Fatalf("nine presses: honoured %d, rest %q", len(presses), rest)
	}
	if presses, rest = ParseChunk("x"); len(presses) != 0 || rest != "x" {
		t.Fatalf("plain key: %+v %q", presses, rest)
	}
}

type matrixInput struct {
	name  string
	key   string
	click *MouseEvent
}

func TestConfirmationMatrix(t *testing.T) {
	programs, st := fixture(t)
	hits := []*LineHit{{Program: intRef(1)}, {Asks: intRef(1)}, nil}
	click := func(button, y int) *MouseEvent { return &MouseEvent{Button: button, X: 3, Y: y, Press: true} }
	armed := map[string]View{
		"stop":  {ConfirmStop: true, Message: "interrupt alpha? y to confirm, any other key to cancel"},
		"start": ArmStart(View{}, "alpha"),
	}
	confirms := map[string]IntentKind{"stop": IntentInterrupt, "start": IntentStartCycle}
	for noun, v := range armed {
		cancel := noun + " cancelled"
		cases := []struct {
			in        matrixInput
			want      IntentKind
			stillArmd bool
			message   string
		}{
			{matrixInput{name: "y", key: "y"}, confirms[noun], false, v.Message},
			{matrixInput{name: "n", key: "n"}, IntentCancel, false, cancel},
			{matrixInput{name: "j", key: "j"}, IntentCancel, false, cancel},
			{matrixInput{name: "up", key: "\x1b[A"}, IntentCancel, false, cancel},
			{matrixInput{name: "row click", click: click(0, 1)}, IntentCancel, false, cancel},
			{matrixInput{name: "asks click", click: click(0, 2)}, IntentCancel, false, cancel},
			{matrixInput{name: "wheel up", click: click(64, 9)}, IntentCancel, false, cancel},
			{matrixInput{name: "wheel down", click: click(65, 9)}, IntentCancel, false, cancel},
			{matrixInput{name: "q", key: "q"}, IntentQuit, true, v.Message},
			{matrixInput{name: "ctrl-c", key: CtrlC}, IntentQuit, true, v.Message},
			{matrixInput{name: "dead space", click: click(0, 3)}, IntentNone, true, v.Message},
			{matrixInput{name: "past the frame", click: click(0, 40)}, IntentNone, true, v.Message},
			{matrixInput{name: "right", click: click(2, 1)}, IntentNone, true, v.Message},
			{matrixInput{name: "middle", click: click(1, 1)}, IntentNone, true, v.Message},
		}
		for _, c := range cases {
			var got Intent
			var next View
			if c.in.click != nil {
				got, next = DecideClick(*c.in.click, hits, 100, false, v, programs, st)
			} else {
				got, next = DecideKey(c.in.key, v, programs, st)
			}
			label := noun + "/" + c.in.name
			if got.Kind != c.want || (next.ConfirmStop || next.ConfirmStart) != c.stillArmd || next.Message != c.message {
				t.Errorf("%s: got %v armed=%v %q", label, got.Kind, next.ConfirmStop || next.ConfirmStart, next.Message)
			}
			if c.want == IntentCancel && next.Selected != v.Selected {
				t.Errorf("%s: a cancel moved the selection to %d", label, next.Selected)
			}
			if c.want == confirms[noun] && got.Program != "alpha" {
				t.Errorf("%s: confirmed %q", label, got.Program)
			}
		}
	}
}

func TestSelectionWraps(t *testing.T) {
	programs, st := fixture(t)
	steps := []struct {
		key  string
		from int
		want int
	}{
		{"j", 0, 1}, {"j", 1, 1}, {"\x1b[B", 0, 1}, {"k", 1, 0}, {"k", 0, 0}, {"\x1b[A", 1, 0},
	}
	for _, s := range steps {
		got, next := DecideKey(s.key, View{Selected: s.from, Message: "old"}, programs, st)
		if got.Kind != IntentMove || next.Selected != s.want || next.Message != "" {
			t.Errorf("%q from %d: %v -> %d %q", s.key, s.from, got.Kind, next.Selected, next.Message)
		}
	}
	if _, next := DecideKey("j", View{}, nil, st); next.Selected != -1 {
		t.Errorf("j with zero programs: %d, want the TS -1", next.Selected)
	}
	if _, next := DecideKey("j", View{Help: true}, programs, st); next.Selected != 1 {
		t.Errorf("j under help: %d", next.Selected)
	}
	wheel := []struct{ button, from, want int }{{65, 0, 1}, {65, 1, 1}, {64, 1, 0}, {64, 0, 0}}
	for _, w := range wheel {
		_, next := DecideClick(MouseEvent{Button: w.button, X: 1, Y: 1, Press: true}, nil, 100, false, View{Selected: w.from}, programs, st)
		if next.Selected != w.want {
			t.Errorf("wheel %d from %d: %d", w.button, w.from, next.Selected)
		}
	}
	if _, next := DecideClick(MouseEvent{Button: 0, X: 1, Y: 1, Press: true}, []*LineHit{{Program: intRef(5)}}, 100, false, View{}, programs, nil); next.Selected != 0 {
		t.Errorf("row click with no state clamps to 0, got %d", next.Selected)
	}
}

func TestMessagesAreVerbatim(t *testing.T) {
	programs, st := fixture(t)
	cases := []struct {
		key     string
		v       View
		kind    IntentKind
		message string
	}{
		{"r", View{}, IntentRefresh, "refreshed"},
		{"x", View{Selected: 0}, IntentArmStop, "interrupt alpha? y to confirm, any other key to cancel"},
		{"x", View{Selected: 1}, IntentArmStop, "stop beta? y to confirm, any other key to cancel"},
		{"l", View{Selected: 1}, IntentNone, "beta runs headless — no runner to release"},
		{"o", View{Selected: 1}, IntentNone, "beta has no asks page configured"},
		{"e", View{Selected: 5}, IntentNone, "no programs configured"},
		{"y", View{Selected: 5, ConfirmStop: true}, IntentNone, "no program selected"},
		{"y", View{Selected: 5, ConfirmStart: true}, IntentNone, "no program selected"},
		{"y", View{Message: "kept"}, IntentNone, ""},
		{"r", View{Help: true, Message: "kept"}, IntentNone, ""},
		{"?", View{Message: "kept"}, IntentHelp, ""},
		{"\x1b", View{Help: true}, IntentHelp, ""},
	}
	for _, c := range cases {
		got, next := DecideKey(c.key, c.v, programs, st)
		if got.Kind != c.kind || next.Message != c.message {
			t.Errorf("%q: %v %q, want %v %q", c.key, got.Kind, next.Message, c.kind, c.message)
		}
	}
	if v := ArmStart(View{}, "alpha"); !v.ConfirmStart || v.Message != "start alpha now, past every gate? y to confirm, any other key to cancel" {
		t.Errorf("ArmStart: %+v", v)
	}
}

func TestKeysBecomeIntents(t *testing.T) {
	programs, st := fixture(t)
	cases := []struct {
		key  string
		want Intent
	}{
		{"m", Intent{Kind: IntentSetMode}},
		{"p", Intent{Kind: IntentTogglePause}},
		{"P", Intent{Kind: IntentExtendPause}},
		{"<", Intent{Kind: IntentNudgeReserve, Delta: -1}},
		{",", Intent{Kind: IntentNudgeReserve, Delta: -1}},
		{">", Intent{Kind: IntentNudgeReserve, Delta: 1}},
		{".", Intent{Kind: IntentNudgeReserve, Delta: 1}},
		{"+", Intent{Kind: IntentAdjustConcurrency, Delta: 1}},
		{"=", Intent{Kind: IntentAdjustConcurrency, Delta: 1}},
		{"-", Intent{Kind: IntentAdjustConcurrency, Delta: -1}},
		{"_", Intent{Kind: IntentAdjustConcurrency, Delta: -1}},
		{"t", Intent{Kind: IntentTickNow}},
		{" ", Intent{Kind: IntentToggleEnabled, Program: "alpha"}},
		{"e", Intent{Kind: IntentToggleEnabled, Program: "alpha"}},
		{"[", Intent{Kind: IntentNudgePriority, Program: "alpha", Delta: -1}},
		{"]", Intent{Kind: IntentNudgePriority, Program: "alpha", Delta: 1}},
		{"l", Intent{Kind: IntentReleaseLeftover, Program: "alpha"}},
		{"s", Intent{Kind: IntentArmStart, Program: "alpha"}},
		{"o", Intent{Kind: IntentOpenAsks, Program: "alpha", URL: asksURL}},
		{"r", Intent{Kind: IntentRefresh, Fresh: true, Redraw: true}},
	}
	for _, c := range cases {
		got, next := DecideKey(c.key, View{Message: "before"}, programs, st)
		if got != c.want {
			t.Errorf("%q: %+v, want %+v", c.key, got, c.want)
		}
		if c.key == "s" && (next.ConfirmStart || next.Message != "before") {
			t.Errorf("s armed before the runner checked the lock: %+v", next)
		}
	}
	// Settings keys need no program: the TS checks them before "no programs configured".
	if got, _ := DecideKey("m", View{Selected: 9}, nil, st); got.Kind != IntentSetMode {
		t.Errorf("m with no programs: %v", got.Kind)
	}
}

func TestClicksResolveAgainstTheFrameOnScreen(t *testing.T) {
	programs, st := fixture(t)
	hits := []*LineHit{{Program: intRef(1)}, {Asks: intRef(0)}, {Keybar: intRef(0)}}
	got, next := DecideClick(MouseEvent{Button: 0, X: 1, Y: 1, Press: true}, hits, 100, false, View{Message: "x"}, programs, st)
	if got.Kind != IntentMove || next.Selected != 1 || next.Message != "" {
		t.Errorf("row click: %v %+v", got.Kind, next)
	}
	got, next = DecideClick(MouseEvent{Button: 4, X: 1, Y: 2, Press: true}, hits, 100, false, View{Selected: 1}, programs, st)
	if got.Kind != IntentOpenAsks || got.URL != asksURL || next.Selected != 0 {
		t.Errorf("shift-click on asks: %+v %+v", got, next)
	}
	for column := 0; column < 100; column++ {
		key, ok := KeybarKeyAt(100, false, 0, column)
		if !ok {
			continue
		}
		want, _ := DecideKey(key, View{}, programs, st)
		got, _ = DecideClick(MouseEvent{Button: 0, X: column + 1, Y: 3, Press: true}, hits, 100, false, View{}, programs, st)
		if got != want {
			t.Errorf("keybar column %d (%q): %+v, want %+v", column, key, got, want)
		}
	}
	if got, _ = DecideClick(MouseEvent{Button: 0, X: 1, Y: 1}, hits, 100, false, View{}, programs, st); got.Kind != IntentNone {
		t.Errorf("a release acted: %v", got.Kind)
	}
}
