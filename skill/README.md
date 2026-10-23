# The other half

`project-loop.SKILL.md` is a copy of the skill the runner reads from
`~/.claude/skills/project-loop/SKILL.md`. Install it there:

```bash
mkdir -p ~/.claude/skills/project-loop && cp skill/project-loop.SKILL.md ~/.claude/skills/project-loop/SKILL.md
```

It lives here because the two halves are coupled and would otherwise version apart:

| Contract | drovr side | skill side |
|---|---|---|
| Cycle report | `src/cycle.ts` `reportShape` | "The cycle report" |
| Report is the finish signal | `src/cycle.ts` polls for it, then releases the pane | "write the report last, then stop" |
| Onboarding detection | `isOnboarding()` — absence of `state.json` | "First run onboards" |
| Context ceiling | `contextCeilingTokens` in control | the wind-down trigger table |
| Asks page or asks file | polled by `src/asks.ts` | "Program artifacts on aice" |

**The installed copy is the live one.** Edit it to suit your programs. When a change touches one of
the contracts above, bring it back here in the same commit as the drovr side.

A change to the report shape has to land on both sides or a cycle will look like a crash.
