// Package transcript lifts the runner's closing message from claude's own session transcript
// (src/transcript.ts). The agent is told never to recap, and yet every cycle ends with one — so
// rather than ask for it through `drovr report`, drovr reads the last thing claude said. That
// file is claude's, in a format it has not declared, which makes this a scrape: lenient like
// preview, never a failed tick.
package transcript

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/jsnum"
)

// One `cat` over ssh; the file is a few hundred KB at most.
const sshTimeout = 20 * time.Second

// ClosingMaxChars is enough for a full recap; a runner that says more than this is not
// closing, it is working.
const ClosingMaxChars = 4000

var uuidish = regexp.MustCompile(`(?i)^[0-9a-f-]+$`)

type line struct {
	Type    string `json:"type"`
	Message *struct {
		Content []json.RawMessage `json:"content"`
	} `json:"message"`
}

type block struct {
	Type *string         `json:"type"`
	Text json.RawMessage `json:"text"`
}

// lineTexts is the non-blank, trimmed text blocks of one assistant line, or ok=false when the
// line is not one the TS zod shape would have accepted: then the whole line is skipped.
func lineTexts(raw string) (texts []string, ok bool) {
	var l line
	if json.Unmarshal([]byte(raw), &l) != nil || l.Type != "assistant" || l.Message == nil || l.Message.Content == nil {
		return nil, false
	}
	for _, b := range l.Message.Content {
		var blk block
		if json.Unmarshal(b, &blk) != nil || blk.Type == nil {
			return nil, false
		}
		var text string
		if *blk.Type != "text" || json.Unmarshal(blk.Text, &text) != nil {
			continue
		}
		if trimmed := strings.TrimSpace(text); trimmed != "" {
			texts = append(texts, trimmed)
		}
	}
	return texts, true
}

// ClosingFrom is the last non-blank assistant text block, trimmed and cut at ClosingMaxChars
// UTF-16 units; nil when there is none.
func ClosingFrom(jsonl string) *string {
	var closing *string
	for _, raw := range strings.Split(jsonl, "\n") {
		texts, ok := lineTexts(raw)
		if !ok || len(texts) == 0 {
			continue
		}
		last := jsnum.Slice(texts[len(texts)-1], ClosingMaxChars)
		closing = &last
	}
	return closing
}

// ClosingMessage reads the transcript claude keyed by the session id drovr minted, under a
// directory named for the cwd. The cwd slug is claude's to compute, so every project directory
// is searched for the id rather than re-deriving it. Nil when there is no such file yet, or
// when the format has moved on: the ledger loses a recap, nothing else. An error only for a
// hosted session id that is not a UUID, since it would be interpolated into a shell.
func ClosingMessage(ctx context.Context, home, sessionID string, host *control.Host, log io.Writer) (*string, error) {
	if host != nil {
		return remoteClosing(ctx, sessionID, *host, log)
	}
	projects := filepath.Join(home, ".claude", "projects")
	dirs, err := os.ReadDir(projects)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		// swallowed: an unreadable transcript costs the ledger a recap, never the cycle.
		fmt.Fprintf(log, "could not read the transcripts under %s, recording no closing message: %v\n", projects, err)
		return nil, nil
	}
	for _, dir := range dirs {
		path := filepath.Join(projects, dir.Name(), sessionID+".jsonl")
		// existsSync is false on any stat error, not only a missing file.
		if _, err := os.Stat(path); err != nil {
			continue
		}
		body, err := os.ReadFile(path)
		if err != nil {
			// swallowed: an unreadable transcript costs the ledger a recap, never the cycle.
			fmt.Fprintf(log, "could not read the transcript at %s, recording no closing message: %v\n", path, err)
			return nil, nil
		}
		return ClosingFrom(string(body)), nil
	}
	return nil, nil
}

// remoteClosing reads the transcript where it was written: the box's ~/.claude is the box's
// own, searched by the remote shell's glob. A failed read is logged and costs the ledger a
// recap, exactly as an unreadable local file does.
func remoteClosing(ctx context.Context, sessionID string, host control.Host, log io.Writer) (*string, error) {
	if !uuidish.MatchString(sessionID) {
		return nil, fmt.Errorf("session id is not a UUID: %s", sessionID)
	}
	res, err := exec.RunSsh(ctx, host.SSH, "cat ~/.claude/projects/*/"+sessionID+".jsonl", sshTimeout)
	if err != nil {
		// swallowed: an unreadable transcript costs the ledger a recap, never the cycle.
		fmt.Fprintf(log, "could not read the transcript for %s on %s, recording no closing message: %v\n", sessionID, host.SSH, err)
		return nil, nil
	}
	return ClosingFrom(res.Stdout), nil
}
