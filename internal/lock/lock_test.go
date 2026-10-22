package lock

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
)

var itoa = strconv.Itoa

func TestLegacyBarePidIsHeldWithUnknownAge(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	os.WriteFile(path, []byte("76410"), 0o644) // a pid that is not alive here
	if _, held := HeldBy(path); held {
		t.Fatal("dead legacy pid read as held")
	}
	os.WriteFile(path, []byte(itoa(os.Getpid())), 0o644)
	h, held := HeldBy(path)
	if !held || h.Pid != os.Getpid() || h.At != nil {
		t.Fatalf("%+v %v", h, held)
	}
	if _, ok := HeldForMs(path, 0); ok {
		t.Fatal("unknown age must be unknown, never 0")
	}
}

func TestAcquireRefusesLiveHolderAndReleasesOwn(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	ok, err := Acquire(path)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	if ok, _ := Acquire(path); ok {
		t.Fatal("acquired a lock this process holds")
	}
	if ms, ok := HeldForMs(path, 1<<62); !ok || ms <= 0 {
		t.Fatal(ms, ok)
	}
	if err := Release(path); err != nil {
		t.Fatal(err)
	}
	if _, held := HeldBy(path); held {
		t.Fatal("released lock still held")
	}
	os.WriteFile(path, []byte(`{"pid":1,"at":5}`), 0o644)
	Release(path) // not ours: must stay
	if _, err := os.Stat(path); err != nil {
		t.Fatal("released someone else's lock")
	}
}

func TestGarbageIsUnheld(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tick.lock")
	for _, body := range []string{"", "   ", "{nope", `{"pid":"x","at":1}`, "-3", "1.5"} {
		os.WriteFile(path, []byte(body), 0o644)
		if _, held := HeldBy(path); held {
			t.Errorf("%q read as held", body)
		}
	}
}
