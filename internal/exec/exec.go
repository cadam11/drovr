// Package exec is drovr's only way to spawn a subprocess. execFile-style spawning has no
// default timeout, so one hung child holds the tick lock and lock.ts will not reclaim a lock
// from a live holder; the ceiling is therefore a required parameter here rather than
// per-call-site discipline. Every timeout is a named constant beside the module that uses it.
package exec

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"os"
	osexec "os/exec"
	"strings"
	"syscall"
	"time"
)

type Bounds struct {
	Timeout time.Duration
	Cwd     string
	Label   string
	// LogPath appends stdout and stderr to this file instead of capturing them (Result is
	// then empty): a headless runner prints for hours, far more than belongs in memory.
	LogPath string
	// Env is added to the parent's environment, never a replacement for it.
	Env []string
}

type Result struct{ Stdout, Stderr string }

type TimedOut struct{ Msg string }

func (e *TimedOut) Error() string { return e.Msg }

// ExitError keeps the child's output because callers lift a reason out of its stdout
// (orca's ok:false envelope, aice's error line) rather than stderr.
type ExitError struct {
	Err            error
	Stdout, Stderr string
	Code           int
	// Msg is Node's execFile wording, so a failed child reads the same from either CLI and
	// names what failed instead of a bare "exit status 1".
	Msg string
}

func (e *ExitError) Error() string { return e.Msg }
func (e *ExitError) Unwrap() error { return e.Err }

// ExplainSpawn names the binary, where it was looked for and the fix: launchd gives a tick
// a bare environment, and a bare "not found" is a log line nobody can act on.
func ExplainSpawn(bin string, err error) error {
	if !errors.Is(err, osexec.ErrNotFound) {
		return err
	}
	path, ok := os.LookupEnv("PATH")
	if !ok {
		path = "(unset)"
	}
	return fmt.Errorf("%s is not on PATH. Looked in: %s. If this came from a launchd tick, re-run `drovr service install` from a shell where `%s` works — the agent bakes in that shell's PATH.", bin, path, bin)
}

// RunSsh is non-interactive by construction: a box that wants a password or a host-key
// answer fails at once instead of holding the caller on a prompt nobody will see.
func RunSsh(ctx context.Context, target, command string, timeout time.Duration) (Result, error) {
	return RunBounded(ctx, "ssh", []string{"-o", "BatchMode=yes", "-o", "ConnectTimeout=10", target, command},
		Bounds{Timeout: timeout, Label: "ssh " + target + " " + command})
}

func RunBounded(ctx context.Context, bin string, args []string, b Bounds) (Result, error) {
	if b.Timeout <= 0 {
		panic("exec.RunBounded: Bounds.Timeout is required")
	}
	ctx, cancel := context.WithTimeout(ctx, b.Timeout)
	defer cancel()
	cmd := osexec.CommandContext(ctx, bin, args...)
	cmd.Dir = b.Cwd
	// The whole group goes, or a shell's grandchild outlives the timeout holding the pipes.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	cmd.WaitDelay = time.Second
	if len(b.Env) > 0 {
		cmd.Env = append(os.Environ(), b.Env...)
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if b.LogPath != "" {
		log, err := openLog(b.LogPath)
		if err != nil {
			return Result{}, err
		}
		defer log.Close()
		cmd.Stdout, cmd.Stderr = log, log
	}
	err := cmd.Run()
	r := Result{Stdout: stdout.String(), Stderr: stderr.String()}
	if err == nil {
		return r, nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return r, timedOut(bin, args, b, r.Stderr)
	}
	if errors.Is(err, osexec.ErrNotFound) {
		return r, ExplainSpawn(bin, err)
	}
	return r, &ExitError{Err: err, Stdout: r.Stdout, Stderr: r.Stderr, Code: exitCode(err), Msg: failedMsg(bin, args, b, r.Stderr)}
}

func openLog(path string) (*os.File, error) {
	return os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
}

// Detach starts the run-cycle worker and lets go of it. A cycle runs for hours and must
// outlive the tick that admitted it, which is why this takes no context and no timeout and
// is not RunBounded: nothing here waits, so nothing here can hold the tick lock. Its own
// session keeps a launchd teardown of the tick's process group from reaching it.
func Detach(bin string, args []string, logPath string) (int, error) {
	log, err := openLog(logPath)
	if err != nil {
		return 0, err
	}
	defer log.Close() // the child holds its own copy of the descriptor
	cmd := osexec.Command(bin, args...)
	cmd.Stdout, cmd.Stderr = log, log // Stdin nil is /dev/null
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return 0, ExplainSpawn(bin, err)
	}
	pid := cmd.Process.Pid
	if err := cmd.Process.Release(); err != nil {
		return pid, err
	}
	return pid, nil
}

func shownCommand(bin string, args []string, b Bounds) string {
	if b.Label != "" {
		return b.Label
	}
	return strings.TrimSpace(bin + " " + strings.Join(args, " "))
}

func failedMsg(bin string, args []string, b Bounds, stderr string) string {
	msg := "Command failed: " + shownCommand(bin, args, b)
	if s := strings.TrimSpace(stderr); s != "" {
		msg += "\n" + s
	}
	return msg
}

// The child's stderr often says what it was waiting on (an ssh prompt, a pairing link),
// so the last of it rides along.
func timedOut(bin string, args []string, b Bounds, stderr string) error {
	shown := shownCommand(bin, args, b)
	tail := ""
	if s := strings.TrimSpace(stderr); s != "" {
		lines := strings.Split(s, "\n")
		tail = "; it had printed: " + strings.Join(lines[max(0, len(lines)-2):], " ")
	}
	return &TimedOut{Msg: fmt.Sprintf("%s did not return within %ds and was killed%s", shown, int(math.Round(b.Timeout.Seconds())), tail)}
}

func exitCode(err error) int {
	var ee *osexec.ExitError
	if errors.As(err, &ee) {
		return ee.ExitCode()
	}
	return -1
}
