package hey

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func envOf(pairs map[string]string) func(string) (string, bool) {
	return func(key string) (string, bool) {
		value, ok := pairs[key]
		return value, ok
	}
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

func writeConfig(t *testing.T, home, body string) {
	t.Helper()
	writeFile(t, filepath.Join(home, ".config", "hey.json"), body)
}

const configShapeText = ` is not {"to"?: string, "from"?: string, "endpoint"?: "https://…"}: `

func TestReadConfigMissingGoodAndBad(t *testing.T) {
	dir := t.TempDir()
	got, err := readConfig(filepath.Join(dir, "missing.json"))
	if err != nil || got.To != nil || got.From != nil || got.Endpoint != defaultEndpoint {
		t.Fatalf("missing: %+v, %v", got, err)
	}
	good := filepath.Join(dir, "good.json")
	writeFile(t, good, `{"to":"craig"}`)
	got, err = readConfig(good)
	if err != nil || *got.To != "craig" || got.From != nil || got.Endpoint != defaultEndpoint {
		t.Fatalf("good: %+v, %v", got, err)
	}
	// The issue text is zod's, because the Node CLI prints the first issue's message.
	bad := map[string]string{
		`{"to":5}`:                  "Expected string, received number",
		`{"to":""}`:                 "String must contain at least 1 character(s)",
		`null`:                      "Expected object, received null",
		`[]`:                        "Expected object, received array",
		`{"from":true}`:             "Expected string, received boolean",
		`{"endpoint":"nope"}`:       "Invalid url",
		`{"endpoint":"http://x.y"}`: `Invalid input: must start with "https://"`,
	}
	for body, issue := range bad {
		path := filepath.Join(dir, "bad.json")
		writeFile(t, path, body)
		_, err = readConfig(path)
		if err == nil || err.Error() != path+configShapeText+issue {
			t.Fatalf("%s: got %v", body, err)
		}
	}
	broken := filepath.Join(dir, "broken.json")
	writeFile(t, broken, `{to: craig}`)
	_, err = readConfig(broken)
	if err == nil || !strings.HasPrefix(err.Error(), broken+" is not JSON: ") {
		t.Fatalf("broken: got %v", err)
	}
	// Unknown keys are tolerated, as zod's non-strict object is.
	extra := filepath.Join(dir, "extra.json")
	writeFile(t, extra, `{"to":"craig","function":"x","endpoint":"https://hey.example.test/mcp"}`)
	got, err = readConfig(extra)
	if err != nil || got.Endpoint != "https://hey.example.test/mcp" {
		t.Fatalf("extra key: %+v %v", got, err)
	}
}

func TestConfigDefaultsEnvWinsEvenWhenEmpty(t *testing.T) {
	home := t.TempDir()
	writeConfig(t, home, `{"to":"craig","from":"file"}`)
	to, from, endpoint, err := configDefaults(envOf(nil), home)
	if err != nil || *to != "craig" || *from != "file" || endpoint != defaultEndpoint {
		t.Fatalf("file only: %v %v %v", to, from, err)
	}
	to, from, _, _ = configDefaults(envOf(map[string]string{"HEY_TO": "ann", "HEY_FROM": ""}), home)
	if *to != "ann" || *from != "" {
		t.Fatalf("env must win even when empty, as process.env.X ?? does: %q %q", *to, *from)
	}
	to, from, _, err = configDefaults(envOf(nil), t.TempDir())
	if err != nil || to != nil || from != nil {
		t.Fatalf("no file, no env: %v %v %v", to, from, err)
	}
	writeConfig(t, home, `{broken`)
	if _, _, _, err = configDefaults(envOf(nil), home); err == nil {
		t.Fatal("a broken file must be an error, not silently empty")
	}
}
