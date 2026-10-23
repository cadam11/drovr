package cycle

import (
	"context"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/ledger"
	"github.com/cadam11/drovr/internal/paths"
)

var now = epoch.MustParse("2026-08-28T12:00:00Z")

func f(v float64) *float64 { return &v }

func TestParseReportArgs(t *testing.T) {
	program, r, err := ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--startup-tokens", "14000", "--tickets-moved", "2", "--prs-opened", "1", "--commits", "6", "--asks-raised", "1"}, now)
	want := Report{Exit: "seam", StartupTokens: f(14000), Yield: &ledger.Yield{TicketsMoved: 2, PrsOpened: 1, Commits: 6}, AsksRaised: 1}
	if err != nil || program != "sunnyt" || !reflect.DeepEqual(r, want) {
		t.Fatalf("%s %+v %v", program, r, err)
	}
	if _, r, _ := ParseReportArgs([]string{"sunnyt", "--exit", "context"}, now); r.Yield != nil || r.StartupTokens != nil || r.AsksRaised != 0 {
		t.Fatal("no yield flags means yield unknown, not zero")
	}
	if _, r, _ := ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--commits", "3"}, now); *r.Yield != (ledger.Yield{Commits: 3}) {
		t.Fatal("one yield flag defaults the other two to zero")
	}
	refusals := []struct {
		args []string
		want string
	}{
		{[]string{}, "usage: drovr report"},
		{[]string{"--exit", "seam"}, "usage: drovr report"},
		{[]string{"sunnyt"}, "--exit is required"},
		{[]string{"sunnyt", "--exit", "seam", "--startup_tokens", "14000"}, "unknown flag --startup_tokens"},
		{[]string{"sunnyt", "--exit", "seam", "--commits", "lots"}, `--commits needs a number, got "lots"`},
		{[]string{"sunnyt", "--exit", "seam", "--pause-until", "2026-08-01"}, "already in the past"},
		{[]string{"sunnyt", "--exit", "seam", "--pause-until", "90d"}, "more than 35 days"},
		{[]string{"sunnyt", "--exit", "seam", "--pause-until", "whenever"}, "needs a duration (48h, 7d) or an ISO date"},
		{[]string{"sunnyt", "--exit", "seam", "--cadence", "weekly"}, "--cadence must look like"},
		{[]string{"sunnyt", "--exit", "seam", "--cadence", "60d"}, "longer than 35 days"},
	}
	for _, c := range refusals {
		if _, _, err := ParseReportArgs(c.args, now); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%v: %v (want %q)", c.args, err, c.want)
		}
	}
	_, r, _ = ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--pause-until", "48h", "--cadence", "7d"}, now)
	if *r.PauseUntil != epoch.ISO(now+48*3_600_000) || *r.Cadence != "7d" {
		t.Fatalf("%+v", r)
	}
	_, r, _ = ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--pause-until", "2026-08-30T09:00:00Z"}, now)
	if *r.PauseUntil != "2026-08-30T09:00:00.000Z" {
		t.Fatal(*r.PauseUntil)
	}
	_, r, _ = ParseReportArgs([]string{"sunnyt", "--exit", "seam", "--pause-until", "2026-08-30T09:00Z", "--commits", "12abc"}, now)
	if r.PauseUntil == nil || *r.PauseUntil != "2026-08-30T09:00:00.000Z" || r.Yield.Commits != 12 {
		t.Fatalf("Date.parse takes minutes-only ISO and parseInt reads leading digits: %+v", r)
	}
}

func alpha(t *testing.T) (paths.Paths, Source) {
	p := paths.Paths{Base: t.TempDir()}
	c, err := control.Parse([]byte(`{"programs":[{"name":"alpha","cwd":"/x"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	return p, SourceFor(p, c.Programs[0])
}

func TestWriteReportIsStagedAndRoundTrips(t *testing.T) {
	p, src := alpha(t)
	written, err := WriteReport(p, "alpha", Report{Exit: "seam", StartupTokens: f(9000), Yield: &ledger.Yield{TicketsMoved: 1, Commits: 4}})
	if err != nil {
		t.Fatal(err)
	}
	got, err := ReadReport(context.Background(), src)
	if err != nil || !reflect.DeepEqual(*got, written) {
		t.Fatalf("%+v %v", got, err)
	}
	raw, _ := os.ReadFile(p.LastCycle("alpha"))
	if string(raw) != `{"exit":"seam","startupTokens":9000,"yield":{"ticketsMoved":1,"prsOpened":0,"commits":4},"asksRaised":0,"pauseUntil":null,"cadence":null}`+"\n" {
		t.Fatalf("%s", raw)
	}
	entries, _ := os.ReadDir(p.ProgramState("alpha"))
	if len(entries) != 1 {
		t.Fatalf("staging left behind: %v", entries)
	}
	if _, err := WriteReport(p, "beta", Report{Exit: "done"}); err == nil || !strings.Contains(err.Error(), "not a valid cycle report") {
		t.Fatalf("%v", err)
	}
	if _, err := os.Stat(p.LastCycle("beta")); err == nil {
		t.Fatal("an invalid report touched disk")
	}
}

func TestPollLeniency(t *testing.T) {
	text := func(s string) *string { return &s }
	if r, err := ReportFromPoll(nil, "x"); r != nil || err != nil {
		t.Fatal("absent is not yet")
	}
	if r, err := ReportFromPoll(text(`{"exit": "sea`), "x"); r != nil || err != nil {
		t.Fatal("torn is not yet")
	}
	if r, err := ReportFromPoll(text(`{"exit":"seam"}`), "x"); err != nil || r.Exit != "seam" {
		t.Fatalf("%+v %v", r, err)
	}
	if _, err := ReportFromPoll(text(`{"exit":"done"}`), "x"); err == nil || !strings.Contains(err.Error(), "not a valid cycle report") {
		t.Fatalf("a complete report with the wrong shape is broken: %v", err)
	}
	p, src := alpha(t)
	os.MkdirAll(p.ProgramState("alpha"), 0o755)
	os.WriteFile(p.LastCycle("alpha"), []byte(`{ "exit": "seam", "startupTo`), 0o644)
	if _, err := ReadReport(context.Background(), src); err == nil {
		t.Fatal("readReport is strict where the poll is lenient")
	}
	if err := src.Clear(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got, err := src.Read(context.Background()); got != nil || err != nil {
		t.Fatal("cleared reads as absent")
	}
}

func TestRemotePathsAndMissingFile(t *testing.T) {
	h := control.Host{DrovrHome: "~/.drovr"}
	if RemoteReportPath(h, "relliq") != "~/.drovr/programs/relliq/last-cycle.json" {
		t.Fatal(RemoteReportPath(h, "relliq"))
	}
	if !IsMissingFile("cat: /home/ubuntu/.drovr/programs/relliq/last-cycle.json: No such file or directory\n") || IsMissingFile("ssh: connect to host relliq-devbox port 22: Operation timed out\r\n") || IsMissingFile("") {
		t.Fatal("only cat's own No such file means not yet")
	}
}

// useSSH puts a shim named ssh first on PATH: it logs its argv, prints $SSH_STDOUT and
// $SSH_STDERR, and exits $SSH_CODE.
func useSSH(t *testing.T, stdout, stderr, code string) string {
	bin := t.TempDir()
	script := "#!/bin/sh\necho \"$*\" >> \"$SSH_LOG\"\nprintf '%s' \"$SSH_STDOUT\"\nprintf '%s' \"$SSH_STDERR\" >&2\nexit \"$SSH_CODE\"\n"
	if err := os.WriteFile(bin+"/ssh", []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", bin+":"+os.Getenv("PATH"))
	log := t.TempDir() + "/calls.log"
	t.Setenv("SSH_LOG", log)
	t.Setenv("SSH_STDOUT", stdout)
	t.Setenv("SSH_STDERR", stderr)
	t.Setenv("SSH_CODE", code)
	return log
}

func TestHostedSourceReadsOverSSH(t *testing.T) {
	c, err := control.Parse([]byte(`{"programs":[{"name":"relliq","cwd":"/x","host":{"environment":"e","ssh":"ubuntu@box","cwd":"/home/ubuntu/r"}}]}`))
	if err != nil {
		t.Fatal(err)
	}
	src := SourceFor(paths.Paths{Base: t.TempDir()}, c.Programs[0])
	ctx := context.Background()
	if src.Label != "ubuntu@box:~/.drovr/programs/relliq/last-cycle.json" {
		t.Fatal(src.Label)
	}

	calls := useSSH(t, `{"exit":"seam"}`, "", "0")
	if r, err := ReadReport(ctx, src); err != nil || r.Exit != "seam" {
		t.Fatalf("%+v %v", r, err)
	}
	if err := src.Clear(ctx); err != nil {
		t.Fatal(err)
	}
	logged, _ := os.ReadFile(calls)
	if string(logged) != "-o BatchMode=yes -o ConnectTimeout=10 ubuntu@box cat ~/.drovr/programs/relliq/last-cycle.json\n-o BatchMode=yes -o ConnectTimeout=10 ubuntu@box rm -f ~/.drovr/programs/relliq/last-cycle.json\n" {
		t.Fatalf("%s", logged)
	}

	useSSH(t, "", "cat: /home/ubuntu/.drovr/programs/relliq/last-cycle.json: No such file or directory\n", "1")
	if got, err := src.Read(ctx); got != nil || err != nil {
		t.Fatalf("missing is not yet: %v %v", got, err)
	}
	useSSH(t, "", "ssh: connect to host box port 22: Operation timed out\n", "255")
	if _, err := src.Read(ctx); err == nil {
		t.Fatal("a failure to look is never read as absent")
	}
}
