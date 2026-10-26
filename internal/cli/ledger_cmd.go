package cli

import (
	"fmt"
	"regexp"
	"slices"
	"strings"
	"unicode/utf16"

	"github.com/cadam11/drovr/internal/help"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/ledger"
)

var allDigits = regexp.MustCompile(`^\d+$`)

// padEnd counts UTF-16 units like JS and never truncates.
func padEnd(s string, width int) string {
	return s + strings.Repeat(" ", max(0, width-len(utf16.Encode([]rune(s)))))
}

func padStart(s string, width int) string {
	return strings.Repeat(" ", max(0, width-len(utf16.Encode([]rune(s))))) + s
}

// ledgerArgs reads the words (arguments not starting with "-"): the program is the first
// that is not all digits, the limit the first that is, default 20.
func ledgerArgs(rest []string) (program *string, limit float64) {
	limit = 20
	var seenLimit bool
	for _, w := range rest {
		switch {
		case strings.HasPrefix(w, "-"):
		case allDigits.MatchString(w) && !seenLimit:
			limit, _ = jsnum.ParseInt(w)
			seenLimit = true
		case !allDigits.MatchString(w) && program == nil:
			program = &w
		}
	}
	return program, limit
}

// lastPerProgram keeps, per program, the identity whose first end record appears latest in
// the file, then orders those by start. That is not the max startedAt, by design of the TS.
func lastPerProgram(cycles []ledger.Cycle) []ledger.Cycle {
	byProgram := map[string]ledger.Cycle{}
	var order []string
	for _, c := range ledger.LatestEnds(cycles) {
		if _, seen := byProgram[c.Program]; !seen {
			order = append(order, c.Program)
		}
		byProgram[c.Program] = c
	}
	out := make([]ledger.Cycle, 0, len(order))
	for _, name := range order {
		out = append(out, byProgram[name])
	}
	slices.SortStableFunc(out, func(a, b ledger.Cycle) int { return strings.Compare(a.StartedAt, b.StartedAt) })
	return out
}

// indentLines is closing.replace(/^/gm, '    '): JS multiline ^ also matches after \r, U+2028 and U+2029.
func indentLines(s string) string {
	var b strings.Builder
	b.WriteString("    ")
	for _, r := range s {
		b.WriteRune(r)
		if r == '\n' || r == '\r' || r == ' ' || r == ' ' {
			b.WriteString("    ")
		}
	}
	return b.String()
}

func ledgerLine(c ledger.Cycle) string {
	total := "—"
	if c.Yield != nil {
		total = jsnum.String(c.Yield.TicketsMoved + c.Yield.PrsOpened + c.Yield.Commits)
	}
	return fmt.Sprintf("%s  %s %s %s yield=%s asks=%s", jsnum.Slice(c.StartedAt, 16), padEnd(c.Program, 16),
		padEnd(c.Kind, 10), padEnd(c.Exit, 9), total, jsnum.String(c.AsksRaised))
}

// Ledger prints recent cycle records, or with --json {exitReasons, cycles}.
func Ledger(env Env, rest []string, asJSON bool) error {
	program, limit := ledgerArgs(rest)
	all, err := ledger.ReadCycles(env.Paths.Cycles)
	if err != nil {
		return err
	}
	mine := make([]ledger.Cycle, 0, len(all))
	for _, c := range all {
		if program == nil || c.Program == *program {
			mine = append(mine, c)
		}
	}
	recent := mine
	if limit > 0 && limit < float64(len(mine)) { // slice(-0) is slice(0): a zero limit keeps everything
		recent = mine[len(mine)-int(limit):]
	}
	if slices.Contains(rest, "--last") {
		recent = lastPerProgram(mine)
	}
	if asJSON {
		return encodeJSON(env.Stdout, struct {
			ExitReasons help.ExitReasons `json:"exitReasons"`
			Cycles      []ledger.Cycle   `json:"cycles"`
		}{help.AgentNotes.ExitReasons, recent})
	}
	closing := slices.Contains(rest, "--closing")
	for _, c := range recent {
		fmt.Fprintln(env.Stdout, ledgerLine(c))
		if closing && c.Closing != nil {
			fmt.Fprintln(env.Stdout, indentLines(*c.Closing)+"\n")
		}
	}
	return nil
}
