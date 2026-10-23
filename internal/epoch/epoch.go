// Package epoch is the Date.parse / toISOString subset drovr uses; instants are epoch millis.
package epoch

import (
	"io"
	"time"
)

type Millis = int64

// The minute-only form is "2026-08-30T09:00Z", which Date.parse takes: the form an agent
// waiting on a release date writes.
var layouts = []string{time.RFC3339Nano, "2006-01-02T15:04:05Z07:00", "2006-01-02T15:04Z07:00", "2006-01-02"}

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

type stamped struct {
	w   io.Writer
	now func() Millis
}

// cli.ts's stampConsole prefixes each console call, not each line; one Fprintln per message
// keeps the two the same, so a multi-line message carries one stamp.
// One Write per message: the tick and its detached workers append to the same log under
// O_APPEND, and a stamp written separately could land between another process's stamp and line.
func (s stamped) Write(p []byte) (int, error) {
	line := append([]byte(ISO(s.now())+" "), p...)
	n, err := s.w.Write(line)
	return max(0, min(len(p), n-(len(line)-len(p)))), err
}

// Stamped writes "<ISO> " before every Write call.
func Stamped(w io.Writer, now func() Millis) io.Writer { return stamped{w, now} }
