package usage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cadam11/drovr/internal/epoch"
	"github.com/cadam11/drovr/internal/teamclaude"
)

const now = epoch.Millis(1787400000000) // 2026-08-22T12:00:00.000Z

func f(v float64) *float64            { return &v }
func ms(v epoch.Millis) *epoch.Millis { return &v }

func TestSampleOfRecordsEveryAccount(t *testing.T) {
	s := teamclaude.Status{Accounts: []teamclaude.Account{
		{Name: "a", Quota: teamclaude.Quota{Unified7dFable: f(0.4), Unified7dFableReset: ms(now + 3_600_000)}},
		{Name: "b", Disabled: true},
	}}
	got := SampleOf(s, now)
	a, b := got.Accounts[0], got.Accounts[1]
	if got.V != 1 || got.At != "2026-08-22T12:00:00.000Z" || !a.Usable || a.Fable != 0.4 || a.General != 0 || a.Session != 0 || *a.FableReset != now+3_600_000 || a.GeneralReset != nil || b.Usable {
		t.Fatalf("%+v", got)
	}
}

func TestReadSamplesRoundTripsAndRefuses(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	if got, err := ReadSamples(filepath.Join(dir, "nothing.jsonl")); err != nil || len(got) != 0 {
		t.Fatalf("absent is empty: %v %v", got, err)
	}
	in := SampleOf(teamclaude.Status{Accounts: []teamclaude.Account{{Name: "a"}}}, now)
	if err := Append(path, in, MaxBytes); err != nil {
		t.Fatal(err)
	}
	raw, _ := os.ReadFile(path)
	if string(raw) != `{"v":1,"at":"2026-08-22T12:00:00.000Z","accounts":[{"name":"a","usable":true,"fable":0,"general":0,"session":0,"fableReset":null,"generalReset":null,"sessionReset":null}]}`+"\n" {
		t.Fatalf("%s", raw)
	}
	os.WriteFile(path, append(raw, []byte(`{"v":2,"at":"x","accounts":[]}`+"\n")...), 0o644)
	if _, err := ReadSamples(path); err == nil || !strings.Contains(err.Error(), "usage.jsonl:2 is not a valid usage sample") {
		t.Fatalf("%v", err)
	}
}

func TestAppendBoundsTheLog(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "usage.jsonl")
	for i := 0; i < 200; i++ {
		s := SampleOf(teamclaude.Status{Accounts: []teamclaude.Account{{Name: "a", Quota: teamclaude.Quota{Unified7d: f(float64(i) / 1000)}}}}, now+epoch.Millis(i)*60_000)
		if err := Append(path, s, 4_000); err != nil {
			t.Fatal(err)
		}
	}
	info, _ := os.Stat(path)
	got, err := ReadSamples(path)
	if err != nil || info.Size() > 4_000 || len(got) == 0 || len(got) >= 200 {
		t.Fatalf("size %d, %d samples, %v", info.Size(), len(got), err)
	}
	if got[len(got)-1].At != epoch.ISO(now+199*60_000) || got[0].At <= epoch.ISO(now) {
		t.Fatal("the newest must survive a prune and the oldest go")
	}
	strays, _ := filepath.Glob(filepath.Join(dir, "*.tmp"))
	if len(strays) != 0 {
		t.Fatalf("staging files left: %v", strays)
	}
}

func TestPruneKeepsExactlyTheNewestHalf(t *testing.T) {
	path := filepath.Join(t.TempDir(), "usage.jsonl")
	for i := 0; i < 4; i++ {
		if err := Append(path, SampleOf(teamclaude.Status{}, now+epoch.Millis(i)*1000), MaxBytes); err != nil {
			t.Fatal(err)
		}
	}
	if err := prune(path, 1); err != nil {
		t.Fatal(err)
	}
	got, err := ReadSamples(path)
	if err != nil || len(got) != 2 || got[0].At != epoch.ISO(now+2000) {
		t.Fatalf("%v %v", got, err)
	}
}
