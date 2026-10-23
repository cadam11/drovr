package main

import (
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
)

func e(at, program, verdict, reason string) entry {
	return entry{At: at, Program: program, Verdict: verdict, Reason: reason, at: epoch.MustParse(at)}
}

func TestCompare(t *testing.T) {
	live := []entry{
		e("2026-10-23T10:00:30.000Z", "alpha", "GO", "fundable: 1.25 cycles"),
		e("2026-10-23T10:10:30.000Z", "alpha", "GO", "fundable: 1.25 cycles"),
		e("2026-10-23T10:20:30.000Z", "beta", "WAIT", "x"),
		e("2026-10-23T10:30:30.000Z", "beta", "WAIT", "held for alpha"),
		e("2026-10-23T10:40:30.000Z", "gamma", "STOP", "disabled"),
		e("2026-10-23T09:00:00.000Z", "gamma", "GO", "before --since: ignored"),
	}
	shadow := []entry{
		e("2026-10-23T10:00:05.000Z", "alpha", "GO", "fundable: 1.25 cycles"),
		e("2026-10-23T10:00:40.000Z", "alpha", "WAIT", "after the live pass: never its pair"),
		e("2026-10-23T10:10:10.000Z", "alpha", "GO", "fundable: 1.20 cycles"),
		e("2026-10-23T10:20:20.000Z", "beta", "GO", "x"),
		e("2026-10-23T10:30:01.000Z", "beta", "WAIT", "held back for alpha"),
		e("2026-10-23T10:38:00.000Z", "gamma", "STOP", "disabled"),
	}
	r := compare(live, shadow, epoch.MustParse("2026-10-23T10:00:00.000Z"))
	if r.Paired != 4 || r.Unpaired != 1 || r.Verdict != 1 || r.Reason != 1 || r.Drift != 1 {
		t.Fatalf("%+v", r)
	}
	if summary(r) != "paired 4, unpaired 1, verdict 1, reason 1, numeric drift 1" || exitCode(r) != 1 {
		t.Fatal(summary(r))
	}
	var kinds []string
	for _, f := range r.Findings {
		kinds = append(kinds, f.Kind+":"+f.Live.Program)
	}
	if strings.Join(kinds, ",") != "drift:alpha,verdict:beta,reason:beta,unpaired:gamma" {
		t.Fatal(kinds)
	}
	if exitCode(compare(live[:1], shadow[:1], 0)) != 0 {
		t.Fatal("a clean window exits 0")
	}
	if r := compare(nil, shadow, 0); exitCode(r) != 3 || r.Paired != 0 {
		t.Fatal("no live lines compares nothing, which is not a clean day")
	}
	if exitCode(compare(live, shadow, epoch.MustParse("2026-10-24T00:00:00.000Z"))) != 3 {
		t.Fatal("a --since past every live line compares nothing")
	}
}

// A day of logs is read leniently: a torn or foreign line is counted and named, never fatal.
func TestParseIsLenient(t *testing.T) {
	text := `{"v":1,"at":"2026-10-23T10:00:30.000Z","program":"alpha","verdict":"GO","reason":"r","pool":null}
{nope
{"at":"not a time","program":"alpha"}

{"v":1,"at":"2026-10-23T10:10:30.000Z","program":"beta","verdict":"WAIT","reason":"q"}
`
	var bad strings.Builder
	entries := parse(strings.NewReader(text), "decisions.jsonl", &bad)
	if len(entries) != 2 || entries[1].Program != "beta" || entries[1].at != epoch.MustParse("2026-10-23T10:10:30.000Z") {
		t.Fatalf("%+v", entries)
	}
	if !strings.Contains(bad.String(), "decisions.jsonl: 2 unreadable line(s): 2, 3") {
		t.Fatal(bad.String())
	}
}
