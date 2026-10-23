package shape

import (
	"encoding/json"
	"strings"
	"testing"
)

type sample struct {
	Name  string
	Count float64
	Note  *string
	Reset *float64
	Kind  string
}

func decodeSample(raw string) (sample, error) {
	o, err := Decode(json.RawMessage(raw), "programs[0]")
	if err != nil {
		return sample{}, err
	}
	s := sample{Count: 8, Kind: "orca"}
	Required(o, "name", &s.Name)
	Optional(o, "count", &s.Count)
	NullableDefault(o, "note", &s.Note)
	RequiredNullable(o, "reset", &s.Reset)
	Optional(o, "kind", &s.Kind)
	OneOf(o, "kind", s.Kind, []string{"orca", "headless"})
	return s, o.Err
}

func TestFieldRules(t *testing.T) {
	s, err := decodeSample(`{"name":"a","reset":null,"extra":1}`)
	if err != nil || s.Name != "a" || s.Count != 8 || s.Note != nil || s.Reset != nil || s.Kind != "orca" {
		t.Fatalf("%+v %v", s, err)
	}
	cases := map[string]string{
		`{"reset":1}`:                         "programs[0].name: required",
		`{"name":null,"reset":1}`:             "programs[0].name: required",
		`{"name":"a"}`:                        "programs[0].reset: required",
		`{"name":"a","reset":1,"count":null}`: "programs[0].count: expected a value, received null",
		`{"name":"a","reset":1,"count":"x"}`:  "programs[0].count: json: cannot unmarshal string",
		`{"name":"a","reset":1,"kind":"vm"}`:  `programs[0].kind: invalid enum value "vm", expected orca | headless`,
		`null`:                                "programs[0]: expected object, received null",
		`[1]`:                                 "programs[0]: expected object:",
	}
	for in, want := range cases {
		if _, err := decodeSample(in); err == nil || !strings.HasPrefix(err.Error(), want) {
			t.Errorf("%s: err = %v, want prefix %q", in, err, want)
		}
	}
}

func TestFirstRefusalWins(t *testing.T) {
	if _, err := decodeSample(`{"count":null}`); err == nil || err.Error() != "programs[0].name: required" {
		t.Fatalf("%v", err)
	}
}

func TestRootPathAndEach(t *testing.T) {
	if _, err := Decode(json.RawMessage(`null`), ""); err == nil || err.Error() != "(root): expected object, received null" {
		t.Fatalf("%v", err)
	}
	o, _ := Decode(json.RawMessage(`{"xs":[{"n":1},{}]}`), "")
	var raw json.RawMessage
	Required(o, "xs", &raw)
	Each(o, "xs", raw, func(item json.RawMessage, path string) (float64, error) {
		inner, err := Decode(item, path)
		if err != nil {
			return 0, err
		}
		var n float64
		Required(inner, "n", &n)
		return n, inner.Err
	})
	if o.Err == nil || o.Err.Error() != "xs[1].n: required" {
		t.Fatalf("%v", o.Err)
	}
}
