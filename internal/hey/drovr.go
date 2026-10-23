package hey

import (
	"context"
	"net/http"
	"time"
)

// The four calls drovr makes (src/hey.ts's send, readPrefs, setProfile, putStatus), over the
// copied client. Everything below the exported names is the hey repo's; only this file and
// icon.go are drovr's own.

var ErrNotSignedIn = errNotSignedIn

// DefaultCaller is the config's endpoint, the credentials file under home and the real clock.
// A malformed hey.json is the error, so a caller building it inside its guard gets a reason.
func DefaultCaller(home string) (Call, error) {
	return defaultCallerWith(home, http.DefaultClient.Do)
}

func defaultCallerWith(home string, do httpDo) (Call, error) {
	cfg, err := readConfig(configPath(home))
	if err != nil {
		return nil, err
	}
	return toolCaller(callerDeps{http: do, endpoint: cfg.Endpoint, path: credentialsPath(home), now: time.Now}), nil
}

type SendInput struct{ To, From, Host, Cwd, Text string }

type Sent struct {
	ID     string
	Pushed bool
	Reason *string
}

func Send(ctx context.Context, call Call, in SendInput) (Sent, error) {
	res, err := send(ctx, call, sendRequest{To: in.To, From: in.From, Host: in.Host, Cwd: in.Cwd, Text: in.Text})
	if err != nil {
		return Sent{}, err
	}
	return Sent{ID: res.ID, Pushed: res.Pushed, Reason: res.Reason}, nil
}

type Prefs struct{ Away bool }

func ReadPrefs(ctx context.Context, call Call, to string) (Prefs, error) {
	p, err := readPrefs(ctx, call, to)
	if err != nil {
		return Prefs{}, err
	}
	return Prefs{Away: p.Away}, nil
}

// A nil field stays off the wire: the handler merges, and an absent field must not read as "clear".
type ProfileInput struct {
	To, From             string
	Icon, Summary, Color *string
}

func SetProfile(ctx context.Context, call Call, in ProfileInput) error {
	_, err := setProfile(ctx, call, profileRequest{To: in.To, From: in.From, Icon: in.Icon, Summary: in.Summary, Color: in.Color})
	return err
}

// The tick's row carries no program, so the handler defaults it to drovr. hey's own
// statusPutRequest always sends one; this keeps the call byte-identical to the TS.
type StatusInput struct{ To, Host, At, Payload string }

type statusRequest struct {
	To      string `json:"to"`
	Host    string `json:"host"`
	At      string `json:"at"`
	Payload string `json:"payload"`
}

type statusAck struct {
	SK        string  `json:"sk"`
	At        string  `json:"at"`
	ExpiresAt float64 `json:"expiresAt"`
}

func PutStatus(ctx context.Context, call Call, in StatusInput) error {
	body, err := call(ctx, "putStatus", statusRequest{To: in.To, Host: in.Host, At: in.At, Payload: in.Payload})
	if err != nil {
		return err
	}
	_, err = decodeInto("putStatus", body, []string{"sk", "at", "expiresAt"}, false, func(a statusAck) error { return nonEmpty("sk", a.SK) })
	return err
}
