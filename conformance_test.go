package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// The Node CLI is the oracle until cut-over: both run on the same DROVR_HOME and must agree.
// Only generatedAt is normalised; every other difference is a port bug.
var generatedAt = regexp.MustCompile(`"generatedAt": "[^"]+"`)

// goBin is built once with the caller's own environment: the fixture moves HOME, and a
// `go run` under it would look for its build cache and module cache in testdata.
var goBin string

func TestMain(m *testing.M) {
	dir, err := os.MkdirTemp("", "drovr-conformance")
	if err != nil {
		panic(err)
	}
	goBin = filepath.Join(dir, "drovr")
	out, err := exec.Command("go", "build", "-o", goBin, ".").CombinedOutput()
	if err != nil {
		os.RemoveAll(dir)
		panic(fmt.Sprintf("go build: %v\n%s", err, out))
	}
	code := m.Run()
	os.RemoveAll(dir)
	os.Exit(code)
}

// oracle points both CLIs at the fixture alone: HOME (the launchd plist), DROVR_HOME, and
// shims for teamclaude, launchctl and orca ahead of the real PATH, so node still resolves.
func oracle(t *testing.T) (node string, env []string) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	if _, err := os.Stat("src/cli.ts"); err != nil {
		t.Skip("TS tree absent")
	}
	bin, _ := filepath.Abs("testdata/bin")
	home, _ := filepath.Abs("testdata/home")
	return node, append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "DROVR_HOME="+home, "HOME="+home)
}

// runBoth compares stdout and the exit code only: stderr carries notes only the Go build
// prints (a launchd agent naming another binary), which are not part of the port target.
func runBoth(t *testing.T, args ...string) (goOut, tsOut string) {
	node, env := oracle(t)
	g := exec.Command(goBin, args...)
	g.Env = env
	gb, gerr, gcode := runCaptured(g)
	n := exec.Command(node, append([]string{"src/cli.ts"}, args...)...)
	n.Env = env
	nb, nerr, ncode := runCaptured(n)
	if gcode != 0 || ncode != 0 {
		t.Fatalf("exit codes go %d node %d\n--- go stderr\n%s\n--- node stderr\n%s", gcode, ncode, gerr, nerr)
	}
	return gb, nb
}

func runCaptured(cmd *exec.Cmd) (stdout, stderr string, code int) {
	var errBuf strings.Builder
	cmd.Stderr = &errBuf
	out, err := cmd.Output()
	var ee *exec.ExitError
	switch {
	case errors.As(err, &ee):
		code = ee.ExitCode()
	case err != nil:
		code = -1
		errBuf.WriteString(err.Error())
	}
	return string(out), errBuf.String(), code
}

func TestStatusJSONMatchesOracle(t *testing.T) {
	g, n := runBoth(t, "status", "--json")
	g, n = generatedAt.ReplaceAllString(g, ""), generatedAt.ReplaceAllString(n, "")
	if g != n {
		t.Fatalf("status --json differs\n--- go\n%s\n--- node\n%s", g, n)
	}
}

// The "Last tick completed …m ago" line ticks over once a minute; a failure on a minute
// boundary is a rerun, never a normalisation — that line is a port target.
func TestStatusTextMatchesOracle(t *testing.T) {
	g, n := runBoth(t, "status")
	if g != n {
		t.Fatalf("status differs\n--- go\n%s\n--- node\n%s", g, n)
	}
}

func TestHelpMatchesOracle(t *testing.T) {
	for _, args := range [][]string{{"help", "--json"}, {"help"}, {"help", "status"}, {"status", "--help", "--json"}} {
		g, n := runBoth(t, args...)
		if g != n {
			t.Fatalf("%v differs\n--- go\n%s\n--- node\n%s", args, g, n)
		}
	}
}

func TestServiceStatusJSONMatchesOracle(t *testing.T) {
	g, n := runBoth(t, "service", "status", "--json")
	if g != n {
		t.Fatalf("service status --json differs\n--- go\n%s\n--- node\n%s", g, n)
	}
}

// ProgramArguments is the one intended difference: the Go plist names the binary itself,
// the Node one names node plus a script. Everything around it is a port target.
var programArguments = regexp.MustCompile(`(?s)<key>ProgramArguments</key>\s*<array>.*?</array>`)

func TestServicePrintMatchesOracleButItsArgv(t *testing.T) {
	for _, args := range [][]string{{"service", "print"}, {"service", "print", "900"}} {
		g, n := runBoth(t, args...)
		g, n = programArguments.ReplaceAllString(g, "ARGV"), programArguments.ReplaceAllString(n, "ARGV")
		if g != n || !strings.Contains(g, "ARGV") {
			t.Fatalf("%v differs\n--- go\n%s\n--- node\n%s", args, g, n)
		}
	}
}

// report is the loop agent's last act, and its refusals are what the agent reads to fix
// the call, so every one is the TS text — except a shape refusal, where zod dumps its issue
// array and the shape package writes one line; those agree up to the colon.
func TestReportRefusalsMatchOracle(t *testing.T) {
	node, env := oracle(t)
	src, err := os.ReadFile("testdata/home/control.json")
	if err != nil {
		t.Fatal(err)
	}
	refusals := [][]string{
		{}, {"--exit", "seam"}, {"alpha"}, {"alpha", "--exit", "seam", "--bogus"}, {"alpha", "--exit", "nope"},
		{"nope", "--exit", "seam"}, {"alpha", "--exit", "seam", "--commits", "x"}, {"alpha", "--exit", "seam", "--commits"},
		{"alpha", "--exit", "seam", "--pause-until", "2020-01-01T00:00:00Z"}, {"alpha", "--exit", "seam", "--cadence", "soon"},
	}
	// A trailing string flag reads as absent in the TS, so these report rather than refuse.
	trailing := [][]string{{"alpha", "--exit", "seam", "--pause-until"}, {"alpha", "--exit", "seam", "--cadence"}}
	for i, args := range append(refusals, trailing...) {
		wantCode := 1
		if i >= len(refusals) {
			wantCode = 0
		}
		home := t.TempDir()
		if err := os.WriteFile(filepath.Join(home, "control.json"), src, 0o644); err != nil {
			t.Fatal(err)
		}
		e := append(env, "DROVR_HOME="+home)
		argv := append([]string{"report"}, args...)
		g := exec.Command(goBin, argv...)
		g.Env = e
		gout, gerr, gcode := runCaptured(g)
		n := exec.Command(node, append([]string{"src/cli.ts"}, argv...)...)
		n.Env = e
		nout, nerr, ncode := runCaptured(n)
		if shapeRefusal := "the given report is not a valid cycle report: "; strings.HasPrefix(nerr, shapeRefusal) && strings.HasPrefix(gerr, shapeRefusal) {
			gerr, nerr = shapeRefusal, shapeRefusal
		}
		if gout != nout || gerr != nerr || gcode != ncode || gcode != wantCode {
			t.Errorf("%v: go %d %q %q, node %d %q %q", args, gcode, gout, gerr, ncode, nout, nerr)
		}
	}
}

var (
	isoInstant = regexp.MustCompile(`\d{4}-\d\d-\d\dT[\d:.]+Z`)
	zodPrefix  = "control file is invalid:"
)

type writerRun struct {
	out, err, file string
	code           int
}

// runWriter runs one CLI on its own temp home, so Go and Node never see each other's writes,
// and returns its output with that home's path replaced by $H.
func runWriter(t *testing.T, name string, argv, env []string, seed []byte, twice bool) writerRun {
	home := t.TempDir()
	if seed != nil {
		if err := os.WriteFile(filepath.Join(home, "control.json"), seed, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	e := append(env, "DROVR_HOME="+home, "HOME="+home)
	for i := range argv {
		argv[i] = strings.ReplaceAll(argv[i], "{tmp}", home)
	}
	var r writerRun
	runs := 1
	if twice {
		runs = 2
	}
	for range runs {
		c := exec.Command(name, argv...)
		if name != goBin {
			c = exec.Command(name, append([]string{"src/cli.ts"}, argv...)...)
		}
		c.Env = e
		r.out, r.err, r.code = runCaptured(c)
	}
	file, _ := os.ReadFile(filepath.Join(home, "control.json"))
	r.file = string(file)
	for _, s := range []*string{&r.out, &r.err, &r.file} {
		*s = isoInstant.ReplaceAllString(strings.ReplaceAll(*s, home, "$H"), "<iso>")
	}
	// Rule "prefix": zod's issue JSON differs from the Go schema's one-liner; compare up to the prefix.
	if i := strings.Index(r.err, zodPrefix); i >= 0 {
		r.err = r.err[:i+len(zodPrefix)]
	}
	return r
}

// Every write runs on a fresh copy of the fixture. Comparison is exact on stdout, stderr, exit
// code and the resulting control.json bytes, with two rules: zod messages compare up to
// "control file is invalid:" ("prefix"), and pause's ISO instant is masked ("mask").
func TestControlWritersMatchOracle(t *testing.T) {
	node, env := oracle(t)
	seed, err := os.ReadFile("testdata/home/control.json")
	if err != nil {
		t.Fatal(err)
	}
	away := []byte(strings.Replace(string(seed), `"mode": "normal"`, `"mode": "off"`, 1))
	cases := [][]string{
		{"add", "delta", "{tmp}", "--priority", "2"}, {"add", "delta", "{tmp}", "--priority"},
		{"add", "delta", "{tmp}", "--priority", "abc"}, {"add", "delta", "{tmp}", "--no-aice", "--model", "m", "--no-direnv", "--deadline", "2026-12-01"},
		{"add", "delta", "{tmp}", "--asks", "p/asks", "--asks-file", "a.md"}, {"add", "delta", "/nope/nope"},
		{"add", "alpha", "{tmp}"}, {"add"}, {"add", "x"},
		{"host", "beta", "--clear"}, {"host", "alpha", "--clear"}, {"host", "beta", "--environment", "e", "--ssh", "u@h", "--cwd", "/x"},
		{"host", "beta", "--environment", "e", "--ssh", "u@h", "--cwd", "/x", "--drovr-home", "/d", "--claude", "/c", "--wake", "w"},
		{"host", "beta", "--ssh", "u@h"}, {"host", "beta", "--environment", "e", "--ssh", "--cwd", "/x"},
		{"host", "beta", "--environment", "e", "--ssh", "u@h", "--cwd", "rel"}, {"host", "nope", "--clear"}, {"host"}, {"host", "--clear"},
		{"rm", "gamma"}, {"rm", "nope"}, {"rm"},
		{"cap"}, {"cap", "12abc"}, {"cap", "-3"}, {"cap", "alpha"}, {"cap", "alpha", "3"}, {"cap", "alpha", "7.9"},
		{"cap", "alpha", "global"}, {"cap", "alpha", "x"}, {"cap", "nope", "3"}, {"cap", "--json"},
		{"mode", "away"}, {"mode", "sideways"}, {"mode"},
		{"pause", "2h"}, {"pause", "alpha", "30m"}, {"pause"}, {"pause", "0h"}, {"pause", "abc"}, {"pause", "alpha"},
		{"pause", "nope", "xyz"}, {"pause", "nope", "1h"},
		{"resume"}, {"resume", "beta"}, {"resume", "nope"}, {"resume", "--json"},
		{"cadence"}, {"cadence", "alpha", "6h"}, {"cadence", "alpha", "off"}, {"cadence", "alpha", "soon"},
		{"cadence", "alpha"}, {"cadence", "nope", "6h"},
		{"reserve"}, {"reserve", "60"}, {"reserve", "45%"}, {"reserve", "0"}, {"reserve", "abc"}, {"reserve", "--json"},
	}
	for _, argv := range cases {
		g := runWriter(t, goBin, slices.Clone(argv), env, seed, false)
		n := runWriter(t, node, slices.Clone(argv), env, seed, false)
		if g != n {
			t.Errorf("%v:\n go   %+v\n node %+v", argv, g, n)
		}
	}
	for _, argv := range [][]string{{"reserve", "60"}, {"reserve"}} {
		if g, n := runWriter(t, goBin, slices.Clone(argv), env, away, false), runWriter(t, node, slices.Clone(argv), env, away, false); g != n {
			t.Errorf("%v in mode off:\n go   %+v\n node %+v", argv, g, n)
		}
	}
	// init runs on an empty home, then again for the "already exists" line.
	for _, twice := range []bool{false, true} {
		if g, n := runWriter(t, goBin, []string{"init"}, env, nil, twice), runWriter(t, node, []string{"init"}, env, nil, twice); g != n {
			t.Errorf("init twice=%v:\n go   %+v\n node %+v", twice, g, n)
		}
	}
}

func TestShadowTickThroughTheBinary(t *testing.T) {
	home := t.TempDir()
	src, err := os.ReadFile("testdata/home/control.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "control.json"), src, 0o644); err != nil {
		t.Fatal(err)
	}
	bin, _ := filepath.Abs("testdata/bin")
	cmd := exec.Command(goBin, "tick", "--shadow")
	cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "DROVR_HOME="+home, "HOME="+t.TempDir())
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
	lines, _ := os.ReadFile(filepath.Join(home, "decisions-shadow.jsonl"))
	if strings.Count(string(lines), "\n") != 2 || !regexp.MustCompile(`(?m)^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z alpha: `).Match(out) {
		t.Fatalf("decisions:\n%s\noutput:\n%s", lines, out)
	}
	for _, f := range []string{"decisions.jsonl", "last-tick.json", "usage.jsonl", "cycles.jsonl", "launched"} {
		if _, err := os.Stat(filepath.Join(home, f)); err == nil {
			t.Errorf("shadow wrote %s", f)
		}
	}
}

// readerHome is a temp copy of the fixture home for the read-only commands. usageLines picks
// the usage.jsonl it carries: -1 none (the fixture ships one), 0 all of it, n the first n samples.
func readerHome(t *testing.T, usageLines int, mode string) string {
	home := t.TempDir()
	for _, f := range []string{"control.json", "cycles.jsonl", "usage.jsonl"} {
		b, err := os.ReadFile(filepath.Join("testdata/home", f))
		if err != nil {
			t.Fatal(err)
		}
		if f == "control.json" && mode != "" {
			b = []byte(strings.Replace(string(b), `"mode": "normal"`, `"mode": "`+mode+`"`, 1))
		}
		if f == "usage.jsonl" && usageLines < 0 {
			continue
		}
		if f == "usage.jsonl" && usageLines > 0 {
			b = []byte(strings.Join(strings.SplitAfter(string(b), "\n")[:usageLines], ""))
		}
		if err := os.WriteFile(filepath.Join(home, f), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return home
}

// The readers print what is in the ledger and the usage log, so every byte is compared.
func TestReadersMatchOracle(t *testing.T) {
	node, env := oracle(t)
	cases := []struct {
		usageLines int
		mode       string // "" keeps the fixture's normal
		argv       []string
	}{
		{-1, "", []string{"ledger"}}, {-1, "", []string{"ledger", "alpha", "2"}}, {-1, "", []string{"ledger", "0"}},
		{-1, "", []string{"ledger", "--last"}}, {-1, "", []string{"ledger", "--json"}}, {-1, "", []string{"ledger", "--json", "--last"}},
		{-1, "", []string{"ledger", "nope", "--json"}}, {-1, "", []string{"ledger", "--closing"}}, {-1, "", []string{"ledger", "--closing", "--json"}},
		{-1, "", []string{"ledger", "nope"}}, {-1, "", []string{"ledger", "-5", "3"}},
		{-1, "", []string{"usage"}}, {-1, "", []string{"usage", "--json"}},
		{0, "", []string{"usage"}}, {0, "", []string{"usage", "--json"}},
		{10, "", []string{"usage"}}, {10, "", []string{"usage", "--json"}},
		{-1, "", []string{"tidy"}},
		// away holds a 15% reserve under the 43% p90: the "Widen it" branch; off holds none.
		{0, "away", []string{"usage"}}, {0, "off", []string{"usage"}}, {0, "off", []string{"usage", "--json"}},
	}
	for _, c := range cases {
		run := func(name string) writerRun {
			home := readerHome(t, c.usageLines, c.mode)
			cmd := exec.Command(name, slices.Clone(c.argv)...)
			if name != goBin {
				cmd = exec.Command(name, append([]string{"src/cli.ts"}, c.argv...)...)
			}
			cmd.Env = append(slices.Clone(env), "DROVR_HOME="+home, "HOME="+home)
			var r writerRun
			r.out, r.err, r.code = runCaptured(cmd)
			r.out, r.err = strings.ReplaceAll(r.out, home, "$H"), strings.ReplaceAll(r.err, home, "$H")
			return r
		}
		if g, n := run(goBin), run(node); g != n {
			t.Errorf("%d %v:\n go   %+v\n node %+v", c.usageLines, c.argv, g, n)
		}
	}
}

// A ceilings map without the current mode reads as no reserve in the TS (`ceilings[mode] ??
// null`), not as an error.
func TestUsageWithoutACeilingMatchesOracle(t *testing.T) {
	node, env := oracle(t)
	for _, argv := range [][]string{{"usage"}, {"usage", "--json"}} {
		run := func(name string) writerRun {
			home := readerHome(t, 0, "")
			ctl := filepath.Join(home, "control.json")
			b, err := os.ReadFile(ctl)
			if err != nil {
				t.Fatal(err)
			}
			b = []byte(strings.Replace(string(b), `"mode": "normal"`, `"mode": "normal", "ceilings": {"low": {"weekly": 0.25, "session": 0.25}}`, 1))
			if err := os.WriteFile(ctl, b, 0o644); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(name, argv...)
			if name != goBin {
				cmd = exec.Command(name, append([]string{"src/cli.ts"}, argv...)...)
			}
			cmd.Env = append(slices.Clone(env), "DROVR_HOME="+home, "HOME="+home)
			var r writerRun
			r.out, r.err, r.code = runCaptured(cmd)
			r.out, r.err = strings.ReplaceAll(r.out, home, "$H"), strings.ReplaceAll(r.err, home, "$H")
			return r
		}
		g, n := run(goBin), run(node)
		if g != n || g.code != 0 {
			t.Errorf("%v:\n go   %+v\n node %+v", argv, g, n)
		}
	}
}

// start detaches a real worker, so both runs get a PATH with no orca, teamclaude or direnv and
// an empty home: the worker dies on its first call. The two spawn different argv and pids, so
// start alpha is compared with the pid masked and the log path home-normalised only.
func TestStartAndReleaseMatchOracle(t *testing.T) {
	node, env := oracle(t)
	pid := regexp.MustCompile(`pid \d+`)
	cases := [][]string{
		{"start"}, {"start", "nope"}, {"start", "alpha"},
		{"release"}, {"release", "nope"}, {"release", "alpha"},
	}
	for _, argv := range cases {
		run := func(name string) writerRun {
			home := readerHome(t, -1, "")
			if err := os.MkdirAll(filepath.Join(home, "logs"), 0o755); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(name, slices.Clone(argv)...)
			if name != goBin {
				cmd = exec.Command(name, append([]string{"src/cli.ts"}, argv...)...)
			}
			cmd.Env = append(slices.Clone(env), "DROVR_HOME="+home, "HOME="+home, "PATH=/usr/bin:/bin")
			var r writerRun
			r.out, r.err, r.code = runCaptured(cmd)
			r.out, r.err = strings.ReplaceAll(r.out, home, "$H"), strings.ReplaceAll(r.err, home, "$H")
			r.out = pid.ReplaceAllString(r.out, "pid N")
			return r
		}
		if g, n := run(goBin), run(node); g != n {
			t.Errorf("%v:\n go   %+v\n node %+v", argv, g, n)
		}
	}
}
