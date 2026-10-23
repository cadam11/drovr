package orca

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"strings"
)

var safeWord = regexp.MustCompile(`^[A-Za-z0-9_\-./=:@%+,]+$`)

// shellWord leaves a leading `~/` bare so the shell running the word expands it: a host's
// home is the one path drovr cannot resolve from here.
func shellWord(arg string) string {
	if safeWord.MatchString(arg) {
		return arg
	}
	if rest, ok := strings.CutPrefix(arg, "~/"); ok {
		return "~/" + shellWord(rest)
	}
	return "'" + strings.ReplaceAll(arg, "'", `'\''`) + "'"
}

// ShellCommand quotes for a shell, because `terminal create --command` hands it the text.
func ShellCommand(argv []string) string {
	words := make([]string, len(argv))
	for i, a := range argv {
		words[i] = shellWord(a)
	}
	return strings.Join(words, " ")
}

// EnvArgs addresses a paired remote runtime on every call: a handle issued there answers
// `terminal_handle_stale` to a call without it (measured 2026-10-15). Empty is this Mac.
func EnvArgs(environment string) []string {
	if environment == "" {
		return nil
	}
	return []string{"--environment", environment}
}

// PaneAddress is the tab and the command that opens it. A handle is drovr's grip on a
// terminal, not an address a human can follow.
type PaneAddress struct {
	Where string
	Open  *string
}

func TerminalAddress(show json.RawMessage, handle, environment string) PaneAddress {
	// swallowed: orca being unreachable costs the message its address, never the message.
	t, _ := readShown(show)
	if t == nil || t.Title == nil || t.WorktreePath == nil {
		return PaneAddress{Where: "terminal " + handle}
	}
	open := strings.Join(append([]string{"orca", "terminal", "switch", "--terminal", handle}, EnvArgs(environment)...), " ")
	return PaneAddress{Where: `its "` + *t.Title + `" tab in ` + filepath.Base(*t.WorktreePath), Open: &open}
}

// OpenLine puts the command on its own line, so it survives the end of a sentence and can
// be copied. Empty when orca could not name a tab.
func OpenLine(a PaneAddress) string {
	if a.Open == nil {
		return ""
	}
	return "\n  look:  " + *a.Open
}
