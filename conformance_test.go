package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
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
	for _, args := range [][]string{
		{}, {"--exit", "seam"}, {"alpha"}, {"alpha", "--exit", "seam", "--bogus"}, {"alpha", "--exit", "nope"},
		{"nope", "--exit", "seam"}, {"alpha", "--exit", "seam", "--commits", "x"},
		{"alpha", "--exit", "seam", "--pause-until", "2020-01-01T00:00:00Z"}, {"alpha", "--exit", "seam", "--cadence", "soon"},
	} {
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
		if gout != nout || gerr != nerr || gcode != ncode || gcode != 1 {
			t.Errorf("%v: go %d %q %q, node %d %q %q", args, gcode, gout, gerr, ncode, nout, nerr)
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
