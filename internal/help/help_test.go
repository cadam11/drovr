package help

import (
	"strings"
	"testing"
)

func TestEveryCommandRenders(t *testing.T) {
	if len(Commands) != 24 {
		t.Fatalf("%d commands, want 24", len(Commands))
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

// Columns are measured in characters: a flag with an em dash or an accent is wider in bytes
// than on screen, and byte width pushed every description in the block right.
func TestFlagColumnCountsCharactersNotBytes(t *testing.T) {
	out := RenderCommand(Command{Usage: "drovr x", Summary: "s", Flags: []Flag{{Flag: "--éé", Describes: "a"}, {Flag: "--abc", Describes: "b"}}})
	if !strings.Contains(out, "\n  --éé   a\n  --abc  b\n") {
		t.Fatalf("%q", out)
	}
}
