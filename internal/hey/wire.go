package hey

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"
)

// Call is src/hey.ts's Call: one MCP tool call, the tool's name and arguments in, its
// structured result out. Task 7's toolCaller is the only real one; the tests' fakes are closures.
type Call func(ctx context.Context, tool string, args any) (json.RawMessage, error)

// The handler's `not_found` message has this fixed prefix (lambda/hey/handler.ts NOT_FOUND_PREFIX).
const notFoundPrefix = "no message "

// The row a wait was polling is gone: Craig deleted the thread on the phone. Not a poll failure.
var errMessageGone = errors.New("the message was deleted on the phone")

// Requests are built in src/hey.ts's key order. Pointers with omitempty so an unset optional
// is absent, never null, and "" still travels.

type sendRequest struct {
	To          string   `json:"to"`
	From        string   `json:"from"`
	Host        string   `json:"host"`
	Cwd         string   `json:"cwd"`
	Text        string   `json:"text"`
	WaitSeconds *int     `json:"waitSeconds,omitempty"`
	Choices     []string `json:"choices,omitempty"`
	Multi       bool     `json:"multi,omitempty"`
}

type idRequest struct {
	ID string `json:"id"`
}

type toRequest struct {
	To string `json:"to"`
}

type profileRequest struct {
	To      string  `json:"to"`
	From    string  `json:"from"`
	Icon    *string `json:"icon,omitempty"`
	Summary *string `json:"summary,omitempty"`
	Color   *string `json:"color,omitempty"`
}

type sendResponse struct {
	ID        string  `json:"id"`
	CreatedAt string  `json:"createdAt"`
	WaitUntil *string `json:"waitUntil"`
	Pushed    bool    `json:"pushed"`
	Quiet     bool    `json:"quiet"`
	Reason    *string `json:"reason"`
}

// The `read` tool's shape (hey-mcp tools.ts publicMessage): absent becomes null there, so
// "answered" is Reply != nil here.
type message struct {
	ID        string  `json:"id"`
	From      string  `json:"from"`
	Text      string  `json:"text"`
	CreatedAt string  `json:"createdAt"`
	WaitUntil *string `json:"waitUntil"`
	Reply     *string `json:"reply"`
	RepliedAt *string `json:"repliedAt"`
}

type quietHours struct {
	From string `json:"from"`
	To   string `json:"to"`
	TZ   string `json:"tz"`
}

type prefs struct {
	QuietHours *quietHours `json:"quietHours"`
	Away       bool        `json:"away"`
}

type profile struct {
	From      string  `json:"from"`
	Icon      *string `json:"icon"`
	Summary   *string `json:"summary"`
	Color     *string `json:"color"`
	UpdatedAt *string `json:"updatedAt"`
}

type whoamiResponse struct {
	Email  string `json:"email"`
	Handle string `json:"handle"`
	Sub    string `json:"sub"`
}

type statusRow struct {
	PK string `json:"pk"`
	SK string `json:"sk"`
	// Absent on a row written before plan 12: drovr's (the handler's statusRowShape default).
	Program   string  `json:"program"`
	Host      string  `json:"host"`
	At        string  `json:"at"`
	Payload   string  `json:"payload"`
	ExpiresAt float64 `json:"expiresAt"`
}

func deref(s *string, fallback string) string {
	if s == nil {
		return fallback
	}
	return *s
}

// One line, body included: a redeploy that renamed a field is diagnosed from stderr alone.
func shapeErr(tool string, body []byte, detail string) error {
	return fmt.Errorf("hey %s answered with an unexpected shape (%s): %s", tool, detail, strings.ReplaceAll(string(body), "\n", " "))
}

// requireKeys is the zod presence check Go's Unmarshal does not do: a nullable field must still
// be present, and with strict every key must be known (prefsShape.strict()).
func requireKeys(body []byte, required []string, strict bool) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(body, &raw); err != nil {
		return err
	}
	if raw == nil {
		return errors.New("expected an object, got null")
	}
	for _, key := range required {
		if _, ok := raw[key]; !ok {
			return fmt.Errorf("missing %s", key)
		}
	}
	if !strict {
		return nil
	}
	for key := range raw {
		if !slices.Contains(required, key) {
			return fmt.Errorf("unknown key %s", key)
		}
	}
	return nil
}

func decodeInto[T any](tool string, body []byte, required []string, strict bool, check func(T) error) (T, error) {
	var out T
	if err := requireKeys(body, required, strict); err != nil {
		return out, shapeErr(tool, body, err.Error())
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, shapeErr(tool, body, err.Error())
	}
	if err := check(out); err != nil {
		return out, shapeErr(tool, body, err.Error())
	}
	return out, nil
}

// unwrap takes the one key a tool answers under ({prefs: …}, {profile: …}, {status: […]}).
func unwrap(tool string, body []byte, key string) (json.RawMessage, error) {
	var wrapper map[string]json.RawMessage
	if err := json.Unmarshal(body, &wrapper); err != nil {
		return nil, shapeErr(tool, body, err.Error())
	}
	inner, ok := wrapper[key]
	if !ok {
		return nil, shapeErr(tool, body, "missing "+key)
	}
	return inner, nil
}

func nonEmpty(name, value string) error {
	if value == "" {
		return fmt.Errorf("%s must be non-empty", name)
	}
	return nil
}

func decodeSendResponse(body []byte) (sendResponse, error) {
	return decodeInto("send", body, []string{"id", "createdAt", "waitUntil", "pushed", "quiet", "reason"}, false, func(r sendResponse) error {
		return nonEmpty("id", r.ID)
	})
}

func decodeMessage(body []byte) (message, error) {
	return decodeInto("read", body, []string{"id", "from", "text", "createdAt", "waitUntil", "reply", "repliedAt"}, false, func(m message) error {
		return nonEmpty("id", m.ID)
	})
}

func decodePrefs(body []byte) (prefs, error) {
	inner, err := unwrap("prefs", body, "prefs")
	if err != nil {
		return prefs{}, err
	}
	if err := requireKeys(inner, []string{"quietHours", "away"}, true); err != nil {
		return prefs{}, shapeErr("prefs", body, err.Error())
	}
	hours, err := unwrap("prefs", inner, "quietHours")
	if err != nil {
		return prefs{}, err
	}
	// The presence check has to read the nested bytes: a decoded struct re-marshals every key.
	if string(hours) != "null" {
		if err := requireKeys(hours, []string{"from", "to", "tz"}, false); err != nil {
			return prefs{}, shapeErr("prefs", body, err.Error())
		}
	}
	return decodeInto("prefs", inner, []string{"quietHours", "away"}, true, func(prefs) error { return nil })
}

func decodeProfile(body []byte) (profile, error) {
	inner, err := unwrap("profile", body, "profile")
	if err != nil {
		return profile{}, err
	}
	return decodeInto("profile", inner, []string{"from", "icon", "summary", "color", "updatedAt"}, false, func(profile) error { return nil })
}

func decodeWhoami(body []byte) (whoamiResponse, error) {
	return decodeInto("whoami", body, []string{"email", "handle", "sub"}, false, func(w whoamiResponse) error {
		return errors.Join(nonEmpty("email", w.Email), nonEmpty("handle", w.Handle), nonEmpty("sub", w.Sub))
	})
}

func decodeStatusRows(body []byte) ([]statusRow, error) {
	inner, err := unwrap("status", body, "status")
	if err != nil {
		return nil, err
	}
	var items []json.RawMessage
	if err := json.Unmarshal(inner, &items); err != nil {
		return nil, shapeErr("status", body, err.Error())
	}
	rows := make([]statusRow, 0, len(items))
	for _, item := range items {
		row, err := decodeInto("status", item, []string{"pk", "sk", "host", "at", "payload", "expiresAt"}, false, func(r statusRow) error {
			if !strings.HasPrefix(r.SK, "status#") {
				return errors.New("sk must start with status#")
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
		if err := defaultProgram(item, &row); err != nil {
			return nil, shapeErr("status", body, err.Error())
		}
		rows = append(rows, row)
	}
	return rows, nil
}

func send(ctx context.Context, call Call, req sendRequest) (sendResponse, error) {
	body, err := call(ctx, "send", req)
	if err != nil {
		return sendResponse{}, err
	}
	return decodeSendResponse(body)
}

func readMessage(ctx context.Context, call Call, id string) (message, error) {
	body, err := call(ctx, "read", idRequest{ID: id})
	if err != nil && strings.HasPrefix(err.Error(), notFoundPrefix) {
		return message{}, errMessageGone
	}
	if err != nil {
		return message{}, err
	}
	return decodeMessage(body)
}

func readPrefs(ctx context.Context, call Call, to string) (prefs, error) {
	body, err := call(ctx, "prefs", toRequest{To: to})
	if err != nil {
		return prefs{}, err
	}
	return decodePrefs(body)
}

func setProfile(ctx context.Context, call Call, req profileRequest) (profile, error) {
	body, err := call(ctx, "profile", req)
	if err != nil {
		return profile{}, err
	}
	return decodeProfile(body)
}

func whoami(ctx context.Context, call Call) (whoamiResponse, error) {
	body, err := call(ctx, "whoami", struct{}{})
	if err != nil {
		return whoamiResponse{}, err
	}
	return decodeWhoami(body)
}

func readStatuses(ctx context.Context, call Call, to string) ([]statusRow, error) {
	body, err := call(ctx, "status", toRequest{To: to})
	if err != nil {
		return nil, err
	}
	return decodeStatusRows(body)
}

// An absent program is drovr; a present one that is not a string is a shape error, never drovr.
func defaultProgram(item json.RawMessage, row *statusRow) error {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(item, &raw); err != nil {
		return err
	}
	value, present := raw["program"]
	if !present {
		row.Program = "drovr"
		return nil
	}
	if err := json.Unmarshal(value, &row.Program); err != nil {
		return errors.New("program must be a string")
	}
	return nil
}

// Read leniently: this is a summary line over a payload drovr owns, and a field off the
// shape costs the words, not the line (src/hey.ts statusSummaryShape.safeParse).
type statusSummary struct {
	Mode     *string            `json:"mode"`
	Capacity json.RawMessage    `json:"capacity"`
	Programs *[]json.RawMessage `json:"programs"`
}

type statusCapacity struct {
	CyclesFundable *float64 `json:"cyclesFundable"`
	BindingBucket  string   `json:"bindingBucket"`
}

// The capacity object, or nil when absent, null, or (as safeParse would have it) off the shape.
func capacityOf(raw json.RawMessage) (*statusCapacity, bool) {
	if raw == nil || string(raw) == "null" {
		return nil, true
	}
	if requireKeys(raw, []string{"cyclesFundable", "bindingBucket"}, false) != nil {
		return nil, false
	}
	var capacity statusCapacity
	if err := json.Unmarshal(raw, &capacity); err != nil {
		return nil, false
	}
	return &capacity, true
}

func summarise(payload []byte) (statusSummary, *statusCapacity) {
	var summary statusSummary
	if err := json.Unmarshal(payload, &summary); err != nil {
		return statusSummary{}, nil
	}
	capacity, ok := capacityOf(summary.Capacity)
	if !ok {
		return statusSummary{}, nil
	}
	return summary, capacity
}

func ageMinutes(at string, nowMs int64) int64 {
	then, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return 0
	}
	return max(0, int64(math.Floor(float64(nowMs-then.UnixMilli())/60_000)))
}

// Same leniency for a generic row: the phone is strict about this shape; a terminal summary is not the place to refuse it.
type genericSummary struct {
	Title *string            `json:"title"`
	Lines *[]json.RawMessage `json:"lines"`
}

func describeGenericRow(row statusRow, nowMs int64) string {
	var summary genericSummary
	if json.Unmarshal([]byte(row.Payload), &summary) != nil {
		summary = genericSummary{}
	}
	lines := 0
	if summary.Lines != nil {
		lines = len(*summary.Lines)
	}
	return fmt.Sprintf("%s@%s  %s (%dm ago)  %s · %d lines", row.Program, row.Host, row.At, ageMinutes(row.At, nowMs), deref(summary.Title, "?"), lines)
}

func describeStatusRow(row statusRow, nowMs int64) string {
	if row.Program != "drovr" {
		return describeGenericRow(row, nowMs)
	}
	summary, capacity := summarise([]byte(row.Payload))
	funding := "no capacity figure"
	if capacity != nil && capacity.CyclesFundable != nil {
		funding = strconv.FormatFloat(*capacity.CyclesFundable, 'f', 2, 64) + " cycles fundable · " + capacity.BindingBucket + " binding"
	}
	programs := 0
	if summary.Programs != nil {
		programs = len(*summary.Programs)
	}
	return fmt.Sprintf("drovr@%s  %s (%dm ago)  %s · %s · %d programs", row.Host, row.At, ageMinutes(row.At, nowMs), deref(summary.Mode, "?"), funding, programs)
}
