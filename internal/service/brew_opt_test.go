package service

import (
	"os"
	"path/filepath"
	"testing"
)

// kegTree builds <prefix>/Cellar/drovr/<version>/bin/drovr as a real file and returns the
// prefix and the binary's resolved path.
func kegTree(t *testing.T, version string) (string, string) {
	t.Helper()
	prefix, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(prefix, "Cellar", "drovr", version, "bin", "drovr")
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, []byte("x"), 0o755); err != nil {
		t.Fatal(err)
	}
	return prefix, bin
}

func linkOpt(t *testing.T, prefix, version string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(prefix, "opt"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join("..", "Cellar", "drovr", version), filepath.Join(prefix, "opt", "drovr")); err != nil {
		t.Fatal(err)
	}
}

func TestPreferBrewOptPinsTheOptLinkOfTheCurrentKeg(t *testing.T) {
	prefix, bin := kegTree(t, "0.2.0")
	linkOpt(t, prefix, "0.2.0")
	if got, want := preferBrewOpt(bin), filepath.Join(prefix, "opt", "drovr", "bin", "drovr"); got != want {
		t.Fatalf("got %s, want %s", got, want)
	}
}

func TestPreferBrewOptKeepsTheKegWithoutAnOptLink(t *testing.T) {
	_, bin := kegTree(t, "0.2.0")
	if got := preferBrewOpt(bin); got != bin {
		t.Fatalf("got %s, want %s", got, bin)
	}
}

func TestPreferBrewOptLeavesANonBrewPathAlone(t *testing.T) {
	for _, p := range []string{"/usr/local/bin/drovr", "/Users/x/.local/bin/drovr-go", "/drovr"} {
		if got := preferBrewOpt(p); got != p {
			t.Fatalf("got %s, want %s", got, p)
		}
	}
}

func TestPreferBrewOptKeepsTheKegWhenOptFollowsAnother(t *testing.T) {
	prefix, bin := kegTree(t, "0.2.0")
	if err := os.MkdirAll(filepath.Join(prefix, "Cellar", "drovr", "0.3.0", "bin"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prefix, "Cellar", "drovr", "0.3.0", "bin", "drovr"), []byte("y"), 0o755); err != nil {
		t.Fatal(err)
	}
	linkOpt(t, prefix, "0.3.0")
	if got := preferBrewOpt(bin); got != bin {
		t.Fatalf("got %s, want %s", got, bin)
	}
}

func TestBinaryMismatchAcceptsAnOptPathOnBothSides(t *testing.T) {
	opt := "/opt/homebrew/opt/drovr/bin/drovr"
	path := filepath.Join(t.TempDir(), "x.plist")
	plist := Plist(PlistInput{Label: Label, Binary: opt, Args: []string{"tick"}, LogName: "tick", IntervalSeconds: 600, LogDir: "/tmp", Path: "/usr/bin"})
	if err := os.WriteFile(path, []byte(plist), 0o644); err != nil {
		t.Fatal(err)
	}
	if note, differs := BinaryMismatch(path, opt); differs {
		t.Fatalf("an opt-path plist against an opt-path binary is not a move: %q", note)
	}
}
