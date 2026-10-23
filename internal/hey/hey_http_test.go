package hey

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type recordedRequest struct {
	method, url, body string
	header            http.Header
}

// fakeHTTP answers requests in order from `answers` and records what was sent.
type fakeHTTP struct {
	answers []*http.Response
	sent    []recordedRequest
}

func respond(status int, body string) *http.Response {
	return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(body)), Header: http.Header{}}
}

func (f *fakeHTTP) do(req *http.Request) (*http.Response, error) {
	body := ""
	if req.Body != nil {
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			return nil, err
		}
		body = string(raw)
	}
	f.sent = append(f.sent, recordedRequest{method: req.Method, url: req.URL.String(), body: body, header: req.Header})
	if len(f.answers) == 0 {
		return nil, errors.New("fakeHTTP: no answer left")
	}
	next := f.answers[0]
	f.answers = f.answers[1:]
	return next, nil
}

var at = time.Date(2026, 10, 17, 10, 0, 0, 0, time.UTC)

func fixedNow() time.Time { return at }

func validCreds() credentials {
	return credentials{Access: "acc", Refresh: "ref", ExpiresAt: "2026-10-17T11:00:00.000Z", Issuer: "https://hey.drovr.app"}
}

func TestCredentialsFileRoundTripBytesAndMode(t *testing.T) {
	home := t.TempDir()
	path := credentialsPath(home)
	if path != filepath.Join(home, ".config", "hey", "credentials.json") {
		t.Fatal(path)
	}
	if err := writeCredentials(path, validCreds()); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	// JSON.stringify(creds, null, 2) + "\n", keys in the Node CLI's order.
	want := "{\n  \"access\": \"acc\",\n  \"refresh\": \"ref\",\n  \"expiresAt\": \"2026-10-17T11:00:00.000Z\",\n  \"issuer\": \"https://hey.drovr.app\"\n}\n"
	if string(raw) != want {
		t.Fatalf("got %q", raw)
	}
	info, _ := os.Stat(path)
	dir, _ := os.Stat(filepath.Dir(path))
	if info.Mode().Perm() != 0o600 || dir.Mode().Perm() != 0o700 {
		t.Fatalf("file %o dir %o", info.Mode().Perm(), dir.Mode().Perm())
	}
	got, err := readCredentials(path)
	if err != nil || got == nil || *got != validCreds() {
		t.Fatalf("got %+v, %v", got, err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	if len(entries) != 1 {
		t.Fatalf("the staged file must be renamed away: %v", entries)
	}
	deleteCredentials(path)
	if got, err := readCredentials(path); err != nil || got != nil {
		t.Fatalf("after delete: %+v, %v", got, err)
	}
	if err := deleteCredentials(path); err != nil {
		t.Fatal("deleting a missing file is not an error (rmSync force)")
	}
}

func TestReadCredentialsMissingBadJSONAndBadShape(t *testing.T) {
	dir := t.TempDir()
	got, err := readCredentials(filepath.Join(dir, "none.json"))
	if err != nil || got != nil {
		t.Fatalf("missing: %+v, %v", got, err)
	}
	path := filepath.Join(dir, "credentials.json")
	writeFile(t, path, "{nope")
	_, err = readCredentials(path)
	if err == nil || !strings.HasPrefix(err.Error(), path+" is not JSON (") || !strings.HasSuffix(err.Error(), "): run hey login") {
		t.Fatalf("got %v", err)
	}
	for body, field := range map[string]string{
		`{"refresh":"r","expiresAt":"2026-10-17T11:00:00.000Z","issuer":"https://x"}`:              "access",
		`{"access":"","refresh":"r","expiresAt":"2026-10-17T11:00:00.000Z","issuer":"https://x"}`:  "access",
		`{"access":"a","refresh":"r","expiresAt":"yesterday","issuer":"https://x"}`:                "expiresAt",
		`{"access":"a","refresh":"r","expiresAt":"2026-10-17T11:00:00.000Z","issuer":"not a url"}`: "issuer",
		`{"access":"a","refresh":5,"expiresAt":"2026-10-17T11:00:00.000Z","issuer":"https://x"}`:   "refresh",
		`[]`: "shape",
	} {
		writeFile(t, path, body)
		_, err = readCredentials(path)
		if err == nil || err.Error() != path+" is not a hey credentials file ("+field+"): run hey login" {
			t.Fatalf("%s: got %v", body, err)
		}
	}
}

func TestIssuerOfIsTheOrigin(t *testing.T) {
	if issuerOf("https://hey.drovr.app/mcp") != "https://hey.drovr.app" || issuerOf("https://x.y:8443/a/b") != "https://x.y:8443" {
		t.Fatal(issuerOf("https://hey.drovr.app/mcp"))
	}
}

const rpcOK = `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"{\"id\":\"01A\"}"}],"structuredContent":{"id":"01A","createdAt":"c"}}}`

func TestCallToolOnceSendsTheEnvelopeAndReadsTheResult(t *testing.T) {
	f := &fakeHTTP{answers: []*http.Response{respond(200, rpcOK)}}
	out, err := callToolOnce(context.Background(), f.do, defaultEndpoint, "acc", "send", toRequest{To: "craig"})
	if err != nil || !out.ok || string(out.value) != `{"id":"01A","createdAt":"c"}` {
		t.Fatalf("got %+v, %v", out, err)
	}
	req := f.sent[0]
	if req.method != "POST" || req.url != defaultEndpoint || req.body != `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"send","arguments":{"to":"craig"}}}` {
		t.Fatalf("request %+v", req)
	}
	for key, want := range map[string]string{"Content-Type": "application/json", "Accept": "application/json, text/event-stream", "Mcp-Protocol-Version": "2025-06-18", "Authorization": "Bearer acc"} {
		if req.header.Get(key) != want {
			t.Fatalf("%s: %q", key, req.header.Get(key))
		}
	}
	// No structuredContent: the first content text is the JSON; no text at all is null.
	f = &fakeHTTP{answers: []*http.Response{respond(200, `{"result":{"content":[{"type":"text","text":"{\"n\":1}"}]}}`), respond(200, `{"result":{"content":[]}}`)}}
	out, _ = callToolOnce(context.Background(), f.do, defaultEndpoint, "acc", "read", struct{}{})
	if string(out.value) != `{"n":1}` {
		t.Fatalf("text content: %s", out.value)
	}
	out, _ = callToolOnce(context.Background(), f.do, defaultEndpoint, "acc", "read", struct{}{})
	if string(out.value) != "null" {
		t.Fatalf("no content: %s", out.value)
	}
}

func TestCallToolOnceErrors(t *testing.T) {
	cases := []struct {
		answer *http.Response
		want   string
	}{
		{respond(200, `{"result":{"content":[{"type":"text","text":"no message 01A"}],"isError":true}}`), "no message 01A"},
		{respond(200, `{"result":{"content":[],"isError":true}}`), "hey read failed"},
		{respond(200, `{"error":{"code":-32602,"message":"bad arguments"}}`), "hey read: bad arguments"},
		{respond(502, `<html>bad gateway</html>`), "hey.drovr.app answered 502: <html>bad gateway</html>"},
		{respond(200, `not json`), "hey read answered 200 with something that is not JSON: not json"},
		{respond(200, `{"result":{"content":[{"type":"text","text":"not json"}]}}`), "hey read answered with an unexpected shape"},
	}
	for _, c := range cases {
		f := &fakeHTTP{answers: []*http.Response{c.answer}}
		_, err := callToolOnce(context.Background(), f.do, defaultEndpoint, "acc", "read", struct{}{})
		if err == nil || !strings.HasPrefix(err.Error(), c.want) {
			t.Fatalf("want %q, got %v", c.want, err)
		}
	}
	f := &fakeHTTP{answers: []*http.Response{respond(401, `{"error":"invalid_token"}`)}}
	out, err := callToolOnce(context.Background(), f.do, defaultEndpoint, "acc", "read", struct{}{})
	if err != nil || out.ok {
		t.Fatalf("401 is an outcome, not an error: %+v %v", out, err)
	}
}

const tokenOK = `{"access_token":"acc2","refresh_token":"ref2","expires_in":3600,"token_type":"Bearer"}`

func callerFor(t *testing.T, f *fakeHTTP, creds *credentials) (Call, string) {
	t.Helper()
	path := credentialsPath(t.TempDir())
	if creds != nil {
		if err := writeCredentials(path, *creds); err != nil {
			t.Fatal(err)
		}
	}
	return toolCaller(callerDeps{http: f.do, endpoint: defaultEndpoint, path: path, now: fixedNow}), path
}

func TestToolCallerNotSignedInAndIssuerMismatch(t *testing.T) {
	call, _ := callerFor(t, &fakeHTTP{}, nil)
	if _, err := call(context.Background(), "whoami", struct{}{}); !errors.Is(err, errNotSignedIn) || err.Error() != "not signed in: run hey login" {
		t.Fatalf("got %v", err)
	}
	other := validCreds()
	other.Issuer = "https://hey.example.test"
	call, _ = callerFor(t, &fakeHTTP{}, &other)
	_, err := call(context.Background(), "whoami", struct{}{})
	if err == nil || err.Error() != "signed in to https://hey.example.test, but the endpoint is https://hey.drovr.app/mcp: run hey login" {
		t.Fatalf("got %v", err)
	}
}

func TestToolCallerRefreshesBeforeExpiryAndRewritesTheFile(t *testing.T) {
	expiring := validCreds()
	expiring.ExpiresAt = "2026-10-17T10:00:30.000Z" // 30s left, inside the 60s skew
	f := &fakeHTTP{answers: []*http.Response{respond(200, tokenOK), respond(200, rpcOK)}}
	call, path := callerFor(t, f, &expiring)
	if _, err := call(context.Background(), "send", toRequest{To: "craig"}); err != nil {
		t.Fatal(err)
	}
	refresh := f.sent[0]
	form, _ := url.ParseQuery(refresh.body)
	if refresh.url != "https://hey.drovr.app/mcp/token" || refresh.header.Get("Content-Type") != "application/x-www-form-urlencoded" || form.Get("grant_type") != "refresh_token" || form.Get("refresh_token") != "ref" || form.Get("client_id") != "hey-cli" {
		t.Fatalf("refresh %+v", refresh)
	}
	if f.sent[1].header.Get("Authorization") != "Bearer acc2" {
		t.Fatal("the call must carry the refreshed token")
	}
	got, _ := readCredentials(path)
	if got.Access != "acc2" || got.Refresh != "ref2" || got.ExpiresAt != "2026-10-17T11:00:00.000Z" || got.Issuer != "https://hey.drovr.app" {
		t.Fatalf("file after refresh: %+v", got)
	}
	// Plenty of time left: no refresh, one call.
	f = &fakeHTTP{answers: []*http.Response{respond(200, rpcOK)}}
	call, _ = callerFor(t, f, ptr(validCreds()))
	if _, err := call(context.Background(), "send", toRequest{To: "craig"}); err != nil || len(f.sent) != 1 {
		t.Fatalf("%v, %d requests", err, len(f.sent))
	}
}

// A refresh's 200 carries live tokens and the caller logs the error as its reason: a malformed
// one must name the field, never echo the tokens.
func TestMalformedTokenResponseNeverEchoesTheTokens(t *testing.T) {
	bodies := []string{
		`{"access_token":"SECRET-A","refresh_token":"SECRET-R"}`,
		`{"access_token":"SECRET-A","refresh_token":"SECRET-R","expires_in":"3600"}`,
		`{"access_token":"","refresh_token":"SECRET-R","expires_in":3600}`,
		`{"access_token":"SECRET-A","refresh_token":"SECRET-R","expires_in":36`,
	}
	for _, body := range bodies {
		expiring := validCreds()
		expiring.ExpiresAt = "2026-10-17T10:00:30.000Z"
		f := &fakeHTTP{answers: []*http.Response{respond(200, body)}}
		call, _ := callerFor(t, f, &expiring)
		_, err := call(context.Background(), "send", toRequest{To: "craig"})
		if err == nil || strings.Contains(err.Error(), "SECRET-A") || strings.Contains(err.Error(), "SECRET-R") {
			t.Fatalf("%s: %v", body, err)
		}
	}
}

func TestToolCallerRetriesOnceOn401ThenGivesUp(t *testing.T) {
	f := &fakeHTTP{answers: []*http.Response{respond(401, ""), respond(200, tokenOK), respond(200, rpcOK)}}
	call, _ := callerFor(t, f, ptr(validCreds()))
	out, err := call(context.Background(), "send", toRequest{To: "craig"})
	if err != nil || string(out) != `{"id":"01A","createdAt":"c"}` || len(f.sent) != 3 {
		t.Fatalf("got %s, %v after %d requests", out, err, len(f.sent))
	}
	f = &fakeHTTP{answers: []*http.Response{respond(401, ""), respond(200, tokenOK), respond(401, "")}}
	call, _ = callerFor(t, f, ptr(validCreds()))
	_, err = call(context.Background(), "send", toRequest{To: "craig"})
	if err == nil || err.Error() != "sign-in expired or revoked (the refreshed token was refused): run hey login" || len(f.sent) != 3 {
		t.Fatalf("got %v after %d requests; nothing is retried twice", err, len(f.sent))
	}
	f = &fakeHTTP{answers: []*http.Response{respond(401, ""), respond(400, `{"error":"invalid_grant","error_description":"revoked"}`)}}
	call, _ = callerFor(t, f, ptr(validCreds()))
	_, err = call(context.Background(), "send", toRequest{To: "craig"})
	if err == nil || err.Error() != "sign-in expired or revoked (revoked): run hey login" {
		t.Fatalf("got %v", err)
	}
	f = &fakeHTTP{answers: []*http.Response{respond(401, ""), respond(503, `down`)}}
	call, _ = callerFor(t, f, ptr(validCreds()))
	_, err = call(context.Background(), "send", toRequest{To: "craig"})
	if err == nil || err.Error() != "token refresh at https://hey.drovr.app answered 503: down" {
		t.Fatalf("got %v", err)
	}
}

// The most expensive regression there is: a retried send is a duplicate message. Only a 401 earns a second attempt.
func TestToolCallerMakesANon401FailureExactlyOnce(t *testing.T) {
	f := &fakeHTTP{answers: []*http.Response{respond(502, "bad gateway"), respond(200, rpcOK)}}
	call, _ := callerFor(t, f, ptr(validCreds()))
	if _, err := call(context.Background(), "send", toRequest{To: "craig"}); err == nil || len(f.sent) != 1 {
		t.Fatalf("a 502 must be reported after one attempt: %v, %d requests", err, len(f.sent))
	}
	f = &fakeHTTP{}
	call, _ = callerFor(t, f, ptr(validCreds()))
	if _, err := call(context.Background(), "send", toRequest{To: "craig"}); err == nil || len(f.sent) != 1 {
		t.Fatalf("a transport error must be reported after one attempt: %v, %d requests", err, len(f.sent))
	}
	f = &fakeHTTP{answers: []*http.Response{respond(200, `{"result":{"content":[{"type":"text","text":"signed in as craig, not x"}],"isError":true}}`), respond(200, rpcOK)}}
	call, _ = callerFor(t, f, ptr(validCreds()))
	if _, err := call(context.Background(), "send", toRequest{To: "x"}); err == nil || err.Error() != "signed in as craig, not x" || len(f.sent) != 1 {
		t.Fatalf("a tool error must be reported after one attempt: %v, %d requests", err, len(f.sent))
	}
}

const deviceOK = `{"device_code":"dev","user_code":"BCDF-GHJK","verification_uri":"https://hey.drovr.app/mcp/device","verification_uri_complete":"https://hey.drovr.app/mcp/device?user_code=BCDF-GHJK","expires_in":900,"interval":5}`

func TestStartDeviceLoginShapeAndErrors(t *testing.T) {
	f := &fakeHTTP{answers: []*http.Response{respond(200, deviceOK)}}
	device, err := startDeviceLogin(context.Background(), f.do, "https://hey.drovr.app")
	if err != nil || device.UserCode != "BCDF-GHJK" || device.Interval != 5 || device.ExpiresIn != 900 {
		t.Fatalf("got %+v, %v", device, err)
	}
	form, _ := url.ParseQuery(f.sent[0].body)
	if f.sent[0].url != "https://hey.drovr.app/mcp/device_authorization" || form.Get("client_id") != "hey-cli" {
		t.Fatalf("request %+v", f.sent[0])
	}
	f = &fakeHTTP{answers: []*http.Response{respond(200, `{"device_code":"dev","user_code":"X","verification_uri":"https://a/b","verification_uri_complete":"https://a/b?c","expires_in":900}`)}}
	device, err = startDeviceLogin(context.Background(), f.do, "https://hey.drovr.app")
	if err != nil || device.Interval != 5 {
		t.Fatalf("interval defaults to 5: %+v %v", device, err)
	}
	cases := []struct {
		answer *http.Response
		want   string
	}{
		{respond(500, `{"error":"server_error"}`), `device authorization at https://hey.drovr.app answered 500: {"error":"server_error"}`},
		{respond(503, `down`), "device authorization answered 503 with something that is not JSON: down"},
		{respond(200, `{"device_code":"dev"}`), "device authorization answer is missing user_code"},
	}
	for _, c := range cases {
		f = &fakeHTTP{answers: []*http.Response{c.answer}}
		_, err = startDeviceLogin(context.Background(), f.do, "https://hey.drovr.app")
		if err == nil || err.Error() != c.want {
			t.Fatalf("want %q, got %v", c.want, err)
		}
	}
}

func pollDevice(t *testing.T, ctx context.Context, f *fakeHTTP, device deviceAuthorization) (devicePoll, *fakeClock) {
	t.Helper()
	clock := &fakeClock{at: at}
	return pollDeviceLogin(ctx, pollInput{http: f.do, issuer: "https://hey.drovr.app", device: device, sleep: clock.sleep, now: clock.now}), clock
}

func TestPollDeviceLoginHonoursSlowDownAndSignsIn(t *testing.T) {
	pending := `{"error":"authorization_pending"}`
	f := &fakeHTTP{answers: []*http.Response{respond(400, pending), respond(400, `{"error":"slow_down"}`), respond(400, pending), respond(200, tokenOK)}}
	device := deviceAuthorization{DeviceCode: "dev", UserCode: "X", ExpiresIn: 900, Interval: 5}
	got, clock := pollDevice(t, context.Background(), f, device)
	if got.outcome != "signed-in" || got.credentials.Access != "acc2" || got.credentials.Issuer != "https://hey.drovr.app" {
		t.Fatalf("got %+v", got)
	}
	// 5 + 5 + 10 + 10 seconds slept: the interval grew by 5 s after slow_down and stayed there.
	if clock.at.Sub(at) != 30*time.Second {
		t.Fatalf("slept %s", clock.at.Sub(at))
	}
	form, _ := url.ParseQuery(f.sent[0].body)
	if f.sent[0].url != "https://hey.drovr.app/mcp/token" || form.Get("grant_type") != "urn:ietf:params:oauth:grant-type:device_code" || form.Get("device_code") != "dev" || form.Get("client_id") != "hey-cli" {
		t.Fatalf("poll %+v", f.sent[0])
	}
	if got.credentials.ExpiresAt != "2026-10-17T11:00:30.000Z" {
		t.Fatalf("expiresAt is the clock at the poll plus expires_in: %s", got.credentials.ExpiresAt)
	}
}

func TestPollDeviceLoginDeniedExpiredAndBounded(t *testing.T) {
	device := deviceAuthorization{DeviceCode: "dev", UserCode: "X", ExpiresIn: 900, Interval: 5}
	f := &fakeHTTP{answers: []*http.Response{respond(400, `{"error":"access_denied"}`)}}
	if got, _ := pollDevice(t, context.Background(), f, device); got.outcome != "denied" {
		t.Fatalf("got %+v", got)
	}
	f = &fakeHTTP{answers: []*http.Response{respond(400, `{"error":"expired_token"}`)}}
	if got, _ := pollDevice(t, context.Background(), f, device); got.outcome != "expired" {
		t.Fatalf("got %+v", got)
	}
	// Never approved: the deadline ends it, with a bounded number of polls even against a huge expires_in.
	long := device
	long.ExpiresIn = 86_400 * 7
	answers := make([]*http.Response, 0, 400)
	for range 400 {
		answers = append(answers, respond(400, `{"error":"authorization_pending"}`))
	}
	f = &fakeHTTP{answers: answers}
	got, clock := pollDevice(t, context.Background(), f, long)
	if got.outcome != "expired" || len(f.sent) > 361 || clock.at.Sub(at) > 30*time.Minute {
		t.Fatalf("got %+v after %d polls and %s", got, len(f.sent), clock.at.Sub(at))
	}
	f = &fakeHTTP{answers: []*http.Response{respond(400, `{"error":"invalid_client","error_description":"who?"}`)}}
	if got, _ := pollDevice(t, context.Background(), f, device); got.outcome != "failed" || got.reason != "device token poll refused: invalid_client who?" {
		t.Fatalf("got %+v", got)
	}
	f = &fakeHTTP{answers: []*http.Response{respond(500, `boom`)}}
	if got, _ := pollDevice(t, context.Background(), f, device); got.outcome != "failed" || got.reason != "device token poll answered 500 with something that is not JSON: boom" {
		t.Fatalf("got %+v", got)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if got, _ := pollDevice(t, ctx, &fakeHTTP{}, device); got.outcome != "interrupted" {
		t.Fatalf("Ctrl-C while waiting: %+v", got)
	}
}

func TestRevokeCredentials(t *testing.T) {
	f := &fakeHTTP{answers: []*http.Response{respond(200, `{}`)}}
	if err := revokeCredentials(context.Background(), f.do, validCreds()); err != nil {
		t.Fatal(err)
	}
	form, _ := url.ParseQuery(f.sent[0].body)
	if f.sent[0].url != "https://hey.drovr.app/mcp/revoke" || form.Get("token") != "ref" {
		t.Fatalf("revoke %+v", f.sent[0])
	}
	f = &fakeHTTP{answers: []*http.Response{respond(500, `nope`)}}
	err := revokeCredentials(context.Background(), f.do, validCreds())
	if err == nil || err.Error() != "revoke at https://hey.drovr.app answered 500: nope" {
		t.Fatalf("got %v", err)
	}
}

func TestJSSliceCutsInUTF16Units(t *testing.T) {
	if jsSlice("abc", 200) != "abc" || jsSlice("abcdef", 3) != "abc" || jsSlice("🦾🦾🦾", 4) != "🦾🦾" {
		t.Fatal("jsSlice must be String.prototype.slice(0, n)")
	}
}

func TestSleepCtxReturnsEarlyWhenCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	start := time.Now()
	if err := sleepCtx(ctx, time.Minute); !errors.Is(err, context.Canceled) || time.Since(start) > time.Second {
		t.Fatalf("got %v after %s", err, time.Since(start))
	}
	if err := sleepCtx(context.Background(), time.Millisecond); err != nil {
		t.Fatal(err)
	}
}
