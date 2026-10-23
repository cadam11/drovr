// Package lock is the tick lock: a pid plus the time it was taken, reclaimed only from a
// dead holder. Reclaiming from a live one would run two ticks at once, which races the
// ledger and double-launches cycles, so a wedge is reported (HeldForMs), never stolen.
package lock

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"strings"
	"syscall"

	"github.com/cadam11/drovr/internal/epoch"
)

// Held is a live holder. At is nil for a legacy bare-pid lock: its age is genuinely
// unknown, and reading that as "taken just now" would make a wedge look fresh forever.
type Held struct {
	Pid int
	At  *epoch.Millis
}

// isAlive reads an unexpected errno as alive: the TS throws there, and the conservative
// direction for a lock is "held", never "free to take".
func isAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return !errors.Is(err, syscall.ESRCH)
}

func positiveInt(v any) (int, bool) {
	f, ok := v.(float64)
	if !ok || f != math.Trunc(f) || f <= 0 || f > math.MaxInt32 {
		return 0, false
	}
	return int(f), true
}

// parse branches on the shape of what decoded, not on whether decoding failed: a bare
// legacy pid is itself valid JSON, so a parse failure cannot be what identifies it.
func parse(raw []byte) (Held, bool) {
	text := strings.TrimSpace(string(raw))
	var decoded any
	if text == "" || json.Unmarshal([]byte(text), &decoded) != nil {
		return Held{}, false
	}
	if _, isNumber := decoded.(float64); isNumber {
		pid, ok := positiveInt(decoded)
		return Held{Pid: pid}, ok
	}
	obj, ok := decoded.(map[string]any)
	if !ok {
		return Held{}, false
	}
	pid, ok := positiveInt(obj["pid"])
	at, isNumber := obj["at"].(float64)
	if !ok || !isNumber {
		return Held{}, false
	}
	ms := epoch.Millis(at)
	return Held{Pid: pid, At: &ms}, true
}

// HeldBy is the live holder and when it took the lock; false when nothing holds it. Only a
// missing file is unheld: an unreadable lock is never free to take (ruling 2026-10-22),
// because Acquire would then write over a live holder and run two ticks at once.
func HeldBy(path string) (Held, bool, error) {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Held{}, false, nil
	}
	if err != nil {
		return Held{}, false, err
	}
	held, ok := parse(raw)
	if !ok || !isAlive(held.Pid) {
		return Held{}, false, nil
	}
	return held, true, nil
}

func Holder(path string) (int, bool, error) {
	held, ok, err := HeldBy(path)
	return held.Pid, ok, err
}

// HeldForMs is how long the live holder has held it; false when nothing holds it or the
// lock predates the timestamped format.
func HeldForMs(path string, now epoch.Millis) (int64, bool, error) {
	held, ok, err := HeldBy(path)
	if err != nil || !ok || held.At == nil {
		return 0, false, err
	}
	return max(0, now-*held.At), true, nil
}

// Acquire returns false when a live process holds the lock; a stale lock is reclaimed.
func Acquire(path string) (bool, error) {
	_, held, err := HeldBy(path)
	if err != nil || held {
		return false, err
	}
	body := fmt.Sprintf(`{"pid":%d,"at":%d}`, os.Getpid(), epoch.Now())
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		return false, err
	}
	return true, nil
}

// Release removes the lock only if this process wrote it.
func Release(path string) error {
	raw, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if held, ok := parse(raw); ok && held.Pid == os.Getpid() {
		return os.Remove(path)
	}
	return nil
}
