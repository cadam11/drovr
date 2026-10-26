# E3: CLI inventory for the remaining TS commands (port target: byte-for-byte)

Source of truth is `/Users/cadam/code/drovr/src/cli.ts` (892 lines) at commit b4d8a06. Every line number below is a line in cli.ts unless another file is named. Quoted strings are copied from the source. A `${x}` inside a quote is a JS interpolation, and the name after it says what it holds.

---

## 0. Global plumbing every command shares

### 0.1 Dispatch (cli.ts 643-656, 884-892)

```ts
const main = async (argv: string[]): Promise<void> => {
  const [command, ...rest] = argv;
  const json = rest.includes('--json');
  if (command !== undefined && rest.includes('--help') && findCommand(command) !== undefined) {
    return showHelp(command, json);
  }
  if (command === 'help' || command === '--help' || command === '-h') { ... }
  ...
main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
```

- **`--json` detection:** `rest.includes('--json')`, an exact element match anywhere after the command. Among the commands in scope only `ledger` and `usage` read `json`. Every other command ignores it, but the token is still positional (see the traps for each command).
- **`<cmd> --help`** is handled before dispatch, and the Go port already has it (main.go 50). Every command in scope has a registry entry, so `drovr add --help` (and the rest) always shows help and never runs the command.
- **Error path:** any `throw` reaches main's `.catch`, which prints `error.message` plus `\n` to **stderr** and exits with **1**. Lines already written to stdout stay written (this matters for `tidy`). In Go this is `run` returning an error, which main.go 35-38 prints and turns into exit 1.
- **Soft failure:** `process.exitCode = 1` with no throw. Only `release` does this here. In Go, return `cli.ErrPrinted` after printing.
- `console.log(x)` writes `x + "\n"` to stdout. `console.error(x)` writes `x + "\n"` to stderr.
- `const p = paths();` (line 49) is evaluated once at module load: `DROVR_HOME` or `~/.drovr`. Accessors are in `src/paths.ts` and Go `internal/paths` (`Paths.Control`, `.Cycles`, `.Usage`, `.Logs`, `.LastCycle(p)`, `.ProgramState(p)`, `.ProgramLock(p)`, `.CycleTerminal(p)`, `.WorkerLog(p)`).

### 0.2 cli.ts's own `mutate` (69-74). It is NOT keys.ts's.

```ts
const mutate = (change: (control: Record<string, unknown>) => void): void => {
  const raw: Record<string, unknown> = JSON.parse(readFileSync(p.control, 'utf8'));
  change(raw);
  parseControl(raw);
  writeFileSync(p.control, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
};
```

- It writes **in place, with no staged rename**. The Go equivalent already exists: **`keys.MutateInPlace(path, change func(*Doc) error)`** (internal/keys/keys.go 84). Its doc comment says it is this function.
- It writes back the **raw** object, not the parsed one. Defaults are not materialised, unknown keys survive, and key order is preserved. A new key is appended at the end of its object, and an existing key keeps its position. `keys.Doc.Set` already behaves this way.
- Validation runs before the write. A `throw` inside `change` or a failing `parseControl` writes nothing.
- Failure texts:
  - Missing control.json gives Node's `ENOENT: no such file or directory, open '<path>'`. Go's `open <path>: no such file or directory` will differ.
  - Invalid JSON gives V8's `SyntaxError` message.
  - Schema failure gives `control file is invalid: ${zod error .message}`, where zod's message is a pretty-printed JSON issue array. Go's `internal/shape` writes a single `path: why` line. conformance_test.go already accepts that for `report` by comparing only up to the prefix.
- **Do not use `keys.Mutate` or `keys.SetMode` for the cli.ts-mutate commands.** That would change both the write mode (staged rename) and, for `mode`, the error text.
- Commands that use cli.ts `mutate`: add, host, rm, pause, resume, cadence, cap, mode. `reserve` uses keys.ts `setReserve` (staged). `init` uses neither.

### 0.3 Shared helpers in cli.ts

```ts
// 427-430
const flag = (rest: string[], name: string): string | undefined => {
  const index = rest.indexOf(`--${name}`);
  return index === -1 ? undefined : rest[index + 1];
};
```

- `flag` returns the token after the **first** occurrence. It is **undefined** when the flag is absent **or is the last token**. It never checks that the value isn't another flag: `--asks --no-aice` yields `'--no-aice'`. **Go trap:** `cycle.flagValue` (internal/cycle/report.go 143) returns `("", true)` for a trailing flag. Here that case must behave like *absent* (TS `undefined`). For example, a trailing `--priority` means priority 0, not parseInt("") = NaN.

```ts
// 466-474
const HOST_USAGE =
  'usage: drovr host <program> --environment <orca env id> --ssh <user@host> --cwd </path/on/box> ' +
  "[--drovr-home <path>] [--claude <path>] [--wake '<local command>']  |  drovr host <program> --clear";

const requiredFlag = (rest: string[], name: string): string => {
  const value = flag(rest, name);
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} is required\n${HOST_USAGE}`);
  return value;
};
```

```ts
// 304-308, used by ledger --last
const lastPerProgram = (cycles: CycleRecord[]): CycleRecord[] => {
  const byProgram = new Map<string, CycleRecord>();
  for (const cycle of latestEnds(cycles)) byProgram.set(cycle.program, cycle);
  return [...byProgram.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
};

// 327
const BUCKETS = ['fable', 'general', 'session'] as const;
```

Not used by any command in scope: `round` (146), `describeFunding`, `evaluateAll`, `statusPayload`, `tickLockHolder`, `stampConsole`. Those belong to status, service, tick and run-cycle, which are already ported.

There is no `requireProgram` and no `printJson` helper. Each command does its own `control.programs.find(...)` and its own `JSON.stringify(x, null, 2)`. The not-found texts differ by command, so take each one from its own section below.

### 0.4 JS number semantics the Go port must reproduce

- **`Number.parseInt(s, 10)`:** skip leading whitespace, take an optional sign, read the longest digit prefix, ignore the rest. No digits gives NaN. `"12abc"` is 12, `"1.9"` is 1, `"1e3"` is 1, `"0x10"` is 0, `""` is NaN. Go already has the same regex twice: `leadingInt` (internal/cycle/report.go 141) and `leadingDigits` (internal/cli/service.go 60). Fold them into one `jsnum.ParseInt(s) (float64, ok bool)` and reuse it. JS whitespace also covers Unicode spaces and the BOM, while Go's `\s` is ASCII only. That gap is acceptable.
- **`Number.parseFloat(s)`** (reserve only): skip leading whitespace, then read the longest prefix that is a StrDecimalLiteral, which includes `Infinity` and exponent forms. `"45abc"` is 45, `".5"` is 0.5, `"1e1"` is 10, `"Infinity"` is Infinity (refused later by isFinite), `"abc"` is NaN.
- **Template interpolation of a number** is `Number.prototype.toString`, which is `jsnum.String`.
- **`x.toFixed(n)`** is `jsnum.ToFixed`. **`Math.round`** is `jsnum.RoundHalfUp`.
- **`JSON.stringify(v, null, 2)`:** two-space indent, `[]` for an empty array, `{}` for an empty object, numbers via `jsnum.String`, no HTML escaping. **Go trap:** `encoding/json` writes a nil slice as `null`, so always allocate (`[]T{}`).
- **`padEnd` and `padStart`** count UTF-16 code units and never truncate.
- **`new Date(ms).toISOString()`** is `epoch.ISO`. It throws `RangeError: Invalid time value` past ±8.64e15 ms (reachable from `pause 999999999d`).

---

## 1. `init` (cli.ts 51-67, dispatched at 658)

```ts
const defaultControl = {
  mode: 'normal',
  pauseUntil: null,
  sessionId: null,
  closing: null,
  programs: [],
};

const init = (): void => {
  ensureDirs();
  if (existsSync(p.control)) {
    console.log(`${p.control} already exists`);
    return;
  }
  writeFileSync(p.control, `${JSON.stringify(defaultControl, null, 2)}\n`, 'utf8');
  console.log(`wrote ${p.control} — add a program entry, then \`drovr service install\``);
};
```

1. **Grammar:** takes no arguments, and all of `rest` is ignored, `--json` included.
2. **Files:**
   - `ensureDirs()` runs `mkdirSync(p.logs, {recursive:true})`, creating `<base>/logs` and `<base>`. The Go equivalent is `paths.EnsureDirs(p, "")`.
   - It checks `existsSync(p.control)` and, when the file is absent, writes `p.control` **in place** (no rename, no validation). The exact bytes are below. Note the dead top-level `sessionId` and `closing` keys: zod strips them on read, but they **must** be written to match.
     ```
     {
       "mode": "normal",
       "pauseUntil": null,
       "sessionId": null,
       "closing": null,
       "programs": []
     }
     ```
     followed by a trailing `\n`.
3. **Subprocesses:** none.
4. **Stdout:** either `${p.control} already exists` or `wrote ${p.control} — add a program entry, then \`drovr service install\`` (with literal backticks). `p.control` is the absolute path.
5. **Exit:** 0 on both paths. Only an fs error gives 1.
6. decide/collectState: none.
7. **Traps:** it is idempotent. It never overwrites, never validates an existing file, and seeds no ceilings and no programs. `ensureDirs` runs even when the file exists.

---

## 2. `add` (433-464, dispatched at 676)

```ts
const addProgram = (rest: string[]): void => {
  const [name, cwd] = rest;
  if (name === undefined || cwd === undefined) {
    throw new Error('usage: drovr add <name> <path> [--priority n] [--deadline YYYY-MM-DD] ...');
  }
  const absolute = resolve(cwd.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(absolute)) throw new Error(`${absolute} does not exist`);

  const asksPage = flag(rest, 'asks') ?? null;
  const noAice = rest.includes('--no-aice');
  const asksFile = flag(rest, 'asks-file') ?? (noAice ? '.drovr/asks.md' : null);

  mutate((control) => {
    const programs = Array.isArray(control.programs) ? control.programs : [];
    if (programs.some((entry) => (entry as { name?: unknown }).name === name)) {
      throw new Error(`a program named "${name}" already exists`);
    }
    programs.push({
      name,
      cwd: absolute,
      priority: Number.parseInt(flag(rest, 'priority') ?? '0', 10),
      deadline: flag(rest, 'deadline') ?? null,
      ...(flag(rest, 'model') === undefined ? {} : { model: flag(rest, 'model') }),
      ...(rest.includes('--no-direnv') ? { useDirenv: false } : {}),
      ...(noAice ? { aice: null } : { aice: { asksPage } }),
      asksFile,
    });
    control.programs = programs;
  });
  console.log(`added ${name} → ${absolute}`);
  console.log('first tick will onboard it: reconstruct state, raise one ask, then stop');
};
```

1. **Grammar:**
   - The positionals are **literally `rest[0]` and `rest[1]`**. Dashes are not filtered, so `drovr add --priority 3 x y` makes name=`--priority` and cwd=`3`.
   - Missing either positional throws `usage: drovr add <name> <path> [--priority n] [--deadline YYYY-MM-DD] ...` (stderr, exit 1).
   - Path handling: a leading `~` is expanded when it stands alone or is followed by `/` (`~user` is untouched), using `os.homedir()`, which is `$HOME`. Then `path.resolve` against the process cwd, which normalises `..` and trailing slashes. Go: `filepath.Abs` (Join+Clean) gives the same result.
   - A path that does not exist throws `${absolute} does not exist`. The check follows symlinks (Go `os.Stat`).
   - Flags, all read through `flag()`:
     - `--priority <n>`: `parseInt(v ?? '0')`. A non-numeric value gives NaN, which zod refuses as `control file is invalid: …Expected number, received nan…`.
     - `--deadline <s>`: any string or null. It is **not** validated here, and a bad date throws later in `effectivePriority`.
     - `--model <s>`: the key is added only when the flag is present.
     - `--no-direnv`: sets `useDirenv:false`.
     - `--asks <page>`.
     - `--asks-file <path>`.
     - `--no-aice`: sets `aice:null`, and `asksFile` then defaults to `.drovr/asks.md`.
   - Unknown flags are ignored silently.
   - A duplicate name throws, inside mutate, `a program named "${name}" already exists`. Nothing is written.
2. **Files:**
   - Read: `p.control` (raw JSON).
   - Write: `p.control` **in place** via cli `mutate`, which is Go `keys.MutateInPlace`.
   - The new program object's **key order**: `name, cwd, priority, deadline, [model], [useDirenv], aice, asksFile`.
   - `aice` is either `null` or `{"asksPage": <string|null>}`.
   - If `programs` is absent or not an array, a fresh array is used and `programs` is set. An absent key is appended at the end.
3. **Subprocesses:** none.
4. **Stdout:** `added ${name} → ${absolute}` then `first tick will onboard it: reconstruct state, raise one ask, then stop`.
5. **Exit:** 0. Every refusal is 1.
6. decide/collectState: none.
7. **Traps:**
   - It creates no `~/.drovr/programs/<name>` directory and runs no orca or worktree check. orca refuses later, at cycle time.
   - `--asks-file` without `--no-aice` keeps `aice:{asksPage:null}`.

---

## 3. `host` (466-505, dispatched at 677)

```ts
const setHost = (rest: string[]): void => {
  const [name] = rest;
  if (name === undefined || name.startsWith('--')) throw new Error(HOST_USAGE);
  const host = rest.includes('--clear')
    ? null
    : {
        environment: requiredFlag(rest, 'environment'),
        ssh: requiredFlag(rest, 'ssh'),
        cwd: requiredFlag(rest, 'cwd'),
        ...(flag(rest, 'drovr-home') === undefined ? {} : { drovrHome: flag(rest, 'drovr-home') }),
        ...(flag(rest, 'claude') === undefined ? {} : { claude: flag(rest, 'claude') }),
        wake: flag(rest, 'wake') ?? null,
      };
  mutate((control) => {
    const programs = Array.isArray(control.programs) ? (control.programs as Record<string, unknown>[]) : [];
    const entry = programs.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no program named "${name}"`);
    entry.host = host;
  });
  if (host === null) {
    console.log(`${name} runs on this Mac again`);
    return;
  }
  console.log(`${name} now runs on ${host.ssh} (orca environment ${host.environment}) in ${host.cwd}`);
  console.log(`the box needs drovr on PATH with a program named "${name}" in its own control.json — the runner's \`drovr report\` checks the name`);
};
```

1. **Grammar:**
   - `rest[0]` is the program. When it is missing or starts with `--`, the command throws `HOST_USAGE` (the whole string, quoted in 0.3).
   - `--clear` anywhere sets `host=null`, and every other flag is ignored.
   - Otherwise the required flags are checked **in this order: environment, ssh, cwd**. The first one that is missing, trailing, or whose value starts with `--` throws `--<name> is required\n<HOST_USAGE>` (two lines on stderr).
   - `--drovr-home` and `--claude` are optional. Their values are *not* checked for a leading `--`.
   - `--wake` is optional and defaults to null.
   - The program name is checked only inside mutate, so a missing flag is reported before an unknown program.
2. **Files:**
   - `p.control` is written in place via cli `mutate`.
   - `entry.host = host` replaces an existing `host` key in place, or appends `host` at the end of the program object.
   - The host object's key order is `environment, ssh, cwd, [drovrHome], [claude], wake`.
   - zod checks `host.cwd` against `/^\//`. A failure message contains `host.cwd must be an absolute path on the box`, inside `control file is invalid: …`.
   - `--clear` on a program with no `host` key appends `"host": null`.
   - An unknown program throws `no program named "${name}"`, with no path suffix.
3. **Subprocesses:** none. Nothing checks the ssh target or the orca environment.
4. **Stdout:**
   - With `--clear`: `${name} runs on this Mac again`.
   - Otherwise the two lines shown in the code.
5. **Exit:** 0 or 1.
6. decide/collectState: none.
7. **Traps:**
   - It does not move an existing `cycle-terminal.json`. A remembered terminal from the old runtime stays until it goes stale.

---

## 4. `rm` (568-577, dispatched at 678: `removeProgram(rest[0])`)

```ts
const removeProgram = (name: string | undefined): void => {
  if (name === undefined) throw new Error('usage: drovr rm <name>');
  mutate((control) => {
    const programs = Array.isArray(control.programs) ? control.programs : [];
    const kept = programs.filter((entry) => (entry as { name?: unknown }).name !== name);
    if (kept.length === programs.length) throw new Error(`no program named "${name}"`);
    control.programs = kept;
  });
  console.log(`removed ${name} (its ledger history and ~/.drovr/programs/${name} are left alone)`);
};
```

1. **Grammar:** `rest[0]` only. `drovr rm --json` looks for a program named `--json` and fails with not-found.
2. **Files:** `p.control` is written in place. Every entry with that name is removed, duplicates included.
3. **Subprocesses:** none.
4. **Stdout:** `removed ${name} (its ledger history and ~/.drovr/programs/${name} are left alone)`. The text says **literally `~/.drovr`** whatever `DROVR_HOME` is.
5. **Exit:** 0 or 1.
6. decide/collectState: none.
7. **Traps:**
   - It does not touch the program's Orca terminal, its `cycle-terminal.json`, its lock, its worker, or an open ledger record. A cycle in flight keeps running, and its watcher (run-cycle) will fail on its next `readControl`-based lookup, depending on where it is.
   - An open `running` record for a removed program stays in cycles.jsonl and still counts in `inFlight` (concurrency) until `maxCycleHours` ages it out.
   - Port it verbatim, but note the interaction for the plan.

---

## 5. `tidy` (823-839)

```ts
if (command === 'tidy') {
  const control = readControl(p.control);
  const running = new Set(inFlightCycles().map((cycle) => cycle.program));
  for (const program of control.programs) {
    if (running.has(program.name)) {
      console.log(`${program.name}: cycle in flight, left alone`);
      continue;
    }
    const closed = await tidyRunnerTerminal(program.name);
    console.log(
      closed === null
        ? `${program.name}: no empty cycle terminal`
        : `${program.name}: closed ${closed}`,
    );
  }
  return;
}
```

1. **Grammar:** takes no arguments. `rest` is ignored.
2. **Files:**
   - `readControl(p.control)` is a strict parse.
   - `inFlightCycles()` (src/tick.ts 702-705) is `inFlight(readCycles(p.cycles), Date.now(), readControl(p.control).maxCycleHours)`. It re-reads control and uses **maxCycleHours, not inFlight's 24h default**.
   - For each program, `tidyRunnerTerminal` reads `programs/<name>/cycle-terminal.json` (`rememberedTerminal`). It rewrites that file when it adopts a stale handle by tab id, and `rm -f`s it after closing the terminal.
   - Go equivalents: `ledger.InFlight(cycles, now, c.MaxCycleHours)` and `orca.Client.TidyRunnerTerminal(ctx, program) (*string, error)` (internal/orca/cycle.go 304).
3. **Subprocesses** (src/orca.ts 696-706, plus `runnerTerminal` and `agentState`): all go through `runBounded('orca', [...args, '--json'], {timeoutMs, maxBuffer: 8 MiB})`, with `ORCA_TIMEOUT_MS = 20_000` unless noted otherwise.
   - `orca terminal show --terminal <h> [--environment <env>] --json`.
   - If that answers "gone": `orca terminal list --worktree id:<worktreeId> [--environment <env>] --json`. Its errors are swallowed and read as no adoption.
   - `agentState`:
     - `show` again.
     - When show says occupied: `orca terminal wait --terminal <h> --for exit --timeout-ms 1 [...] --json` (20 s).
     - When the pty is not exited: `orca terminal wait --terminal <h> --for tui-idle --timeout-ms 1500 [...] --json`, with the runBounded timeout `IDLE_PROBE_MS + ORCA_TIMEOUT_MS` = 21 500 ms.
   - Only when the state is `gone`: `orca terminal close --terminal <h> [...] --json`. The gone codes `terminal_handle_stale|terminal_not_found|selector_not_found` are tolerated.
4. **Stdout:** one line per program, **in control.json order** (not priority order). The three forms:
   - `${name}: cycle in flight, left alone`
   - `${name}: no empty cycle terminal`
   - `${name}: closed ${handle}`, where handle is the raw orca handle, e.g. `term_…`.
5. **Exit:** 0. Any orca failure that isn't a gone code throws **mid-loop**. Lines printed so far stay on stdout, the error goes to stderr, and the exit is 1. Programs run sequentially, not in parallel.
6. decide/collectState: none.
7. **Traps:**
   - It closes only a terminal whose agent is `gone`. An idle claude is never closed here. That is `release`'s job.
   - Disabled programs are tidied too.
   - On testdata/home with no `cycle-terminal.json`, `runnerTerminal` returns null before any orca call. That makes the command hermetic and prints `no empty cycle terminal` for alpha, beta and gamma: the fixture's open records are from 2025, outside maxCycleHours.

---

## 6. `cap` (738-771)

```ts
if (command === 'cap') {
  const [name, value] = rest;
  const control = readControl(p.control);
  if (name === undefined) {
    console.log(`global daily cap: ${control.maxCyclesPerDay}`);
    for (const program of control.programs) {
      const own = program.maxCyclesPerDay;
      console.log(`  ${program.name}: ${own === null ? `${control.maxCyclesPerDay} (global)` : own}`);
    }
    console.log('set with: drovr cap <n>  |  drovr cap <program> <n>  |  drovr cap <program> global');
    return;
  }

  // `drovr cap 12` sets the global; `drovr cap aice-x 12` overrides one program.
  const globalOnly = value === undefined && Number.isFinite(Number.parseInt(name, 10));
  mutate((raw) => {
    if (globalOnly) {
      raw.maxCyclesPerDay = Number.parseInt(name, 10);
      return;
    }
    const programs = Array.isArray(raw.programs) ? raw.programs : [];
    const found = programs.find(
      (entry): entry is Record<string, unknown> =>
        typeof entry === 'object' && entry !== null && (entry as { name?: unknown }).name === name,
    );
    if (found === undefined) throw new Error(`no program named "${name}"`);
    found.maxCyclesPerDay = value === 'global' ? null : Number.parseInt(value ?? '', 10);
    if (value !== 'global' && !Number.isFinite(found.maxCyclesPerDay)) {
      throw new Error('usage: drovr cap <program> <n|global>');
    }
  });
  console.log(globalOnly ? `global daily cap → ${name}` : `${name} daily cap → ${value}`);
  return;
}
```

1. **Grammar:**
   - Positionals are `rest[0]` and `rest[1]`, and dashes are not filtered.
   - `readControl` (strict) runs **first**, even for writes, so a file that is already invalid fails here with the parse message.
   - **Global form:** `value === undefined` and `parseInt(name)` is finite. So `cap 12abc` sets 12, `cap -3` sets -3 (nothing refuses a negative), and `cap 0` sets 0.
   - **Program form:** every other case. Checks run in this order:
     1. Program not found: `no program named "${name}"`.
     2. Value not `global` and not parseInt-finite: `usage: drovr cap <program> <n|global>`.
   - So `drovr cap alpha` (no value) gives the **usage** error, and `drovr cap --json` gives `no program named "--json"`.
   - `drovr cap 2026` with a program named `2026` sets the **global** cap.
2. **Files:**
   - `p.control` is read strictly, then rewritten in place via cli `mutate`.
   - The global form appends `maxCyclesPerDay` at the end of the top-level object if it is absent.
   - The program form sets the program's `maxCyclesPerDay` to an int or `null`, appended at the end of the program object if absent.
3. **Subprocesses:** none.
4. **Stdout:**
   - **List form:** the three line shapes are in the code. Numbers are JS toString (`jsnum.String`), and programs come in control order. Two-space indent on the program lines.
   - **Set forms:** `global daily cap → ${name}` or `${name} daily cap → ${value}`. Both print the **raw argv string**, not the parsed number: `cap 12abc` prints `global daily cap → 12abc` while storing 12, and `cap alpha 7.9` prints `→ 7.9` while storing 7.
5. **Exit:** 0 or 1. `--json` is not supported: there is no JSON branch.
6. decide/collectState: none.
7. **Traps:** the global/program precedence above, and the raw echo of the argument.

---

## 7. `start` (773-782)

```ts
if (command === 'start') {
  const name = rest[0];
  if (name === undefined) throw new Error('usage: drovr start <program>');
  const control = readControl(p.control);
  const program = control.programs.find((entry) => entry.name === name);
  if (program === undefined) throw new Error(`no program named "${name}"`);
  // Detached, like tick does, so it does not hold the terminal for the whole cycle.
  launchDetached(program.name);
  return;
}
```

`launchDetached` (src/tick.ts 63-73):

```ts
export const launchDetached = (name: string): void => {
  const cli = fileURLToPath(new URL('./cli.ts', import.meta.url));
  const logPath = join(paths().logs, `${name}-worker.log`);
  const log = openSync(logPath, 'a');
  const child = spawn(process.execPath, [cli, 'run-cycle', name], {
    detached: true,
    stdio: ['ignore', log, log],
  });
  child.unref();
  console.log(`${name}: launched cycle (pid ${child.pid}, log ${logPath})`);
};
```

1. **Grammar:** `rest[0]`. Missing, it throws `usage: drovr start <program>`. Not found: `no program named "${name}"`.
2. **Files:**
   - `readControl(p.control)` is strict.
   - `openSync(<logs>/<name>-worker.log, 'a')` creates the **file** but not the directory, and **no `ensureDirs` runs**, so a home with no `logs/` fails with `ENOENT: no such file or directory, open '<path>'`.
   - The worker writes cycles.jsonl, the lock and the rest, not `start` itself.
3. **Subprocess:**
   - A detached `node <src/cli.ts> run-cycle <name>` in its own session (`detached:true` means setsid), with stdin ignored and stdout+stderr appended to the worker log.
   - No timeout: it is detached and not awaited. This is the one sanctioned non-`runBounded` spawn, and the Go side already has it as `exec.Detach`.
   - **Go:** `tick.Launch(cli.TickEnv(env, false), name)` (internal/tick/record.go 40). It runs `exec.Detach(env.Self, ["run-cycle", name], env.Paths.WorkerLog(name), "", nil)` and prints the identical line. It also fails without a `logs/` directory (`openLog` is `O_CREATE` on the file only), though with Go's error text.
4. **Stdout:** `${name}: launched cycle (pid ${pid}, log ${logPath})`, with an absolute logPath.
5. **Exit:** 0 as soon as the spawn succeeds, whatever the worker then does.
6. decide/collectState: **none. It bypasses admission completely**: mode, pause, `enabled`, caps, the crash latch, the leftover-runner gate and the concurrency cap are all ignored.
7. **Traps:**
   - **Re-attach happens in the worker, not in `start`.** `runProgramCycle` (tick.ts 574-) looks up `inFlight(readCycles, now, control.maxCycleHours).find(program)`. When it finds an open record, it resumes it:
     - It reuses `startedAt`, `sessionId`, `kind` and `poolBefore`.
     - It writes no start record, does not `clearReport`, and opens no new terminal.
     - It logs `${name}: re-attaching to the cycle started ${startedAt} — its watcher died with the runner still there`.
     - Unlike the tick's `reconcileAbandoned`, **`start` never asks orca whether the runner is still present first**. If the runner is gone, the resumed watch sees it gone and ends the cycle; no fresh cycle starts. Only the next `start` or tick does that.
   - **A held program lock:** the worker prints `a cycle for ${name} is already running (pid N)` into the **worker log** and exits 1. `start` has already printed "launched" and exited 0.
   - **Mode off:** the worker throws `mode is off`, also into the log.

---

## 8. `mode` (859-865)

```ts
if (command === 'mode') {
  const mode = rest[0];
  if (mode === undefined) throw new Error('mode needs one of: off, low, normal, away');
  mutate((control) => { control.mode = mode; });
  console.log(`mode set to ${mode}`);
  return;
}
```

1. **Grammar:**
   - `rest[0]`. Missing, it throws `mode needs one of: off, low, normal, away`.
   - **There is no membership check here.** A bad value is refused by zod's enum inside cli `mutate`: `control file is invalid: <zod issue JSON, "Invalid enum value. Expected 'off' | 'low' | 'normal' | 'away', received 'x'">`.
2. **Files:** `p.control` is written in place via cli mutate. Go: `keys.MutateInPlace` with `d.Set("mode", mode)`. **Do not call `keys.SetMode`**: it stages through a rename and throws a different text, `unknown mode "x" — expected one of: …`.
3. **Subprocesses:** none.
4. **Stdout:** `mode set to ${mode}`. The TUI's `mode → x` text comes from keys.ts and is not used here.
5. **Exit:** 0 or 1.
6. decide/collectState: none.
7. **Traps:**
   - It writes the **stored** mode. The phone's Away (`applyAwayMode`) is not read or written.
   - It does not check that `ceilings` has an entry for the new mode. If `ceilings` exists without that mode, `ceilingsFor` throws later at tick time.
   - Using `keys.SetMode` would produce a **diff in stderr on a bad mode**. Pick the TS behaviour, or record it as a deliberate difference.

---

## 9. `reserve` (841-857)

```ts
if (command === 'reserve') {
  const control = readControl(p.control);
  if (control.mode === 'off') throw new Error('mode is off — nothing is being spent to reserve against');
  const ceilings = control.ceilings[control.mode];
  if (rest[0] === undefined) {
    const held = 1 - (ceilings?.weekly ?? 0);
    console.log(
      `${Math.round(held * 100)}% of each account's weekly quota is held for you in mode "${control.mode}"`,
    );
    console.log(`set it with: drovr reserve <percent>`);
    return;
  }
  const percent = Number.parseFloat(rest[0].replace('%', ''));
  if (!Number.isFinite(percent)) throw new Error(`reserve needs a percentage, e.g. \`drovr reserve 45\``);
  console.log(setReserve(p.control, control.mode, percent / 100).message);
  return;
}
```

`setReserve` (src/keys.ts 114-138) is already ported as **`keys.SetReserve(path, mode, fraction) (Action, error)`**. It uses the **staged rename** (`<path>.<pid>.tmp`, then rename) through `keys.Mutate`. What it does:
- Clamps the reserve to [0.05, 0.95]. Then weekly = 1 - reserve.
- Session = clamp(weekly × (old session/old weekly), 0.05, 1).
- Seeds the missing modes from `DEFAULT_CEILINGS`.
- Runs `orderCeilings(ceilings, mode)`.
- Message: `${mode}: ${pct(reserve)} held for you — programs up to ${pct(weekly)} weekly, ${pct(session)} per 5h`, where `pct = v => `${Math.round(v*100)}%``.

1. **Grammar:**
   - `rest[0]` is the only argument.
   - The mode-off check runs **before** argument parsing, so even a bare `drovr reserve` throws `mode is off — nothing is being spent to reserve against`.
   - The value is parsed as `parseFloat(rest[0].replace('%',''))`. Only the **first** `%` is removed, so `"45%"` is 45 and `"%45"` is 45.
   - A non-finite value throws ``reserve needs a percentage, e.g. `drovr reserve 45` ``, with literal backticks. `drovr reserve --json` is NaN and hits this error.
   - Out-of-range values are silently clamped by setReserve: `reserve 0` becomes 5% and `reserve -10` becomes 5%.
2. **Files:**
   - `readControl(p.control)` is strict.
   - The write goes through keys.ts `mutate`: **a staged write to `${path}.${pid}.tmp`, then `renameSync`**. The tmp file is removed on failure.
   - It writes the whole `ceilings` object. Existing keys are spread first, then the defaults fill the gaps, and the result is ordered.
3. **Subprocesses:** none.
4. **Stdout:**
   - **Read form**, two lines:
     - `${Math.round(held*100)}% of each account's weekly quota is held for you in mode "${mode}"`
     - `set it with: drovr reserve <percent>`
   - In the read form, `held = 1 - (ceilings[mode]?.weekly ?? 0)`, so a mode with no ceiling entry prints `100%`.
   - **Set form:** the `setReserve` message.
5. **Exit:** 0 or 1.
6. decide/collectState: none.
7. **Traps:**
   - It uses the **stored** mode. The phone's Away is not applied, so with Away on, `reserve` edits `normal`'s ceiling.
   - It is the only cli-routed write in this set that is staged.
   - `drovr usage` recommends `drovr reserve 0.60`, a fraction, but this command reads a **percent**: 0.60 becomes 0.006, which clamps to 5%. See usage, section 14.

---

## 10. `pause` (696-718)

```ts
if (command === 'pause') {
  const [first, second] = rest;
  if (first === undefined) {
    throw new Error('usage: drovr pause <duration>  |  drovr pause <program> <duration>');
  }
  // A bare duration pauses everything; a program name pauses that program alone.
  const scoped = !/^\d+[mhd]$/.test(first);
  const spec = scoped ? second : first;
  if (spec === undefined) throw new Error(`pause needs a duration, e.g. \`drovr pause ${first} 3h\``);
  const until = new Date(Date.now() + parseDuration(spec)).toISOString();
  mutate((control) => {
    if (!scoped) {
      control.pauseUntil = until;
      return;
    }
    const programs = Array.isArray(control.programs) ? (control.programs as Record<string, unknown>[]) : [];
    const entry = programs.find((candidate) => candidate.name === first);
    if (entry === undefined) throw new Error(`no program named "${first}"`);
    entry.pauseUntil = until;
  });
  console.log(scoped ? `${first} paused until ${until}` : `paused until ${until}`);
  return;
}
```

`parseDuration` (src/control.ts 323-330) is ported as `control.ParseDuration`. Its error is `duration must look like 30m, 3h, or 2d — got "${input}"`. Go formats with `%q`, which differs from JS only for strings that need escaping.

1. **Grammar:**
   - Missing `first` throws `usage: drovr pause <duration>  |  drovr pause <program> <duration>`, with two spaces around the `|`.
   - When `first` matches `/^\d+[mhd]$/`, the pause is **global** and `second` is ignored. Otherwise `first` is a program and `second` is the duration.
   - A missing duration throws ``pause needs a duration, e.g. `drovr pause ${first} 3h` ``.
   - An invalid duration gives the parseDuration error. It is checked **before** the program lookup, so `pause nope xyz` reports the duration.
   - An unknown program throws `no program named "${first}"`.
   - No bounds: neither PauseForHours' 1h–72h nor MAX_REST_DAYS applies. Only Date's range limits the value, and `pause 999999999d` throws RangeError `Invalid time value`.
   - A program whose name matches the regex (e.g. `3h`) cannot be paused alone.
2. **Files:**
   - `p.control` is written in place via cli mutate.
   - Global: top-level `pauseUntil` is set to the ISO string.
   - Scoped: the program's `pauseUntil` is set. The key is appended if absent.
   - Go: `keys.MutateInPlace`. **Not** `keys.PauseForHours` (bounded, staged, different message) and not `CyclePause`/`ExtendPause` (TUI steps).
3. **Subprocesses:** none.
4. **Stdout:** `${first} paused until ${until}` or `paused until ${until}`. `until` is `epoch.ISO(now + ms)`, millisecond precision with a trailing `Z`.
5. **Exit:** 0 or 1.
6. decide/collectState: none.
7. **Traps:** the output is time-dependent, so an oracle diff needs ISO normalisation (see section 18).

---

## 11. `resume` (720-734)

```ts
if (command === 'resume') {
  const name = rest.find((argument) => !argument.startsWith('-'));
  mutate((control) => {
    if (name === undefined) {
      control.pauseUntil = null;
      return;
    }
    const programs = Array.isArray(control.programs) ? (control.programs as Record<string, unknown>[]) : [];
    const entry = programs.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no program named "${name}"`);
    entry.pauseUntil = null;
  });
  console.log(name === undefined ? 'resumed' : `${name} resumed`);
  return;
}
```

1. **Grammar:**
   - The program is the **first argument not starting with `-`**. This is the only command in the set that filters dashes for its positional, so `resume --json` is global.
   - An unknown program throws `no program named "${name}"`.
2. **Files:**
   - `p.control` is written in place.
   - The `pauseUntil: null` key is set **even when it is absent**, which appends it. That makes a byte diff even when nothing was paused.
3. **Subprocesses:** none.
4. **Stdout:** `resumed` or `${name} resumed`.
5. **Exit:** 0 or 1.
6. decide/collectState: none.
7. **Traps:**
   - It does not clear `cadence`.
   - A lapsed pause is overwritten with null without any notice.

---

## 12. `cadence` (547-566, dispatched at 736)

```ts
const setCadence = (rest: string[]): void => {
  const [name, value] = rest;
  const control = readControl(p.control);
  if (name === undefined) {
    for (const program of control.programs) {
      console.log(`  ${program.name}: ${program.cadence ?? 'every tick is a candidate'}`);
    }
    console.log('set with: drovr cadence <program> <every, e.g. 12h or 7d>  |  drovr cadence <program> off');
    return;
  }
  if (value === undefined) throw new Error('usage: drovr cadence <program> <every|off>');
  if (value !== 'off') parseDuration(value);
  mutate((raw) => {
    const programs = Array.isArray(raw.programs) ? (raw.programs as Record<string, unknown>[]) : [];
    const entry = programs.find((candidate) => candidate.name === name);
    if (entry === undefined) throw new Error(`no program named "${name}"`);
    entry.cadence = value === 'off' ? null : value;
  });
  console.log(value === 'off' ? `${name}: cadence cleared` : `${name}: at most one cycle per ${value}`);
};
```

1. **Grammar:**
   - Positionals are `rest[0]` and `rest[1]` (dashes not filtered). `readControl` (strict) runs first.
   - No name gives the list.
   - A name with no value throws `usage: drovr cadence <program> <every|off>`. This is what `cadence --json` hits.
   - A value that isn't `off` is validated by `parseDuration` (its error text), **before** the program lookup.
   - An unknown program throws `no program named "${name}"`.
   - No 35-day cap here; only `report --cadence` has one.
2. **Files:**
   - `p.control` is read strictly, then written in place via cli mutate. The program's `cadence` is set to the string or null, appended if absent.
   - zod's cadence regex `/^\d+[mhd]$/` (message `cadence must look like 30m, 12h, or 7d`) can't fire, because parseDuration has already passed the value.
3. **Subprocesses:** none.
4. **Stdout:**
   - List form, one line per program in control order: `  ${name}: ${cadence ?? 'every tick is a candidate'}`, then `set with: drovr cadence <program> <every, e.g. 12h or 7d>  |  drovr cadence <program> off`.
   - Set form: `${name}: cadence cleared` or `${name}: at most one cycle per ${value}`.
5. **Exit:** 0 or 1.
6. decide/collectState: none.
7. **Traps:** none beyond the above. The list form is hermetic on testdata/home and prints alpha `every tick is a candidate`, beta `12h`, and gamma `every tick is a candidate`.

---

## 13. `ledger` (301-325, dispatched at 681-690)

```ts
if (command === 'ledger') {
  const words = rest.filter((a) => !a.startsWith('-'));
  return showLedger({
    program: words.find((a) => !/^\d+$/.test(a)) ?? null,
    limit: Number.parseInt(words.find((a) => /^\d+$/.test(a)) ?? '20', 10),
    json,
    closing: rest.includes('--closing'),
    last: rest.includes('--last'),
  });
}

const showLedger = ({ limit, json, closing, program, last }: LedgerView): void => {
  const mine = readCycles(p.cycles).filter((cycle) => program === null || cycle.program === program);
  const recent = last ? lastPerProgram(mine) : mine.slice(-limit);
  if (json) {
    console.log(JSON.stringify({ exitReasons: AGENT_NOTES.exitReasons, cycles: recent }, null, 2));
    return;
  }
  for (const cycle of recent) {
    const produced = cycle.yield;
    const total = produced === null ? '—' : produced.ticketsMoved + produced.prsOpened + produced.commits;
    console.log(
      `${cycle.startedAt.slice(0, 16)}  ${cycle.program.padEnd(16)} ${cycle.kind.padEnd(10)} ${cycle.exit.padEnd(9)} yield=${total} asks=${cycle.asksRaised}`,
    );
    if (closing && cycle.closing !== null) console.log(cycle.closing.replace(/^/gm, '    ') + '\n');
  }
};
```

1. **Grammar:**
   - Words are the arguments not starting with `-`. The program is the first word that isn't all digits. The limit is `parseInt` of the first all-digit word, default 20.
   - Flags: `--json`, `--closing`, `--last`. Any other `-x` is ignored, so `-5` is ignored too.
   - Programs are not validated: an unknown name prints nothing (text) or `"cycles": []` (JSON).
   - A program whose name is all digits can't be filtered.
   - **`ledger 0` prints everything**, because `slice(-0)` is `slice(0)`.
   - `--last` ignores n.
   - With `--json` and `--closing` together, `--json` wins.
2. **Files:**
   - Reads `p.cycles` only, via `readCycles`, which is strict. A missing file reads as `[]`. A bad line throws ``${path}:${lineNo} is not a valid cycle record: ${zod message}``, and V8's own SyntaxError for non-JSON.
   - Go: `ledger.ReadCycles`. Its error texts for the same cases are already decided by the ported status command.
   - No `control.json` read at all.
3. **Subprocesses:** none.
4. **Output.**
   - **Text**, one line per record (with `--last`, ended records only; otherwise **start records are included**, showing `running` and `yield=—`). The line is:
     ```
     `${startedAt.slice(0,16)}  ${program.padEnd(16)} ${kind.padEnd(10)} ${exit.padEnd(9)} yield=${total} asks=${asksRaised}`
     ```
     - Two spaces after the date; single spaces after that.
     - `total` is `'—'` (U+2014) when yield is null; otherwise it is the sum of the three numbers in JS toString.
     - `asksRaised` is a JS number toString, defaulting to 0.
   - With `--closing` and a non-null `closing`: every line of closing gets four leading spaces (`/^/gm`: JS multiline `^` matches after `\n`, `\r`, U+2028 and U+2029). Then `+ '\n'`, and console.log adds another `\n`, which leaves a blank line. An empty-string closing prints `    ` plus the blank line.
   - **JSON** (`JSON.stringify(..., null, 2)`) has the top-level keys in this order: `exitReasons`, `cycles`.
     - `exitReasons` is `AGENT_NOTES.exitReasons` (src/help.ts 39-52), with keys in order `context, capacity, seam, abandoned, blocked, crash, stalled`. Go already has `help.AgentNotes.ExitReasons` with that order.
     - `cycles` holds **zod-parsed** records:
       - Keys follow the **schema order**: `v, kind, program, startedAt, endedAt, exit, poolBefore{fable,general,session}, poolAfter (null | {fable,general,session}), startupTokens, yield (null | {ticketsMoved,prsOpened,commits}), asksRaised, pauseUntil, sessionId, closing`.
       - Defaults are **filled in**: `asksRaised:0`, `pauseUntil:null`, `sessionId:null`, `closing:null` appear even when absent from the file. Unknown keys are stripped.
       - The Go `ledger.Cycle` struct already marshals in exactly this order. Its numbers are float64 (`jsnum`-compatible for integers and shortest form). `V` is int.
       - An empty result must print `"cycles": []`, never `null`.
5. **Exit:** 0 unless the read throws.
6. decide/collectState: none.
7. **Traps, `lastPerProgram` ordering:**
   - `latestEnds` keeps the **first-seen position** of each `program|startedAt` identity, with the latest end record's *value*.
   - `byProgram` then keeps, per program, the **last identity in that order**. That is the cycle whose first end record appears latest in the file, not necessarily the max `startedAt`.
   - The result is then **stably** sorted by `startedAt` with `localeCompare`. For well-formed ISO UTC strings that equals byte compare, so Go can use `slices.SortStableFunc` with `strings.Compare`.
   - Go has `ledger.LatestEnds`.

---

## 14. `usage` (327-409, dispatched at 692)

The full body is at cli.ts 335-409. The helpers come from src/usage.ts: `readSamples` (102), `shareOf` (154), `observedYours` (186, `fraction=0.9, minSamples=24`).

1. **Grammar:** only `--json` matters. Everything else is ignored.
2. **Files** (all read-only):
   - `p.usage` via `readSamples`, which is strict. A missing file reads as `[]`. A bad line gives `${path}:${n} is not a valid usage sample: ${zod msg}`.
   - `p.cycles` via `readCycles`.
   - `p.control` via `readControl`.
   - Phone Away is **not** applied.
   - `ceilings = control.mode === 'off' ? null : control.ceilings[control.mode] ?? null`, and `reserve = ceilings === null ? null : 1 - ceilings.weekly`. This is a raw float: `1 - 0.55` is `0.44999999999999996` and prints that way in JSON.
   - Go has `usage.ReadSamples` and `ledger.SpentSince`. **Not ported yet:** `shareOf`, `sharesOf`, `observedYours`, `windowStartOf`. Port them pure, about 50 lines. The bodies:
     ```ts
     const windowStartOf = (sample, bucket, at) => {
       const resets = usable(sample).map((e) => e[resetField[bucket]]).filter((r) => r !== null && r > at);
       return resets.length === 0 ? at : Math.min(...resets) - WINDOW_MS[bucket];   // WEEK 168h, SESSION 5h
     };
     export const shareOf = (sample, cycles, bucket) => {
       const at = Date.parse(sample.at);
       const total = usable(sample).reduce((sum, e) => sum + e[bucket], 0);
       const drovr = spentSince(cycles, windowStartOf(sample, bucket, at), at)[bucket];
       return { at, total, drovr, yours: Math.max(0, total - drovr) };
     };
     export const observedYours = (samples, cycles, bucket, fraction = 0.9, minSamples = 24) => {
       if (samples.length < minSamples) return null;
       const shares = sharesOf(samples, cycles, bucket);
       const sorted = [...shares].sort((a, b) => a.yours - b.yours);
       const rank = Math.ceil(fraction * sorted.length);
       const peak = sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!.yours;
       const accounts = usable(samples[samples.length - 1]!).length;
       return { bucket, samples: samples.length, now: shares.at(-1).yours, peak,
                peakFraction: accounts === 0 ? 0 : peak / accounts };
     };
     ```
     `usable(sample)` is `sample.accounts.filter(e => e.usable)`.
   - Rows: `latest = samples.length === 0 ? null : shareOf(samples.at(-1), cycles, bucket)`, and `observed = observedYours(samples, cycles, bucket)`.
3. **Subprocesses:** none. No teamclaude call: the samples were recorded by the tick.
4. **JSON**, with this key order:
   ```
   { "note": "yours = total account usage minus what drovr's own ledger accounts for, in account-units (N usable accounts = N.0). peakFraction is that peak as a share of the pool, directly comparable to configuredReserve. Sampled once per tick; nothing here feeds an admission decision.",
     "samples": <int>, "firstSampleAt": <iso|null>, "lastSampleAt": <iso|null>,
     "mode": <stored mode>, "configuredReserve": <raw float|null>,
     "buckets": [ { "bucket": "fable"|"general"|"session",
                    "yoursNow": Number(x.toFixed(3))|null, "drovrNow": …, "totalNow": …,
                    "observedPeakP90": Number(peak.toFixed(3))|null,
                    "observedPeakFractionP90": Number(peakFraction.toFixed(3))|null } ×3 ] }
   ```
   - `Number(x.toFixed(3))` is `jsnum.ToFixed(x,3)`, parsed back to float64 and then printed with `jsnum.String`. So `0.100` prints `0.1`.
   - The `note` string is the concatenation at lines 351-354, verbatim above. Its apostrophe is `'`, not a curly quote.
   - **Text:**
     - **No samples:** `no usage samples yet — the tick records one per firing, so give it a tick.`, then exit 0.
     - **Otherwise:**
       ```
       `${n} samples, ${samples[0].at.slice(0,16)} to ${samples.at(-1).at.slice(0,16)}`
       `mode ${mode}${reserve === null ? '' : `, reserve held for you ${(reserve*100).toFixed(0)}%`}`
       ''
       'bucket    yours now  drovr now   your p90 peak   as % of pool'
       per row: `${bucket.padEnd(9)} ${yours.padStart(9)} ${drovr.padStart(10)} ${peak.padStart(15)} ${pct.padStart(14)}`
       ```
       Inside a row, `yours`, `drovr` and `peak` are `toFixed(2)` or `'—'`, and `pct` is `${(peakFraction*100).toFixed(0)}%` or `'—'`.
     - Then the general bucket's observation decides the tail:
       - **null** (fewer than 24 samples): `''` and then `Not enough samples yet to say whether the reserve is sized for you.`, return.
       - **non-null but `reserve` null** (mode off): return with no further lines.
       - **Otherwise** `''`, then one of:
         - `peakFraction > reserve`: ``Your own weekly p90 (${(pf*100).toFixed(0)}%) is above the ${(reserve*100).toFixed(0)}% held for you — the reserve is under-sized for how you actually use the pool. Widen it with "drovr reserve ${Math.min(0.95, Math.ceil(pf*20)/20).toFixed(2)}".``
         - Otherwise: ``Your own weekly p90 (${(pf*100).toFixed(0)}%) fits inside the ${(reserve*100).toFixed(0)}% held for you — the reserve covers you as configured.``
5. **Exit:** 0 unless a read throws.
6. decide/collectState: none. It never calls teamclaude.
7. **Traps:**
   - **A TS bug to port verbatim, but flag it:** the "Widen it with" suggestion prints a fraction (`drovr reserve 0.60`), while `reserve` reads its argument as a **percent**. Followed literally, it sets the reserve to the 5% floor, the opposite of widening it. Fix it in the TS first (`× 100`, `toFixed(0)`), with a test, if Craig agrees, per the TS-first rule.
   - `toFixed` rounds the exact binary value half-up; use `jsnum.ToFixed`, never `%.2f`.
   - `Math.ceil(pf*20)/20` is float arithmetic and must be reproduced exactly.
   - On testdata/home there is **no usage.jsonl**, so the output is the one "no usage samples yet" line. JSON then shows `samples: 0`, both timestamps null, `configuredReserve: 0.44999999999999996` (mode normal with default ceilings), and every bucket value null.

---

## 15. `release` (253-288, dispatched at 694: `releaseRunner(rest[0])`)

```ts
const releaseRunner = async (name: string | undefined): Promise<void> => {
  if (name === undefined) throw new Error('release needs a program, e.g. `drovr release sunnyt`');
  const control = readControl(p.control);
  if (!control.programs.some((entry) => entry.name === name)) {
    throw new Error(`no program named "${name}" in ${p.control}`);
  }

  const state = await runnerState(name);
  if (state === 'gone') {
    // No claude to ask out, but the tab it left (or the pty it died in) may still be remembered.
    await freeRunner(name);
    console.log(`${name}: no runner to release — its terminal is free`);
    return;
  }
  const address = await runnerAddress(name);

  if (!isSettled(state)) {
    console.error(
      `${name}: its runner is ${state}, so it was left alone — /exit typed into a live ` +
        `turn is swallowed and the terminal stays held. Open ${address.where} and answer what it ` +
        `is waiting on, then run this again.` +
        (address.open === null ? '' : `\n  open it:  ${address.open}`),
    );
    process.exitCode = 1;
    return;
  }

  const released = await freeRunner(name);
  console.log(
    released
      ? `${name}: released its runner — the next tick can start a cycle`
      : `${name}: the runner did not exit; it still holds ${address.where}. Run this again, or ` +
        `close the tab` + (address.open === null ? '' : `:  ${address.open}`),
  );
  if (!released) process.exitCode = 1;
};
```

`freeRunner` is orca.ts `releaseRunner(program, settleAttempts = 10)` (629-638), Go `orca.Client.ReleaseRunner(ctx, program, 10)`. `runnerState` is Go `RunnerState`, `runnerAddress` is Go `RunnerAddress`, and `isSettled` is Go `orca.IsSettled` (Idle or Gone).

1. **Grammar:**
   - `rest[0]`. Missing, it throws ``release needs a program, e.g. `drovr release sunnyt` ``.
   - An unknown program throws `no program named "${name}" in ${p.control}`. This one **carries the path**, unlike the others.
   - `release --json` looks for a program named `--json`.
2. **Files:**
   - `readControl` is strict.
   - `programs/<name>/cycle-terminal.json`:
     - read by `rememberedTerminal`;
     - rewritten with the adopted handle when a stale handle is re-resolved by tab id;
     - **deleted** when the release succeeds;
     - rewritten with `exitSent: true` when `/exit` was ignored. That write is plain `writeFileSync`, with no staging.
3. **Subprocesses:** orca only. Each call is `runBounded` with the 20 s ceiling unless noted.
   - **`runnerState`:** `terminal show`, then (when stale) `terminal list --worktree id:<wt>`, then `agentState` (show, `wait --for exit --timeout-ms 1`, `wait --for tui-idle --timeout-ms 1500` at 21.5 s).
   - **`runnerAddress`:** `runnerTerminal` again, then one more `terminal show`. It is best effort, with fallbacks:
     - `{where: "no terminal (${program} has never run, or its terminal is closed)", open: null}`;
     - `{where: "terminal ${handle}", open: null}`;
     - `{where: 'its "${title}" tab in ${basename(worktreePath)}', open: "orca terminal switch --terminal <h>[ --environment <env>]"}`.
   - **`freeRunner`** goes through `releaseAgent`, src/orca.ts 597-623:
     1. Up to 10 settle polls, each a `sleep(3000)` followed by `agentState`. While idle this exits at once.
     2. If gone: `terminal close`, and the result is released.
     3. If not settled: the result is `busy`.
     4. Otherwise `orca terminal send --terminal <h> --text /exit --enter [--environment e] --json`. Its errors are **swallowed** (`.catch(() => ({}))`).
     5. Then up to 10 × (`sleep(2000)`, `agentState`). Gone means `terminal close`, released. Running out means `exit-ignored`.
   - Worst case is about 30 s + 20 s plus the probe time.
4. **Output:**
   - stdout `${name}: no runner to release — its terminal is free`. This prints whatever freeRunner returned, and exits 0.
   - stdout `${name}: released its runner — the next tick can start a cycle`, exit 0.
   - stdout (**not stderr**): `${name}: the runner did not exit; it still holds ${where}. Run this again, or close the tab` plus `:  ${open}` when `open` is non-null. Exit 1.
   - **stderr**: `${name}: its runner is ${state}, so it was left alone — /exit typed into a live turn is swallowed and the terminal stays held. Open ${where} and answer what it is waiting on, then run this again.` plus `\n  open it:  ${open}` when `open` is non-null. Exit 1 (no throw). `state` is `working` or `blocked`.
   - No JSON form.
5. **Exit:** as above. An orca failure inside `runnerState` or `freeRunner` that isn't a gone code throws: stderr, exit 1.
6. decide/collectState: none.
7. **Traps:**
   - The only agent that is `/exit`ed is one `agentState` reads as `idle`, and only after the settle loop re-checks it. A working or blocked runner is **refused, never interrupted**.
   - Unlike the tick's `leftoverAction`, `release` does **not** require that the cycle reported and does **not** honour `exitSent`. It is Craig's manual override.
   - `address` is computed **before** the release, so the failure line names the pre-release tab.
   - On testdata/home there is no `cycle-terminal.json`, so `runnerState` returns `gone` without spawning orca, and `release alpha` prints `alpha: no runner to release — its terminal is free`. That path is hermetic.

---

## 16. `watch`: argument parsing and launch only (cli.ts 680; src/watch.ts 798-)

```ts
if (command === 'watch') return watch(Number.parseInt(rest[0] ?? '15', 10));
```

- **Interval:** `intervalSeconds = parseInt(rest[0] ?? '15')`. Only `rest[0]` is read.
  - `watch 30` gives 30. `watch 1.9` gives 1.
  - `watch abc` and **`watch --json`** give **NaN**.
- **The interval is used in two places**, both through `Math.max(2, intervalSeconds) * 1000`:
  - `setInterval(draw, Math.max(2, s) * 1000)`.
  - The probe-reuse window passed to `collectState(onWarning, fresh ? 0 : Math.max(2, s) * 1000)`.
- **Clamping and NaN:** a negative or small value clamps to 2 s. NaN propagates. **Node 24 turns a NaN delay into 1 ms** (it prints `TimeoutNaNWarning: NaN is not a number. Timeout duration was set to 1.` to stderr, which is the alt screen). And `now - at < NaN` is false, so every frame probes fresh. `drovr watch --json` is therefore a 1 ms redraw storm (serialised through the `pending` chain). The Go port should refuse a non-numeric interval, or treat it as 15, and record that as a deliberate difference. Do not reproduce the storm.
- **collectState arguments:** `onWarning` is `(warning) => { view.previewWarning = warning; }`, so the warning is folded into the frame, never printed. `probeMaxAgeMs` is `0` for a `fresh` draw (the `r` key) and `max(2,s)*1000` otherwise. Go: `state.Collector.Collect(ctx, onWarning, probeMaxAge time.Duration)`. Nothing else calls decide directly: collectState does, and passes `runnerPresent` itself.
- **Launch:**
  - Writes `ESC[?1049h ESC[?25l ESC[?1000h ESC[?1006h`.
  - Installs `SIGINT` (exit 0) and `uncaughtException` (exit 1) handlers.
  - Sets stdin raw mode **only if `process.stdin.isTTY`**, and otherwise draws with no keys.
  - Awaits the first draw. A failure there is fatal: restore the terminal, print the error to stderr, exit 1.
  - Then starts the interval. The process never returns from main; it ends only through `process.exit`.
- **Exit:** 0 on `q`, Ctrl-C or SIGINT. 1 when the first frame fails or on an uncaught exception.

---

## 17. decide()/collectState() summary (question 6)

No command in this set calls `decide()`, `evaluateAll`, `collectState` or `readStatus` (teamclaude), except `watch` through collectState, described above. So none of them needs `runnerPresent`, `probeMaxAgeMs` or an `onWarning` sink. `start` deliberately skips admission. The worker it spawns does its own reads.

---

## 18. Summary table

"Hermetic" means the output can be diffed against `node src/cli.ts` on a **copy** of testdata/home with the existing `testdata/bin` shims: `orca` is `exit 1`, `teamclaude` cats the fixture, `launchctl` is the fixed line. Every write command must run on a `t.TempDir()` copy, as `TestReportRefusalsMatchOracle` does, and compare **stdout, stderr, exit code and the resulting control.json bytes**.

| command | TS lines (cli.ts) | consumes | Go already has | size | oracle-diffable hermetically? / shim needed |
|---|---|---|---|---|---|
| init | 51-67, 658 | ensureDirs, existsSync, writeFileSync | paths.EnsureDirs | S | Yes. Run it on an empty temp `DROVR_HOME`, and again to get the "already exists" path. Diff the file bytes too. No shim. |
| add | 433-464, 676 | flag, cli mutate, parseControl, homedir/resolve | keys.MutateInPlace, Doc | M | Yes on a temp copy. `HOME` must point somewhere real for `~`, and `<path>` must exist (use the temp dir). Refusals agree up to the `control file is invalid:` prefix only (zod vs shape text). The ENOENT/JSON-syntax texts differ: exclude them or normalise. |
| host | 466-505, 677 | HOST_USAGE, requiredFlag, flag, cli mutate | keys.MutateInPlace | S | Yes on a temp copy, including every refusal (the usage strings are exact). The `host.cwd` regex refusal is prefix-only. |
| rm | 568-577, 678 | cli mutate | keys.MutateInPlace | S | Yes on a temp copy. |
| tidy | 823-839 | readControl, inFlightCycles (tick.ts 702), tidyRunnerTerminal (orca.ts 696) | ledger.InFlight, orca.Client.TidyRunnerTerminal | S | Yes for the no-terminal path (the fixture has no cycle-terminal.json, so prints "no empty cycle terminal" ×3). The closed/in-flight paths need a seeded `programs/<p>/cycle-terminal.json` plus a **scripted orca shim** answering `terminal show`/`wait`/`close` envelopes by argv. Also an in-flight record dated near now: there is no clock override, so write the record at test time. |
| cap | 738-771 | readControl, cli mutate, JS parseInt | keys.MutateInPlace; parseInt regex exists twice (cycle/report.go, cli/service.go), so fold into jsnum | S | Yes on a temp copy, including `cap 12abc`, `cap -3`, `cap alpha`, `cap --json`, `cap alpha global`. |
| start | 773-782 | readControl, launchDetached (tick.ts 63) | tick.Launch + cli.TickEnv(env,false), exec.Detach | S | Partially. The refusals are hermetic. The success line has a pid and differing argv (node+script vs Go binary), so normalise `pid \d+`. Run it with a `logs/` dir present, and once without to check the refusal (text differs: Node vs Go ENOENT). The spawned run-cycle then hits the shims; do not assert on the worker log. |
| mode | 859-865 | cli mutate | keys.MutateInPlace (NOT keys.SetMode) | S | Yes on a temp copy. A bad mode is prefix-only (zod enum text). |
| reserve | 841-857 | readControl, parseFloat, keys.setReserve (staged) | keys.SetReserve | S | Yes on a temp copy: `reserve`, `reserve 60`, `reserve 45%`, `reserve 0`, `reserve abc`, plus a mode-off control. Needs a JS-parseFloat clone (`jsnum.ParseFloat`), which is new. |
| pause | 696-718 | parseDuration, cli mutate, Date | control.ParseDuration, keys.MutateInPlace, epoch.ISO | S | Yes on a temp copy **with the ISO timestamp masked** (`\d{4}-\d\d-\d\dT[\d:.]+Z`) in stdout and in control.json, because neither CLI has a clock override. All refusals are exact, except parseDuration's `%q` vs `"…"` on odd input. |
| resume | 720-734 | cli mutate | keys.MutateInPlace | S | Yes on a temp copy. |
| cadence | 547-566, 736 | readControl, parseDuration, cli mutate | control.ParseDuration, keys.MutateInPlace | S | Yes. The list form runs on testdata/home itself (read-only), and the set and refusal forms on a temp copy. |
| ledger | 301-325, 681-690 | readCycles, latestEnds, lastPerProgram, AGENT_NOTES.exitReasons | ledger.ReadCycles, ledger.LatestEnds, help.AgentNotes.ExitReasons, ledger.Cycle JSON order | M | Yes, read-only, on testdata/home: `ledger`, `ledger alpha 2`, `ledger 0`, `ledger --last`, `ledger --json`, `ledger --json --last`, `ledger nope --json` (must print `[]`). For `--closing`, add a fixture record with a multi-line `closing`. |
| release | 253-288, 694 | readControl, runnerState, runnerAddress, isSettled, releaseRunner(…,10) | orca.Client.RunnerState/RunnerAddress/ReleaseRunner, orca.IsSettled | S (M with tests) | Gone path: yes (no cycle-terminal.json, prints "no runner to release"). Refusals: yes. The idle, working, blocked and exit-ignored paths need a seeded cycle-terminal.json and a **stateful scripted orca shim**; exit-ignored also costs ~50 s of real sleeps (3 s/2 s), so inject the sleep in Go and accept no TS oracle for those paths, or keep them to Go unit tests against `orca` fakes. |
| usage | 327-409, 692 | readSamples, readCycles, readControl, shareOf, observedYours, spentSince | usage.ReadSamples, ledger.SpentSince; **shareOf/observedYours not ported** | M | Yes, read-only. The fixture has no usage.jsonl (one-line "no samples" text; an all-null JSON). For the table and the verdict tail, add `testdata/home/usage.jsonl` with at least 24 samples, and a second one with fewer than 24. No shim: no subprocess. |
| watch (parse + launch only) | 680; watch.ts 798-1010 | parseInt, collectState(onWarning, probeMaxAgeMs), setInterval | state.Collector.Collect | (TUI is separate) | No: TTY-only, alternate screen, time-driven. Unit-test the interval parse (`15` default, `max(2,…)`, NaN refused) in Go only. |

**New helpers this batch needs in Go:**
- `jsnum.ParseInt`, replacing the two `leadingInt`/`leadingDigits` copies.
- `jsnum.ParseFloat`.
- A TS-`flag()`-compatible lookup where a trailing flag counts as absent.
- `usage.ShareOf` and `usage.ObservedYours`.

Everything else (`MutateInPlace`, `SetReserve`, `ParseDuration`, the orca client methods, `tick.Launch`, `LatestEnds`, the exit-reason notes) already exists.
