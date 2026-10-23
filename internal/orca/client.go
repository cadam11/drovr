package orca

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/exec"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/paths"
)

const (
	// Every orca call is a local socket round-trip and normally sub-second. Bounded because
	// AgentState is reached from the tick's per-program loop, where a hung call holds the
	// tick lock that lock.go can only reclaim from a dead holder.
	orcaTimeout = 20 * time.Second
	// How long the TUI gets to settle before a claude is called working. `terminal wait`
	// returns the instant it is satisfied, so an idle runner costs nothing and a working
	// one costs exactly this per probe.
	idleProbe = 1500 * time.Millisecond
	// A cold `teamclaude run` is seconds to tens of seconds before claude is promptable, and
	// slower behind a trust dialog. A ceiling that fires on a healthy start refuses cycles
	// for no reason, which is worse than the wedge it guards.
	agentStartTimeout = 90 * time.Second
	// How long `terminal send` observes a prompt for proof the turn started.
	promptSubmitWaitS = 10
	// direnv may evaluate a whole .envrc — a version manager, a nix shell — so it is the
	// slowest local call by a wide margin.
	direnvTimeout         = 30 * time.Second
	claudeAttempts        = 30 // waitForClaude: 30 × 3 s
	claudePoll            = 3 * time.Second
	settlePoll            = 3 * time.Second
	exitPolls             = 10 // after /exit: 10 × 2 s
	exitPoll              = 2 * time.Second
	DefaultSettleAttempts = 10
)

type Client struct {
	Paths paths.Paths
	Log   io.Writer // diagnostics (RememberedTerminal)
	// ReadOnly is the shadow tick: an adopted handle is used but cycle-terminal.json is not
	// rewritten.
	ReadOnly bool
	Sleep    func(time.Duration)

	// Per process: a watch frame redraws every few seconds and must not shell out to
	// direnv per program each time.
	mu      sync.Mutex
	baseURL map[string]*string
}

func NewClient(p paths.Paths, log io.Writer) *Client {
	return &Client{Paths: p, Log: log, Sleep: time.Sleep, baseURL: map[string]*string{}}
}

type TerminalRef struct{ Handle, Environment string }

// orcaRaw returns the envelope unread. The TS capped stdout at 8 MiB (Node's maxBuffer);
// a Go buffer does not overflow, so there is no twin.
func (c *Client) orcaRaw(ctx context.Context, args []string, timeout time.Duration) (json.RawMessage, error) {
	shown := "orca " + strings.Join(args, " ")
	res, err := exec.RunBounded(ctx, "orca", append(args[:len(args):len(args)], "--json"), exec.Bounds{Timeout: timeout, Label: shown})
	var exitErr *exec.ExitError
	if errors.As(err, &exitErr) {
		// A refusal exits non-zero with the envelope on stdout; that envelope is the answer.
		if _, uerr := Unwrap(json.RawMessage(exitErr.Stdout), shown); uerr == nil || isRefused(uerr) {
			return json.RawMessage(exitErr.Stdout), nil
		}
		return nil, fmt.Errorf("%s failed: %s", shown, err)
	}
	if err != nil {
		return nil, err // *exec.TimedOut and the not-on-PATH explanation, as they are
	}
	if !json.Valid([]byte(res.Stdout)) {
		return nil, fmt.Errorf("%s did not return JSON. It printed: %s", shown, jsnum.Slice(res.Stdout, 300))
	}
	return json.RawMessage(res.Stdout), nil
}

func isRefused(err error) bool {
	var r *Refused
	return errors.As(err, &r)
}

func (c *Client) orca(ctx context.Context, args []string, timeout time.Duration) (json.RawMessage, error) {
	raw, err := c.orcaRaw(ctx, args, timeout)
	if err != nil {
		return nil, err
	}
	return Unwrap(raw, "orca "+strings.Join(args, " "))
}

func terminalArgs(verb, handle, environment string, rest ...string) []string {
	args := append([]string{"terminal", verb, "--terminal", handle}, rest...)
	return append(args, EnvArgs(environment)...)
}

func (c *Client) showTerminal(ctx context.Context, handle, environment string) (json.RawMessage, error) {
	return c.orcaRaw(ctx, terminalArgs("show", handle, environment), orcaTimeout)
}

func (c *Client) probeIdle(ctx context.Context, handle, environment string) (json.RawMessage, error) {
	ms := strconv.Itoa(int(idleProbe.Milliseconds()))
	return c.orcaRaw(ctx, terminalArgs("wait", handle, environment, "--for", "tui-idle", "--timeout-ms", ms), idleProbe+orcaTimeout)
}

// probeExit answers at once either way: satisfied for a dead pty, timeout for a live one.
func (c *Client) probeExit(ctx context.Context, handle, environment string) (json.RawMessage, error) {
	return c.orcaRaw(ctx, terminalArgs("wait", handle, environment, "--for", "exit", "--timeout-ms", "1"), orcaTimeout)
}

// AgentState makes three calls at most; the probes only when they can matter. The exit
// probe goes first because `show` keeps naming a claude whose pty has ended (2026-09-15).
func (c *Client) AgentState(ctx context.Context, handle, environment string) (AgentState, error) {
	show, err := c.showTerminal(ctx, handle, environment)
	if err != nil {
		return "", err
	}
	if occ, err := occupancyFrom(show); err != nil || occ != occupied {
		return AgentState(occ), err
	}
	exit, err := c.probeExit(ctx, handle, environment)
	if err != nil {
		return "", err
	}
	if gone, err := TerminalExited(exit); err != nil || gone {
		return goneOr(err)
	}
	idle, err := c.probeIdle(ctx, handle, environment)
	if err != nil {
		return "", err
	}
	return AgentStateFrom(show, idle, exit)
}

// RunnerTerminal is the live handle of a program's runner, or nil when there is none. A
// stale handle is re-resolved through the remembered tab (an Orca restart invalidates
// every handle) and the file rewritten so the next reader pays nothing.
func (c *Client) RunnerTerminal(ctx context.Context, program string) (*TerminalRef, error) {
	r := RememberedTerminal(c.Paths, program, c.Log)
	if r == nil {
		return nil, nil
	}
	show, err := c.showTerminal(ctx, r.Handle, r.Environment)
	if err != nil {
		return nil, err
	}
	t, err := readShown(show)
	if err != nil {
		return nil, err
	}
	if t != nil {
		return &TerminalRef{Handle: r.Handle, Environment: r.Environment}, nil
	}
	args := append([]string{"terminal", "list", "--worktree", "id:" + r.WorktreeID}, EnvArgs(r.Environment)...)
	list, err := c.orcaRaw(ctx, args, orcaTimeout)
	if err != nil {
		return nil, nil // swallowed: TS .catch(() => null) — a failed list is no adoption
	}
	handle, ok, err := AdoptHandle(list, r.TabID)
	if err != nil || !ok {
		return nil, err
	}
	if !c.ReadOnly {
		adopted := *r
		adopted.Handle = handle
		if err := RememberTerminal(c.Paths, program, adopted); err != nil {
			return nil, err
		}
	}
	return &TerminalRef{Handle: handle, Environment: r.Environment}, nil
}

func (c *Client) RunnerState(ctx context.Context, program string) (AgentState, error) {
	t, err := c.RunnerTerminal(ctx, program)
	if err != nil || t == nil {
		return Gone, err
	}
	return c.AgentState(ctx, t.Handle, t.Environment)
}

// RunnerIsPresent skips the idle probe, which bills its full ceiling on a working claude
// for a distinction no presence caller reads.
func (c *Client) RunnerIsPresent(ctx context.Context, program string) (bool, error) {
	t, err := c.RunnerTerminal(ctx, program)
	if err != nil || t == nil {
		return false, err
	}
	show, err := c.showTerminal(ctx, t.Handle, t.Environment)
	if err != nil {
		return false, err
	}
	if occ, err := occupancyFrom(show); err != nil || occ != occupied {
		return PresentFrom(show, nil)
	}
	exit, err := c.probeExit(ctx, t.Handle, t.Environment)
	if err != nil {
		return false, err
	}
	return PresentFrom(show, exit)
}

// RunnerAddress is best-effort: orca being unreachable costs a message its address, never
// the message.
func (c *Client) RunnerAddress(ctx context.Context, program string) PaneAddress {
	t, err := c.RunnerTerminal(ctx, program)
	if err != nil || t == nil {
		return PaneAddress{Where: "no terminal (" + program + " has never run, or its terminal is closed)"}
	}
	show, _ := c.showTerminal(ctx, t.Handle, t.Environment) // swallowed: TS .catch(() => null)
	return TerminalAddress(show, t.Handle, t.Environment)
}

// AiceBaseURL reads the program repo's .envrc through direnv, the only honest source.
func (c *Client) AiceBaseURL(ctx context.Context, program control.Program) *string {
	c.mu.Lock()
	cached, ok := c.baseURL[program.Name]
	c.mu.Unlock()
	if ok {
		return cached
	}
	var resolved *string
	res, err := exec.RunBounded(ctx, "direnv", []string{"exec", program.Cwd, "sh", "-c", `printf %s "$AICE_BASE_URL"`}, exec.Bounds{Timeout: direnvTimeout})
	if s := strings.TrimSpace(res.Stdout); err == nil && s != "" { // swallowed: TS .catch(() => null)
		resolved = &s
	}
	c.mu.Lock()
	c.baseURL[program.Name] = resolved
	c.mu.Unlock()
	return resolved
}

// worktreeShow: on a host the checkout orca knows is the box's, not the local cwd.
func (c *Client) worktreeShow(ctx context.Context, program control.Program) (map[string]json.RawMessage, string, []string, error) {
	cwd, env := program.Cwd, []string(nil)
	if program.Host != nil {
		cwd, env = program.Host.Cwd, EnvArgs(program.Host.Environment)
	}
	result, err := c.orca(ctx, append([]string{"worktree", "show", "--worktree", "path:" + cwd}, env...), orcaTimeout)
	if err != nil {
		return nil, cwd, env, err
	}
	var w struct {
		Worktree map[string]json.RawMessage `json:"worktree"`
	}
	if json.Unmarshal(result, &w) != nil || w.Worktree == nil {
		return nil, cwd, env, fmt.Errorf("orca worktree show did not carry a worktree: %s", jsnum.Slice(string(result), 300))
	}
	return w.Worktree, cwd, env, nil
}

func worktreeField(w map[string]json.RawMessage, field string) (string, error) {
	var s string
	if err := json.Unmarshal(w[field], &s); err != nil {
		return "", fmt.Errorf("orca worktree show: worktree.%s is not a string", field)
	}
	return s, nil
}

// ResolveWorktree: orca only opens terminals in worktrees it knows, and registering one is
// a decision about Craig's workspace, so a missing one is refused with the fixing command.
func (c *Client) ResolveWorktree(ctx context.Context, program control.Program) (string, error) {
	w, cwd, env, err := c.worktreeShow(ctx, program)
	if IsGone(err) {
		register := strings.Join(append([]string{"orca repo add --path", cwd}, env...), " ")
		return "", fmt.Errorf("orca has no worktree at %s, so %s has nowhere to run. Register it:  %s", cwd, program.Name, register)
	}
	if err != nil {
		return "", err
	}
	return worktreeField(w, "id")
}

// WorktreeRepoID: a cwd is usually a worktree, and `repo list` is keyed by its repo.
func (c *Client) WorktreeRepoID(ctx context.Context, program control.Program) (string, error) {
	w, _, _, err := c.worktreeShow(ctx, program)
	if err != nil {
		return "", err
	}
	return worktreeField(w, "repoId")
}

// ListRepos is raw: profile reads the icon leniently, because a tile is decoration.
func (c *Client) ListRepos(ctx context.Context) ([]json.RawMessage, error) {
	result, err := c.orca(ctx, []string{"repo", "list"}, orcaTimeout)
	if err != nil {
		return nil, err
	}
	var l struct {
		Repos *[]json.RawMessage `json:"repos"`
	}
	if json.Unmarshal(result, &l) != nil || l.Repos == nil {
		return nil, fmt.Errorf("orca repo list did not carry repos: %s", jsnum.Slice(string(result), 300))
	}
	return *l.Repos, nil
}
