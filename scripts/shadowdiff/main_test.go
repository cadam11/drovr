package main

import (
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
)

func e(at, program, verdict, reason string) entry {
	return entry{At: at, Program: program, Verdict: verdict, Reason: reason, at: epoch.MustParse(at)}
}

func withPool(x entry, session float64, fundable *float64) entry {
	x.Pool = &pool{Fable: 1, General: 1, Session: session}
	x.CyclesFundable = fundable
	return x
}

func ptr(f float64) *float64 { return &f }

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
		withPool(e("2026-10-23T10:10:10.000Z", "alpha", "GO", "fundable: 1.20 cycles"), 0.5, nil),
		e("2026-10-23T10:20:20.000Z", "beta", "GO", "x"),
		e("2026-10-23T10:30:01.000Z", "beta", "WAIT", "held back for alpha"),
		e("2026-10-23T10:38:00.000Z", "gamma", "STOP", "disabled"),
	}
	live[1] = withPool(live[1], 0.4, nil) // the pool moved between the passes: digits may drift
	r := compare(live, shadow, epoch.MustParse("2026-10-23T10:00:00.000Z"), defaultWindow)
	if r.Paired != 4 || r.Unpaired != 1 || r.Verdict != 1 || r.Reason != 1 || r.Drift != 1 {
		t.Fatalf("%+v", r)
	}
	if summary(r) != "paired 4, unpaired 1, verdict 1, reason 1, numbers 0, numeric drift 1" || exitCode(r) != 1 {
		t.Fatal(summary(r))
	}
	var kinds []string
	for _, f := range r.Findings {
		kinds = append(kinds, f.Kind+":"+f.Live.Program)
	}
	if strings.Join(kinds, ",") != "drift:alpha,verdict:beta,reason:beta,unpaired:gamma" {
		t.Fatal(kinds)
	}
	if exitCode(compare(live[:1], shadow[:1], 0, defaultWindow)) != 0 {
		t.Fatal("a clean window exits 0")
	}
	if r := compare(nil, shadow, 0, defaultWindow); exitCode(r) != 3 || r.Paired != 0 {
		t.Fatal("no live lines compares nothing, which is not a clean day")
	}
	if exitCode(compare(live, shadow, epoch.MustParse("2026-10-24T00:00:00.000Z"), defaultWindow)) != 3 {
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

// launchd jitter can put consecutive shadow passes more than 60 s apart, so the default window
// is 1.5 intervals; --window narrows it.
func TestWindow(t *testing.T) {
	live := []entry{e("2026-10-23T10:01:15.000Z", "alpha", "GO", "r")}
	shadow := []entry{e("2026-10-23T10:00:00.000Z", "alpha", "GO", "r")}
	if r := compare(live, shadow, 0, defaultWindow); r.Paired != 1 || r.Unpaired != 0 {
		t.Fatalf("75 s before pairs at the default window: %+v", r)
	}
	if r := compare(live, shadow, 0, 60_000); r.Paired != 0 || r.Unpaired != 1 {
		t.Fatalf("75 s before is unpaired at --window 60: %+v", r)
	}
	if code := run([]string{"--window", "nope"}); code != 2 {
		t.Fatalf("a non-numeric window is a usage error, got %d", code)
	}
}

// Drift is only excusable when the pool moved: with identical pools the two ticks saw the
// same world, so any difference at all is the port's.
func TestSamePoolAllowsNoDrift(t *testing.T) {
	at, before := "2026-10-23T10:00:30.000Z", "2026-10-23T10:00:05.000Z"
	cases := []struct {
		name       string
		live, shad entry
		want       string
	}{
		{"digits differ, same pool", withPool(e(at, "a", "GO", "fundable: 1.25"), 0.4, nil), withPool(e(before, "a", "GO", "fundable: 1.20"), 0.4, nil), "reason"},
		{"digits differ, pool moved", withPool(e(at, "a", "GO", "fundable: 1.25"), 0.4, nil), withPool(e(before, "a", "GO", "fundable: 1.20"), 0.5, nil), "drift"},
		{"clock text moved, same pool", withPool(e(at, "a", "WAIT", "more room in 43m"), 0.4, nil), withPool(e(before, "a", "WAIT", "more room in 44m"), 0.4, nil), ""},
		{"ask age moved, same pool", withPool(e(at, "a", "WAIT", "raised 5m ago"), 0.4, nil), withPool(e(before, "a", "WAIT", "raised 6m ago"), 0.4, nil), ""},
		{"readiness hold, both pools null", e(at, "a", "WAIT", "rest ends in 2h, 40% through the window"), e(before, "a", "WAIT", "rest ends in 3h, 41% through the window"), ""},
		{"cycles differ, same pool", withPool(e(at, "a", "GO", "room for 1.35 cycles"), 0.4, nil), withPool(e(before, "a", "GO", "room for 1.40 cycles"), 0.4, nil), "reason"},
		{"count differs, same pool", withPool(e(at, "a", "WAIT", "cap is 2"), 0.4, nil), withPool(e(before, "a", "WAIT", "cap is 3"), 0.4, nil), "reason"},
		{"fundable differs, same pool", withPool(e(at, "a", "GO", "r"), 0.4, ptr(1.25)), withPool(e(before, "a", "GO", "r"), 0.4, ptr(1.2)), "numbers"},
		{"fundable within 1e-9, same pool", withPool(e(at, "a", "GO", "r"), 0.4, ptr(1.25)), withPool(e(before, "a", "GO", "r"), 0.4, ptr(1.25+1e-12)), ""},
		{"fundable differs, pool moved", withPool(e(at, "a", "GO", "r"), 0.4, ptr(1.25)), withPool(e(before, "a", "GO", "r"), 0.5, ptr(1.2)), ""},
		{"fundable on one side only", withPool(e(at, "a", "GO", "r"), 0.4, ptr(1.25)), withPool(e(before, "a", "GO", "r"), 0.4, nil), ""},
	}
	for _, c := range cases {
		r := compare([]entry{c.live}, []entry{c.shad}, 0, defaultWindow)
		got := ""
		if len(r.Findings) > 0 {
			got = r.Findings[0].Kind
		}
		if got != c.want || (c.want != "" && c.want != "drift") != (exitCode(r) == 1) {
			t.Errorf("%s: kind %q exit %d", c.name, got, exitCode(r))
		}
	}
}

func TestParseReadsPoolAndFundable(t *testing.T) {
	text := `{"at":"2026-10-23T10:00:30.000Z","program":"alpha","verdict":"GO","reason":"r","pool":{"fable":0.5,"general":0.25,"session":1},"cyclesFundable":1.5}`
	var bad strings.Builder
	got := parse(strings.NewReader(text), "d", &bad)
	if len(got) != 1 || *got[0].Pool != (pool{0.5, 0.25, 1}) || *got[0].CyclesFundable != 1.5 {
		t.Fatalf("%+v %s", got, bad.String())
	}
}
