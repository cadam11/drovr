package cli

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/paths"
	"github.com/cadam11/drovr/internal/service"
)

func cliEnv(t *testing.T, control string) (Env, *bytes.Buffer, *bytes.Buffer) {
	t.Setenv("DROVR_HOME", t.TempDir())
	p := paths.New()
	if err := os.WriteFile(p.Control, []byte(control), 0o644); err != nil {
		t.Fatal(err)
	}
	out, errs := &bytes.Buffer{}, &bytes.Buffer{}
	return Env{Paths: p, Now: func() epoch.Millis { return epoch.MustParse("2026-08-28T12:00:00Z") }, Stdout: out, Stderr: errs, Self: "/opt/homebrew/bin/drovr", Host: "mac", Home: t.TempDir()}, out, errs
}

func TestReportWritesAndAppliesTheRest(t *testing.T) {
	env, out, _ := cliEnv(t, `{"programs":[{"name":"sunnyt","cwd":"/s"}]}`)
	if err := Report(env, []string{"sunnyt", "--exit", "seam", "--pause-until", "48h", "--cadence", "7d"}); err != nil {
		t.Fatal(err)
	}
	want := "reported sunnyt: exit=seam → " + env.Paths.LastCycle("sunnyt") + "\n" +
		"sunnyt rests until 2026-08-30T12:00:00.000Z — resume early: drovr resume sunnyt\n" +
		"sunnyt now runs at most once per 7d — change: drovr cadence sunnyt off\n" +
		"the cycle is now over — drovr will close this session; start nothing new\n"
	if out.String() != want {
		t.Fatalf("%q", out.String())
	}
	raw, _ := os.ReadFile(env.Paths.Control)
	if !strings.Contains(string(raw), `"pauseUntil": "2026-08-30T12:00:00.000Z"`) || !strings.Contains(string(raw), `"cadence": "7d"`) {
		t.Fatalf("%s", raw)
	}
	if err := Report(env, []string{"nope", "--exit", "seam"}); err == nil || err.Error() != `no program named "nope" — tracked: sunnyt` {
		t.Fatalf("%v", err)
	}
}

func TestNotify(t *testing.T) {
	env, _, errs := cliEnv(t, `{"notifyTo":null,"programs":[]}`)
	if err := Notify(context.Background(), env, []string{"hi"}, false); err == nil || !strings.Contains(errs.String(), "notifyTo is not set in ~/.drovr/control.json") {
		t.Fatalf("%v %s", err, errs)
	}
	env, out, _ := cliEnv(t, `{"notifyTo":"craig","programs":[]}`)
	env.Caller = func() (hey.Call, error) {
		return func(context.Context, string, any) (json.RawMessage, error) {
			return json.RawMessage(`{"id":"01J","createdAt":"x","waitUntil":null,"pushed":true,"quiet":false,"reason":null}`), nil
		}, nil
	}
	if err := Notify(context.Background(), env, []string{"hello", "there", "--json"}, true); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Sent      bool            `json:"sent"`
		ID        string          `json:"id"`
		To        string          `json:"to"`
		Message   string          `json:"message"`
		Note      string          `json:"note"`
		UsingThis json.RawMessage `json:"usingThis"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || !got.Sent || got.ID != "01J" || got.Message != "hello there" || len(got.UsingThis) == 0 {
		t.Fatalf("%s %v", out, err)
	}
	out.Reset()
	if err := Notify(context.Background(), env, nil, false); err != nil || out.String() != "sent 01J to craig\n" {
		t.Fatalf("%q %v", out, err)
	}
}

func TestServicePrintNamesThisBinary(t *testing.T) {
	env, out, _ := cliEnv(t, `{"programs":[]}`)
	if err := Service(context.Background(), env, []string{"print"}, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "<string>/opt/homebrew/bin/drovr</string>\n    <string>tick</string>\n  </array>") || !strings.Contains(out.String(), "<integer>600</integer>") {
		t.Fatalf("%s", out)
	}
	out.Reset()
	if err := Service(context.Background(), env, []string{"print", "--shadow"}, false); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out.String(), "tech.propra.drovr.shadow") || !strings.Contains(out.String(), "<string>--shadow</string>") || !strings.Contains(out.String(), "<integer>60</integer>") || !strings.Contains(out.String(), filepath.Join(env.Paths.Logs, "tick-shadow.err")) {
		t.Fatalf("%s", out)
	}
	if err := Service(context.Background(), env, []string{"reload"}, false); err == nil || err.Error() != `unknown service subcommand "reload" — expected status, install, uninstall or print (label: tech.propra.drovr)` {
		t.Fatalf("%v", err)
	}
	if err := Service(context.Background(), env, []string{"print", "soon"}, false); err == nil {
		t.Fatal("a non-numeric interval printed a plist")
	}
}

// The shadow tick must be built read-only and keep to its own lock and log: a shadow that
// rewrote cycle-terminal.json or took tick.lock would be a second live tick.
func TestTickEnvShadowIsReadOnly(t *testing.T) {
	env, _, _ := cliEnv(t, `{"programs":[]}`)
	live, shadow := TickEnv(env, false), TickEnv(env, true)
	if live.Shadow || live.Orca.ReadOnly || !shadow.Shadow || !shadow.Orca.ReadOnly || shadow.Self != env.Self || shadow.Asks == nil {
		t.Fatalf("live %+v\nshadow %+v", live, shadow)
	}
	if service.ShadowLogName != "tick-shadow" {
		t.Fatal(service.ShadowLogName)
	}
}
