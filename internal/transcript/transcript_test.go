package transcript

import (
	"bytes"
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
)

func assistant(blocks string) string {
	return `{"type":"assistant","message":{"role":"assistant","content":[` + blocks + `]}}`
}

func TestClosingFrom(t *testing.T) {
	jsonl := strings.Join([]string{
		`{"type":"user","message":{"content":"go"}}`,
		assistant(`{"type":"text","text":"first turn"}`),
		assistant(`{"type":"tool_use","name":"Bash","input":{}}`),
		assistant(`{"type":"text","text":"Cycle 5 closed at a clean seam."}`),
		`{"type":"user","message":{"content":[{"type":"tool_result"}]}}`,
		`{"type":"summary","summary":"x"}`,
	}, "\n")
	if got := ClosingFrom(jsonl); got == nil || *got != "Cycle 5 closed at a clean seam." {
		t.Fatalf("%v", got)
	}
	for _, none := range []string{"", assistant(`{"type":"tool_use","name":"Bash","input":{}}`), assistant(`{"type":"text","text":"   "}`)} {
		if ClosingFrom(none) != nil {
			t.Errorf("%q has no closing", none)
		}
	}
	if got := ClosingFrom(assistant(`{"type":"text","text":"kept"}`) + "\nnot json\n{\"type\":\"assistant\",\"message\":7}"); got == nil || *got != "kept" {
		t.Fatal("a scrape skips what it cannot read")
	}
	if got := ClosingFrom(assistant(`{"type":"text","text":"` + strings.Repeat("x", ClosingMaxChars+500) + `"}`)); len(*got) != ClosingMaxChars {
		t.Fatal("capped")
	}
}

func TestClosingMessageSearchesEveryProject(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, ".claude", "projects", "-Users-x-code-alpha")
	os.MkdirAll(dir, 0o755)
	id := "6f1c2a7e-3b0d-4c55-9e2a-1d9f0b7c8e41"
	os.WriteFile(filepath.Join(dir, id+".jsonl"), []byte(assistant(`{"type":"text","text":"done"}`)), 0o644)
	var log bytes.Buffer
	if got, err := ClosingMessage(context.Background(), home, id, nil, &log); err != nil || got == nil || *got != "done" {
		t.Fatalf("%v %v", got, err)
	}
	if got, err := ClosingMessage(context.Background(), t.TempDir(), id, nil, &log); err != nil || got != nil {
		t.Fatal("no projects directory is no closing")
	}
	if _, err := ClosingMessage(context.Background(), home, "x; rm -rf ~", &control.Host{SSH: "u@box"}, &log); err == nil || !strings.Contains(err.Error(), "session id is not a UUID") {
		t.Fatalf("%v", err)
	}
}

func useSSH(t *testing.T, stdout, code string) string {
	bin, _ := filepath.Abs("testdata")
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	log := filepath.Join(t.TempDir(), "calls.log")
	t.Setenv("SSH_LOG", log)
	t.Setenv("SSH_STDOUT", stdout)
	t.Setenv("SSH_CODE", code)
	return log
}

func TestClosingMessageHostedReadsOverSSH(t *testing.T) {
	id := "6f1c2a7e-3b0d-4c55-9e2a-1d9f0b7c8e41"
	host := &control.Host{SSH: "u@box"}
	calls := useSSH(t, assistant(`{"type":"text","text":"remote done"}`), "0")
	var log bytes.Buffer
	if got, err := ClosingMessage(context.Background(), t.TempDir(), id, host, &log); err != nil || got == nil || *got != "remote done" {
		t.Fatalf("%v %v", got, err)
	}
	raw, _ := os.ReadFile(calls)
	if !strings.Contains(string(raw), "u@box cat ~/.claude/projects/*/"+id+".jsonl") {
		t.Fatalf("calls: %s", raw)
	}
	useSSH(t, "", "1")
	if got, err := ClosingMessage(context.Background(), t.TempDir(), id, host, &log); err != nil || got != nil {
		t.Fatalf("a failed read is no closing: %v %v", got, err)
	}
	if !strings.Contains(log.String(), "could not read the transcript for "+id+" on u@box, recording no closing message: ") {
		t.Fatalf("log: %s", log.String())
	}
}

func TestClosingMessageUnreadableIsLoggedAndNil(t *testing.T) {
	home := t.TempDir()
	id := "6f1c2a7e-3b0d-4c55-9e2a-1d9f0b7c8e41"
	path := filepath.Join(home, ".claude", "projects", "p", id+".jsonl")
	os.MkdirAll(path, 0o755) // a directory where the file should be: exists, unreadable as a file
	var log bytes.Buffer
	if got, err := ClosingMessage(context.Background(), home, id, nil, &log); err != nil || got != nil {
		t.Fatalf("%v %v", got, err)
	}
	if !strings.Contains(log.String(), "could not read the transcript at "+path+", recording no closing message: ") {
		t.Fatalf("log: %s", log.String())
	}
}
