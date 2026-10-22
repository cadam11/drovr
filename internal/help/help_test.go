package help

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os/exec"
	"strings"
	"testing"
)

func TestEveryCommandRenders(t *testing.T) {
	if len(Commands) != 23 {
		t.Fatalf("%d commands, the TS registry has 23", len(Commands))
	}
	for _, c := range Commands {
		out := RenderCommand(c)
		if !strings.HasPrefix(out, c.Usage+"\n\n  "+c.Summary) || !strings.Contains(out, "\nWrites: ") {
			t.Errorf("%s renders badly:\n%s", c.Name, out)
		}
	}
	if _, ok := Find("add"); !ok {
		t.Fatal("add missing")
	}
}

func TestListMatchesOracle(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	want, err := exec.Command(node, "../../src/cli.ts", "help").Output()
	if err != nil {
		t.Skip("TS tree absent")
	}
	if got := RenderList() + "\n"; got != string(want) {
		t.Fatalf("list differs from the Node CLI:\n%s", diffLines(got, string(want)))
	}
}

// TestTreeMatchesOracle guards the per-literal key order (add, host and report put flags first).
func TestTreeMatchesOracle(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	want, err := exec.Command(node, "../../src/cli.ts", "help", "--json").Output()
	if err != nil {
		t.Skip("TS tree absent")
	}
	var got bytes.Buffer
	enc := json.NewEncoder(&got)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(TreeOf()); err != nil {
		t.Fatal(err)
	}
	if got.String() != string(want) {
		t.Fatalf("tree differs from the Node CLI:\n%s", diffLines(got.String(), string(want)))
	}
}

// diffLines names the first line where the two texts part, which is all a mismatch needs to be fixed.
func diffLines(got, want string) string {
	g, w := strings.Split(got, "\n"), strings.Split(want, "\n")
	for i := 0; i < len(g) && i < len(w); i++ {
		if g[i] != w[i] {
			return fmt.Sprintf("line %d\n go: %q\nnode: %q", i+1, g[i], w[i])
		}
	}
	return fmt.Sprintf("lengths differ: go %d lines, node %d", len(g), len(w))
}
