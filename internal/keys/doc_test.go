package keys

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestDocRoundTripsNodeBytes(t *testing.T) {
	cases := map[string]string{
		"empties and nesting": `{"a":{},"b":[],"c":[1,[2,{"d":null}]],"e":true,"f":false}`,
		"numbers":             `{"a":1.50,"b":1e21,"c":1.5e-7,"d":-0,"e":100,"f":0.1}`,
		"strings":             "{\"a\":\"q\\\"b\\\\s\\n\\t\\r\\b\\f\\u0001\\u001f\",\"b\":\"<>&’é🦾\\u007f\"}",
		"duplicate keys":      `{"a":1,"b":2,"a":3}`,
	}
	for name, in := range cases {
		d, err := decode([]byte(in))
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		got, err := encode(d)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if want := nodeStringify(t, in); want != "" && string(got) != want {
			t.Errorf("%s:\ngot  %q\nwant %q", name, got, want)
		}
	}
}

func TestDecodeRefusesTrailingData(t *testing.T) {
	if _, err := decode([]byte(`{"a":1} {}`)); err == nil {
		t.Fatal("trailing data accepted")
	}
}

// The oracle is Node itself: the same edit through JSON.parse / JSON.stringify must give the same bytes.
func TestMutateMatchesNodeEdit(t *testing.T) {
	body := `{"programs":[{"cwd":"/s","name":"sunnyt","priority":1.0,"enabled":true,"deadline":null}],"mode":"normal","ceilings":{"away":{"session":0.6,"weekly":0.85,"extra":1},"custom":{"weekly":0.3,"session":0.3}},"tiny":1e-7,"html":"<a&b>"}`
	path := scratch(t, body)
	if _, err := SetReserve(path, "normal", 0.2); err != nil {
		t.Fatal(err)
	}
	got, _ := os.ReadFile(path)
	src := filepath.Join(t.TempDir(), "in.json")
	if err := os.WriteFile(src, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	want := node(t, `const fs=require('fs');const raw=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));
const D={low:{weekly:0.25,session:0.25},normal:{weekly:0.55,session:0.4},away:{weekly:0.85,session:0.6}};
const c={...D,...raw.ceilings};const cur=c.normal;const weekly=1-0.2;
c.normal={weekly,session:Math.max(0.05,Math.min(1,weekly*(cur.session/cur.weekly)))};
c.low={...c.low,weekly:Math.min(c.low.weekly,c.normal.weekly)};c.away={...c.away,weekly:Math.max(c.away.weekly,c.normal.weekly)};
c.low={...c.low,session:Math.min(c.low.session,c.normal.session)};c.away={...c.away,session:Math.max(c.away.session,c.normal.session)};
raw.ceilings=c;process.stdout.write(JSON.stringify(raw,null,2)+'\n')`, src)
	if want != "" && string(got) != want {
		t.Fatalf("got\n%s\nwant\n%s", got, want)
	}
}

func nodeStringify(t *testing.T, in string) string {
	t.Helper()
	return node(t, `process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]),null,2)+'\n')`, in)
}

// node returns "" when node is not installed, so the oracle is a bonus rather than a dependency.
func node(t *testing.T, script, arg string) string {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Log("node not on PATH; oracle skipped")
		return ""
	}
	out, err := exec.Command("node", "-e", script, arg).Output()
	if err != nil {
		t.Fatalf("node: %v", err)
	}
	return string(out)
}
