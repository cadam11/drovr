// Package watch is `drovr watch`: a frame drawn from one state.DrovrState, a keybar that is
// both drawn and hit-tested from one layout, and the terminal loop that paints them.
package watch

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	Esc   = "\x1b["
	CtrlC = "\x03"
)

func dim(text string) string             { return Esc + "2m" + text + Esc + "0m" }
func bold(text string) string            { return Esc + "1m" + text + Esc + "0m" }
func paint(code int, text string) string { return fmt.Sprintf("%s%dm%s%s0m", Esc, code, text, Esc) }
func invert(text string) string          { return Esc + "7m" + text + Esc + "0m" }

// osc8 is clickable in Ghostty and friends, plain text everywhere else.
func osc8(url, text string) string {
	return "\x1b]8;;" + url + "\x1b\\" + paint(36, text) + "\x1b]8;;\x1b\\"
}

var (
	osc = regexp.MustCompile("\x1b\\][^\x07\x1b]*(\x07|\x1b\\\\)")
	sgr = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]")
)

// jsLen is String.prototype.length — UTF-16 units — which every TS width in the frame counts.
func jsLen(s string) int {
	n := 0
	for _, r := range s {
		n += utf16.RuneLen(r)
	}
	return n
}

func padEnd(s string, width int) string {
	return s + strings.Repeat(" ", max(0, width-jsLen(s)))
}

func padStart(s string, width int, fill string) string {
	return strings.Repeat(fill, max(0, width-jsLen(s))) + s
}

// VisibleLength measures columns, which escape sequences do not occupy. Wide characters
// count as one, as in the TS.
func VisibleLength(text string) int {
	return jsLen(sgr.ReplaceAllString(osc.ReplaceAllString(text, ""), ""))
}

// Clip keeps a line inside the terminal width so nothing soft-wraps and pushes the frame
// around. An escape is copied up to the next literal "m", which is right for SGR and, as in
// the TS, swallows an OSC 8 link up to the first "m" it contains.
func Clip(text string, width int) string {
	if VisibleLength(text) <= width {
		return text
	}
	var out strings.Builder
	shown := 0
	for index := 0; index < len(text); {
		if text[index] == '\x1b' {
			stop := len(text) - 1
			if end := strings.IndexByte(text[index:], 'm'); end != -1 {
				stop = index + end
			}
			out.WriteString(text[index : stop+1])
			index = stop + 1
			continue
		}
		if shown >= width-1 {
			break
		}
		r, size := utf8.DecodeRuneInString(text[index:])
		out.WriteRune(r)
		shown += utf16.RuneLen(r)
		index += size
	}
	return out.String() + Esc + "0m…"
}

func isJSSpace(r rune) bool { return unicode.IsSpace(r) || r == 0xfeff }

// WrapText is a bounded word wrap for text that must not lose its tail; the last line takes
// whatever is left and is clipped by the caller. Widths count UTF-16 units, as the TS does.
func WrapText(text string, width, maxLines int) []string {
	if width < 1 || maxLines < 1 {
		panic(fmt.Sprintf("wrapText needs width>=1 and maxLines>=1, got %d/%d", width, maxLines))
	}
	lines := []string{}
	rest := utf16.Encode([]rune(text))
	for len(rest) > width && len(lines) < maxLines-1 {
		at := lastSpace(rest, width)
		if at <= 0 {
			at = width
		}
		lines = append(lines, string(utf16.Decode(rest[:at])))
		rest = trimStart(rest[at:])
	}
	return append(lines, string(utf16.Decode(rest)))
}

// lastSpace is lastIndexOf(' ', from): a space exactly at `from` still counts.
func lastSpace(units []uint16, from int) int {
	for i := min(from, len(units)-1); i >= 0; i-- {
		if units[i] == ' ' {
			return i
		}
	}
	return -1
}

func trimStart(units []uint16) []uint16 {
	for len(units) > 0 && isJSSpace(rune(units[0])) {
		units = units[1:]
	}
	return units
}

// ChildReason is the one line of a failed subprocess worth a row of the frame: the line
// after execFile's own `Command failed: <argv>`, which only restates the call.
func ChildReason(text string) string {
	lines := []string{}
	for _, line := range strings.Split(text, "\n") {
		if line = strings.TrimFunc(line, isJSSpace); line != "" {
			lines = append(lines, line)
		}
	}
	for _, line := range lines {
		if !strings.HasPrefix(line, "Command failed:") {
			return line
		}
	}
	if len(lines) > 0 {
		return lines[0]
	}
	return "unknown error"
}
