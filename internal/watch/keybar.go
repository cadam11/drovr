package watch

import "strings"

func key(k string) *string { return &k }

// keys' key is what a click on the label feeds back in as a keystroke: nil where a click
// cannot disambiguate ('[ ]' is two opposite actions) and for selection, which the mouse
// does by clicking a row.
var keys = []struct {
	label string
	key   *string
}{
	{"j/k select", nil},
	{"space enable", key(" ")},
	{"[ ] priority", nil},
	{"m mode", key("m")},
	{"p pause", key("p")},
	{"+/- cap", nil},
	{"< > reserve", nil},
	{"r refresh", key("r")},
	{"t tick", key("t")},
	{"o asks", key("o")},
	{"s start", key("s")},
	{"x interrupt", key("x")},
	{"l release", key("l")},
	{"? help", key("?")},
	{"q quit", key("q")},
}

type keybarEntry struct {
	shown      string
	key        *string
	start, end int
}

// keybarLayout is the one layout both KeybarLines draws and KeybarKeyAt hit-tests, so a
// click can never land on a different key than the one drawn there. The loop is bounded by
// the key table; each key opens at most one row.
func keybarLayout(width int, narrow bool) [][]keybarEntry {
	rows := [][]keybarEntry{{}}
	used := 0
	for _, k := range keys {
		shown := k.label
		if narrow {
			shown, _, _ = strings.Cut(k.label, " ")
		}
		cost := len(shown) + 3
		if used+cost > width-4 && len(rows[len(rows)-1]) > 0 {
			rows = append(rows, []keybarEntry{})
			used = 0
		}
		rows[len(rows)-1] = append(rows[len(rows)-1], keybarEntry{shown, k.key, 2 + used, 2 + used + len(shown)})
		used += cost
	}
	return rows
}

// KeybarLines wraps rather than clips: a key you cannot see is a key you do not have.
func KeybarLines(width int, narrow bool) []string {
	layout := keybarLayout(width, narrow)
	lines := make([]string, len(layout))
	for i, row := range layout {
		shown := make([]string, len(row))
		for j, entry := range row {
			shown[j] = entry.shown
		}
		lines[i] = "  " + strings.Join(shown, dim(" · "))
	}
	return lines
}

// KeybarKeyAt is the keystroke a click at this keybar row and 0-based column stands for.
func KeybarKeyAt(width int, narrow bool, row, column int) (string, bool) {
	layout := keybarLayout(width, narrow)
	if row < 0 || row >= len(layout) {
		return "", false
	}
	for _, entry := range layout[row] {
		if column >= entry.start && column < entry.end && entry.key != nil {
			return *entry.key, true
		}
	}
	return "", false
}
