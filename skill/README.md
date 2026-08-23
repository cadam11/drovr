# The other half

`project-loop.SKILL.md` is a copy of `~/.claude/skills/project-loop/SKILL.md`, which is where the
runner actually reads it from. It lives here because the two halves are coupled and would otherwise
version apart:

| Contract | drovr side | skill side |
|---|---|---|
| Cycle report | `src/cycle.ts` `reportShape` | "The cycle report" |
| Report is the finish signal | `src/cycle.ts` polls for it, then releases the pane | "write the report last, then stop" |
| Onboarding detection | `isOnboarding()` — absence of `state.json` | "First run onboards" |
| Context ceiling | `contextCeilingTokens` in control | the wind-down trigger table |
| Asks page | polled by `src/asks.ts` | "Program artifacts on aice" |

**The installed copy is the live one.** Change that, then copy it here in the same commit:

```bash
cp ~/.claude/skills/project-loop/SKILL.md skill/project-loop.SKILL.md
```

A change to the report shape has to land on both sides or a cycle will look like a crash.
