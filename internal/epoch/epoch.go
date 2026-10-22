// Package epoch is the Date.parse / toISOString subset drovr uses; instants are epoch millis.
package epoch

import "time"

type Millis = int64

var layouts = []string{time.RFC3339Nano, "2006-01-02T15:04:05Z07:00", "2006-01-02"}

// Parse truncates sub-millisecond digits, as JS does. A date-only string is UTC.
func Parse(s string) (Millis, bool) {
	for _, l := range layouts {
		if t, err := time.Parse(l, s); err == nil {
			return t.UnixMilli(), true
		}
	}
	return 0, false
}

// MustParse is for tests only.
func MustParse(s string) Millis {
	ms, ok := Parse(s)
	if !ok {
		panic("epoch: unparseable " + s)
	}
	return ms
}

func ISO(ms Millis) string { return time.UnixMilli(ms).UTC().Format("2006-01-02T15:04:05.000Z") }

func Now() Millis { return time.Now().UnixMilli() }
