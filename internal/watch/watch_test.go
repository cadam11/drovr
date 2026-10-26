package watch

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/fixtures"
	"github.com/cadam11/drovr/internal/state"
)

func decodeInput(t *testing.T, name string, raw json.RawMessage, v any) {
	t.Helper()
	if err := json.Unmarshal(raw, v); err != nil {
		t.Fatalf("%s: %v", name, err)
	}
}

func wantString(t *testing.T, name string, raw json.RawMessage) string {
	t.Helper()
	var s string
	decodeInput(t, name, raw, &s)
	return s
}

func TestVisibleLengthFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.visibleLength")
	for _, c := range cases {
		var in struct{ Text string }
		decodeInput(t, c.Name, c.Input, &in)
		fixtures.Equal(t, c.Name, VisibleLength(in.Text), c.Output)
	}
	t.Logf("%d cases", len(cases))
}

func TestClipFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.clip")
	for _, c := range cases {
		var in struct {
			Text  string
			Width int
		}
		decodeInput(t, c.Name, c.Input, &in)
		if got, want := Clip(in.Text, in.Width), wantString(t, c.Name, c.Output); got != want {
			t.Errorf("%s: got %q, want %q", c.Name, got, want)
		}
	}
	t.Logf("%d cases", len(cases))
}

func TestWrapTextFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.wrapText")
	for _, c := range cases {
		var in struct {
			Text     string
			Width    int
			MaxLines int
		}
		decodeInput(t, c.Name, c.Input, &in)
		fixtures.Equal(t, c.Name, WrapText(in.Text, in.Width, in.MaxLines), c.Output)
	}
	t.Logf("%d cases", len(cases))
}

func TestWrapTextRefusesNoRoom(t *testing.T) {
	defer func() {
		if got := recover(); got != "wrapText needs width>=1 and maxLines>=1, got 0/3" {
			t.Fatalf("recovered %v", got)
		}
	}()
	WrapText("abc", 0, 3)
}

func TestUntilLabelFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.untilLabel")
	for _, c := range cases {
		var in struct {
			At  *string
			Now epoch.Millis
		}
		decodeInput(t, c.Name, c.Input, &in)
		fixtures.Equal(t, c.Name, UntilLabel(in.At, in.Now), c.Output)
	}
	t.Logf("%d cases", len(cases))
}

func TestAccountsLabelFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.accountsLabel")
	for _, c := range cases {
		var in struct{ Funding, Usable int }
		decodeInput(t, c.Name, c.Input, &in)
		fixtures.Equal(t, c.Name, AccountsLabel(in.Funding, in.Usable), c.Output)
	}
	t.Logf("%d cases", len(cases))
}

func TestChildReasonFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.childReason")
	for _, c := range cases {
		var in struct{ Text string }
		decodeInput(t, c.Name, c.Input, &in)
		fixtures.Equal(t, c.Name, ChildReason(in.Text), c.Output)
	}
	t.Logf("%d cases", len(cases))
}

func TestKeybarLinesFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.keybarLines")
	for _, c := range cases {
		var in struct {
			Width  int
			Narrow bool
		}
		decodeInput(t, c.Name, c.Input, &in)
		fixtures.Equal(t, c.Name, KeybarLines(in.Width, in.Narrow), c.Output)
	}
	t.Logf("%d cases", len(cases))
}

func TestKeybarKeyAtFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.keybarKeyAt")
	for _, c := range cases {
		var in struct {
			Width, Row, Column int
			Narrow             bool
		}
		decodeInput(t, c.Name, c.Input, &in)
		var got *string
		if key, ok := KeybarKeyAt(in.Width, in.Narrow, in.Row, in.Column); ok {
			got = &key
		}
		fixtures.Equal(t, c.Name, got, c.Output)
	}
	t.Logf("%d cases", len(cases))
}

// stripped is a keybar line as the eye sees it, so a label's columns can be read off it.
func stripped(line string) string {
	return sgr.ReplaceAllString(line, "")
}

func TestKeybarKeyAtMatchesKeybarLines(t *testing.T) {
	labels := map[string]*string{}
	for _, k := range keys {
		labels[k.label] = k.key
		labels[strings.SplitN(k.label, " ", 2)[0]] = k.key
	}
	for width := 24; width <= 120; width++ {
		for _, narrow := range []bool{false, true} {
			for row, line := range KeybarLines(width, narrow) {
				checkKeybarRow(t, width, narrow, row, stripped(line), labels)
			}
		}
	}
}

// checkKeybarRow walks the drawn row's labels and asks KeybarKeyAt about every column.
func checkKeybarRow(t *testing.T, width int, narrow bool, row int, line string, labels map[string]*string) {
	t.Helper()
	if VisibleLength(line) > width {
		t.Errorf("%d/%v row %d is %d wide", width, narrow, row, VisibleLength(line))
	}
	runes := []rune(line)
	drawn := make([]*string, len(runes)+1)
	col := 2
	for _, shown := range strings.Split(string(runes[2:]), " · ") {
		k, isLabel := labels[shown]
		if !isLabel {
			t.Fatalf("%d/%v row %d: %q is not a key label", width, narrow, row, shown)
		}
		for i := col; i < col+len(shown); i++ {
			drawn[i] = k
		}
		col += len(shown) + 3
	}
	for column := 0; column <= len(runes); column++ {
		key, ok := KeybarKeyAt(width, narrow, row, column)
		if ok != (drawn[column] != nil) || ok && key != *drawn[column] {
			t.Errorf("%d/%v row %d col %d: KeybarKeyAt %q/%v, drawn %v", width, narrow, row, column, key, ok, drawn[column])
		}
	}
}

func TestKeybarEveryKeyReachableAt40Narrow(t *testing.T) {
	reached := map[string]bool{}
	for row := range KeybarLines(40, true) {
		for column := 0; column < 40; column++ {
			if key, ok := KeybarKeyAt(40, true, row, column); ok {
				reached[key] = true
			}
		}
	}
	for _, k := range keys {
		if k.key != nil && !reached[*k.key] {
			t.Errorf("%q unreachable", *k.key)
		}
	}
}

type frameInput struct {
	State   state.DrovrState
	View    View
	Columns int
	Rows    *int
}

func (in frameInput) rows() int {
	if in.Rows == nil {
		return 0
	}
	return *in.Rows
}

func TestFrameWithHitsFixtures(t *testing.T) {
	cases := fixtures.Load(t, "watch.frameWithHits")
	for _, c := range cases {
		var in frameInput
		decodeInput(t, c.Name, c.Input, &in)
		var want struct {
			Text string
			Hits json.RawMessage
		}
		decodeInput(t, c.Name, c.Output, &want)
		text, hits := FrameWithHits(in.State, in.View, in.Columns, in.rows(), time.UTC)
		if text != want.Text {
			t.Errorf("%s (%d cols, rows %v): %s", c.Name, in.Columns, in.rows(), firstDiff(text, want.Text))
		}
		fixtures.Equal(t, c.Name, hits, want.Hits)
	}
	t.Logf("%d cases", len(cases))
}

func firstDiff(got, want string) string {
	g, w := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := 0; i < min(len(g), len(w)); i++ {
		if g[i] != w[i] {
			return fmt.Sprintf("line %d:\n got  %q\n want %q", i, g[i], w[i])
		}
	}
	return "line counts differ"
}

func TestClampKeepsTheTail(t *testing.T) {
	seen := map[int]bool{}
	for _, c := range fixtures.Load(t, "watch.frameWithHits") {
		var in frameInput
		decodeInput(t, c.Name, c.Input, &in)
		if in.rows() != 24 || in.View.Help || !map[int]bool{60: true, 80: true, 100: true, 120: true}[in.Columns] {
			continue
		}
		seen[in.Columns] = true
		checkTail(t, c.Name, in)
	}
	if len(seen) != 4 {
		t.Fatalf("24-row cases at widths %v, want 60/80/100/120", seen)
	}
}

func checkTail(t *testing.T, name string, in frameInput) {
	t.Helper()
	text, hits := FrameWithHits(in.State, in.View, in.Columns, 24, time.UTC)
	lines := strings.Split(text, "\n")
	if len(lines) > 23 || len(lines) != len(hits) {
		t.Fatalf("%s: %d lines, %d hits", name, len(lines), len(hits))
	}
	unclamped, _ := FrameWithHits(in.State, in.View, in.Columns, 0, time.UTC)
	if len(strings.Split(unclamped, "\n")) <= 24 {
		t.Fatalf("%s: unclamped frame fits, so the clamp is untested", name)
	}
	bar := KeybarLines(in.Columns, in.Columns < 72)
	if strings.Join(lines[len(lines)-len(bar):], "\n") != strings.Join(bar, "\n") {
		t.Errorf("%s: keybar is not the whole tail", name)
	}
	if in.View.Message != "" && !strings.Contains(text, in.View.Message) {
		t.Errorf("%s: message line lost", name)
	}
	if in.View.PreviewWarning != nil && !strings.Contains(text, *in.View.PreviewWarning) {
		t.Errorf("%s: preview warning lost", name)
	}
}
