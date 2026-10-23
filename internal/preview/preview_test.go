package preview

import (
	"fmt"
	"strings"
	"testing"
	"unicode/utf8"
)

const real = `⏺ Agent "Promotion train + S-123 close" finished · 30m 42s

⏺ Poll 7, ~8 min. Waiting.

✻ Cooked for 5s · 1 monitor still running

──────────────── sunnyt program runner ─
❯
────────────────────────────────────────
  Propra@Craigs-MacBook-Pro in sunnyt on stage
  using Fable 5 | ctx:18% (176k)
  ⏵⏵ auto mode on · 1 monitor · ← for agents
`

func lines(n int, f func(i int) string) string {
	out := make([]string, n)
	for i := range out {
		out[i] = f(i)
	}
	return strings.Join(out, "\n")
}

func is(p *float64, want float64) bool { return p != nil && *p == want }

func TestPreviewParse(t *testing.T) {
	scanTail := lines(500, func(i int) string {
		if i < 50 {
			return fmt.Sprintf("⏺ line %d", i)
		}
		return fmt.Sprintf("line %d with no turn marker", i)
	})
	cases := []struct {
		name     string
		raw      string
		maxLines int
		check    func(*Preview) bool
	}{
		{"takes the trailing assistant lines and reads the gauge", real, 6, func(p *Preview) bool {
			return p != nil && len(p.Lines) == 3 && strings.HasPrefix(p.Lines[0], `Agent "Promotion train`) &&
				p.Lines[2] == "Cooked for 5s · 1 monitor still running" &&
				is(p.ContextPercent, 18) && is(p.ContextTokens, 176000) && is(p.Subagents, 1)
		}},
		{"bounded by maxLines and truncates long lines", lines(40, func(i int) string { return fmt.Sprintf("⏺ line %d %s", i, strings.Repeat("x", 400)) }), 6, func(p *Preview) bool {
			if p == nil || len(p.Lines) != 6 || !strings.HasPrefix(p.Lines[5], "line 39") {
				return false
			}
			for _, l := range p.Lines {
				if utf8.RuneCountInString(l) > 200 {
					return false
				}
			}
			return true
		}},
		{"caps the whole preview at 2KB of UTF-8", lines(10, func(i int) string { return fmt.Sprintf("⏺ %s %d", strings.Repeat("✻", 190), i) }), 6, func(p *Preview) bool {
			return p != nil && len(strings.Join(p.Lines, "\n")) <= 2048
		}},
		{"empty is nil", "", 6, func(p *Preview) bool { return p == nil }},
		{"an unrecognised shape is nil", "claude: command not found", 6, func(p *Preview) bool { return p == nil }},
		{"the last gauge and monitor win", "ctx:9% (88k)\n3 monitors here\n\n⏺ early line\n⏺ later line\nctx:41% (402k)\n1 monitor there", 6, func(p *Preview) bool {
			return p != nil && is(p.ContextPercent, 41) && is(p.ContextTokens, 402000) && is(p.Subagents, 1)
		}},
		{"only the last MAX_SCAN lines are scanned", scanTail, 6, func(p *Preview) bool { return p == nil }},
		{"uppercase K", "⏺ Agent running\nusing Fable 5 | ctx:41% (402K)", 6, func(p *Preview) bool {
			return p != nil && is(p.ContextPercent, 41) && is(p.ContextTokens, 402000)
		}},
		{"uppercase M", "⏺ Agent running\nusing Fable 5 | ctx:85% (1.2M)", 6, func(p *Preview) bool {
			return p != nil && is(p.ContextPercent, 85) && is(p.ContextTokens, 1200000)
		}},
	}
	for _, c := range cases {
		if got := Parse(c.raw, c.maxLines); !c.check(got) {
			t.Errorf("%s: %+v", c.name, got)
		}
	}
}
