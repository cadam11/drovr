package profile

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/orca"
	"github.com/cadam11/drovr/internal/paths"
)

func repo(over string) json.RawMessage {
	base := `{"id":"r1","path":"/Users/cadam/code/x","badgeColor":"#737373","repoIcon":null`
	if over != "" {
		base += "," + over
	}
	return json.RawMessage(base + "}")
}

func patchJSON(p *Patch) string {
	if p == nil {
		return "null"
	}
	b, _ := json.Marshal(p)
	return string(b)
}

func TestFromRepo(t *testing.T) {
	summary := "Ticket loop for sunnyt"
	cases := []struct {
		name string
		repo json.RawMessage
		desc *string
		want string
	}{
		{"emoji and colour", repo(`"repoIcon":{"type":"emoji","emoji":"🦾"}`), nil, `{"icon":"🦾","color":"#737373"}`},
		{"lucide mapped", repo(`"repoIcon":{"type":"lucide","name":"Globe"}`), nil, `{"icon":"sf:globe","color":"#737373"}`},
		{"lucide unmapped", repo(`"repoIcon":{"type":"lucide","name":"Unicorn"}`), nil, `{"color":"#737373"}`},
		{"https image", repo(`"repoIcon":{"type":"image","src":"https://github.com/propra-tech.png?size=64","source":"github"}`), nil, `{"icon":"https://github.com/propra-tech.png?size=64","color":"#737373"}`},
		{"big data url dropped", repo(`"repoIcon":{"type":"image","src":"data:image/png;base64,` + strings.Repeat("A", 40_000) + `"}`), nil, `{"color":"#737373"}`},
		{"description only", repo(`"badgeColor":null`), &summary, `{"summary":"Ticket loop for sunnyt"}`},
		{"nothing at all", repo(`"badgeColor":null`), nil, `null`},
		{"bad colour dropped", repo(`"badgeColor":"purple","repoIcon":{"type":"emoji","emoji":"📣"}`), nil, `{"icon":"📣"}`},
		{"not a repo", json.RawMessage(`{"nonsense":true}`), nil, `null`},
		{"unknown icon type", repo(`"badgeColor":null,"repoIcon":{"type":"hologram","src":"x"}`), nil, `null`},
	}
	for _, c := range cases {
		if got := patchJSON(FromRepo(c.repo, c.desc)); got != c.want {
			t.Errorf("%s: %s", c.name, got)
		}
	}
	for lucide, sf := range LucideToSF {
		if !regexp.MustCompile(`^[a-z0-9.]+$`).MatchString(sf) {
			t.Errorf("%s → %s", lucide, sf)
		}
	}
}

func TestFindRepo(t *testing.T) {
	repos := []json.RawMessage{json.RawMessage(`{"id":"a"}`), json.RawMessage(`{"id":"b","badgeColor":"#8b5cf6"}`)}
	if got := FindRepo(repos, "b"); !strings.Contains(string(got), "#8b5cf6") {
		t.Fatal(string(got))
	}
	if FindRepo(repos, "zzz") != nil || FindRepo([]json.RawMessage{json.RawMessage(`42`), json.RawMessage(`null`)}, "a") != nil {
		t.Fatal("unknown id or malformed entries are nil")
	}
}

func seedInput(t *testing.T, answers map[string]string, call hey.Call) (SeedInput, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	bin, _ := filepath.Abs("../orca/testdata")
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	dir := t.TempDir()
	t.Setenv("ORCA_ANSWERS", dir)
	for name, body := range answers {
		os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644)
	}
	t.Setenv("DROVR_HOME", t.TempDir())
	p := paths.New()
	to := "craig"
	var out, errs bytes.Buffer
	return SeedInput{
		Paths: p, Orca: orca.NewClient(p, &errs), NotifyTo: &to, Out: &out, Err: &errs, Now: 1_761_177_600_000,
		Caller:  func() (hey.Call, error) { return call, nil },
		Program: control.Program{Name: "alpha", Cwd: "/w/alpha"},
	}, &out, &errs
}

var seedAnswers = map[string]string{
	"repo_list.json":     `{"ok":true,"result":{"repos":[{"id":"r1","badgeColor":"#8b5cf6","repoIcon":{"type":"image","src":"https://x.test/a.png?s=1&t=2"}}]}}`,
	"worktree_show.json": `{"ok":true,"result":{"worktree":{"repoId":"r1"}}}`,
}

func TestSeedSendsOnceAndWritesTheMarker(t *testing.T) {
	var sent []string
	call := func(_ context.Context, tool string, args any) (json.RawMessage, error) {
		b, _ := json.Marshal(args)
		sent = append(sent, tool+" "+string(b))
		return json.RawMessage(`{"profile":{"from":"alpha","icon":null,"summary":null,"color":null,"updatedAt":"2026-10-23T00:00:00.000Z"}}`), nil
	}
	in, out, errs := seedInput(t, seedAnswers, call)
	Seed(context.Background(), in)
	Seed(context.Background(), in)
	if len(sent) != 1 || !strings.Contains(sent[0], `"from":"alpha"`) || !strings.Contains(sent[0], `"color":"#8b5cf6"`) {
		t.Fatalf("sent %v; err %s", sent, errs)
	}
	if !strings.Contains(out.String(), "alpha: seeded its hey profile (icon, color). Change it with: hey profile --from alpha …; to seed again: rm ") {
		t.Fatal(out.String())
	}
	marker, _ := os.ReadFile(in.Paths.ProfileSeeded("alpha"))
	if string(marker) != `{"seededAt":"2025-10-23T00:00:00.000Z","patch":{"icon":"https://x.test/a.png?s=1&t=2","color":"#8b5cf6"}}`+"\n" {
		t.Fatal(string(marker))
	}
}

func TestSeedFailureIsALogLineAndNoMarker(t *testing.T) {
	call := func(context.Context, string, any) (json.RawMessage, error) { return nil, errors.New("hey is down") }
	in, _, errs := seedInput(t, seedAnswers, call)
	Seed(context.Background(), in)
	if !strings.Contains(errs.String(), "alpha: could not seed its hey profile (hey is down) — tried again at its next cycle start") {
		t.Fatal(errs.String())
	}
	if _, err := os.Stat(in.Paths.ProfileSeeded("alpha")); err == nil {
		t.Fatal("a failed seed writes no marker")
	}
}

func TestSeedWithNothingToSeedStillMarks(t *testing.T) {
	answers := map[string]string{"repo_list.json": `{"ok":true,"result":{"repos":[]}}`, "worktree_show.json": seedAnswers["worktree_show.json"]}
	in, out, _ := seedInput(t, answers, nil)
	Seed(context.Background(), in)
	if !strings.Contains(out.String(), "alpha: nothing to seed into its hey profile") {
		t.Fatal(out.String())
	}
	marker, _ := os.ReadFile(in.Paths.ProfileSeeded("alpha"))
	if !strings.Contains(string(marker), `"patch":null`) {
		t.Fatal(string(marker))
	}
}

func TestSeedWithoutAHandleDoesNothing(t *testing.T) {
	in, out, errs := seedInput(t, seedAnswers, nil)
	in.NotifyTo = nil
	Seed(context.Background(), in)
	if out.Len()+errs.Len() != 0 {
		t.Fatal(out.String(), errs.String())
	}
}
