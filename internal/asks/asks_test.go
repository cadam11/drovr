package asks

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
)

func TestSplitPage(t *testing.T) {
	cases := []struct{ in, page, prefix string }{
		{"craig/loop-asks.html", "loop-asks.html", "craig"},
		{"asks.html", "asks.html", ""},
		{"craig/programs/asks.html", "programs/asks.html", "craig"},
	}
	for _, c := range cases {
		page, prefix := SplitPage(c.in)
		got := ""
		if prefix != nil {
			got = *prefix
		}
		if page != c.page || got != c.prefix {
			t.Errorf("%s → %s %s", c.in, page, got)
		}
	}
}

func TestFromNotes(t *testing.T) {
	s := FromNotes([]byte(`{"notes":{"shared":true,"threads":[{"id":"a","resolved":true,"createdAt":"2026-10-22T09:00:00.000Z"},{"id":"b","updatedAt":"2026-10-22T10:00:00.000Z","replies":[{"at":"2026-10-22T11:00:00.000Z"},{"at":"garbage"}]}]}}`))
	if s == nil || !s.Shared || s.OpenThreads != 1 || s.LatestAt == nil || *s.LatestAt != epoch.MustParse("2026-10-22T11:00:00.000Z") {
		t.Fatalf("%+v", s)
	}
	off := FromNotes([]byte(`{"notes":{}}`))
	if off == nil || off.Shared || off.LatestAt != nil || off.OpenThreads != 0 {
		t.Fatalf("notes sharing off reads as unshared and empty: %+v", off)
	}
	for _, bad := range []string{"", "not json", `{"error":{"message":"x"}}`, `{"notes":{"threads":7}}`} {
		if FromNotes([]byte(bad)) != nil {
			t.Errorf("%q read as a state", bad)
		}
	}
}

func dirWith(t *testing.T, name, text string) string {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

func TestReadFile(t *testing.T) {
	dir := dirWith(t, "asks.md", "# Asks\n\n- [ ] Which region?\n  context here\n- [x] Keep the old name?\n- [ ] Ship on Friday?\n- [ ]\n- [ ] \n")
	at := time.Date(2026, 10, 22, 10, 0, 0, 0, time.UTC)
	os.Chtimes(filepath.Join(dir, "asks.md"), at, at)
	s, err := ReadFile(dir, "asks.md")
	if err != nil || s == nil || !s.Shared || s.OpenThreads != 4 || *s.LatestAt != at.UnixMilli() {
		t.Fatalf("%+v %v", s, err)
	}
	done, _ := ReadFile(dirWith(t, "asks.md", "- [X] done\r\n- [x] also done\r\n"), "asks.md")
	if done.OpenThreads != 0 {
		t.Error("answered items are not open")
	}
	if s, err := ReadFile(dir, "missing.md"); s != nil || err != nil {
		t.Errorf("missing: %v %v", s, err)
	}
	if s, err := ReadFile(filepath.Join(dir, "sub"), "../asks.md"); s != nil || err != nil {
		t.Errorf("outside cwd: %v %v", s, err)
	}
	// An absolute asksFile is taken as given, as node's resolve() does, and then guarded.
	if s, err := ReadFile(dir, filepath.Join(dir, "asks.md")); err != nil || s == nil || s.OpenThreads != 4 {
		t.Errorf("absolute inside cwd: %+v %v", s, err)
	}
	outside := dirWith(t, "asks.md", "- [ ] elsewhere\n")
	os.MkdirAll(filepath.Join(dir, outside), 0o755)
	os.WriteFile(filepath.Join(dir, outside, "asks.md"), []byte("- [ ] joined under cwd\n"), 0o644)
	if s, err := ReadFile(dir, filepath.Join(outside, "asks.md")); s != nil || err != nil {
		t.Errorf("absolute outside cwd is refused, never joined under it: %+v %v", s, err)
	}
	os.Chmod(filepath.Join(dir, "asks.md"), 0)
	if _, err := ReadFile(dir, "asks.md"); err == nil {
		t.Error("an unreadable file is an error, not an empty answer")
	}
}

func useShim(t *testing.T) string {
	bin, _ := filepath.Abs("testdata")
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	log := filepath.Join(t.TempDir(), "calls.log")
	t.Setenv("ASKS_LOG", log)
	return log
}

func TestReaderRunsNotesListOncePerTTL(t *testing.T) {
	log := useShim(t)
	t.Setenv("ASKS_STDOUT", `{"notes":{"shared":true,"threads":[]}}`)
	page := "craig/loop-asks.html"
	p := control.Program{Name: "alpha", Cwd: t.TempDir(), Aice: &control.Aice{AsksPage: &page}}
	r := NewReader()
	for _, now := range []epoch.Millis{1000, 30_000} {
		if s, err := r.Read(context.Background(), p, now); err != nil || s == nil || !s.Shared {
			t.Fatalf("%+v %v", s, err)
		}
	}
	raw, _ := os.ReadFile(log)
	if strings.Count(string(raw), "\n") != 1 || !strings.Contains(string(raw), "exec "+p.Cwd+" aice notes list loop-asks.html --prefix craig --json") {
		t.Fatalf("calls:\n%s", raw)
	}
}

func TestNotesFailureIsNoAnswerNotAnError(t *testing.T) {
	useShim(t)
	t.Setenv("ASKS_STDOUT", `{"error":{"message":"page not found"}}`)
	t.Setenv("ASKS_CODE", "1")
	page := "asks.html"
	s, err := NewReader().Read(context.Background(), control.Program{Name: "a", Cwd: t.TempDir(), Aice: &control.Aice{AsksPage: &page}}, 1)
	if s != nil || err != nil {
		t.Fatalf("%+v %v", s, err)
	}
}

func TestNotesCallIsBoundedAndNamed(t *testing.T) {
	useShim(t)
	t.Setenv("ASKS_SLEEP", "5")
	start := time.Now()
	_, err := notesJSON(context.Background(), t.TempDir(), []string{"list", "asks.html"}, 200*time.Millisecond)
	if err == nil || err.Error() != "aice notes list did not return within 0.2s and was killed" {
		t.Fatalf("%v", err)
	}
	if time.Since(start) > 2*time.Second {
		t.Fatal("the bound did not cut the child off")
	}
}

func TestHostedProgramHasNoLocalAsksFile(t *testing.T) {
	file := ".drovr-asks.md"
	dir := dirWith(t, file, "- [ ] x\n")
	p := control.Program{Name: "h", Cwd: dir, AsksFile: &file, Host: &control.Host{Environment: "e", SSH: "u@h", Cwd: "/srv/h"}}
	if s, err := NewReader().Read(context.Background(), p, 1); s != nil || err != nil {
		t.Fatalf("%+v %v", s, err)
	}
}
