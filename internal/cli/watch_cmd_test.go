package cli

import (
	"context"
	"testing"
)

func TestWatchIntervalIsParseIntWithR1(t *testing.T) {
	for _, c := range []struct {
		args []string
		want int
	}{{nil, 15}, {[]string{"30"}, 30}, {[]string{"10abc"}, 10}, {[]string{"0"}, 0}, {[]string{"-3"}, -3}} {
		if got, err := watchInterval(c.args); err != nil || got != c.want {
			t.Errorf("%v: %d %v, want %d", c.args, got, err, c.want)
		}
	}
}

// Refused before the terminal is touched: no alternate screen for a typo.
func TestWatchRefusesANonInteger(t *testing.T) {
	env, out, _ := cliEnv(t, `{"programs":[]}`)
	err := Watch(context.Background(), env, []string{"abc"})
	if err == nil || err.Error() != `the interval is a number of seconds, got "abc"` {
		t.Fatalf("err %v", err)
	}
	if out.Len() != 0 {
		t.Errorf("wrote %q", out.String())
	}
}

// time.Duration overflows past ~292 years and NewTicker panics on what it wraps to.
func TestWatchRefusesAnIntervalPastAYear(t *testing.T) {
	if got, err := watchInterval([]string{"31536000"}); err != nil || got != maxWatchIntervalSeconds {
		t.Errorf("a year: %d %v", got, err)
	}
	for raw, n := range map[string]string{"31536001": "31536001", "99999999999999999999": "100000000000000000000", "40000000s": "40000000"} {
		if _, err := watchInterval([]string{raw}); err == nil || err.Error() != "the interval is too large: "+n+" seconds" {
			t.Errorf("%s: err %v", raw, err)
		}
	}
}
