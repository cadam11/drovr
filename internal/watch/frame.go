package watch

import (
	"math"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"

	"github.com/cadam11/drovr/internal/allocation"
	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/state"
	"github.com/cadam11/drovr/internal/status"
)

var segments = []struct {
	of     func(allocation.Allocation) float64
	char   string
	colour int
	label  string
}{
	{func(a allocation.Allocation) float64 { return a.YoursSpent }, "▓", 35, "you spent"},
	{func(a allocation.Allocation) float64 { return a.ProgramsSpent }, "█", 32, "programs spent"},
	{func(a allocation.Allocation) float64 { return a.ProgramsReserved }, "▒", 36, "in flight"},
	{func(a allocation.Allocation) float64 { return a.ProgramsAvailable }, "░", 90, "free to programs"},
	{func(a allocation.Allocation) float64 { return a.YoursReserved }, "·", 35, "held for you"},
}

var buckets = []struct {
	name         capacity.Bucket
	label, short string
}{
	{"fable", "fable   7d", "fab"},
	{"general", "general 7d", "gen"},
	{"session", "session 5h", "5h"},
}

var accountBuckets = []struct {
	of    func(status.Buckets) status.Bucket
	label string
}{
	{func(b status.Buckets) status.Bucket { return b.Session }, "5h"},
	{func(b status.Buckets) status.Bucket { return b.General }, "wk"},
	{func(b status.Buckets) status.Bucket { return b.Fable }, "F7"},
}

// parseMs is Date.parse: NaN for what it cannot read, so the TS's NaN arithmetic carries over.
func parseMs(s string) float64 {
	ms, ok := epoch.Parse(s)
	if !ok {
		return math.NaN()
	}
	return float64(ms)
}

// jsSlice is String.prototype.slice(a, b) for non-negative bounds, clamped as JS clamps them.
func jsSlice(s string, a, b int) string {
	u := utf16.Encode([]rune(s))
	b = min(b, len(u))
	if a >= b {
		return ""
	}
	return string(utf16.Decode(u[a:b]))
}

// repeat is String.prototype.repeat over a JS number: NaN repeats nothing.
func repeat(s string, n float64) string {
	if math.IsNaN(n) {
		return ""
	}
	if n < 0 || math.IsInf(n, 0) {
		panic("repeat: invalid count " + jsnum.String(n))
	}
	return strings.Repeat(s, int(n))
}

func pad2(v float64) string { return padStart(jsnum.String(v), 2, "0") }

// hoursMinutes is "4h49m": the shape every minute count past an hour takes.
func hoursMinutes(minutes float64) string {
	if minutes < 60 {
		return jsnum.String(minutes) + "m"
	}
	return jsnum.String(math.Floor(minutes/60)) + "h" + pad2(math.Mod(minutes, 60)) + "m"
}

func elapsed(since string, now float64) string {
	return hoursMinutes(math.Max(0, jsnum.RoundHalfUp((now-parseMs(since))/60_000)))
}

// UntilLabel is time until a reset in teamclaude's dashboard vocabulary: 59m, 4h49m, 2d18h.
func UntilLabel(at *string, now epoch.Millis) string {
	return untilLabel(at, float64(now))
}

func untilLabel(at *string, now float64) string {
	if at == nil {
		return "—"
	}
	minutes := jsnum.RoundHalfUp((parseMs(*at) - now) / 60_000)
	if minutes <= 0 {
		return "now"
	}
	hours := math.Floor(minutes / 60)
	if minutes < 60 || hours < 24 {
		return hoursMinutes(minutes)
	}
	return jsnum.String(math.Floor(hours/24)) + "d" + pad2(math.Mod(hours, 24)) + "h"
}

// AccountsLabel says both numbers when they differ: "3 accounts" beside near-empty bars
// read as a healthy pool on 2026-08-25 while one account carried everything.
func AccountsLabel(funding, usable int) string {
	if funding == usable {
		return strconv.Itoa(usable) + " accounts"
	}
	return strconv.Itoa(funding) + " of " + strconv.Itoa(usable) + " accounts funding"
}

// barCells is a largest-remainder allocation, so the bar is always exactly width cells.
func barCells(a allocation.Allocation, width int) []float64 {
	exact := make([]float64, len(segments))
	cells := make([]float64, len(segments))
	deficit := float64(width)
	for i, s := range segments {
		exact[i] = s.of(a) / a.Total * float64(width)
		cells[i] = math.Floor(exact[i])
		deficit -= cells[i]
	}
	order := []int{0, 1, 2, 3, 4}
	sort.SliceStable(order, func(i, j int) bool {
		a, b := exact[order[i]], exact[order[j]]
		return a-math.Floor(a) > b-math.Floor(b)
	})
	for n := 0; float64(n) < deficit && n < len(order); n++ {
		cells[order[n]]++
	}
	return cells
}

func bar(a allocation.Allocation, width int) string {
	var out strings.Builder
	for i, cells := range barCells(a, width) {
		out.WriteString(paint(segments[i].colour, repeat(segments[i].char, cells)))
	}
	return out.String()
}

func percent(value, total float64) string { return jsnum.ToFixed(value/total*100, 0) + "%" }

// usedBar is a used-fraction bar, coloured by how close the bucket is to its limit.
func usedBar(fraction *float64, width int) string {
	if fraction == nil {
		return dim(strings.Repeat("?", width))
	}
	clamped := math.Min(1, math.Max(0, *fraction))
	filled := jsnum.RoundHalfUp(clamped * float64(width))
	colour := 32
	if clamped >= 0.8 {
		colour = 31
	} else if clamped >= 0.5 {
		colour = 33
	}
	return paint(colour, repeat("█", filled)) + paint(90, repeat("░", float64(width)-filled))
}

type tagged struct {
	text string
	hit  *LineHit
}

func plain(text string) tagged { return tagged{text, nil} }

func plainAll(texts []string) []tagged {
	out := make([]tagged, len(texts))
	for i, text := range texts {
		out[i] = plain(text)
	}
	return out
}

// helpLines explains what the view means, not only which key does what — modes especially.
func helpLines() []string {
	lines := []string{
		"  " + bold("drovr watch"),
		"",
		"  " + bold("Mode") + " — how much of each account's weekly quota programs may spend.",
		"  Whatever is left is held for you, no matter what they do.",
		"    " + paint(31, "off") + "     nothing runs",
		"    " + paint(33, "low") + "     programs 25%, you keep 75%",
		"    " + paint(32, "normal") + "  programs 55%, you keep 45%",
		"    " + paint(36, "away") + "    programs 85%, you keep 15% — for when you are gone",
		"  " + dim("< and > adjust the current mode by 5%."),
		"",
		"  " + bold("Verdicts"),
		"    " + paint(32, "GO") + "    starts on the next tick",
		"    " + paint(36, "RUN") + "   running now — open its tab to read or talk to it",
		"    " + paint(33, "WAIT") + "  transient; it retries by itself",
		"    " + paint(31, "STOP") + "  needs you — the reason says what",
		"",
		"  " + bold("Bars") + " — one per quota bucket, each summing to the whole pool.",
	}
	for _, s := range segments {
		lines = append(lines, "    "+paint(s.colour, s.char)+" "+s.label)
	}
	return append(lines,
		"  "+dim("fable = the runner; general = subagents it spawns; 5h = the burst window."),
		"  "+dim("All three bind at once; the tightest decides."),
		"",
		"  "+bold("Keys"),
		"    j k    select            space  enable/disable",
		"    [ ]    priority          o      open asks page",
		"    m      mode              < >    your reserve",
		"    p P    pause / extend    + -    concurrency cap",
		"    t      tick now          r      redraw",
		"    x      interrupt cycle   l      release a finished runner",
		"    q      quit",
		"  "+dim("Mouse: click a program to select it, its asks link to open it, a key below to run it."),
		"",
		// A documented floor: below it the frame degrades quietly rather than refusing.
		"  "+dim("Sized for 80×24+. Narrower shortens labels and bars; keys always show."),
		"",
		"  "+dim("? or esc closes this"),
	)
}

func allocationOf(s allocation.Segments, b capacity.Bucket) allocation.Allocation {
	switch b {
	case "fable":
		return s.Fable
	case "general":
		return s.General
	}
	return s.Session
}

func allocationLines(st state.DrovrState, barWidth int, narrow bool) []string {
	resetIn := "—"
	if st.HoursToWeeklyReset != nil {
		resetIn = jsnum.String(math.Floor(*st.HoursToWeeklyReset)) + "h"
	}
	legend := make([]string, len(segments))
	for i, s := range segments {
		legend[i] = paint(s.colour, s.char) + " " + dim(s.label)
	}
	lines := []string{
		"",
		"  " + bold("ALLOCATION") + "  " + dim(AccountsLabel(st.Pool.FundingAccounts, st.Pool.UsableAccounts)+" · weekly resets in "+resetIn),
		"  " + strings.Join(legend, "  "),
		"",
	}
	for _, b := range buckets {
		lines = append(lines, bucketRow(st, b.name, b.label, b.short, barWidth, narrow))
	}
	return lines
}

// bucketRow marks the binding bucket: the three are not a hierarchy, and only one of them
// is why admission is what it is.
func bucketRow(st state.DrovrState, name capacity.Bucket, label, short string, barWidth int, narrow bool) string {
	alloc := allocationOf(st.Allocation, name)
	yours := alloc.YoursSpent + alloc.YoursReserved
	binds := ""
	if name == st.BindingBucket {
		binds = paint(31, " binds")
	}
	shown, width := label, 11
	if narrow {
		shown, width = short, 4
	}
	return "  " + padEnd(shown, width) + bar(alloc, barWidth) + " " +
		dim("you "+padStart(percent(yours, alloc.Total), 4, " ")) + binds
}

// accountLines folds teamclaude's dashboard in: ► is the account the fable route serves
// next, ✗ one it refuses, whose headroom shows in the bars but funds nothing.
func accountLines(accounts []status.Account, now float64, width int, narrow bool) []string {
	if len(accounts) == 0 {
		return []string{}
	}
	nameWidth, statusWidth := 14, 0
	if !narrow {
		nameWidth, statusWidth = 0, 9
		for _, a := range accounts {
			nameWidth = max(nameWidth, jsLen(a.Name))
		}
		nameWidth = min(28, nameWidth)
	}
	fixed := 4 + nameWidth + 1 + statusWidth + len(accountBuckets)*11
	barWidth := max(3, int(math.Floor(float64(width-fixed)/float64(len(accountBuckets)))))
	target := "fable route has no target"
	for _, a := range accounts {
		if a.FableTarget {
			target = "fable route → " + a.Name
			break
		}
	}
	lines := []string{"", "  " + bold("ACCOUNTS") + "  " + dim(target)}
	for _, a := range accounts {
		lines = append(lines, accountRow(a, now, nameWidth, statusWidth, barWidth, narrow))
	}
	return lines
}

func accountRow(a status.Account, now float64, nameWidth, statusWidth, barWidth int, narrow bool) string {
	marker := " "
	if a.FableTarget {
		marker = paint(32, "►")
	} else if a.FableEligible != nil && !*a.FableEligible {
		marker = paint(31, "✗")
	}
	name := a.Name
	if narrow {
		name, _, _ = strings.Cut(a.Name, "@")
	}
	// padEnd counts a clipped name's escape bytes, so a clipped name is never padded.
	name = padEnd(Clip(name, nameWidth), nameWidth)
	statusText := ""
	if !narrow {
		statusText = accountStatus(a, statusWidth)
	}
	cells := make([]string, len(accountBuckets))
	for i, b := range accountBuckets {
		bucket := b.of(a.Buckets)
		cells[i] = dim(b.label) + " " + usedBar(bucket.UsedFraction, barWidth) + " " + padEnd(untilLabel(bucket.ResetsAt, now), 6)
	}
	return "  " + marker + " " + name + " " + statusText + strings.Join(cells, " ")
}

func accountStatus(a status.Account, width int) string {
	if a.Disabled {
		return dim(padEnd("disabled", width))
	}
	text, colour := "?", 33
	if a.Status != nil {
		text = *a.Status
	}
	if text == "active" {
		colour = 32
	}
	return paint(colour, padEnd(text, width))
}

func detailLinesFor(width int) int {
	return min(4, max(2, int(math.Ceil(float64(ReasonBudget)/float64(max(8, width-DetailIndent))))))
}

func intp(i int) *int { return &i }

// programLines returns each row with its wrapped detail, then its asks link as a separate
// target: with mouse reporting on, the terminal no longer opens OSC 8 links itself.
func programLines(programs []state.ProgramState, now float64, selected, width int, narrow bool) []tagged {
	nameWidth := 8
	for _, p := range programs {
		nameWidth = max(nameWidth, jsLen(p.Name))
	}
	out := []tagged{}
	for index, p := range programs {
		out = append(out, tagged{programRow(p, now, index == selected, nameWidth+6, width, narrow), &LineHit{Program: intp(index)}})
		if p.AsksURL == nil {
			continue
		}
		label := "asks ›"
		if !narrow {
			label = strings.TrimPrefix(*p.AsksURL, "https://")
		}
		out = append(out, tagged{strings.Repeat(" ", DetailIndent) + osc8(*p.AsksURL, label), &LineHit{Asks: intp(index)}})
	}
	return out
}

func programDetail(p state.ProgramState, now float64) string {
	if p.StartedAt == nil {
		return p.Reason
	}
	pid, kind := "?", "?"
	if p.Pid != nil {
		pid = strconv.Itoa(*p.Pid)
	}
	if p.Kind != nil {
		kind = *p.Kind
	}
	return "pid " + pid + " · " + elapsed(*p.StartedAt, now) + " · " + kind
}

// programRow keeps the reason beside the row only while it fits whole: clipped, a long
// reason loses its tail, which is where it keeps the coupling note or the retry command.
func programRow(p state.ProgramState, now float64, isSelected bool, nameWidth, width int, narrow bool) string {
	detail := programDetail(p, now)
	label := p.Name
	if !p.Enabled {
		label += " (off)"
	}
	label = padEnd(label, nameWidth)
	marker := " "
	if isSelected {
		marker, label = paint(36, "▸"), invert(label)
	}
	colour, ok := VerdictColour[p.Verdict]
	if !ok {
		colour = 37
	}
	head := " " + marker + dim("p"+padStart(jsnum.String(p.Priority), 2, " ")) + " " + label + " " + paint(colour, padEnd(p.Verdict, 4))
	if !narrow && VisibleLength(head)+2+jsLen(detail) <= width {
		return head + "  " + dim(detail)
	}
	lines := []string{head}
	for _, line := range WrapText(detail, max(8, width-DetailIndent), detailLinesFor(width)) {
		lines = append(lines, strings.Repeat(" ", DetailIndent)+dim(line))
	}
	return strings.Join(lines, "\n")
}

// serviceLine draws what decide() sees of launchd, never its raw exit-status detail.
func serviceLine(s state.ServiceState, now float64) string {
	if !s.Loaded {
		return "launchd agent is not loaded, so no tick will fire. Fix: drovr service install"
	}
	if s.LastTickAt == nil {
		every := ""
		if s.IntervalSeconds != nil {
			every = " (fires every " + strconv.Itoa(*s.IntervalSeconds) + "s)"
		}
		return "loaded" + every + ", but no tick has recorded a decision yet"
	}
	overdue := ""
	if s.Overdue {
		overdue = " — overdue, the agent may be stalled"
	}
	return "loaded. Last tick recorded a decision " + elapsed(*s.LastTickAt, now) + " ago" + overdue
}

// clock is toTimeString().slice(0, 8) in loc, the TS's process-local zone.
func clock(now float64, loc *time.Location) string {
	if math.IsNaN(now) {
		return "Invalid "
	}
	return time.UnixMilli(int64(now)).In(loc).Format("15:04:05")
}

func headerLines(st state.DrovrState, now float64, loc *time.Location) []string {
	held := ""
	if st.PauseUntil != nil && parseMs(*st.PauseUntil) > now {
		held = paint(33, " paused until "+jsSlice(*st.PauseUntil, 11, 16))
	}
	phone := ""
	if st.ModeFromPhone {
		phone = " (phone)"
	}
	healthy := 31
	if st.Service.Loaded && !st.Service.Overdue {
		healthy = 32
	}
	return []string{
		bold("drovr") + "  " + dim("mode "+string(st.Mode)+phone) + held + "  " + dim(clock(now, loc)),
		"  " + paint(healthy, "●") + " " + dim(serviceLine(st.Service, now)),
	}
}

// poolLines prints the pool context once beside the bars it explains: program reasons no
// longer carry it (decide's reason/note split).
func poolLines(st state.DrovrState, now float64, width int, narrow bool) []string {
	if st.Mode == "off" {
		return []string{"", paint(31, "  mode is off — press m to cycle modes")}
	}
	// Reserves the six columns of " binds" too, or clip eats the marker at narrow widths.
	barWidth := max(8, width-28)
	if narrow {
		barWidth = max(8, width-22)
	}
	lines := allocationLines(st, barWidth, narrow)
	for _, line := range WrapText(st.CapacityNote, max(8, width-4), 3) {
		lines = append(lines, "  "+dim(line))
	}
	return append(lines, accountLines(st.Accounts, now, width, narrow)...)
}

const recentShown = 5

func recentLines(cycles []state.RecentCycle) []string {
	if len(cycles) == 0 {
		return []string{}
	}
	lines := []string{"", "  " + bold("RECENT")}
	for _, c := range cycles[:min(recentShown, len(cycles))] {
		lines = append(lines, dim("  "+strings.Replace(jsSlice(c.StartedAt, 5, 16), "T", " ", 1)+"  "+padEnd(c.Program, 10)+
			padEnd(c.Kind, 11)+padEnd(c.Exit, 9)+"asks="+jsnum.String(c.AsksRaised)))
	}
	return lines
}

// tail is held out of the body and re-attached by the clamp: appended last, the message
// line, the warning and the keybar were the first rows a short terminal lost — and an
// armed `x` then had no visible prompt.
func tail(v View, width int, narrow bool) []tagged {
	message := "  "
	if v.Message != "" {
		message = paint(36, "  "+v.Message)
	}
	out := []tagged{plain(""), plain(message)}
	if v.PreviewWarning != nil {
		out = append(out, plain(paint(33, "  "+*v.PreviewWarning)))
	}
	for i, line := range KeybarLines(width, narrow) {
		out = append(out, tagged{line, &LineHit{Keybar: intp(i)}})
	}
	return out
}

func split(source []tagged) []tagged {
	out := []tagged{}
	for _, line := range source {
		for _, text := range strings.Split(line.text, "\n") {
			out = append(out, tagged{text, line.hit})
		}
	}
	return out
}

// clampAndClip reserves the foot first — keybar, confirmation prompt — and lets the body
// give way. Program rows carry newlines, so both halves are flattened before measuring.
// rows 0 is no viewport: the frame is as tall as it needs.
func clampAndClip(body, foot []tagged, width, rows int) (string, []*LineHit) {
	flatBody, flatFoot := split(body), split(foot)
	budget := len(flatBody) + len(flatFoot)
	if rows != 0 {
		budget = max(1, rows-1)
	}
	kept := flatFoot[:min(budget, len(flatFoot))]
	if len(flatFoot) < budget {
		kept = append(flatBody[:min(len(flatBody), budget-len(flatFoot))], flatFoot...)
	}
	texts := make([]string, len(kept))
	hits := make([]*LineHit, len(kept))
	for i, line := range kept {
		texts[i], hits[i] = Clip(line.text, width), line.hit
	}
	return strings.Join(texts, "\n"), hits
}

// FrameWithHits is pure: now is the state's own generatedAt and the clock is drawn in loc,
// so the TUI and every other renderer of one DrovrState agree. columns is clamped to
// 24..120; rows 0 means no viewport.
func FrameWithHits(st state.DrovrState, v View, columns, rows int, loc *time.Location) (string, []*LineHit) {
	width := max(24, min(columns, 120))
	if v.Help {
		return clampAndClip(plainAll(helpLines()), nil, width, rows)
	}
	now := parseMs(st.GeneratedAt)
	narrow := width < 72
	lines := plainAll(headerLines(st, now, loc))
	lines = append(lines, plainAll(poolLines(st, now, width, narrow))...)
	lines = append(lines,
		plain(""),
		plain("  "+bold("PROGRAMS")+"  "+dim(strconv.Itoa(st.CyclesInFlight)+"/"+jsnum.String(st.MaxConcurrentCycles)+" in flight")),
	)
	lines = append(lines, programLines(st.Programs, now, v.Selected, width, narrow)...)
	lines = append(lines, plainAll(recentLines(st.RecentCycles))...)
	return clampAndClip(lines, tail(v, width, narrow), width, rows)
}

// Frame is the rendered frame alone, for every caller with no mouse to serve.
func Frame(st state.DrovrState, v View, columns, rows int, loc *time.Location) string {
	text, _ := FrameWithHits(st, v, columns, rows, loc)
	return text
}
