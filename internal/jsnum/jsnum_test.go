package jsnum

import (
	"math"
	"testing"
)

func TestToFixed(t *testing.T) {
	cases := []struct {
		v    float64
		d    int
		want string
	}{
		{1.005, 2, "1.00"}, {0.125, 2, "0.13"}, {2.5, 0, "3"}, {0.1 + 0.2, 2, "0.30"},
		{1.35, 2, "1.35"}, {0.39, 3, "0.390"}, {0, 2, "0.00"}, {12.34567, 2, "12.35"},
		{-1.5, 0, "-2"}, {-0.001, 2, "-0.00"},
		{math.Inf(1), 2, "Infinity"}, {math.Inf(-1), 2, "-Infinity"}, {math.NaN(), 2, "NaN"},
	}
	for _, c := range cases {
		if got := ToFixed(c.v, c.d); got != c.want {
			t.Errorf("ToFixed(%v,%d) = %q want %q", c.v, c.d, got, c.want)
		}
	}
}

func TestRound4AndHalfUp(t *testing.T) {
	if got := Round4(0.5700000000000001); got != 0.57 {
		t.Errorf("Round4 = %v", got)
	}
	if got := RoundHalfUp(-2.5); got != -2 { // JS Math.round(-2.5) === -2
		t.Errorf("RoundHalfUp(-2.5) = %v", got)
	}
	if got := RoundHalfUp(2.5); got != 3 {
		t.Errorf("RoundHalfUp(2.5) = %v", got)
	}
}

// The last two cases cut through a surrogate pair. JS keeps the lone high surrogate; Go
// drops it (see Slice).
func TestSliceCountsUTF16Units(t *testing.T) {
	cases := []struct {
		in   string
		n    int
		want string
	}{{"abcdef", 3, "abc"}, {"ab", 5, "ab"}, {"é✳x", 2, "é✳"}, {"a🦾b", 3, "a🦾"}, {"", 4, ""},
		{"a🦾b", 2, "a"}, {"🦾", 1, ""}}
	for _, c := range cases {
		if got := Slice(c.in, c.n); got != c.want {
			t.Errorf("Slice(%q,%d) = %q want %q", c.in, c.n, got, c.want)
		}
	}
}

func TestStringIsJSNumberToString(t *testing.T) {
	ninetyFive := 0.95 // a constant 1 - 0.95 folds exactly to 0.05; JS subtracts at runtime
	cases := []struct {
		v    float64
		want string
	}{
		{0.1, "0.1"}, {8, "8"}, {0.25, "0.25"}, {1.5e-7, "1.5e-7"}, {1e21, "1e+21"}, {math.Copysign(0, -1), "0"},
		{1e-6, "0.000001"}, {1e20, "100000000000000000000"}, {-2.5e-10, "-2.5e-10"}, {1 - ninetyFive, "0.050000000000000044"},
		{math.NaN(), "NaN"}, {math.Inf(-1), "-Infinity"},
	}
	for _, c := range cases {
		if got := String(c.v); got != c.want {
			t.Errorf("String(%v) = %q want %q", c.v, got, c.want)
		}
	}
}
