package fixtures

import (
	"encoding/json"
	"math"
	"testing"
)

func TestLoadDecideHasCases(t *testing.T) {
	cases := Load(t, "decide")
	if len(cases) < 50 {
		t.Fatalf("decide fixtures: %d cases, expected the recorded suite", len(cases))
	}
}

func TestFloatInfinity(t *testing.T) {
	if !math.IsInf(Float(json.RawMessage(`"Infinity"`)), 1) {
		t.Fatal("Infinity")
	}
	if !math.IsInf(Float(json.RawMessage(`"-Infinity"`)), -1) {
		t.Fatal("-Infinity")
	}
	if got := Float(json.RawMessage(`1.5`)); got != 1.5 {
		t.Fatal(got)
	}
}

func TestEqual(t *testing.T) {
	cases := []struct {
		name string
		got  any
		want string
		diff string
	}{
		{"same object", map[string]any{"a": 1, "b": "x"}, `{"b":"x","a":1}`, ""},
		{"float within tolerance", 0.1 + 0.2, `0.3`, ""},
		{"float outside tolerance", 0.3001, `0.3`, "$: got 0.3001, want 0.3"},
		{"null vs absent", map[string]any{"a": nil}, `{}`, "$.a: present in got true, in want false"},
		{"absent vs null", map[string]any{}, `{"a":null}`, "$.a: present in got false, in want true"},
		{"array length", []int{1, 2}, `[1]`, "$: got [1,2], want [1]"},
		{"nested element", map[string]any{"xs": []string{"a", "b"}}, `{"xs":["a","c"]}`, "$.xs[1]: got \"b\", want \"c\""},
		{"infinity sentinel", "Infinity", `"Infinity"`, ""},
		{"number vs string", 1, `"1"`, "$: got 1, want \"1\""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var g, w any
			raw, err := json.Marshal(tc.got)
			if err != nil {
				t.Fatal(err)
			}
			if err := decode(raw, &g); err != nil {
				t.Fatal(err)
			}
			if err := decode([]byte(tc.want), &w); err != nil {
				t.Fatal(err)
			}
			if diff := compare("$", g, w); diff != tc.diff {
				t.Fatalf("diff %q, want %q", diff, tc.diff)
			}
		})
	}
}

func TestEqualPassesOnRecordedOutputs(t *testing.T) {
	for _, c := range Load(t, "decide") {
		var v any
		if err := json.Unmarshal(c.Output, &v); err != nil {
			t.Fatal(err)
		}
		Equal(t, c.Name, v, c.Output)
	}
}
