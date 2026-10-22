package epoch

import "testing"

func TestParseAndISO(t *testing.T) {
	cases := []struct {
		in string
		ms Millis
		ok bool
	}{
		{"2026-08-22T12:00:00.000Z", 1787400000000, true},
		{"2026-08-22T12:00:00Z", 1787400000000, true},
		{"2026-08-22T12:00:00.123456Z", 1787400000123, true},
		{"2026-08-22T07:00:00-05:00", 1787400000000, true},
		{"2026-08-22", 1787356800000, true},
		{"not a date", 0, false},
		{"", 0, false},
	}
	for _, c := range cases {
		got, ok := Parse(c.in)
		if ok != c.ok || got != c.ms {
			t.Errorf("Parse(%q) = %d,%v want %d,%v", c.in, got, ok, c.ms, c.ok)
		}
	}
	if got := ISO(1787400000123); got != "2026-08-22T12:00:00.123Z" {
		t.Errorf("ISO = %q", got)
	}
	if got := ISO(1787400000000); got != "2026-08-22T12:00:00.000Z" {
		t.Errorf("ISO whole second = %q", got)
	}
}
