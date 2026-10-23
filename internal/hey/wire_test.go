package hey

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"
)

const messageBody = `{"id":"01A","from":"f","text":"t","createdAt":"c","waitUntil":null,"reply":null,"repliedAt":null}`

// recording answers every call with `body` (or `err`) and keeps "<tool> <args>" for each.
func recording(body string, err error) (Call, *[]string) {
	sent := &[]string{}
	return func(_ context.Context, tool string, args any) (json.RawMessage, error) {
		raw, marshalErr := marshalJSON(args, false)
		if marshalErr != nil {
			return nil, marshalErr
		}
		*sent = append(*sent, tool+" "+strings.TrimSpace(string(raw)))
		if err != nil {
			return nil, err
		}
		return json.RawMessage(body), nil
	}, sent
}

func TestSendCarriesOnlyTheFieldsGivenInTheNodeOrder(t *testing.T) {
	call, sent := recording(`{"id":"01A","createdAt":"c","waitUntil":null,"pushed":false,"quiet":false,"reason":"no devices registered"}`, nil)
	got, err := send(context.Background(), call, sendRequest{To: "craig", From: "f", Host: "h", Cwd: "c", Text: "t"})
	if err != nil || got.ID != "01A" || got.Quiet || got.WaitUntil != nil || *got.Reason != "no devices registered" {
		t.Fatalf("got %+v, %v", got, err)
	}
	if (*sent)[0] != `send {"to":"craig","from":"f","host":"h","cwd":"c","text":"t"}` {
		t.Fatalf("payload %s", (*sent)[0])
	}
	_, _ = send(context.Background(), call, sendRequest{To: "craig", From: "f", Host: "h", Cwd: "c", Text: "t", WaitSeconds: ptr(300), Choices: []string{"yes", "no"}, Multi: true})
	if (*sent)[1] != `send {"to":"craig","from":"f","host":"h","cwd":"c","text":"t","waitSeconds":300,"choices":["yes","no"],"multi":true}` {
		t.Fatalf("payload %s", (*sent)[1])
	}
}

func TestDecodeRefusesTheWrongShapeAndNamesTheBody(t *testing.T) {
	for _, body := range []string{
		`{"nope":true}`,
		`{"id":5,"createdAt":"c","waitUntil":null,"pushed":false,"quiet":false,"reason":null}`,
		`{"id":"","createdAt":"c","waitUntil":null,"pushed":false,"quiet":false,"reason":null}`,
		`{"id":"01A","createdAt":"c","pushed":true,"quiet":false,"reason":null}`,
		`{"id":"01A","createdAt":"c","waitUntil":null,"pushed":true,"reason":null}`,
		`[]`, `null`,
	} {
		_, err := decodeSendResponse([]byte(body))
		if err == nil || !strings.Contains(err.Error(), body) || strings.Contains(err.Error(), "\n") {
			t.Fatalf("%s: want a one-line error carrying the body, got %v", body, err)
		}
	}
	got, err := decodeSendResponse([]byte(`{"id":"01A","createdAt":"c","waitUntil":"w","pushed":true,"quiet":true,"reason":null,"extra":1}`))
	if err != nil || !got.Quiet || *got.WaitUntil != "w" || got.Reason != nil {
		t.Fatalf("got %+v, %v", got, err)
	}
}

func TestDecodeMessageRequiresEveryKeyAndKeepsAnEmptyReply(t *testing.T) {
	row, err := decodeMessage([]byte(messageBody))
	if err != nil || row.Reply != nil || row.Text != "t" || row.ID != "01A" {
		t.Fatalf("got %+v, %v", row, err)
	}
	row, err = decodeMessage([]byte(`{"id":"01A","from":"f","text":"t","createdAt":"c","waitUntil":"w","reply":"","repliedAt":"r","choices":["a"],"multi":true}`))
	if err != nil || row.Reply == nil || *row.Reply != "" || *row.RepliedAt != "r" {
		t.Fatalf("an empty reply is a reply: %+v, %v", row, err)
	}
	for _, body := range []string{
		`{"id":"01A","text":"t","waitUntil":null,"reply":"yes"}`,
		`{"id":"01A","text":"t"}`,
		`{"id":"","text":"t","waitUntil":null,"reply":null,"repliedAt":null}`,
	} {
		if _, err := decodeMessage([]byte(body)); err == nil {
			t.Fatalf("%s must be refused", body)
		}
	}
}

func TestDecodePrefsIsStrictAndProfileRequiresEveryKey(t *testing.T) {
	got, err := decodePrefs([]byte(`{"prefs":{"quietHours":null,"away":true}}`))
	if err != nil || !got.Away || got.QuietHours != nil {
		t.Fatalf("got %+v, %v", got, err)
	}
	got, _ = decodePrefs([]byte(`{"prefs":{"quietHours":{"from":"22:00","to":"07:00","tz":"America/Winnipeg"},"away":false}}`))
	if got.QuietHours == nil || got.QuietHours.TZ != "America/Winnipeg" {
		t.Fatalf("got %+v", got)
	}
	for _, body := range []string{`{"prefs":{"quietHours":null,"away":true,"theme":"dark"}}`, `{"prefs":{"away":true}}`, `{"prefs":{"quietHours":null}}`, `{"quietHours":null,"away":true}`, `{"prefs":{"quietHours":{"from":"22:00"},"away":false}}`, `{"prefs":{"quietHours":{"from":"22:00","to":"07:00","tz":5},"away":false}}`} {
		if _, err := decodePrefs([]byte(body)); err == nil {
			t.Fatalf("%s must be refused", body)
		}
	}
	profile, err := decodeProfile([]byte(`{"profile":{"from":"sunnyt","icon":"🦾","summary":null,"color":null,"updatedAt":"u"}}`))
	if err != nil || *profile.Icon != "🦾" || profile.Summary != nil {
		t.Fatalf("got %+v, %v", profile, err)
	}
	if _, err := decodeProfile([]byte(`{"profile":{"from":"sunnyt","icon":"🦾"}}`)); err == nil {
		t.Fatal("every profile key is required (nullable, not optional)")
	}
}

func TestDecodeWhoamiAndStatusRows(t *testing.T) {
	me, err := decodeWhoami([]byte(`{"email":"c@x.y","handle":"craig","sub":"s"}`))
	if err != nil || me.Email != "c@x.y" || me.Handle != "craig" || me.Sub != "s" {
		t.Fatalf("got %+v, %v", me, err)
	}
	for _, body := range []string{`{"email":"c@x.y","handle":"craig"}`, `{"email":"","handle":"craig","sub":"s"}`} {
		if _, err := decodeWhoami([]byte(body)); err == nil {
			t.Fatalf("%s must be refused", body)
		}
	}
	rows, err := decodeStatusRows([]byte(`{"status":[{"pk":"s","sk":"status#drovr@mac","host":"mac","at":"2026-10-17T10:00:00.000Z","payload":"{}","expiresAt":1}]}`))
	if err != nil || len(rows) != 1 || rows[0].Host != "mac" || rows[0].ExpiresAt != 1 {
		t.Fatalf("got %+v, %v", rows, err)
	}
	rows, err = decodeStatusRows([]byte(`{"status":[]}`))
	if err != nil || len(rows) != 0 {
		t.Fatalf("empty: %+v, %v", rows, err)
	}
	for _, body := range []string{`{"status":[{"pk":"s","sk":"msg#1","host":"mac","at":"a","payload":"{}","expiresAt":1}]}`, `{"status":[{"host":"mac"}]}`, `[]`} {
		if _, err := decodeStatusRows([]byte(body)); err == nil {
			t.Fatalf("%s must be refused", body)
		}
	}
}

func TestDescribeStatusRowReadsThePayloadLeniently(t *testing.T) {
	now := int64(1792231200000) // 2026-10-17T10:00:00.000Z
	row := statusRow{Program: "drovr", Host: "mac", At: "2026-10-17T09:47:30.000Z", Payload: `{"mode":"normal","capacity":{"cyclesFundable":1.2345,"bindingBucket":"unified7d"},"programs":[1,2,3]}`}
	want := "drovr@mac  2026-10-17T09:47:30.000Z (12m ago)  normal · 1.23 cycles fundable · unified7d binding · 3 programs"
	if got := describeStatusRow(row, now); got != want {
		t.Fatalf("got %q\nwant %q", got, want)
	}
	row.Payload = `{"capacity":null}`
	want = "drovr@mac  2026-10-17T09:47:30.000Z (12m ago)  ? · no capacity figure · 0 programs"
	if got := describeStatusRow(row, now); got != want {
		t.Fatalf("got %q", got)
	}
	for _, payload := range []string{`{"mode":7}`, `{"mode":"normal","capacity":{"cyclesFundable":0.5}}`, `{"capacity":{"bindingBucket":"unified7d"},"programs":[1]}`} {
		row.Payload = payload
		if got := describeStatusRow(row, now); got != want {
			t.Fatalf("a payload off the summary shape costs the words, not the line: %q for %s", got, payload)
		}
	}
	row.At = "2026-10-17T11:00:00.000Z"
	if got := describeStatusRow(row, now); !strings.Contains(got, "(0m ago)") {
		t.Fatalf("a clock ahead of ours is 0m, never negative: %q", got)
	}
}

func TestReadMessageTurnsNotFoundIntoMessageGone(t *testing.T) {
	gone, _ := recording("", errors.New("no message 01A"))
	_, err := readMessage(context.Background(), gone, "01A")
	if !errors.Is(err, errMessageGone) {
		t.Fatalf("got %v", err)
	}
	timeout, _ := recording("", errors.New("hey read: context deadline exceeded"))
	_, err = readMessage(context.Background(), timeout, "01A")
	if errors.Is(err, errMessageGone) || err.Error() != "hey read: context deadline exceeded" {
		t.Fatalf("other failures stay as they were: %v", err)
	}
	ok, sent := recording(messageBody, nil)
	row, err := readMessage(context.Background(), ok, "01A")
	if err != nil || row.Text != "t" || (*sent)[0] != `read {"id":"01A"}` {
		t.Fatalf("got %+v, %v, %v", row, err, *sent)
	}
}

func TestReadPrefsSetProfileWhoamiAndStatusRequests(t *testing.T) {
	call, sent := recording(`{"prefs":{"quietHours":null,"away":true}}`, nil)
	if _, err := readPrefs(context.Background(), call, "craig"); err != nil || (*sent)[0] != `prefs {"to":"craig"}` {
		t.Fatalf("%v %v", err, *sent)
	}
	call, sent = recording(`{"profile":{"from":"sunnyt","icon":"🦾","summary":null,"color":null,"updatedAt":"u"}}`, nil)
	_, err := setProfile(context.Background(), call, profileRequest{To: "craig", From: "sunnyt", Icon: ptr("🦾")})
	if err != nil || (*sent)[0] != `profile {"to":"craig","from":"sunnyt","icon":"🦾"}` {
		t.Fatalf("only the fields given travel: %v %v", err, *sent)
	}
	_, _ = setProfile(context.Background(), call, profileRequest{To: "craig", From: "sunnyt", Color: ptr("")})
	if (*sent)[1] != `profile {"to":"craig","from":"sunnyt","color":""}` {
		t.Fatalf(`"" must travel (it clears): %s`, (*sent)[1])
	}
	call, sent = recording(`{"email":"c@x.y","handle":"craig","sub":"s"}`, nil)
	if _, err := whoami(context.Background(), call); err != nil || (*sent)[0] != `whoami {}` {
		t.Fatalf("%v %v", err, *sent)
	}
	call, sent = recording(`{"status":[]}`, nil)
	if _, err := readStatuses(context.Background(), call, "craig"); err != nil || (*sent)[0] != `status {"to":"craig"}` {
		t.Fatalf("%v %v", err, *sent)
	}
}
