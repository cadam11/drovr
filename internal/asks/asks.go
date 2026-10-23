// Package asks reads a program's open questions for Craig: threads on its aice asks page, or
// unchecked items in a markdown file in its checkout. It is drovr's only aice caller, and it
// only reads. It backs a liveness heuristic, so it parses leniently: a missing or odd field
// costs a timestamp, never a decision.
package asks

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/exec"
)

// notesTimeout bounds one aice call. readAsks runs inside the tick's per-program loop, so a
// hung aice there holds the tick lock and every later launchd firing logs "another tick is
// still evaluating" while admission silently stops. A notes list is sub-second in practice.
const notesTimeout = 20 * time.Second

// ttl: a watch frame redraws every few seconds and must not shell out per program each time.
const ttl = 60 * time.Second

type State struct {
	// Shared notes must be toggled on by the page owner. When off, the list call succeeds and
	// returns nothing, so unshared and unanswered are different facts and both are kept.
	Shared bool
	// LatestAt is the most recent human activity on the page, nil when there is none.
	LatestAt    *epoch.Millis
	OpenThreads int
}

// SplitPage exists because `notes list` takes a page relative to a prefix, defaulting to the
// caller's own slug: passing "craig/loop-asks.html" whole looks under <yourslug>/craig/... and
// quietly reports an unshared, empty page rather than failing.
func SplitPage(asksPage string) (page string, prefix *string) {
	head, rest, found := strings.Cut(asksPage, "/")
	if !found {
		return asksPage, nil
	}
	return rest, &head
}

// Threads carry a timestamp under one of several names depending on aice's version, so take
// whichever is present rather than guessing one and silently reading nothing.
type thread struct {
	ID        *string `json:"id"`
	Resolved  *bool   `json:"resolved"`
	UpdatedAt *string `json:"updatedAt"`
	CreatedAt *string `json:"createdAt"`
	At        *string `json:"at"`
	Replies   []struct {
		At *string `json:"at"`
	} `json:"replies"`
}

type notesPayload struct {
	Notes *struct {
		Shared  *bool     `json:"shared"`
		Threads *[]thread `json:"threads"`
	} `json:"notes"`
}

// FromNotes reads `aice notes list --json` stdout; nil means it was not a notes payload.
func FromNotes(stdout []byte) *State {
	var p notesPayload
	if json.Unmarshal(stdout, &p) != nil || p.Notes == nil {
		return nil
	}
	s := &State{Shared: p.Notes.Shared != nil && *p.Notes.Shared}
	if p.Notes.Threads == nil {
		return s
	}
	for _, t := range *p.Notes.Threads {
		if t.Resolved == nil || !*t.Resolved {
			s.OpenThreads++
		}
		for _, at := range timestamps(t) {
			if s.LatestAt == nil || at > *s.LatestAt {
				s.LatestAt = &at
			}
		}
	}
	return s
}

func timestamps(t thread) []epoch.Millis {
	raw := []*string{t.UpdatedAt, t.CreatedAt, t.At}
	for _, r := range t.Replies {
		raw = append(raw, r.At)
	}
	var out []epoch.Millis
	for _, s := range raw {
		if s == nil {
			continue
		}
		if ms, ok := epoch.Parse(*s); ok {
			out = append(out, ms)
		}
	}
	return out
}

var (
	openItem = regexp.MustCompile(`^\s*[-*]\s+\[ \](\s|$)`)
	newline  = regexp.MustCompile(`\r?\n`)
)

// ReadFile is the no-aice source: one task item per ask, open while unchecked, and the file's
// mtime as the latest human activity since a person answers by editing it. The guard is
// lexical (symlinks are not resolved): a path outside cwd is not read. Only a missing file is
// "nothing"; any other failure is returned.
func ReadFile(cwd, file string) (*State, error) {
	root := filepath.Clean(cwd)
	path := filepath.Join(root, file)
	if !strings.HasPrefix(path, root+string(filepath.Separator)) {
		return nil, nil
	}
	text, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	open := 0
	for _, line := range newline.Split(string(text), -1) {
		if openItem.MatchString(line) {
			open++
		}
	}
	// Node's mtimeMs keeps sub-millisecond digits Go truncates; it is compared against
	// hour-scale gates.
	at := info.ModTime().UnixMilli()
	return &State{Shared: true, LatestAt: &at, OpenThreads: open}, nil
}

// notesJSON runs through direnv so the install named by the repo's .envrc, and the aice login
// beside it, are the ones used. Sole owner of the argv: the page argument's position differs
// per subcommand and getting it wrong reads as a page with no notes rather than an error.
func notesJSON(ctx context.Context, cwd string, argv []string, timeout time.Duration) (string, error) {
	args := append(append([]string{"exec", cwd, "aice", "notes"}, argv...), "--json")
	r, err := exec.RunBounded(ctx, "direnv", args, exec.Bounds{Timeout: timeout, Cwd: cwd})
	if err == nil {
		return r.Stdout, nil
	}
	if _, ok := errors.AsType[*exec.TimedOut](err); ok {
		return "", fmt.Errorf("aice notes %s did not return within %ss and was killed",
			argv[0], strconv.FormatFloat(timeout.Seconds(), 'f', -1, 64))
	}
	// A failing `aice --json` puts its reason on stdout and leaves stderr to direnv's banner.
	if exit, ok := errors.AsType[*exec.ExitError](err); ok {
		if reason := aiceReason(exit.Stdout); reason != "" {
			return "", fmt.Errorf("aice notes %s failed: %s", argv[0], reason)
		}
	}
	return "", exec.ExplainSpawn("direnv", err)
}

func aiceReason(stdout string) string {
	var e struct {
		Error *struct {
			Message *string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal([]byte(stdout), &e) != nil || e.Error == nil || e.Error.Message == nil {
		return ""
	}
	return *e.Error.Message
}

type entry struct {
	at    epoch.Millis
	state *State
}

type Reader struct {
	mu    sync.Mutex
	cache map[string]entry
}

func NewReader() *Reader { return &Reader{cache: map[string]entry{}} }

// Read caches per program name, nil results included: an unreachable page is asked again
// after the ttl, not on every frame.
func (r *Reader) Read(ctx context.Context, program control.Program, now epoch.Millis) (*State, error) {
	r.mu.Lock()
	cached, ok := r.cache[program.Name]
	r.mu.Unlock()
	if ok && now-cached.at < ttl.Milliseconds() {
		return cached.state, nil
	}
	state, err := readUncached(ctx, program)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	r.cache[program.Name] = entry{at: now, state: state}
	r.mu.Unlock()
	return state, nil
}

func readUncached(ctx context.Context, program control.Program) (*State, error) {
	if program.Aice == nil || program.Aice.AsksPage == nil {
		// The file lives in the runner's checkout, which for a hosted program is on the box.
		if program.AsksFile == nil || program.Host != nil {
			return nil, nil
		}
		return ReadFile(program.Cwd, *program.AsksFile)
	}
	page, prefix := SplitPage(*program.Aice.AsksPage)
	argv := []string{"list", page}
	if prefix != nil {
		argv = append(argv, "--prefix", *prefix)
	}
	stdout, err := notesJSON(ctx, program.Cwd, argv, notesTimeout)
	if err != nil {
		// swallowed: TS .catch(() => null) — an unreachable aice page is "no answer", and
		// decide treats nil as unknown.
		return nil, nil
	}
	return FromNotes([]byte(stdout)), nil
}
