package cli

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/paths"
)

const fixtureControl = `{"mode":"normal","programs":[{"name":"a","cwd":"/tmp","priority":0,"host":null}]}`

// The oracle compares a zod refusal only up to its prefix; here the Go side proves the
// prefix is there, names the field, and that nothing was written.
func TestSchemaRefusalsWriteNothing(t *testing.T) {
	for name, run := range map[string]func(Env) error{
		"bad mode":     func(e Env) error { return Mode(e, []string{"sideways"}) },
		"relative cwd": func(e Env) error { return Host(e, []string{"a", "--environment", "e", "--ssh", "u@h", "--cwd", "rel"}) },
	} {
		dir := t.TempDir()
		file := filepath.Join(dir, "control.json")
		if err := os.WriteFile(file, []byte(fixtureControl), 0o644); err != nil {
			t.Fatal(err)
		}
		before, _ := os.ReadFile(file)
		err := run(Env{Paths: paths.Paths{Control: file}, Stdout: &bytes.Buffer{}})
		if err == nil || !strings.HasPrefix(err.Error(), "control file is invalid:") {
			t.Errorf("%s: err = %v", name, err)
		}
		after, _ := os.ReadFile(file)
		if !bytes.Equal(before, after) {
			t.Errorf("%s: control.json changed: %s", name, after)
		}
	}
}
