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
	for _, f := range []string{"wire.go", "hey_http.go", "config.go", "jsonout.go", "wire_test.go", "hey_http_test.go", "config_test.go"} {
		theirs, err := os.ReadFile(filepath.Join(repo, "cli", "hey", f))
		if err != nil {
			t.Skipf("hey repo not at %s: %v", repo, err)
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
