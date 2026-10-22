// Package help is the port of src/help.ts: one registry that every help rendering reads, so
// `drovr help`, `drovr help <cmd>`, `<cmd> --help` and `help --json` cannot drift apart.
package help

import (
	"bytes"
	"encoding/json"
	"fmt"
	"strings"
)

type Flag struct {
	Flag      string `json:"flag"`
	Describes string `json:"describes"`
}

// Command marshals itself because the TS object literals do not share one key order: add, host and
// report put flags before details, and `help --json` must reproduce each literal byte for byte.
type Command struct {
	Name     string
	Usage    string
	Summary  string
	Details  []string
	Flags    []Flag
	Examples []string
	Writes   string // empty means read-only, and is omitted like the TS's absent writes
	Blocking bool
	// flagsFirst records the literal's key order; the registry transcription sets it.
	flagsFirst bool
}

type jsonField struct {
	key     string
	value   any
	present bool
}

func (c Command) MarshalJSON() ([]byte, error) {
	fields := []jsonField{
		{"name", c.Name, true},
		{"usage", c.Usage, true},
		{"summary", c.Summary, true},
		{"details", c.Details, c.Details != nil},
		{"flags", c.Flags, c.Flags != nil},
		{"examples", c.Examples, c.Examples != nil},
		{"writes", c.Writes, c.Writes != ""},
		{"blocking", c.Blocking, c.Blocking},
	}
	if c.flagsFirst {
		fields[3], fields[4] = fields[4], fields[3]
	}
	// The caller's encoder compacts and re-indents this, so the newlines Encode leaves are harmless;
	// HTML escaping is off here because the caller's setting does not reach into a Marshaler.
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	b.WriteByte('{')
	for _, f := range fields {
		if !f.present {
			continue
		}
		if b.Len() > 1 {
			b.WriteByte(',')
		}
		if err := enc.Encode(f.key); err != nil {
			return nil, err
		}
		b.WriteByte(':')
		if err := enc.Encode(f.value); err != nil {
			return nil, err
		}
	}
	b.WriteByte('}')
	return b.Bytes(), nil
}

type StateFiles struct {
	Control   string `json:"control"`
	Cycles    string `json:"cycles"`
	Decisions string `json:"decisions"`
	Usage     string `json:"usage"`
	Logs      string `json:"logs"`
}

type Verdicts struct {
	GO   string `json:"GO"`
	WAIT string `json:"WAIT"`
	STOP string `json:"STOP"`
}

type ExitReasons struct {
	Context   string `json:"context"`
	Capacity  string `json:"capacity"`
	Seam      string `json:"seam"`
	Abandoned string `json:"abandoned"`
	Blocked   string `json:"blocked"`
	Crash     string `json:"crash"`
	Stalled   string `json:"stalled"`
}

type Notes struct {
	JSON        string      `json:"json"`
	ExitCodes   string      `json:"exitCodes"`
	StateFiles  StateFiles  `json:"stateFiles"`
	Verdicts    Verdicts    `json:"verdicts"`
	ExitReasons ExitReasons `json:"exitReasons"`
	Gotchas     []string    `json:"gotchas"`
}

type Tree struct {
	Tool      string    `json:"tool"`
	Overview  string    `json:"overview"`
	UsingThis Notes     `json:"usingThis"`
	Commands  []Command `json:"commands"`
}

func TreeOf() Tree {
	return Tree{Tool: "drovr", Overview: Overview, UsingThis: AgentNotes, Commands: Commands}
}

func Find(name string) (Command, bool) {
	for _, c := range Commands {
		if c.Name == name {
			return c, true
		}
	}
	return Command{}, false
}

func pad(s string, width int) string { return fmt.Sprintf("%-*s", width, s) }

func RenderList() string {
	width := 0
	for _, c := range Commands {
		width = max(width, len(c.Name))
	}
	lines := []string{
		"drovr — capacity-aware supervisor for long-horizon delivery loops",
		"",
		Overview,
		"",
		"Commands:",
	}
	for _, c := range Commands {
		lines = append(lines, "  "+pad(c.Name, width+2)+c.Summary)
	}
	lines = append(lines,
		"",
		"Every read command accepts --json, whose values carry their own units and meanings — parse",
		"that rather than these columns.",
		"",
		"Run `drovr help <command>` for detail, or `drovr help --json` for the whole tree plus the",
		"verdict vocabulary, exit reasons, and state-file locations.",
	)
	return strings.Join(lines, "\n")
}

func indented(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = "  " + l
	}
	return out
}

func RenderCommand(c Command) string {
	parts := []string{c.Usage, "", "  " + c.Summary}
	if c.Details != nil {
		parts = append(append(parts, ""), indented(c.Details)...)
	}
	if c.Flags != nil {
		width := 0
		for _, f := range c.Flags {
			width = max(width, len(f.Flag))
		}
		parts = append(parts, "", "Flags:")
		for _, f := range c.Flags {
			parts = append(parts, "  "+pad(f.Flag, width+2)+f.Describes)
		}
	}
	if c.Examples != nil {
		parts = append(append(parts, "", "Examples:"), indented(c.Examples)...)
	}
	writes := c.Writes
	if writes == "" {
		writes = "nothing — read-only"
	}
	return strings.Join(append(parts, "", "Writes: "+writes), "\n")
}
