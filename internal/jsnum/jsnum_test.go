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
