package hey

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type recorder struct {
	tools, args []string
	answer      string
}

// Marshals as callToolOnce does (marshalJSON, HTML escaping off), so args read as the wire bytes.
func (r *recorder) call(_ context.Context, tool string, args any) (json.RawMessage, error) {
	b, err := marshalJSON(args, false)
	if err != nil {
		return nil, err
	}
	r.tools, r.args = append(r.tools, tool), append(r.args, strings.TrimSuffix(string(b), "\n"))
	return json.RawMessage(r.answer), nil
}

func TestPutStatusSendsNoProgram(t *testing.T) {
	r := &recorder{answer: `{"sk":"status#drovr@mac","at":"2026-10-16T18:40:00.000Z","expiresAt":1}`}
	err := PutStatus(context.Background(), r.call, StatusInput{To: "craig", Host: "mac", At: "2026-10-16T18:40:00.000Z", Payload: `{"a":"<b>"}`})
	if err != nil || r.tools[0] != "putStatus" || r.args[0] != `{"to":"craig","host":"mac","at":"2026-10-16T18:40:00.000Z","payload":"{\"a\":\"<b>\"}"}` {
		t.Fatalf("%v %v %v", err, r.tools, r.args)
	}
	r.answer = `{"at":"x"}`
	if err := PutStatus(context.Background(), r.call, StatusInput{To: "craig"}); err == nil {
		t.Fatal("an ack without sk is a shape error")
	}
}

func TestSendCarriesTheFiveFields(t *testing.T) {
	r := &recorder{answer: `{"id":"01J","createdAt":"2026-10-16T18:40:00.000Z","waitUntil":null,"pushed":false,"quiet":false,"reason":"no device"}`}
	sent, err := Send(context.Background(), r.call, SendInput{To: "craig", From: "sunnyt", Host: "mac", Cwd: "sunnyt", Text: "hi"})
	if err != nil || sent.ID != "01J" || sent.Pushed || sent.Reason == nil || *sent.Reason != "no device" {
		t.Fatalf("%+v %v", sent, err)
	}
	if r.args[0] != `{"to":"craig","from":"sunnyt","host":"mac","cwd":"sunnyt","text":"hi"}` {
		t.Fatalf("%s", r.args[0])
	}
}

// Only the fields given travel: the handler merges, and an absent field must not read as "clear".
func TestSetProfileSendsOnlyGivenFields(t *testing.T) {
	r := &recorder{answer: `{"profile":{"from":"sunnyt","icon":"🦾","summary":null,"color":null,"updatedAt":null}}`}
	icon := "🦾"
	if err := SetProfile(context.Background(), r.call, ProfileInput{To: "craig", From: "sunnyt", Icon: &icon}); err != nil {
		t.Fatal(err)
	}
	if r.tools[0] != "profile" || r.args[0] != `{"to":"craig","from":"sunnyt","icon":"🦾"}` {
		t.Fatalf("%v %s", r.tools, r.args[0])
	}
}

func TestDefaultCallerOverHTTPS(t *testing.T) {
	var auth, version string
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		auth, version = req.Header.Get("authorization"), req.Header.Get("mcp-protocol-version")
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{}"}],"structuredContent":{"prefs":{"quietHours":null,"away":true}}}}`))
	}))
	defer srv.Close()
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "hey.json"), []byte(`{"endpoint":"`+srv.URL+`/mcp"}`), 0o600)
	if err := writeCredentials(credentialsPath(home), credentials{Access: "acc", Refresh: "ref", ExpiresAt: "2099-01-01T00:00:00.000Z", Issuer: srv.URL}); err != nil {
		t.Fatal(err)
	}
	call, err := defaultCallerWith(home, srv.Client().Do)
	if err != nil {
		t.Fatal(err)
	}
	prefs, err := ReadPrefs(context.Background(), call, "craig")
	if err != nil || !prefs.Away || auth != "Bearer acc" || version != "2025-06-18" {
		t.Fatalf("%+v %v %q %q", prefs, err, auth, version)
	}
}

func TestDefaultCallerWithoutSignIn(t *testing.T) {
	call, err := DefaultCaller(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ReadPrefs(context.Background(), call, "craig"); !errors.Is(err, ErrNotSignedIn) {
		t.Fatalf("%v", err)
	}
	home := t.TempDir()
	os.MkdirAll(filepath.Join(home, ".config"), 0o700)
	os.WriteFile(filepath.Join(home, ".config", "hey.json"), []byte(`{"endpoint": 5}`), 0o600)
	if _, err := DefaultCaller(home); err == nil {
		t.Fatal("a malformed hey.json must be an error, which nudge turns into a reason")
	}
}

func TestIconForm(t *testing.T) {
	cases := map[string]string{
		"sf:globe": "symbol", "sf:paperplane.fill": "symbol", "sf:bad name": "",
		"🦾": "emoji", "📣": "emoji", "✳": "emoji", "👩‍💻": "emoji", "A": "", "a 🦾": "", "😀😀😀😀😀😀😀😀😀": "",
		"https://github.com/propra-tech.png?size=64": "url", "http://x": "",
		"data:image/png;base64,AAAA": "data", "data:image/png;base64,AA!A": "",
	}
	for icon, want := range cases {
		if got := IconForm(icon); got != want {
			t.Errorf("IconForm(%q) = %q want %q", icon, got, want)
		}
	}
	if IconForm("data:image/png;base64,"+repeat("A", 40_000)) != "" {
		t.Error("a data URL over 32 KB is not an icon")
	}
}

func repeat(s string, n int) string {
	out := make([]byte, 0, len(s)*n)
	for i := 0; i < n; i++ {
		out = append(out, s...)
	}
	return string(out)
}
