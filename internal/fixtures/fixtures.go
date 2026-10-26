// Package fixtures replays the cases the TypeScript suite recorded into testdata/recorded/
// before it was deleted. The recordings are frozen: a behaviour change deletes the fixture it
// contradicts in the same commit, never edits it.
package fixtures

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type Case struct {
	Name   string
	Input  json.RawMessage
	Output json.RawMessage
}

// maxDepth bounds the walk up to go.mod; drovr's tree is a handful of levels deep.
const maxDepth = 32

func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatalf("fixtures: working directory: %v", err)
	}
	for range maxDepth {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Fatalf("fixtures: no go.mod above the test's working directory")
	return ""
}

// Load reads testdata/recorded/<fn>/*.json. An empty corpus fails rather than passing
// vacuously: a Go test that replays nothing proves nothing.
func Load(t *testing.T, fn string) []Case {
	t.Helper()
	dir := filepath.Join(repoRoot(t), "testdata", "recorded", fn)
	paths, err := filepath.Glob(filepath.Join(dir, "*.json"))
	if err != nil {
		t.Fatalf("fixtures: %s: %v", dir, err)
	}
	if len(paths) == 0 {
		t.Fatalf("fixtures: no recorded cases in %s; restore it from git, the recordings cannot be regenerated", dir)
	}
	sort.Strings(paths)
	cases := make([]Case, 0, len(paths))
	for _, path := range paths {
		cases = append(cases, readCase(t, fn, path))
	}
	return cases
}

func readCase(t *testing.T, fn, path string) Case {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("fixtures: %v", err)
	}
	var file struct {
		Fn     string          `json:"fn"`
		Input  json.RawMessage `json:"input"`
		Output json.RawMessage `json:"output"`
	}
	if err := json.Unmarshal(data, &file); err != nil {
		t.Fatalf("fixtures: %s: %v", path, err)
	}
	if file.Fn != fn {
		t.Fatalf("fixtures: %s records %q, not %q", path, file.Fn, fn)
	}
	// A TS function returning undefined records no output key; JSON null is the nearest Go value.
	if file.Output == nil {
		file.Output = json.RawMessage("null")
	}
	return Case{Name: strings.TrimSuffix(filepath.Base(path), ".json"), Input: file.Input, Output: file.Output}
}

// Float reads a recorded number, including the sentinels the recorder writes for ±Infinity.
// Anything else is a corrupt corpus, so it panics rather than returning a plausible zero.
func Float(raw json.RawMessage) float64 {
	switch string(bytes.TrimSpace(raw)) {
	case `"Infinity"`:
		return math.Inf(1)
	case `"-Infinity"`:
		return math.Inf(-1)
	}
	var f float64
	if err := json.Unmarshal(raw, &f); err != nil {
		panic(fmt.Sprintf("fixtures.Float: %s: %v", raw, err))
	}
	return f
}

// tolerance absorbs float rounding between the two runtimes' arithmetic, not real drift:
// every value drovr compares is a fraction or a count well above it.
const tolerance = 1e-9

// Equal compares got and want as canonical JSON: key sets and values, array lengths and
// elements, numbers within tolerance, null distinct from absent.
func Equal(t *testing.T, name string, got any, want json.RawMessage) {
	t.Helper()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(got); err != nil {
		t.Errorf("%s: marshal got: %v", name, err)
		return
	}
	var g, w any
	if err := decode(buf.Bytes(), &g); err != nil {
		t.Errorf("%s: decode got: %v", name, err)
		return
	}
	if err := decode(want, &w); err != nil {
		t.Errorf("%s: decode want: %v", name, err)
		return
	}
	if diff := compare("$", g, w); diff != "" {
		t.Errorf("%s: %s", name, diff)
	}
}

func decode(data []byte, v *any) error {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	return dec.Decode(v)
}

// compare returns the first difference as "<path>: got <x>, want <y>", or "" when equal.
func compare(path string, got, want any) string {
	switch w := want.(type) {
	case map[string]any:
		g, ok := got.(map[string]any)
		if !ok {
			return mismatch(path, got, want)
		}
		return compareObjects(path, g, w)
	case []any:
		g, ok := got.([]any)
		if !ok || len(g) != len(w) {
			return mismatch(path, got, want)
		}
		for i := range w {
			if diff := compare(fmt.Sprintf("%s[%d]", path, i), g[i], w[i]); diff != "" {
				return diff
			}
		}
		return ""
	case json.Number:
		g, ok := got.(json.Number)
		if !ok || !numbersClose(g, w) {
			return mismatch(path, got, want)
		}
		return ""
	}
	if got != want {
		return mismatch(path, got, want)
	}
	return ""
}

func compareObjects(path string, got, want map[string]any) string {
	keys := make([]string, 0, len(want)+len(got))
	for k := range want {
		keys = append(keys, k)
	}
	for k := range got {
		if _, ok := want[k]; !ok {
			keys = append(keys, k)
		}
	}
	sort.Strings(keys)
	for _, k := range keys {
		g, gok := got[k]
		w, wok := want[k]
		sub := path + "." + k
		if gok != wok {
			return fmt.Sprintf("%s: present in got %t, in want %t", sub, gok, wok)
		}
		if diff := compare(sub, g, w); diff != "" {
			return diff
		}
	}
	return ""
}

func numbersClose(got, want json.Number) bool {
	g, gerr := got.Float64()
	w, werr := want.Float64()
	if gerr != nil || werr != nil {
		return false
	}
	return math.Abs(g-w) <= tolerance
}

func mismatch(path string, got, want any) string {
	return fmt.Sprintf("%s: got %s, want %s", path, asJSON(got), asJSON(want))
}

// asJSON keeps 1 and "1" distinguishable in a failure message, which %v does not.
func asJSON(v any) string {
	data, err := json.Marshal(v)
	if err != nil {
		return fmt.Sprintf("%v (unmarshalable: %v)", v, err)
	}
	return string(data)
}
