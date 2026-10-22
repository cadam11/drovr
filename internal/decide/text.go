package decide

import (
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/cadam11/drovr/internal/capacity"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/jsnum"
)

// num is a JS template literal's `${n}` for the finite, sub-1e21 numbers a reason carries.
func num(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// roundInt is `Math.round` printed as an integer.
func roundInt(v float64) int64 { return int64(jsnum.RoundHalfUp(v)) }

// shortName is the local part, unless two accounts share one. Length is a hard constraint:
// the note has to survive beside a program row in `drovr watch`, and keeping the domains
// costs about thirty columns and pushes the verdict itself off the frame.
func shortName(name string, all []AccountFunding) string {
	local := func(s string) string { return strings.SplitN(s, "@", 2)[0] }
	collisions := 0
	for _, a := range all {
		if local(a.Name) == local(name) {
			collisions++
		}
	}
	if collisions > 1 {
		return name
	}
	return local(name)
}

func listOf(names []string) string {
	if len(names) == 0 {
		return ""
	}
	if len(names) == 1 {
		return names[0]
	}
	return strings.Join(names[:len(names)-1], ", ") + " and " + names[len(names)-1]
}

// sourcedFrom: "across 3 accounts" is a lie when one of them carries all of it — measured
// 2026-08-25, two of three spent and the third also serving Craig's own sessions.
func sourcedFrom(f Funding, usable int) string {
	from := ContributingAccounts(f)
	if from == usable {
		return fmt.Sprintf("across %d accounts", usable)
	}
	return fmt.Sprintf("from %d of %d accounts", from, usable)
}

// concentrationNote: a pool resting on one account has no fallback, and that account is
// also where Craig's own sessions land. Silent for a single-account pool, which never had
// anything to spread across.
func concentrationNote(f Funding, usable int) *string {
	if usable < 2 {
		return nil
	}
	var carrying []AccountFunding
	unroutable := 0
	for _, a := range f.Accounts {
		if a.Cycles > 0 {
			carrying = append(carrying, a)
		}
		if !a.Routable {
			unroutable++
		}
	}
	if len(carrying) != 1 {
		return nil
	}
	why := ""
	if unroutable != 0 {
		why = fmt.Sprintf(", %d not routed for fable", unroutable)
	}
	s := "all of it on " + shortName(carrying[0].Name, f.Accounts) + " with no fallback" + why
	return &s
}

// couplingNote names the gap between the bars (pool-wide spend per bucket) and the verdict
// (room in all three at once on one account), because that gap is what got misread as
// capacity. Appended, never prefixed: surfaces clip from the right. Silent for one account,
// where min-of-sums and sum-of-mins agree.
func couplingNote(f Funding) *string {
	if len(f.Accounts) < 2 {
		return nil
	}
	var pinned []AccountFunding
	for _, a := range f.Accounts {
		if a.Cycles <= 0 {
			pinned = append(pinned, a)
		}
	}
	if len(pinned) == 0 {
		return nil
	}
	pins := strings.Join(pinGroups(pinned, f.Accounts), ", ")
	if len(pinned) == len(f.Accounts) {
		s := "no account has room in all three buckets: " + pins
		return &s
	}
	spare := len(f.Accounts) - len(pinned)
	has := "have"
	if spare == 1 {
		has = "has"
	}
	s := fmt.Sprintf("only %d of %d accounts %s room in all three buckets: %s", spare, len(f.Accounts), has, pins)
	return &s
}

func pinGroups(pinned, all []AccountFunding) []string {
	var groups []string
	for _, b := range capacity.Buckets {
		var names []string
		for _, a := range pinned {
			if a.Binding == b {
				names = append(names, shortName(a.Name, all))
			}
		}
		if len(names) == 0 {
			continue
		}
		verb := " on"
		if len(groups) == 0 {
			verb = " is full on"
		}
		groups = append(groups, string(b)+verb+" "+listOf(names))
	}
	return groups
}

// untilText is hours until an hour is the wrong unit: `Math.round` turned a 26-minute session
// hold into "recovers in 0h", which reads as "any moment now" for a wait that is not.
func untilText(at *epoch.Millis, now epoch.Millis) string {
	if at == nil {
		return "unknown"
	}
	minutes := math.Max(0, jsnum.RoundHalfUp(float64(*at-now)/60_000))
	if minutes < 60 {
		return fmt.Sprintf("%dm", int64(minutes))
	}
	hours := jsnum.RoundHalfUp(minutes / 60)
	// "168h" is technically a recovery time and practically a riddle.
	if hours < 48 {
		return fmt.Sprintf("%dh", int64(hours))
	}
	return fmt.Sprintf("%dd", roundInt(hours/24))
}

func paceMessage(over capacity.Bucket, spent, allowance, elapsed, hoursLeft float64) string {
	return fmt.Sprintf("ahead of pace on %s — %s spent of a %s ", over, jsnum.ToFixed(spent, 2), jsnum.ToFixed(allowance, 2)) +
		fmt.Sprintf("weekly allowance at %d%% through the window (all programs). ", roundInt(elapsed*100)) +
		fmt.Sprintf("Clears as the week catches up, or at the reset in %dh", roundInt(hoursLeft))
}
