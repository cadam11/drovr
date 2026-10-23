package orca

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/paths"
)

func shown(fields string) json.RawMessage {
	return json.RawMessage(`{"id":"82729c72","ok":true,"result":{"terminal":{"handle":"term_844e8720-ac95-453c-bb73-7e2fd567479a","worktreePath":"/Users/cadam/code/sunnyt","connected":true,` + fields + `}}}`)
}

var (
	claudeShown   = shown(`"title":"✳ Claude Code","agentIdentity":"claude","agentWait":null`)
	shellShown    = shown(`"title":"~/code/sunnyt","agentIdentity":null,"agentWait":null`)
	bareShown     = shown(`"title":"✳ Claude Code"`)
	blockedShown  = shown(`"title":"✳ Claude Code","agentIdentity":"claude","agentWait":{"kind":"permission","evidence":"prompt-text"}`)
	restoredShell = shown(`"tabId":"c4c69d5f","title":null,"lastOutputAt":null,"preview":"","agentWait":null`)
	noWaitField   = shown(`"title":"✳ Claude Code","agentIdentity":"claude"`)
	stale         = json.RawMessage(`{"id":"ca3dceb8","ok":false,"error":{"code":"terminal_handle_stale","message":"terminal_handle_stale"}}`)
	idleSatisfied = json.RawMessage(`{"id":"175e9e23","ok":true,"result":{"wait":{"handle":"term_844e8720","condition":"tui-idle","satisfied":true,"status":"running","exitCode":null}}}`)
	idleTimedOut  = json.RawMessage(`{"id":"175e9e24","ok":false,"error":{"code":"timeout","message":"timeout"}}`)
	exited        = json.RawMessage(`{"id":"43d5e42a","ok":true,"result":{"wait":{"handle":"term_2c1446bd","condition":"exit","satisfied":true,"status":"exited","exitCode":0}}}`)
)

func TestAgentStateFrom(t *testing.T) {
	cases := []struct {
		name             string
		show, idle, exit json.RawMessage
		want             AgentState
	}{
		{"a stale handle is gone", stale, idleTimedOut, nil, Gone},
		{"a plain shell is gone", shellShown, idleSatisfied, nil, Gone},
		{"show omits agentIdentity on a bare shell: gone", bareShown, idleSatisfied, nil, Gone},
		{"a restored terminal with a null title is a shell, not a shape error", restoredShell, idleSatisfied, nil, Gone},
		{"a claude on a human-only prompt is blocked whatever idle says", blockedShown, idleSatisfied, nil, Blocked},
		{"an exited pty is gone although show still names claude", claudeShown, idleTimedOut, exited, Gone},
		{"settled within the probe is idle", claudeShown, idleSatisfied, nil, Idle},
		{"not settled within the probe is working", claudeShown, idleTimedOut, nil, Working},
		{"an older host that never looked for a wait", noWaitField, idleTimedOut, nil, Working},
	}
	for _, c := range cases {
		got, err := AgentStateFrom(c.show, c.idle, c.exit)
		if err != nil || got != c.want {
			t.Errorf("%s: %s, %v", c.name, got, err)
		}
	}
}

func TestShapeErrorNamesThePath(t *testing.T) {
	_, err := AgentStateFrom(shown(`"title":"t","agentIdentity":7`), idleSatisfied, nil)
	if err == nil || !strings.Contains(err.Error(), "did not match the expected shape") || !strings.Contains(err.Error(), "terminal.agentIdentity") {
		t.Fatalf("%v", err)
	}
}

func TestRefusalsOtherThanTimeoutThrow(t *testing.T) {
	if _, err := AgentStateFrom(claudeShown, stale, nil); err == nil || !strings.Contains(err.Error(), "terminal_handle_stale") {
		t.Errorf("idle probe: %v", err)
	}
	if _, err := TerminalExited(stale); err == nil || !strings.Contains(err.Error(), "terminal_handle_stale") {
		t.Errorf("exit probe: %v", err)
	}
	if state, err := AgentStateFrom(claudeShown, idleSatisfied, stale); err == nil || state == Gone {
		t.Errorf("a refused exit probe read as gone: %s %v", state, err)
	}
	if _, err := PresentFrom(claudeShown, stale); err == nil {
		t.Error("presentFrom read a refusal as absent")
	}
	if _, err := Unwrap(json.RawMessage(`{"result":{}}`), "orca terminal show"); err == nil || !strings.HasPrefix(err.Error(), "orca terminal show did not answer with an orca envelope") {
		t.Errorf("unwrap: %v", err)
	}
	if exitedNow, err := TerminalExited(idleTimedOut); err != nil || exitedNow {
		t.Errorf("a timed-out exit probe is a live pty: %v %v", exitedNow, err)
	}
}

func TestPresentFromAgreesWithAgentStateFrom(t *testing.T) {
	cases := []struct {
		name       string
		show, exit json.RawMessage
	}{{"live claude", claudeShown, nil}, {"exited pty", claudeShown, exited}, {"bare shell", shellShown, nil}, {"stale", stale, nil}, {"blocked", blockedShown, nil}}
	for _, c := range cases {
		for _, idle := range []json.RawMessage{idleSatisfied, idleTimedOut} {
			state, err := AgentStateFrom(c.show, idle, c.exit)
			present, perr := PresentFrom(c.show, c.exit)
			if err != nil || perr != nil || present != (state != Gone) {
				t.Errorf("%s: state %s present %v (%v %v)", c.name, state, present, err, perr)
			}
		}
	}
}

func TestSettledAndLeftoverAction(t *testing.T) {
	for state, want := range map[AgentState]bool{Idle: true, Gone: true, Working: false, Blocked: false} {
		if IsSettled(state) != want {
			t.Errorf("IsSettled(%s)", state)
		}
	}
	for _, reported := range []bool{true, false} {
		for _, sent := range []bool{true, false} {
			if LeftoverAction(Gone, reported, sent) != "close" {
				t.Error("an exited runner is always closed")
			}
			for _, busy := range []AgentState{Working, Blocked} {
				if LeftoverAction(busy, reported, sent) != "hold" {
					t.Errorf("%s runner touched", busy)
				}
			}
		}
	}
	if LeftoverAction(Idle, true, false) != "exit" || LeftoverAction(Idle, false, false) != "hold" || LeftoverAction(Idle, true, true) != "hold" {
		t.Error("idle: exit only when reported, and only once")
	}
}

func TestShellCommandAndEnvArgs(t *testing.T) {
	cases := map[string][]string{
		`direnv exec /Users/cadam/code/aice-x/aice teamclaude run -- --name 'aice-x program runner'\''s'`: {"direnv", "exec", "/Users/cadam/code/aice-x/aice", "teamclaude", "run", "--", "--name", "aice-x program runner's"},
		`~/.local/bin/claude --name 'relliq program runner'`:                                              {"~/.local/bin/claude", "--name", "relliq program runner"},
		`cat ~/'.drovr/programs/my prog/last-cycle.json'`:                                                 {"cat", "~/.drovr/programs/my prog/last-cycle.json"},
		`'~alone'`: {"~alone"},
	}
	for want, argv := range cases {
		if got := ShellCommand(argv); got != want {
			t.Errorf("ShellCommand(%q) = %s", argv, got)
		}
	}
	if EnvArgs("") != nil || strings.Join(EnvArgs("a7a12606"), " ") != "--environment a7a12606" {
		t.Error("EnvArgs")
	}
}

func TestTerminalAddress(t *testing.T) {
	a := TerminalAddress(claudeShown, "term_844e8720-ac95-453c-bb73-7e2fd567479a", "")
	if a.Where != `its "✳ Claude Code" tab in sunnyt` || a.Open == nil || *a.Open != "orca terminal switch --terminal term_844e8720-ac95-453c-bb73-7e2fd567479a" {
		t.Errorf("%+v", a)
	}
	if OpenLine(a) != "\n  look:  orca terminal switch --terminal term_844e8720-ac95-453c-bb73-7e2fd567479a" {
		t.Errorf("%q", OpenLine(a))
	}
	remote := TerminalAddress(json.RawMessage(`{"ok":true,"result":{"terminal":{"handle":"term_1","agentIdentity":"claude","title":"relliq cycles","worktreePath":"/home/ubuntu/code/propra/relliq"}}}`), "term_1", "a7a12606")
	if remote.Where != `its "relliq cycles" tab in relliq` || *remote.Open != "orca terminal switch --terminal term_1 --environment a7a12606" {
		t.Errorf("%+v", remote)
	}
	for _, show := range []json.RawMessage{restoredShell, stale, nil} {
		if a := TerminalAddress(show, "term_dead", ""); a.Where != "terminal term_dead" || a.Open != nil || OpenLine(a) != "" {
			t.Errorf("%s: %+v", show, a)
		}
	}
}

func TestAdoptHandleByTabID(t *testing.T) {
	list := json.RawMessage(`{"id":"94745afa","ok":true,"result":{"terminals":[{"handle":"term_3998","tabId":"tab-other","agentIdentity":null},{"handle":"term_5b2e","tabId":"tab-drovr","agentIdentity":"claude"}]}}`)
	if h, ok, err := AdoptHandle(list, "tab-drovr"); err != nil || !ok || h != "term_5b2e" {
		t.Errorf("%s %v %v", h, ok, err)
	}
	if _, ok, err := AdoptHandle(list, "tab-gone"); err != nil || ok {
		t.Errorf("%v %v", ok, err)
	}
}

func TestPreviewText(t *testing.T) {
	read := json.RawMessage(`{"id":"a1eff3f9","ok":true,"result":{"terminal":{"handle":"term_844e8720","status":"running","tail":["❯","──────","  using Fable 5.1 | ctx:15% (148k)"],"truncated":false}}}`)
	if got, err := PreviewText(read); err != nil || got != "❯\n──────\n  using Fable 5.1 | ctx:15% (148k)" {
		t.Fatalf("%q %v", got, err)
	}
}

func TestRememberedTerminal(t *testing.T) {
	p := paths.Paths{Base: t.TempDir()}
	var log bytes.Buffer
	if RememberedTerminal(p, "aice-x", &log) != nil {
		t.Fatal("no file yet must be nil")
	}
	want := Remembered{Handle: "term_a1b2", TabID: "tab-1", WorktreeID: "repo-1::/Users/cadam/code/aice-x/aice"}
	if err := os.MkdirAll(p.ProgramState("aice-x"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := RememberTerminal(p, "aice-x", want); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(p.CycleTerminal("aice-x"))
	if string(raw) != "{\n  \"handle\": \"term_a1b2\",\n  \"tabId\": \"tab-1\",\n  \"worktreeId\": \"repo-1::/Users/cadam/code/aice-x/aice\"\n}\n" {
		t.Fatalf("file bytes %q", raw)
	}
	if got := RememberedTerminal(p, "aice-x", &log); got == nil || *got != want {
		t.Fatalf("%+v", got)
	}
	for _, body := range []string{"{ this is not json", `{"paneId":"old-shape"}`} {
		os.WriteFile(filepath.Join(p.ProgramState("aice-x"), "cycle-terminal.json"), []byte(body), 0o644)
		if RememberedTerminal(p, "aice-x", &log) != nil {
			t.Errorf("%q read as a terminal", body)
		}
	}
	if !strings.Contains(log.String(), "treating aice-x as having no runner terminal") {
		t.Errorf("unreadable file not logged: %q", log.String())
	}
}
