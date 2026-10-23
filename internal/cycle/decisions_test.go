package cycle

import (
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/orca"
)

func TestStallAction(t *testing.T) {
	base := StallInput{NudgeAfter: 10 * time.Minute, MaxNudges: 3, BlockedAlertAfter: 20 * time.Minute}
	with := func(edit func(*StallInput)) StallInput { in := base; edit(&in); return in }
	cases := []struct {
		name string
		in   StallInput
		want Stall
	}{
		{"working is left alone", with(func(i *StallInput) { i.State = orca.Working; i.IdleFor = 9 * time.Hour }), "wait"},
		{"idle within grace", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 9 * time.Minute }), "wait"},
		{"idle past grace is nudged", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 10 * time.Minute }), "nudge"},
		{"reported is never nudged", with(func(i *StallInput) { i.State = orca.Idle; i.HasReport = true; i.IdleFor = 9 * time.Hour }), "wait"},
		{"the last nudge is spent", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 10 * time.Minute; i.NudgesSent = 2 }), "nudge"},
		{"out of nudges gives up", with(func(i *StallInput) { i.State = orca.Idle; i.IdleFor = 10 * time.Minute; i.NudgesSent = 3 }), "give-up"},
		{"blocked past threshold asks a human", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = 20 * time.Minute }), "alert"},
		{"just blocked waits", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = time.Minute }), "wait"},
		{"blocked alerts once", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = 4 * time.Hour; i.Alerted = true }), "wait"},
		{"blocked and reported is finished", with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = 4 * time.Hour; i.HasReport = true }), "wait"},
	}
	for _, c := range cases {
		if got := StallAction(c.in); got != c.want {
			t.Errorf("%s: %s", c.name, got)
		}
	}
	for _, d := range []time.Duration{0, 20 * time.Minute, 12 * time.Hour} {
		if got := StallAction(with(func(i *StallInput) { i.State = orca.Blocked; i.BlockedFor = d; i.IdleFor = time.Hour })); got == "nudge" || got == "give-up" {
			t.Fatal("a blocked runner is never nudged")
		}
	}
}

func TestLaunchArgv(t *testing.T) {
	c, _ := control.Parse([]byte(`{"programs":[{"name":"relliq","cwd":"/Users/cadam/code/propra/relliq"},{"name":"h","cwd":"/x","host":{"environment":"e","ssh":"ubuntu@box","cwd":"/home/ubuntu/code/propra/relliq"}},{"name":"n","cwd":"/x","useDirenv":false,"host":{"environment":"e","ssh":"ubuntu@box","cwd":"/home/ubuntu/code/propra/relliq"}}]}`))
	claude := "--model fable --name relliq program runner --session-id sid"
	want := []string{
		"direnv exec /Users/cadam/code/propra/relliq teamclaude run -- " + claude,
		"direnv exec /home/ubuntu/code/propra/relliq ~/.local/bin/claude " + claude,
		"~/.local/bin/claude " + claude,
	}
	for i, p := range c.Programs {
		if got := strings.Join(LaunchArgv(p, "relliq program runner", "sid"), " "); got != want[i] {
			t.Errorf("%s: %s", p.Name, got)
		}
	}
}

func TestWakeTailscaleSessionAndExits(t *testing.T) {
	wake := "pnpm devbox:start"
	if WakeDecision(true, nil) != "proceed" || WakeDecision(true, &wake) != "proceed" || WakeDecision(false, &wake) != "run-wake" || WakeDecision(false, nil) != "fail" {
		t.Fatal("wakeDecision")
	}
	reason := "ssh ubuntu@box true did not return within 20s and was killed; it had printed: # Tailscale SSH requires an additional check. # To authenticate, visit: https://login.tailscale.com/a/l1e8671de330fd4"
	if got := TailscaleCheckLink(&reason); got == nil || *got != "https://login.tailscale.com/a/l1e8671de330fd4" {
		t.Fatal("link")
	}
	plain := "ssh ubuntu@box true did not return within 20s and was killed"
	if TailscaleCheckLink(&plain) != nil || TailscaleCheckLink(nil) != nil {
		t.Fatal("no link")
	}
	id, err := NewSessionID()
	if err != nil || !regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(id) {
		t.Fatalf("%q %v", id, err)
	}
	for in, want := range map[[3]bool]string{{true, true, true}: "deferred", {false, true, true}: "stalled", {false, false, true}: "abandoned", {false, false, false}: "crash"} {
		if got := UnreportedExit(in[0], in[1], in[2]); got != want {
			t.Errorf("%v: %s", in, got)
		}
	}
	p := control.Program{Name: "alpha", Model: "fable"}
	if Substitute("/project-loop {program} {mode} --model {model}", p, true) != "/project-loop alpha onboard --model fable" {
		t.Fatal("substitute")
	}
}
