package lock

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

var itoa = strconv.Itoa

func write(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLegacyBarePidIsHeldWithUnknownAge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	write(t, path, "76410") // a pid that is not alive here
	if _, held, err := HeldBy(path); held || err != nil {
		t.Fatal("dead legacy pid read as held", err)
	}
	write(t, path, itoa(os.Getpid()))
	h, held, err := HeldBy(path)
	if err != nil || !held || h.Pid != os.Getpid() || h.At != nil {
		t.Fatalf("%+v %v %v", h, held, err)
	}
	if _, ok, err := HeldForMs(path, 0); ok || err != nil {
		t.Fatal("unknown age must be unknown, never 0", err)
	}
}

func TestAcquireRefusesLiveHolderAndReleasesOwn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	ok, err := Acquire(path)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, err := Acquire(path); ok || err != nil {
		t.Fatal("acquired a lock this process holds", err)
	}
	if ms, ok, err := HeldForMs(path, 1<<62); !ok || ms <= 0 || err != nil {
		t.Fatal(ms, ok, err)
	}
	if err := Release(path); err != nil {
		t.Fatal(err)
	}
	if _, held, err := HeldBy(path); held || err != nil {
		t.Fatal("released lock still held", err)
	}
	write(t, path, `{"pid":1,"at":5}`)
	if err := Release(path); err != nil { // not ours: must stay
		t.Fatal(err)
	}
	if _, err := os.Stat(path); err != nil {
		t.Fatal("released someone else's lock")
	}
}

func TestGarbageIsUnheld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	for _, body := range []string{"", "   ", "{nope", `{"pid":"x","at":1}`, "-3", "1.5"} {
		write(t, path, body)
		if _, held, err := HeldBy(path); held || err != nil {
			t.Errorf("%q read as held (%v)", body, err)
		}
	}
}

// An unreadable lock is never free to take: Acquire must refuse it, not write over a
// holder it could not see. Write-only (0o200), not 0o000: at 0o000 the overwrite fails on
// its own, so the test would pass against the bug it exists to catch.
func TestUnreadableLockIsNotAcquired(t *testing.T) {
	if os.Geteuid() == 0 {
		t.Skip("root reads a write-only file")
	}
	path := filepath.Join(t.TempDir(), "tick.lock")
	body := `{"pid":1,"at":5}`
	write(t, path, body)
	if err := os.Chmod(path, 0o200); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(path, 0o644) })
	if ok, err := Acquire(path); ok || err == nil {
		t.Fatalf("acquired an unreadable lock: %v %v", ok, err)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(path); err != nil || string(raw) != body {
		t.Fatalf("lock overwritten: %q %v", raw, err)
	}
}
