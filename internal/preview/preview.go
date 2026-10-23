// Package preview reads the tail of claude's TUI. It is a scrape of an undeclared format
// that changes between releases, so an unrecognised shape is nil — the panel shows no
// preview — and never an error that could fail a tick. That is the inverse of orca's
// `terminal show`, a declared interface parsed strictly so a surprise throws.
package preview

import (
	"regexp"
	"strconv"
	"strings"

	"github.com/cadam11/drovr/internal/jsnum"
)

const (
	maxLine    = 200
	maxScan    = 400
	byteBudget = 2048
	turnGlyphs = "⏺✻✦" // claude marks each assistant turn with one of these
)

var (
	gaugePattern   = regexp.MustCompile(`(?i)ctx:\s*(\d+)%\s*\(([\d.]+)([km])\)`)
	monitorPattern = regexp.MustCompile(`(\d+)\s+monitor`)
)

type Preview struct {
	Lines                                    []string
	ContextPercent, ContextTokens, Subagents *float64
}

func Parse(raw string, maxLines int) *Preview {
	if strings.TrimSpace(raw) == "" {
		return nil
	}
	all := strings.Split(raw, "\n")
	scanned := all[max(0, len(all)-maxScan):]
	var turns []string
	for _, line := range scanned {
		if isTurn(line) {
			if s := strip(line); s != "" {
				turns = append(turns, s)
			}
		}
	}
	if len(turns) == 0 {
		return nil
	}
	text := strings.Join(scanned, "\n")
	p := &Preview{Lines: capBytes(turns[max(0, len(turns)-maxLines):]), Subagents: monitors(text)}
	p.ContextPercent, p.ContextTokens = gauge(text)
	return p
}

func isTurn(line string) bool {
	for _, r := range line {
		return strings.ContainsRune(turnGlyphs, r)
	}
	return false
}

// strip drops the glyph and cuts by character, as the panel draws characters.
func strip(line string) string {
	runes := []rune(strings.TrimSpace(string([]rune(line)[1:])))
	return string(runes[:min(len(runes), maxLine)])
}

// capBytes enforces the byte budget the panel ships; strip's cut is by character.
func capBytes(lines []string) []string {
	kept, used := []string{}, 0
	for _, line := range lines {
		size := len(line) + 1
		if used+size > byteBudget {
			break
		}
		kept = append(kept, line)
		used += size
	}
	return kept
}

func lastMatch(text string, re *regexp.Regexp) []string {
	all := re.FindAllStringSubmatch(text, -1)
	if len(all) == 0 {
		return nil
	}
	return all[len(all)-1]
}

func number(s string) *float64 {
	n, err := strconv.ParseFloat(s, 64)
	if err != nil {
		return nil
	}
	return &n
}

func gauge(text string) (percent, tokens *float64) {
	m := lastMatch(text, gaugePattern)
	if m == nil {
		return nil, nil
	}
	scale := 1000.0
	if strings.EqualFold(m[3], "m") {
		scale = 1_000_000
	}
	if n := number(m[2]); n != nil {
		t := jsnum.RoundHalfUp(*n * scale)
		tokens = &t
	}
	return number(m[1]), tokens
}

func monitors(text string) *float64 {
	m := lastMatch(text, monitorPattern)
	if m == nil {
		return nil
	}
	return number(m[1])
}
