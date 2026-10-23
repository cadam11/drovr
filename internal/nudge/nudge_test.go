package nudge

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/hey"
	"github.com/cadam11/drovr/internal/paths"
)

type fakeHey struct {
	tools []string
	fail  error
}

const sentAnswer = `{"id":"01J","createdAt":"2026-10-16T18:40:00.000Z","waitUntil":null,"pushed":true,"quiet":false,"reason":null}`

func (f *fakeHey) call(_ context.Context, tool string, _ any) (json.RawMessage, error) {
	f.tools = append(f.tools, tool)
	if f.fail != nil {
		return nil, f.fail
	}
	answers := map[string]string{"send": sentAnswer, "prefs": `{"prefs":{"quietHours":null,"away":true}}`, "putStatus": `{"sk":"status#drovr@mac","at":"x","expiresAt":1}`}
	return json.RawMessage(answers[tool]), nil
}

func (f *fakeHey) caller() (hey.Call, error) { return f.call, nil }

func craig() *string { s := "craig"; return &s }

func TestAlertFrom(t *testing.T) {
	p := "sunnyt"
	if AlertFrom(&p, "mac") != "sunnyt" || AlertFrom(nil, "mac") != "drovr on mac" {
		t.Fatal("labels")
	}
}

func TestNullNotifyToIsANamedReason(t *testing.T) {
	var log bytes.Buffer
	f := &fakeHey{}
	c := Channel{Caller: f.caller, Host: "mac", Log: &log}
	r := c.TextCraig(context.Background(), "something broke", "drovr on mac")
	if r.Sent || r.Reason == nil || *r.Reason != "notifyTo is null in control.json, so the alert was dropped" || len(f.tools) != 0 {
		t.Fatalf("%+v %v", r, f.tools)
	}
	if log.String() != "notifyTo is null in control.json, so the alert was dropped: something broke\n" {
		t.Fatalf("%q", log.String())
	}
	if p := c.PublishStatus(context.Background(), "at", "{}"); p.Sent || *p.Reason != "notifyTo is null in control.json" {
		t.Fatalf("%+v", p)
	}
	if pr := c.PhonePrefs(context.Background()); pr.Away || pr.Warning != nil {
		t.Fatalf("no handle is no phone, not a warning: %+v", pr)
	}
	if log.Len() != len("notifyTo is null in control.json, so the alert was dropped: something broke\n") {
		t.Fatal("a null notifyTo publish is quiet")
	}
}

func TestSendsAndReads(t *testing.T) {
	f := &fakeHey{}
	c := Channel{NotifyTo: craig(), Caller: f.caller, Host: "mac", Log: &bytes.Buffer{}}
	if r := c.TextCraig(context.Background(), "hi", "sunnyt"); !r.Sent || *r.MessageID != "01J" || r.Via != "hey" {
		t.Fatalf("%+v", r)
	}
	if p := c.PublishStatus(context.Background(), "2026-10-16T18:40:00.000Z", "{}"); !p.Sent || p.Reason != nil {
		t.Fatalf("%+v", p)
	}
	if pr := c.PhonePrefs(context.Background()); !pr.Away || pr.Warning != nil {
		t.Fatalf("%+v", pr)
	}
}

func TestFailuresAreReasonsNeverThrows(t *testing.T) {
	var log bytes.Buffer
	f := &fakeHey{fail: errors.New("The security token included in the request is expired")}
	c := Channel{NotifyTo: craig(), Caller: f.caller, Host: "mac", Log: &log}
	if p := c.PublishStatus(context.Background(), "at", "{}"); p.Sent || !strings.Contains(*p.Reason, "security token") {
		t.Fatalf("%+v", p)
	}
	if pr := c.PhonePrefs(context.Background()); pr.Away || !strings.HasPrefix(*pr.Warning, "could not read the phone's prefs (The security token") || !strings.HasSuffix(*pr.Warning, "— this pass runs on the stored mode") {
		t.Fatalf("%+v", pr)
	}
}

func TestWithoutSignInEveryPathNamesHeyLogin(t *testing.T) {
	home := t.TempDir()
	var log bytes.Buffer
	c := Channel{NotifyTo: craig(), Caller: func() (hey.Call, error) { return hey.DefaultCaller(home) }, Host: "mac", Log: &log}
	if r := c.TextCraig(context.Background(), "x", "drovr on mac"); r.Sent || !strings.Contains(*r.Reason, "run hey login") {
		t.Fatalf("%+v", r)
	}
	if !strings.Contains(log.String(), "— run hey login in a terminal as ") {
		t.Fatalf("sign-in hint missing: %q", log.String())
	}
	if pr := c.PhonePrefs(context.Background()); !strings.Contains(*pr.Warning, "run hey login") {
		t.Fatalf("%+v", pr)
	}
}

func TestPublishStatusMalformedConfigIsAReason(t *testing.T) {
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "hey.json"), []byte(`{"endpoint": 5}`), 0o600)
	c := Channel{NotifyTo: craig(), Caller: func() (hey.Call, error) { return hey.DefaultCaller(home) }, Host: "mac", Log: &bytes.Buffer{}}
	if p := c.PublishStatus(context.Background(), "at", "{}"); p.Sent || !strings.Contains(*p.Reason, "hey.json") {
		t.Fatalf("%+v", p)
	}
}

func TestNudgeOncePerAsk(t *testing.T) {
	base := t.TempDir()
	p := paths.Paths{Base: base, Logs: filepath.Join(base, "logs")}
	f := &fakeHey{}
	c := Channel{NotifyTo: craig(), Caller: f.caller, Host: "mac", Log: &bytes.Buffer{}}
	var out bytes.Buffer
	n := Neglect{Program: "sunnyt", Asks: 2, AskedAt: 0, Now: 239 * 60_000, AfterMinutes: 240}
	if sent, err := c.NudgeIfNeglected(context.Background(), p, &out, n); err != nil || sent {
		t.Fatalf("before the window: %v %v", sent, err)
	}
	n.Now = 5 * 3_600_000
	if sent, err := c.NudgeIfNeglected(context.Background(), p, &out, n); err != nil || !sent {
		t.Fatalf("%v %v", sent, err)
	}
	if sent, _ := c.NudgeIfNeglected(context.Background(), p, &out, n); sent {
		t.Fatal("one nudge per ask, not one per tick")
	}
	raw, _ := os.ReadFile(p.Nudged("sunnyt"))
	if string(raw) != `{"askedAt":0,"sentAt":18000000}`+"\n" || out.String() != "sent hey about sunnyt (2 ask(s), blocked 5h)\n" {
		t.Fatalf("%q %q", raw, out.String())
	}
	n.AskedAt = 60_000
	if sent, _ := c.NudgeIfNeglected(context.Background(), p, &out, n); !sent {
		t.Fatal("a new ask is nudged again")
	}
	if strings.Count(strings.Join(f.tools, ","), "send") != 2 {
		t.Fatalf("%v", f.tools)
	}
}
