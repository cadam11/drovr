package main

import (
	"bytes"
	"strings"
	"testing"
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
		{name: "registered, unported", args: []string{"start", "x"}, wantErr: "drovr start is not ported to Go yet — run: node src/cli.ts start x"},
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
