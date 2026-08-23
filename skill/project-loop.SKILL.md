---
name: project-loop
description: Use when operating a long-running, multi-session software project as a continuous management loop — when Craig invokes /project-loop, asks to "run a cycle," resumes a program after a compact, asks what can be done right now across a tracked project, or asks you to keep driving a program forward across many sessions.
---

# Project Loop

You are operating a long-running software-development project as a **coordinator**, in a continuous **scan → plan → act → verify → compact** loop. The loop is expected to run for days across many sessions, so it must survive being cleared at any moment.

## You coordinate. You do not do the work.

**You perform no real work yourself.** Reading source to understand it, writing or editing code, running and interpreting test suites, scrubbing files, reviewing diffs, drafting docs, investigating a failure — all of it is executed by a dispatched subagent. You write the brief, read the report, decide what happens next.

Your context is the scarcest resource in the program. You protect it by holding **pointers, not payloads** — file paths, ticket IDs, commit SHAs, and subagent verdicts, never the contents behind them.

**Tools you use directly** — and nothing else:
- Commands returning a few lines of state: `git log --oneline -5`, `git status --short`, `gh pr list`, the ticket list.
- Your own checkpoint, plan, and brief files: you read and write these yourself.
- The dispatch tool.

Every other action is a dispatch.

**Model choice:**
- **Opus** — design, implementation, debugging, review, security, anything needing judgment.
- **Sonnet** — bounded mechanical work: renames, wide greps, formatting, collecting command output, gathering file inventories.

**Every brief states:** the objective, the completion criteria, the files and commands in scope, what must not change, and the exact shape of the report you want back — verdict first, then evidence, then anything you must action. Have subagents write their reports to files so you can hold a path instead of a transcript.

Dispatch in parallel whenever two units of work share no state.

## Nothing load-bearing lives in your context

Craig clears the loop whenever he likes, mid-cycle included, and expects to resume with no real loss. The invariant:

**If clearing this session right now would lose it, it is not durable yet — write it before your next dispatch.** Not at the end of the cycle. Before the next dispatch.

Durable means an artifact outside the conversation, routed by lifetime:

| State | Home |
|---|---|
| Objective, milestone sequence, decisions, dead ends | the program's plan/notes file in the repo |
| Current milestone scope, acceptance criteria, verification status | the ticket |
| Constraints and gotchas outliving the program | the auto-memory directory |
| Briefs and subagent reports | files on disk |
| Questions awaiting Craig, with their context | the program's asks page, if it maintains one — his answers arrive there as notes on the ask; update the page whenever the queue changes |

**REQUIRED SUB-SKILL:** Use the `pre-compact` skill for deciding what is conversation-only versus re-derivable, for routing by lifetime, and for verifying a claim is actually durable before asserting it. Do not re-derive its rules here.

**Bootstrap block.** Keep, at the top of the program's plan/notes file, a block a fresh loop agent reads to resume: the objective, the ordered pointers to read (five or fewer), the current milestone, and the exact next action with its required verification. Reading that block is the entire cost of resuming. Update it at the end of every cycle and whenever the next action changes — a stale next action is the one failure that makes a clear expensive.

## The cycle

1. **Scan:** Read the bootstrap block, then reconstruct current state from primary sources — repository, version control, tests, task records, external systems, and, if the program maintains an asks page, the notes on it (the page body is the loop's own output; the NOTES overlay is where human answers land — read it every scan, not just the page). Dispatch the reading; you receive a state summary. Treat prior summaries as navigation aids, not unquestioned truth.
2. **Plan:** Choose one bounded milestone. Define its completion criteria, required checks, dependencies, and any decision needing Craig's input. Write it to its durable home before dispatching. Planning is coordination — it is yours to do.
3. **Act:** Decompose the milestone into subagent-sized units and dispatch them. Preserve unrelated work, keep changes focused, and stop when the milestone is complete, blocked, or resting on a disproven assumption.
4. **Verify:** Dispatch a fresh subagent — not the one that did the work — to test the result against the objective. Independently confirm important claims before treating them as facts.
5. **Compact:** Reconcile rather than compose. If you have been writing as you go, the durable state is already current; confirm it, then bring the bootstrap block up to date so it names the next action and its verification. Anything still living only in this conversation is a gap — write it now.

Then either begin the next cycle, refreshing any state that may have changed, or wind down if any trigger below has been met.

## The cycle ends. It does not run forever.

A cycle is bounded, and **you** end it — nothing kills you from outside. Wind down when any of these is true:

| Trigger | Threshold |
|---|---|
| Context size | ~250k tokens. Above that, wrap-up itself stops fitting. |
| Capacity thinning | `teamclaude status --json` shows the pool no longer funds the work in flight. |
| Natural seam | The milestone is complete and the next one is a clean start. |
| Everything blocked | Every remaining item is waiting on an ask. |

Winding down means: finish or safely park the work in flight, make it durable, update the bootstrap block, publish the program artifacts, then write the cycle report **as your final action**. **Do not start new work during wind-down.** Reserve roughly 50k tokens for it — a cycle that runs to the wall cannot land, and an unlanded cycle costs the next one a full re-onboarding.

Ending early at a seam beats grinding to the ceiling. The next cycle resumes from the bootstrap block at a fraction of the cost.

### The cycle report

Before you exit, write `~/.drovr/programs/<program>/last-cycle.json`:

```json
{ "exit": "context|capacity|seam|blocked",
  "startupTokens": 14000,
  "yield": { "ticketsMoved": 2, "prsOpened": 1, "commits": 6 },
  "asksRaised": 1 }
```

`startupTokens` is what you spent before the first productive action — the re-onboarding tax, and
the main input for tuning cycle length. Its absence is recorded as a crash, so write it even on a
bad cycle.

**Write it last, and then stop.** You cannot end your own session — an interactive agent finishes
its turn and idles at the prompt. The report is the signal: drovr is watching for it, and closes
the session once it appears. So do not write the report until everything else is durable, and do
not start anything after writing it.

**Never write a report you have not earned.** Writing one mid-cycle ends the cycle — the session
is closed underneath you and any work still only in your context is lost.

## First run onboards. It does not deliver.

If `~/.drovr/programs/<program>/state.json` does not exist, this is an onboarding cycle. Reconstruct rather than deliver:

1. Dispatch subagents to harvest current state — tickets, version control, open PRs, program docs, memories, and any aice pages the program already has. Existing pages are inputs to absorb, not artifacts to overwrite.
2. Assemble the objective, milestone sequence, what is delivered, what is in flight, what is blocked.
3. Publish the program artifacts and write the bootstrap block and `state.json`.
4. Raise one ask: what you reconstructed, what cycle 1 would do, and **explicitly what you could not determine** — program boundaries, what "done" means, out-of-scope, soak-test requirements.
5. Exit with `"exit": "seam"`.

**Do not roll into delivery.** Reconstruction is where a fresh loop agent is most confidently wrong, and delivering hours of work against a wrong picture is the expensive failure. Every later cycle starts on its own — this gate applies once.

## Program artifacts on aice

Each program maintains its own pages — including its own asks page. Programs live on different aice installs, so take the page paths and publish flags from the program's entry in `~/.drovr/control.json`.

| Page | Updated |
|---|---|
| overview | when the program's shape or objective changes |
| progress | at each meaningful seam |
| status | rendered by drovr — do not hand-author it |
| asks | **the moment an ask is raised**, never batched to wind-down |

Asks are write-through because a cycle runs for hours: an ask discovered early and published late blocks Craig for the whole cycle, and a cycle that dies on a wall never publishes it at all.

**Dispatch the authoring.** Give a Sonnet subagent the current published page (`aice get`) plus a short brief of what changed, and ask it to *edit* the page, not regenerate it. Regeneration produces restyling churn that hides what actually changed. Hold the page path, never the page body.

**Asks are non-blocking.** An ask parks that thread of work; move to the next item in the backlog. Stop and wait only when every remaining item is blocked. Read answers at every scan with `aice notes list <page> --json`, act, then `aice notes resolve <id>`.

## Red flags — STOP and dispatch instead

- You are about to open a source file to "just check something."
- You are about to make an edit because it is one line.
- You are about to run the test suite and read the output.
- You are reading a diff yourself to review it.
- You are holding file contents in context "in case the next step needs them."
- You are debugging.

All of these mean: write a brief, dispatch, read the report.

## Red flags — STOP and write it down

- You are relying on something only you remember.
- The bootstrap block's next action no longer matches reality.
- A subagent reported a verified fact and you kept it in context instead of routing it.
- A dead end was ruled out this cycle and exists nowhere but here.

| Rationalization | Reality |
|---|---|
| "It's a one-line change, dispatching is overhead" | A subagent costs a few tokens of your context. Doing it yourself costs the whole file, plus every tool result it drags in. |
| "I need to read the file to write a good brief" | Name the file and the objective. The subagent reads it. That is the whole point. |
| "I already have this file in context" | Then it is already too late to save; do not compound it. Dispatch the change. |
| "Verifying my own subagent's work is faster" | The agent that wrote the code is the worst judge of it. Dispatch a fresh verifier. |
| "I'll write the checkpoint at the end of the cycle" | Craig clears mid-cycle. State written only at cycle end is state gambled on finishing. |
| "I'll remember why we rejected that approach" | You will be cleared. The next loop agent will re-try it and lose the same day you did. |
| "Reading it myself avoids a bad brief" | A brief you cannot write without reading the file is a brief missing its objective, not its context. |

Never compact unverified claims as facts. Never undertake a large action without a bounded completion condition. Never rescan the entire project when targeted checks establish freshness. Optimize for reliable progress across context windows, model changes, interruptions, and long stretches of work.
