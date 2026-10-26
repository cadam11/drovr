package scripts_test

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// release runs the local half of release.sh into a fresh DIST and returns it.
func release(t *testing.T) string {
	t.Helper()
	dist := t.TempDir()
	cmd := exec.Command("sh", "scripts/release.sh")
	cmd.Dir = ".."
	cmd.Env = append(os.Environ(), "DIST="+dist)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("release.sh: %v\n%s", err, out)
	}
	return dist
}

func TestReleaseScriptIsDeterministic(t *testing.T) {
	versionBytes, err := os.ReadFile("../VERSION")
	if err != nil {
		t.Fatal(err)
	}
	version := strings.TrimSpace(string(versionBytes))
	a, b := release(t), release(t)

	tarA, err := os.ReadFile(filepath.Join(a, "cli", "drovr_darwin_arm64.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	tarB, err := os.ReadFile(filepath.Join(b, "cli", "drovr_darwin_arm64.tar.gz"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(tarA, tarB) {
		t.Fatal("two builds produced different tarballs")
	}

	sha := fmt.Sprintf("%x", sha256.Sum256(tarA))
	sums, err := os.ReadFile(filepath.Join(a, "cli", "sha256sums.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if want := sha + "  drovr_darwin_arm64.tar.gz\n"; string(sums) != want {
		t.Fatalf("sha256sums.txt = %q, want %q", sums, want)
	}

	formula, err := os.ReadFile(filepath.Join(a, "tap", "Formula", "drovr.rb"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`sha256 "` + sha + `"`, `version "` + version + `"`} {
		if !strings.Contains(string(formula), want) {
			t.Fatalf("formula lacks %s", want)
		}
	}
	if strings.Contains(string(formula), "__") {
		t.Fatal("formula has an unsubstituted placeholder")
	}

	extract := t.TempDir()
	tarPath := filepath.Join(a, "cli", "drovr_darwin_arm64.tar.gz")
	list, err := exec.Command("tar", "-tzf", tarPath).Output()
	if err != nil {
		t.Fatal(err)
	}
	if strings.TrimSpace(string(list)) != "drovr" {
		t.Fatalf("tar lists %q, want only drovr", list)
	}
	if err := exec.Command("tar", "-xzf", tarPath, "-C", extract).Run(); err != nil {
		t.Fatal(err)
	}
	// The darwin binary only runs on a darwin/arm64 host.
	if out, err := exec.Command(filepath.Join(extract, "drovr"), "version").Output(); err == nil {
		if strings.TrimSpace(string(out)) != version {
			t.Fatalf("drovr version = %q, want %q", out, version)
		}
	}
}
