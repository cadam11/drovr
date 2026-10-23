// Command shadowdiff pairs the live tick's decisions with the shadow tick's and prints every
// difference. Exit 0 over a whole day is the Go port's cut-over gate.
//
//	go run ./scripts/shadowdiff [--since <ISO>] [live.jsonl [shadow.jsonl]]
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/paths"
)

// window is how far before a live decision its shadow pair may be. launchd's StartInterval
// cannot align two agents to the second, so the shadow fires every 60 s.
const window epoch.Millis = 60_000

type entry struct {
	At, Program, Verdict, Reason string
	at                           epoch.Millis
}

type finding struct {
	Kind   string // verdict | reason | drift | unpaired
	Live   entry
	Shadow *entry
}

type report struct {
	Paired, Unpaired, Verdict, Reason, Drift int
	Findings                                 []finding
}

var digits = regexp.MustCompile(`\d+`)

func masked(s string) string { return digits.ReplaceAllString(s, "#") }

// compare pairs each live decision since `since` with the latest shadow decision for the same
// program at or before it, within the window. Before, never after: a shadow pass after the
// live one sees the cycle the live one just launched, and would disagree for that reason only.
func compare(live, shadow []entry, since epoch.Millis) report {
	byProgram := map[string][]entry{}
	for _, s := range shadow {
		byProgram[s.Program] = append(byProgram[s.Program], s)
	}
	for _, list := range byProgram {
		sort.SliceStable(list, func(i, j int) bool { return list[i].at < list[j].at })
	}
	live = append([]entry(nil), live...)
	sort.SliceStable(live, func(i, j int) bool { return live[i].at < live[j].at })
	var r report
	for _, l := range live {
		if l.at < since {
			continue
		}
		judge(&r, l, pairOf(byProgram[l.Program], l.at))
	}
	return r
}

// pairOf is the latest of a program's time-sorted shadow entries at or before `at`, within the
// window; nil when there is none.
func pairOf(list []entry, at epoch.Millis) *entry {
	i := sort.Search(len(list), func(i int) bool { return list[i].at > at }) - 1
	if i < 0 || at-list[i].at > window {
		return nil
	}
	return &list[i]
}

// judge files one live decision. A reason mismatch that vanishes once every digit run is
// masked is drift: the pool moved in the seconds between the two passes.
func judge(r *report, l entry, s *entry) {
	kind := ""
	switch {
	case s == nil:
		r.Unpaired++
		r.Findings = append(r.Findings, finding{Kind: "unpaired", Live: l})
		return
	case s.Verdict != l.Verdict:
		kind, r.Verdict = "verdict", r.Verdict+1
	case s.Reason == l.Reason:
	case masked(s.Reason) == masked(l.Reason):
		kind, r.Drift = "drift", r.Drift+1
	default:
		kind, r.Reason = "reason", r.Reason+1
	}
	r.Paired++
	if kind != "" {
		r.Findings = append(r.Findings, finding{Kind: kind, Live: l, Shadow: s})
	}
}

func summary(r report) string {
	return fmt.Sprintf("paired %d, unpaired %d, verdict %d, reason %d, numeric drift %d", r.Paired, r.Unpaired, r.Verdict, r.Reason, r.Drift)
}

// exitCode leaves drift out: it is listed for a human to glance at, not a failure. Nothing
// paired is its own code, never 0: exit 0 is the cut-over gate, and a day the Node tick was
// down (or a --since past the newest live line) compared nothing and proves nothing.
func exitCode(r report) int {
	if r.Verdict+r.Reason+r.Unpaired > 0 {
		return 1
	}
	if r.Paired == 0 {
		return 3
	}
	return 0
}

// parse reads a decisions log leniently: this is a report about the logs, not one of them, so
// a line that does not decode is counted and named on `bad`, never fatal.
func parse(in io.Reader, name string, bad io.Writer) []entry {
	var out []entry
	var unreadable []string
	scanner := bufio.NewScanner(in)
	scanner.Buffer(make([]byte, 0, 64*1024), 1<<20)
	for n := 1; scanner.Scan(); n++ {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var e entry
		var raw struct{ At, Program, Verdict, Reason string }
		ok := json.Unmarshal([]byte(line), &raw) == nil
		if ok {
			e = entry{At: raw.At, Program: raw.Program, Verdict: raw.Verdict, Reason: raw.Reason}
			e.at, ok = epoch.Parse(raw.At)
		}
		if !ok {
			unreadable = append(unreadable, strconv.Itoa(n))
			continue
		}
		out = append(out, e)
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintf(bad, "%s: stopped reading: %s\n", name, err)
	}
	if len(unreadable) > 0 {
		fmt.Fprintf(bad, "%s: %d unreadable line(s): %s\n", name, len(unreadable), strings.Join(unreadable, ", "))
	}
	return out
}

func read(path string) ([]entry, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	return parse(f, path, os.Stderr), nil
}

func printReport(w io.Writer, r report) {
	for _, f := range r.Findings {
		shadowVerdict, shadowReason := "-", "(no shadow decision within 60s before)"
		if f.Shadow != nil {
			shadowVerdict, shadowReason = f.Shadow.Verdict, f.Shadow.Reason
		}
		fmt.Fprintf(w, "%s  %s  %-8s live %s  shadow %s\n  live:   %s\n  shadow: %s\n",
			f.Live.At, f.Live.Program, f.Kind, f.Live.Verdict, shadowVerdict, f.Live.Reason, shadowReason)
	}
	fmt.Fprintln(w, summary(r))
}

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	flags := flag.NewFlagSet("shadowdiff", flag.ContinueOnError)
	sinceFlag := flags.String("since", "", "ISO instant to judge from (default: 24h before the newest live decision)")
	if err := flags.Parse(args); err != nil {
		return 2
	}
	if flags.NArg() > 2 {
		fmt.Fprintln(os.Stderr, "usage: shadowdiff [--since <ISO>] [live.jsonl [shadow.jsonl]]")
		return 2
	}
	p := paths.New()
	files := []string{p.Decisions, p.DecisionsShadow}
	copy(files, flags.Args())
	live, err := read(files[0])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	shadow, err := read(files[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		return 2
	}
	return judgeFiles(live, shadow, *sinceFlag)
}

func judgeFiles(live, shadow []entry, sinceText string) int {
	since, ok := epoch.Parse(sinceText)
	if sinceText == "" {
		since, ok = newest(live)-24*3_600_000, true
	}
	if !ok {
		fmt.Fprintf(os.Stderr, "--since %q is not an ISO instant, e.g. 2026-10-24T00:00:00Z\n", sinceText)
		return 2
	}
	r := compare(live, shadow, since)
	printReport(os.Stdout, r)
	// The newest live line makes a stale log visible: the default --since judges the day
	// before it, which may be long gone.
	newestText := "none"
	if len(live) > 0 {
		newestText = epoch.ISO(newest(live))
	}
	fmt.Printf("newest live decision %s, judged since %s\n", newestText, epoch.ISO(since))
	code := exitCode(r)
	if code == 3 {
		fmt.Fprintln(os.Stderr, "nothing to compare: no live decision since --since was paired, so this proves nothing")
	}
	return code
}

func newest(entries []entry) epoch.Millis {
	var at epoch.Millis
	for _, e := range entries {
		at = max(at, e.at)
	}
	return at
}
