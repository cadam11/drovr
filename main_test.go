package main

import (
	"bytes"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/help"
)

func TestRun(t *testing.T) {
	cases := []struct {
		name       string
		args       []string
		wantErr    string
		wantOut    string
		wantStderr string
	}{
		{name: "version", args: []string{"version"}, wantOut: "dev\n"},
		{name: "--version", args: []string{"--version"}, wantOut: "dev\n"},
		{name: "no arguments", args: nil, wantOut: "drovr — capacity-aware", wantStderr: "\n"},
		{name: "unregistered", args: []string{"nonsense"}, wantErr: "exit 1", wantOut: "drovr — capacity-aware", wantStderr: "unknown command \"nonsense\"\n\n"},
		{name: "watch refuses a non-integer before touching the terminal", args: []string{"watch", "x"}, wantErr: "the interval is a number of seconds, got \"x\""},
		{name: "tick with a misspelt flag never runs a live tick", args: []string{"tick", "--shadwo"}, wantErr: "tick takes no arguments but --shadow"},
		{name: "unknown topic", args: []string{"help", "nope"}, wantErr: "no command named \"nope\" — run `drovr help` for the list"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			err := run(c.args, &out, &errOut)
			if got := errText(err); got != c.wantErr {
				t.Errorf("error %q, want %q", got, c.wantErr)
			}
			if !strings.HasPrefix(out.String(), c.wantOut) {
				t.Errorf("stdout %q, want prefix %q", out.String(), c.wantOut)
			}
			if errOut.String() != c.wantStderr {
				t.Errorf("stderr %q, want %q", errOut.String(), c.wantStderr)
			}
		})
	}
}

func errText(err error) string {
	if err == nil {
		return ""
	}
	if _, ok := err.(exitOne); ok {
		return "exit 1"
	}
	return err.Error()
}

// Every registry command reaches a handler. A command's own refusal is fine; "not ported" is not.
// An empty DROVR_HOME and HOME keep writes (init) in the temp dir, and an empty PATH means
// teamclaude, orca, launchctl and node cannot be found, so status/tidy/release refuse quickly.
func TestEveryRegistryCommandDispatches(t *testing.T) {
	t.Setenv("DROVR_HOME", t.TempDir())
	t.Setenv("HOME", t.TempDir())
	t.Setenv("PATH", "")
	for _, c := range help.Commands {
		switch c.Name {
		case "watch": // needs a TTY; its refusal path is the "watch x" case in TestRun
			continue
		case "tick": // takes the live tick lock and may admit cycles
			continue
		case "run-cycle": // a worker that watches a cycle for hours
			continue
		}
		t.Run(c.Name, func(t *testing.T) {
			var out, errOut bytes.Buffer
			err := run([]string{c.Name}, &out, &errOut)
			if err != nil && strings.Contains(err.Error(), "not ported") {
				t.Fatalf("%s still falls through: %v", c.Name, err)
			}
		})
	}
}
