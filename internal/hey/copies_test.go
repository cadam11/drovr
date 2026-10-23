package hey

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The hey repo owns these files. A drift is fixed there and copied here, never edited here.
// The only normalisation is the package clause: the copies live in package hey, not main.
func TestCopiesMatchTheHeyRepo(t *testing.T) {
	repo := os.Getenv("HEY_REPO")
	if repo == "" {
		home, _ := os.UserHomeDir()
		repo = filepath.Join(home, "code", "hey")
	}
	dir := filepath.Join(repo, "cli", "hey")
	if _, err := os.Stat(dir); err != nil {
		t.Skipf("hey repo not at %s: %v", repo, err)
	}
	// A missing file inside a present repo is a drift, not an absent repo.
	for _, f := range []string{"wire.go", "hey_http.go", "config.go", "jsonout.go", "wire_test.go", "hey_http_test.go", "config_test.go"} {
		theirs, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			t.Errorf("%s: %v", f, err)
			continue
		}
		ours, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Replace(string(theirs), "package main\n", "package hey\n", 1) != string(ours) {
			t.Errorf("%s differs from %s — re-copy it (plan E2 Task 6 Step 1)", f, repo)
		}
	}
}
