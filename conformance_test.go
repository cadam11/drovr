package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"testing"
)

// The Node CLI is the oracle until cut-over: both run on the same DROVR_HOME and must agree.
// Only generatedAt is normalised; every other difference is a port bug.
var generatedAt = regexp.MustCompile(`"generatedAt": "[^"]+"`)

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
	return node, append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"), "DROVR_HOME="+home)
}

func runBoth(t *testing.T, args ...string) (goOut, tsOut string) {
	node, env := oracle(t)
	g := exec.Command("go", append([]string{"run", "."}, args...)...)
	g.Env = env
	gb, err := g.CombinedOutput()
	if err != nil {
		t.Fatalf("go: %v\n%s", err, gb)
	}
	n := exec.Command(node, append([]string{"src/cli.ts"}, args...)...)
	n.Env = env
	nb, err := n.CombinedOutput()
	if err != nil {
		t.Fatalf("node: %v\n%s", err, nb)
	}
	return string(gb), string(nb)
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
