package hey

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

// A port of src/hey-http.ts: the credentials file, the hand-written MCP client and the
// device-flow client. Every HTTP call goes through the injected `httpDo` with a 15 s budget.

const (
	callTimeout = 15 * time.Second
	// Refresh this close to expiry rather than at it, so a call that starts valid does not land expired.
	refreshSkew = 60 * time.Second
	// In the server SDK's SUPPORTED_PROTOCOL_VERSIONS; an absent header would be read as 2025-03-26.
	protocolVersion = "2025-06-18"
	deviceClientID  = "hey-cli"
	deviceGrant     = "urn:ietf:params:oauth:grant-type:device_code"
	// Caps the server's expires_in so the loop is bounded even against a server that claims a code lives for days.
	maxDeviceLifetime = 30 * time.Minute
	slowDownStep      = 5 * time.Second
	maxPollInterval   = 60 * time.Second
	// String.prototype.slice(0, 200): how much of a refused body the Node CLI quotes.
	quotedBodyUnits = 200
	formContentType = "application/x-www-form-urlencoded"
)

type httpDo func(*http.Request) (*http.Response, error)

var errNotSignedIn = errors.New("not signed in: run hey login")

func signInExpired(detail string) error {
	return fmt.Errorf("sign-in expired or revoked (%s): run hey login", detail)
}

// Field order is the file's key order: JSON.stringify(creds, null, 2) on the Node side.
type credentials struct {
	Access    string `json:"access"`
	Refresh   string `json:"refresh"`
	ExpiresAt string `json:"expiresAt"`
	Issuer    string `json:"issuer"`
}

func credentialsPath(home string) string {
	return filepath.Join(home, ".config", "hey", "credentials.json")
}

// The URL's origin: new URL(endpoint).origin.
func issuerOf(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	return parsed.Scheme + "://" + parsed.Host
}

// jsSlice is s.slice(0, n) in JavaScript: a cut measured in UTF-16 units.
func jsSlice(s string, n int) string {
	units := utf16.Encode([]rune(s))
	if len(units) <= n {
		return s
	}
	return string(utf16.Decode(units[:n]))
}

func isoMillis(t time.Time) string { return t.UTC().Format("2006-01-02T15:04:05.000Z") }

// The first zod issue's path, in the shape's field order; "shape" when the body is not an object.
func credentialsIssue(raw map[string]json.RawMessage, creds credentials) string {
	var strs = map[string]*string{"access": &creds.Access, "refresh": &creds.Refresh, "expiresAt": &creds.ExpiresAt, "issuer": &creds.Issuer}
	for _, key := range []string{"access", "refresh", "expiresAt", "issuer"} {
		var asString string
		if value, present := raw[key]; !present || json.Unmarshal(value, &asString) != nil || asString == "" {
			return key
		}
		*strs[key] = asString
	}
	if _, err := time.Parse(time.RFC3339Nano, creds.ExpiresAt); err != nil {
		return "expiresAt"
	}
	if parsed, err := url.Parse(creds.Issuer); err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return "issuer"
	}
	return ""
}

func readCredentials(path string) (*credentials, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		var notObject *json.UnmarshalTypeError
		if errors.As(err, &notObject) {
			return nil, fmt.Errorf("%s is not a hey credentials file (shape): run hey login", path)
		}
		return nil, fmt.Errorf("%s is not JSON (%s): run hey login", path, err)
	}
	var creds credentials
	if issue := credentialsIssue(raw, creds); issue != "" {
		return nil, fmt.Errorf("%s is not a hey credentials file (%s): run hey login", path, issue)
	}
	if err := json.Unmarshal(data, &creds); err != nil {
		return nil, fmt.Errorf("%s is not a hey credentials file (shape): run hey login", path)
	}
	return &creds, nil
}

// Staged through a rename so a concurrent reader never sees half a file; 0600 because it is a bearer.
func writeCredentials(path string, creds credentials) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body, err := marshalJSON(creds, true)
	if err != nil {
		return err
	}
	staged := fmt.Sprintf("%s.%d.tmp", path, os.Getpid())
	if err := os.WriteFile(staged, body, 0o600); err != nil {
		return err
	}
	if err := os.Chmod(staged, 0o600); err != nil {
		return err
	}
	return os.Rename(staged, path)
}

func deleteCredentials(path string) error {
	err := os.Remove(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}

// post is every HTTP call this file makes: bounded by callTimeout, body read whole.
func post(ctx context.Context, do httpDo, target, contentType string, headers map[string]string, body string) (int, string, error) {
	ctx, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	req.Header.Set("Content-Type", contentType)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	res, err := do(req)
	if err != nil {
		return 0, "", err
	}
	defer res.Body.Close()
	text, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, "", err
	}
	return res.StatusCode, string(text), nil
}

func postForm(ctx context.Context, do httpDo, target string, form url.Values) (int, string, error) {
	return post(ctx, do, target, formContentType, nil, form.Encode())
}

func isOK(status int) bool { return status >= 200 && status < 300 }

type tokenResponse struct {
	AccessToken  string  `json:"access_token"`
	RefreshToken string  `json:"refresh_token"`
	ExpiresIn    float64 `json:"expires_in"`
}

type oauthError struct {
	Error       string  `json:"error"`
	Description *string `json:"error_description"`
}

// A 200 here carries live tokens, so unlike every other decode the error names the failing field
// and never quotes the body: the reason is logged by the caller, and a token must never be.
func decodeTokens(what, text string) (tokenResponse, error) {
	if !json.Valid([]byte(text)) {
		return tokenResponse{}, fmt.Errorf("%s answered 200 with something that is not JSON", what)
	}
	var tokens tokenResponse
	err := requireKeys([]byte(text), []string{"access_token", "refresh_token", "expires_in"}, false)
	if err == nil {
		err = json.Unmarshal([]byte(text), &tokens)
	}
	if err == nil {
		err = errors.Join(nonEmpty("access_token", tokens.AccessToken), nonEmpty("refresh_token", tokens.RefreshToken))
	}
	if err != nil {
		return tokenResponse{}, fmt.Errorf("hey %s answered with an unexpected shape (%s)", what, strings.ReplaceAll(err.Error(), "\n", "; "))
	}
	return tokens, nil
}

func credentialsFrom(tokens tokenResponse, issuer string, now time.Time) credentials {
	return credentials{Access: tokens.AccessToken, Refresh: tokens.RefreshToken, ExpiresAt: isoMillis(now.Add(time.Duration(tokens.ExpiresIn * float64(time.Second)))), Issuer: issuer}
}

func oauthErrorOf(text string) (oauthError, bool) {
	var refusal oauthError
	if err := requireKeys([]byte(text), []string{"error"}, false); err != nil {
		return oauthError{}, false
	}
	if err := json.Unmarshal([]byte(text), &refusal); err != nil {
		return oauthError{}, false
	}
	return refusal, true
}

// RFC 6749 §6 against the shim's own token endpoint; the layout under the issuer is the shim's, so no metadata round trip.
func refreshCredentials(ctx context.Context, do httpDo, creds credentials, now func() time.Time) (credentials, error) {
	form := url.Values{"grant_type": {"refresh_token"}, "refresh_token": {creds.Refresh}, "client_id": {deviceClientID}}
	status, text, err := postForm(ctx, do, creds.Issuer+"/mcp/token", form)
	if err != nil {
		return credentials{}, err
	}
	if isOK(status) {
		tokens, err := decodeTokens("token refresh", text)
		if err != nil {
			return credentials{}, err
		}
		return credentialsFrom(tokens, creds.Issuer, now()), nil
	}
	if refusal, ok := oauthErrorOf(text); ok && refusal.Error == "invalid_grant" {
		return credentials{}, signInExpired(deref(refusal.Description, "invalid_grant"))
	}
	return credentials{}, fmt.Errorf("token refresh at %s answered %d: %s", creds.Issuer, status, jsSlice(text, quotedBodyUnits))
}

// The request envelope in the Node CLI's key order.
type rpcCall struct {
	JSONRPC string    `json:"jsonrpc"`
	ID      int       `json:"id"`
	Method  string    `json:"method"`
	Params  rpcParams `json:"params"`
}

type rpcParams struct {
	Name      string `json:"name"`
	Arguments any    `json:"arguments"`
}

type callOutcome struct {
	ok    bool
	value json.RawMessage
}

type rpcEnvelope struct {
	Result *struct {
		Content []struct {
			Type string  `json:"type"`
			Text *string `json:"text"`
		} `json:"content"`
		StructuredContent json.RawMessage `json:"structuredContent"`
		IsError           *bool           `json:"isError"`
	} `json:"result"`
	Error *struct {
		Code    float64 `json:"code"`
		Message string  `json:"message"`
	} `json:"error"`
}

// The tool's value: structuredContent, else the first content text parsed as JSON, else null.
func rpcValue(tool string, body []byte, env rpcEnvelope) (json.RawMessage, error) {
	if env.Result == nil || env.Result.Content == nil {
		return nil, shapeErr(tool, body, "missing result.content")
	}
	var text *string
	if len(env.Result.Content) > 0 {
		text = env.Result.Content[0].Text
	}
	if env.Result.IsError != nil && *env.Result.IsError {
		return nil, errors.New(deref(text, fmt.Sprintf("hey %s failed", tool)))
	}
	if env.Result.StructuredContent != nil {
		return env.Result.StructuredContent, nil
	}
	if text == nil {
		return json.RawMessage("null"), nil
	}
	if !json.Valid([]byte(*text)) {
		return nil, shapeErr(tool, body, "content text is not JSON")
	}
	return json.RawMessage(*text), nil
}

// One JSON-RPC tools/call against a stateless JSON-response server: no initialize, no session
// id. A tool error is returned with the tool's own text; a 401 is an outcome for the caller.
func callToolOnce(ctx context.Context, do httpDo, endpoint, access, tool string, args any) (callOutcome, error) {
	body, err := marshalJSON(rpcCall{JSONRPC: "2.0", ID: 1, Method: "tools/call", Params: rpcParams{Name: tool, Arguments: args}}, false)
	if err != nil {
		return callOutcome{}, err
	}
	headers := map[string]string{"Accept": "application/json, text/event-stream", "Mcp-Protocol-Version": protocolVersion, "Authorization": "Bearer " + access}
	status, text, err := post(ctx, do, endpoint, "application/json", headers, strings.TrimSuffix(string(body), "\n"))
	if err != nil {
		return callOutcome{}, err
	}
	if status == http.StatusUnauthorized {
		return callOutcome{ok: false}, nil
	}
	if !isOK(status) {
		return callOutcome{}, fmt.Errorf("%s answered %d: %s", hostOf(endpoint), status, jsSlice(text, quotedBodyUnits))
	}
	var env rpcEnvelope
	if !json.Valid([]byte(text)) {
		return callOutcome{}, fmt.Errorf("hey %s answered %d with something that is not JSON: %s", tool, status, jsSlice(text, quotedBodyUnits))
	}
	if err := json.Unmarshal([]byte(text), &env); err != nil {
		return callOutcome{}, shapeErr(tool, []byte(text), err.Error())
	}
	if env.Error != nil {
		return callOutcome{}, fmt.Errorf("hey %s: %s", tool, env.Error.Message)
	}
	value, err := rpcValue(tool, []byte(text), env)
	if err != nil {
		return callOutcome{}, err
	}
	return callOutcome{ok: true, value: value}, nil
}

func hostOf(endpoint string) string {
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return endpoint
	}
	return parsed.Host
}

type callerDeps struct {
	http     httpDo
	endpoint string
	path     string
	now      func() time.Time
}

func rotate(ctx context.Context, deps callerDeps, creds credentials) (credentials, error) {
	next, err := refreshCredentials(ctx, deps.http, creds, deps.now)
	if err != nil {
		return credentials{}, err
	}
	if err := writeCredentials(deps.path, next); err != nil {
		return credentials{}, err
	}
	return next, nil
}

func expiringSoon(creds credentials, now time.Time) bool {
	expiresAt, err := time.Parse(time.RFC3339Nano, creds.ExpiresAt)
	if err != nil {
		return true
	}
	return !expiresAt.Add(-refreshSkew).After(now)
}

// The Call every command uses. Refresh before expiry; on a 401 refresh once and retry once —
// safe for a send, because the shim refuses the bearer before any tool runs, so nothing was
// sent; anything else is returned after one attempt, since a retried send is a duplicate
// message and a retried read is the wait loop's job.
func toolCaller(deps callerDeps) Call {
	return func(ctx context.Context, tool string, args any) (json.RawMessage, error) {
		creds, err := readCredentials(deps.path)
		if err != nil {
			return nil, err
		}
		if creds == nil {
			return nil, errNotSignedIn
		}
		if creds.Issuer != issuerOf(deps.endpoint) {
			return nil, fmt.Errorf("signed in to %s, but the endpoint is %s: run hey login", creds.Issuer, deps.endpoint)
		}
		current := *creds
		if expiringSoon(current, deps.now()) {
			if current, err = rotate(ctx, deps, current); err != nil {
				return nil, err
			}
		}
		first, err := callToolOnce(ctx, deps.http, deps.endpoint, current.Access, tool, args)
		if err != nil || first.ok {
			return first.value, err
		}
		if current, err = rotate(ctx, deps, current); err != nil {
			return nil, err
		}
		second, err := callToolOnce(ctx, deps.http, deps.endpoint, current.Access, tool, args)
		if err != nil || second.ok {
			return second.value, err
		}
		return nil, signInExpired("the refreshed token was refused")
	}
}

// ─── Device login (RFC 8628, the client side) ─────────────────────────────────

type deviceAuthorization struct {
	DeviceCode              string  `json:"device_code"`
	UserCode                string  `json:"user_code"`
	VerificationURI         string  `json:"verification_uri"`
	VerificationURIComplete string  `json:"verification_uri_complete"`
	ExpiresIn               float64 `json:"expires_in"`
	Interval                float64 `json:"interval"`
}

func startDeviceLogin(ctx context.Context, do httpDo, issuer string) (deviceAuthorization, error) {
	status, text, err := postForm(ctx, do, issuer+"/mcp/device_authorization", url.Values{"client_id": {deviceClientID}})
	if err != nil {
		return deviceAuthorization{}, err
	}
	if !json.Valid([]byte(text)) {
		return deviceAuthorization{}, fmt.Errorf("device authorization answered %d with something that is not JSON: %s", status, jsSlice(text, quotedBodyUnits))
	}
	if !isOK(status) {
		return deviceAuthorization{}, fmt.Errorf("device authorization at %s answered %d: %s", issuer, status, jsSlice(text, quotedBodyUnits))
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(text), &raw); err != nil {
		return deviceAuthorization{}, errors.New("device authorization answer is missing a field")
	}
	for _, key := range []string{"device_code", "user_code", "verification_uri", "verification_uri_complete", "expires_in"} {
		if _, present := raw[key]; !present {
			return deviceAuthorization{}, fmt.Errorf("device authorization answer is missing %s", key)
		}
	}
	device := deviceAuthorization{Interval: 5}
	if err := json.Unmarshal([]byte(text), &device); err != nil || device.DeviceCode == "" || device.UserCode == "" || device.ExpiresIn <= 0 || device.Interval <= 0 {
		return deviceAuthorization{}, errors.New("device authorization answer is missing a field")
	}
	return device, nil
}

type devicePoll struct {
	outcome     string // signed-in | denied | expired | failed | interrupted
	credentials credentials
	reason      string
}

type pollInput struct {
	http   httpDo
	issuer string
	device deviceAuthorization
	sleep  func(context.Context, time.Duration) error
	now    func() time.Time
}

// One token poll: the answer is a kind, never a thrown refusal, so the loop stays linear.
func pollOnce(ctx context.Context, in pollInput) (kind string, creds credentials, err error) {
	form := url.Values{"grant_type": {deviceGrant}, "device_code": {in.device.DeviceCode}, "client_id": {deviceClientID}}
	status, text, err := postForm(ctx, in.http, in.issuer+"/mcp/token", form)
	if err != nil {
		return "", credentials{}, err
	}
	if !json.Valid([]byte(text)) {
		return "", credentials{}, fmt.Errorf("device token poll answered %d with something that is not JSON: %s", status, jsSlice(text, quotedBodyUnits))
	}
	if isOK(status) {
		tokens, err := decodeTokens("device token poll", text)
		if err != nil {
			return "", credentials{}, err
		}
		return "tokens", credentialsFrom(tokens, in.issuer, in.now()), nil
	}
	refusal, ok := oauthErrorOf(text)
	if !ok {
		return "", credentials{}, fmt.Errorf("device token poll answered %d: %s", status, jsSlice(text, quotedBodyUnits))
	}
	switch refusal.Error {
	case "authorization_pending", "slow_down", "access_denied", "expired_token":
		return refusal.Error, credentials{}, nil
	}
	return "", credentials{}, errors.New(strings.TrimSpace(fmt.Sprintf("device token poll refused: %s %s", refusal.Error, deref(refusal.Description, ""))))
}

// Bounded three ways: the deadline (expires_in, clamped), a poll count sized for the smallest
// interval, and the 60 s cap on how far slow_down can stretch the interval. Sleeps before every
// poll, as RFC 8628 §3.5 says, so the first poll is never inside the server's interval.
func pollDeviceLogin(ctx context.Context, in pollInput) devicePoll {
	lifetime := min(time.Duration(in.device.ExpiresIn*float64(time.Second)), maxDeviceLifetime)
	deadline := in.now().Add(lifetime)
	interval := time.Duration(in.device.Interval * float64(time.Second))
	maxPolls := int(math.Ceil(lifetime.Seconds()/interval.Seconds())) + 1
	for poll := 0; poll < maxPolls; poll++ {
		if in.now().Add(interval).After(deadline) {
			return devicePoll{outcome: "expired"}
		}
		if err := in.sleep(ctx, interval); err != nil {
			return devicePoll{outcome: "interrupted"}
		}
		kind, creds, err := pollOnce(ctx, in)
		switch {
		case ctx.Err() != nil:
			return devicePoll{outcome: "interrupted"}
		case err != nil:
			return devicePoll{outcome: "failed", reason: err.Error()}
		case kind == "tokens":
			return devicePoll{outcome: "signed-in", credentials: creds}
		case kind == "access_denied":
			return devicePoll{outcome: "denied"}
		case kind == "expired_token":
			return devicePoll{outcome: "expired"}
		case kind == "slow_down":
			interval = min(interval+slowDownStep, maxPollInterval)
		}
	}
	return devicePoll{outcome: "expired"}
}

// RFC 7009 with the refresh token: the shim revokes the whole session for either token.
func revokeCredentials(ctx context.Context, do httpDo, creds credentials) error {
	status, text, err := postForm(ctx, do, creds.Issuer+"/mcp/revoke", url.Values{"token": {creds.Refresh}})
	if err != nil {
		return err
	}
	if !isOK(status) {
		return fmt.Errorf("revoke at %s answered %d: %s", creds.Issuer, status, jsSlice(text, quotedBodyUnits))
	}
	return nil
}
