package exec

import (
	"go/parser"
	"go/token"
	"io/fs"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// The trap row: one hung child holds the tick lock forever, so the bound is a parameter of
// the only spawn helper rather than per-call-site discipline. This makes the rule a build gate.
func TestOnlyExecSpawns(t *testing.T) {
	root, _ := filepath.Abs("../..")
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(root, path)
		if d.IsDir() && (rel == "internal/exec" || rel == "node_modules" || rel == "testdata" || strings.HasPrefix(rel, ".")) && rel != "." {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, ".go") || strings.HasSuffix(path, "_test.go") {
			return nil
		}
		f, err := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if err != nil {
			return err
		}
		for _, imp := range f.Imports {
			if p, _ := strconv.Unquote(imp.Path.Value); p == "os/exec" {
				t.Errorf("%s imports os/exec; spawn through exec.RunBounded or exec.Detach", rel)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}
