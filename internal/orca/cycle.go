package orca

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/cadam11/drovr/internal/control"
	"github.com/cadam11/drovr/internal/jsnum"
	"github.com/cadam11/drovr/internal/preview"
)

// PaneBusy means the terminal holds a session that is not drovr's to end. Distinct from a
// crash: the cycle did not start and nothing is wrong, so it must not count against the
// program (recorded as a crash it wrote eight 0.2 s cycles into aice-x's ledger).
type PaneBusy struct{ Msg string }

func (e *PaneBusy) Error() string { return e.Msg }

type Started struct{ Handle, TabID string }

type StartInput struct {
	Program    control.Program
	WorktreeID string
	// Command is the full argv; `--model fable` is the caller's, passed through unchanged.
	Command []string
	Prompt  string
}

type Release string

const (
	Released    Release = "released"
	Busy        Release = "busy"
	ExitIgnored Release = "exit-ignored"
)

func CycleTabLabel(program string) string { return program + " cycles" }

func (c *Client) closeTerminal(ctx context.Context, handle, environment string) error {
	if _, err := c.orca(ctx, terminalArgs("close", handle, environment), orcaTimeout); err != nil && !IsGone(err) {
		return err
	}
	return nil
}

func (c *Client) address(ctx context.Context, handle, environment string) PaneAddress {
	show, _ := c.showTerminal(ctx, handle, environment) // swallowed: TS .catch(() => null)
	return TerminalAddress(show, handle, environment)
}

// clearLeftover: a finished cycle leaves its claude idle at the prompt, or a bare shell
// once released. Either is drovr's own and is cleared before the new terminal is made, so a
// program keeps one cycle tab rather than one per cycle. Anything working or waiting on a
// dialog is left strictly alone.
func (c *Client) clearLeftover(ctx context.Context, program string) error {
	t, err := c.RunnerTerminal(ctx, program)
	if err != nil || t == nil {
		return err
	}
	state, err := c.AgentState(ctx, t.Handle, t.Environment)
	if err != nil {
		return err
	}
	if state == Idle {
		r, err := c.ReleaseAgent(ctx, t.Handle, t.Environment, DefaultSettleAttempts)
		if err != nil {
			return err
		}
		if r != Released {
			return &PaneBusy{Msg: program + "'s previous runner would not exit. The next tick tries again."}
		}
	}
	if state == Working || state == Blocked {
		a := c.address(ctx, t.Handle, t.Environment)
		return &PaneBusy{Msg: fmt.Sprintf("%s already has a live session in %s (%s). Leaving it alone — it is either still working or being used. The next tick tries again.%s", program, a.Where, state, OpenLine(a))}
	}
	if err := c.closeTerminal(ctx, t.Handle, t.Environment); err != nil {
		return err
	}
	return ForgetTerminal(c.Paths, program)
}

// waitForClaude is bounded: claude takes seconds to appear behind `teamclaude run`, and a
// shell that never grows one has crashed. A fresh terminal is a plain shell — idle by
// definition — so identity comes before any idle probe.
func (c *Client) waitForClaude(ctx context.Context, handle, environment string) (bool, error) {
	for range claudeAttempts {
		show, err := c.showTerminal(ctx, handle, environment)
		if err != nil {
			return false, err
		}
		t, err := readShown(show)
		if err != nil || t == nil {
			return false, err
		}
		if t.AgentIdentity != nil {
			return true, nil
		}
		c.Sleep(claudePoll)
	}
	return false, nil
}

func (c *Client) createTerminal(ctx context.Context, in StartInput, environment string) (Started, error) {
	args := []string{"terminal", "create", "--worktree", "id:" + in.WorktreeID, "--title", CycleTabLabel(in.Program.Name), "--command", ShellCommand(in.Command)}
	result, err := c.orca(ctx, append(args, EnvArgs(environment)...), orcaTimeout)
	if err != nil {
		return Started{}, err
	}
	var created struct {
		Terminal *struct {
			Handle *string `json:"handle"`
			TabID  *string `json:"tabId"`
		} `json:"terminal"`
	}
	if json.Unmarshal(result, &created) != nil || created.Terminal == nil || created.Terminal.Handle == nil || created.Terminal.TabID == nil {
		return Started{}, fmt.Errorf("orca terminal create did not carry terminal.handle and terminal.tabId: %s", jsnum.Slice(string(result), 300))
	}
	return Started{Handle: *created.Terminal.Handle, TabID: *created.Terminal.TabID}, nil
}

// StartCycleAgent opens the cycle's terminal and prompts the claude in it. drovr never
// types into a shell: the command goes through `create --command` (measured 2026-09-01: a
// command sent into a live claude prompt, eight times). drovr does not own the process.
func (c *Client) StartCycleAgent(ctx context.Context, in StartInput) (Started, error) {
	name, environment := in.Program.Name, ""
	if in.Program.Host != nil {
		environment = in.Program.Host.Environment
	}
	if err := c.clearLeftover(ctx, name); err != nil {
		return Started{}, err
	}
	started, err := c.createTerminal(ctx, in, environment)
	if err != nil {
		return Started{}, err
	}
	if err := c.rememberStarted(name, started, in.WorktreeID, environment); err != nil {
		return started, err
	}
	up, err := c.waitForClaude(ctx, started.Handle, environment)
	if err != nil {
		return started, err
	}
	if !up {
		return started, fmt.Errorf("%s's runner exited before claude came up — check %s", name, TerminalAddress(nil, started.Handle, environment).Where)
	}
	// The envelope is unread: a start that never settled is judged by AgentState below.
	ms := strconv.Itoa(int(agentStartTimeout.Milliseconds()))
	if _, err := c.orcaRaw(ctx, terminalArgs("wait", started.Handle, environment, "--for", "tui-idle", "--timeout-ms", ms), agentStartTimeout+orcaTimeout); err != nil {
		return started, err
	}
	// A trust dialog settles the TUI too, so idle alone is not promptable. The agent is live
	// and remembered; the next tick prompts it once Craig answers.
	state, err := c.AgentState(ctx, started.Handle, environment)
	if err != nil {
		return started, err
	}
	if state != Idle {
		a := c.address(ctx, started.Handle, environment)
		return started, &PaneBusy{Msg: fmt.Sprintf("%s started but is %s in %s — answer whatever it is waiting on there and the next tick will prompt it.%s", name, state, a.Where, OpenLine(a))}
	}
	return started, c.PromptAgent(ctx, started.Handle, in.Prompt, environment)
}

func (c *Client) rememberStarted(program string, s Started, worktreeID, environment string) error {
	return RememberTerminal(c.Paths, program, Remembered{Handle: s.Handle, TabID: s.TabID, WorktreeID: worktreeID, Environment: environment})
}

// ReleaseAgent: an interactive claude cannot exit itself, so once the cycle reported,
// releasing it is cleanup, not a kill. It refuses rather than sends while the session is
// unsettled — `/exit` typed into a running turn is swallowed by it — which is what makes it
// retryable.
func (c *Client) ReleaseAgent(ctx context.Context, handle, environment string, settleAttempts int) (Release, error) {
	state, err := c.AgentState(ctx, handle, environment)
	for attempt := 0; err == nil && attempt < settleAttempts && !IsSettled(state); attempt++ {
		c.Sleep(settlePoll)
		state, err = c.AgentState(ctx, handle, environment)
	}
	if err != nil {
		return "", err
	}
	if state == Gone {
		return Released, c.closeTerminal(ctx, handle, environment)
	}
	if !IsSettled(state) {
		return Busy, nil
	}
	// swallowed: the TS .catch(() => ({})) — the poll below is what decides
	_, _ = c.orca(ctx, terminalArgs("send", handle, environment, "--text", "/exit", "--enter"), orcaTimeout)
	for range exitPolls {
		c.Sleep(exitPoll)
		state, err := c.AgentState(ctx, handle, environment)
		if err != nil {
			return "", err
		}
		if state == Gone {
			return Released, c.closeTerminal(ctx, handle, environment)
		}
	}
	return ExitIgnored, nil
}

// ReleaseRunner is true when nothing is left holding a terminal for the program. A caller
// that must return in seconds passes settleAttempts 0 to refuse a busy runner at once.
func (c *Client) ReleaseRunner(ctx context.Context, program string, settleAttempts int) (bool, error) {
	t, err := c.RunnerTerminal(ctx, program)
	if err != nil || t == nil {
		return t == nil && err == nil, err
	}
	result, err := c.ReleaseAgent(ctx, t.Handle, t.Environment, settleAttempts)
	if err != nil {
		return false, err
	}
	if result == Released {
		return true, ForgetTerminal(c.Paths, program)
	}
	if r := RememberedTerminal(c.Paths, program, c.Log); result == ExitIgnored && r != nil {
		r.ExitSent = true
		return false, RememberTerminal(c.Paths, program, *r)
	}
	return false, nil
}

// LeftoverIntent is what ReleaseLeftover would do, doing none of it. No
// terminal is "close": nothing holds one, which ReleaseLeftover reports as released.
func (c *Client) LeftoverIntent(ctx context.Context, program string, reported bool) (Leftover, error) {
	t, err := c.RunnerTerminal(ctx, program)
	if err != nil || t == nil {
		return LeftoverClose, err
	}
	state, err := c.AgentState(ctx, t.Handle, t.Environment)
	if err != nil {
		return "", err
	}
	r := RememberedTerminal(c.Paths, program, c.Log)
	return LeftoverAction(state, reported, r != nil && r.ExitSent), nil
}

// ReleaseLeftover is the tick's release by LeftoverAction: true when nothing is left
// holding a terminal.
func (c *Client) ReleaseLeftover(ctx context.Context, program string, reported bool) (bool, error) {
	action, err := c.LeftoverIntent(ctx, program, reported)
	if err != nil || action == LeftoverHold {
		return false, err
	}
	return c.ReleaseRunner(ctx, program, 0)
}

// PromptAgent submits a prompt to a live session: how a cycle starts, and how a stalled
// one is restarted.
func (c *Client) PromptAgent(ctx context.Context, handle, prompt, environment string) error {
	args := terminalArgs("send", handle, environment, "--text", prompt, "--enter", "--wait-submit", strconv.Itoa(promptSubmitWaitS))
	_, err := c.orca(ctx, args, promptSubmitWaitS*time.Second+orcaTimeout)
	return err
}

func (c *Client) requireRunner(ctx context.Context, program string) (*TerminalRef, error) {
	t, err := c.RunnerTerminal(ctx, program)
	if err == nil && t == nil {
		err = fmt.Errorf("%s has no runner terminal", program)
	}
	return t, err
}

func (c *Client) PromptRunner(ctx context.Context, program, prompt string) error {
	t, err := c.requireRunner(ctx, program)
	if err != nil {
		return err
	}
	return c.PromptAgent(ctx, t.Handle, prompt, t.Environment)
}

// InterruptRunner is an interrupt, not a kill: the runner winds down and writes its report.
func (c *Client) InterruptRunner(ctx context.Context, program string) error {
	t, err := c.requireRunner(ctx, program)
	if err != nil {
		return err
	}
	_, err = c.orca(ctx, terminalArgs("send", t.Handle, t.Environment, "--interrupt"), orcaTimeout)
	return err
}

// TidyRunnerTerminal closes a program's cycle terminal only when no claude is in it: a
// stray shell is untidy, a closed live session is lost work. It returns the closed handle.
func (c *Client) TidyRunnerTerminal(ctx context.Context, program string) (*string, error) {
	t, err := c.RunnerTerminal(ctx, program)
	if err != nil || t == nil {
		return nil, err
	}
	state, err := c.AgentState(ctx, t.Handle, t.Environment)
	if err != nil || state != Gone {
		return nil, err
	}
	if err := c.closeTerminal(ctx, t.Handle, t.Environment); err != nil {
		return nil, err
	}
	return &t.Handle, ForgetTerminal(c.Paths, program)
}

// ReadPreview is best-effort: no terminal, orca down or a changed TUI all mean no preview,
// never a failed tick. The warning is returned, not logged — only a caller drawing a frame
// knows where a diagnostic can land.
func (c *Client) ReadPreview(ctx context.Context, program string) (*preview.Preview, *string) {
	warn := func(why string) *string {
		w := "preview unavailable for " + program + ": " + why
		return &w
	}
	t, err := c.RunnerTerminal(ctx, program)
	if err == nil && t == nil {
		return nil, warn("no runner terminal")
	}
	var read json.RawMessage
	if err == nil {
		read, err = c.orcaRaw(ctx, terminalArgs("read", t.Handle, t.Environment, "--limit", "40"), orcaTimeout)
	}
	var text string
	if err == nil {
		text, err = PreviewText(read)
	}
	if err != nil {
		first, _, _ := strings.Cut(err.Error(), "\n")
		return nil, warn(first)
	}
	return preview.Parse(text, 6), nil
}
