

export type Command = {
  name: string;
  usage: string;
  summary: string;
  details?: string[];
  flags?: { flag: string; describes: string }[];
  examples?: string[];
  /** What the command mutates. Absent means read-only. */
  writes?: string;
  /** Runs for hours. Never call one of these from inside a tool loop. */
  blocking?: true;
};

export const OVERVIEW = [
  'drovr decides when a /project-loop cycle may start for each tracked program, based on pooled',
  'Anthropic quota across teamclaude accounts. It never kills a cycle — cycles run for hours and',
  'end themselves. All state lives in ~/.drovr (override with DROVR_HOME).',
].join('\n');

/** This interface is mostly read by agents, so the contract is stated rather than implied. */
export const AGENT_NOTES = {
  json: 'Every read command accepts --json. Parse that; never scrape the human output.',
  exitCodes: '0 success. 1 any failure, with an actionable message on stderr.',
  stateFiles: {
    control: '~/.drovr/control.json — source of truth, re-read every tick; safe to edit directly',
    cycles: '~/.drovr/cycles.jsonl — one record when a cycle starts, one when it ends',
    decisions: '~/.drovr/decisions.jsonl — every tick, its verdict and reason',
    usage: '~/.drovr/usage.jsonl — one sample of raw account usage per tick, so Craig\'s own '
      + 'share of the pool can be measured rather than assumed. Feeds no gate.',
    logs: '~/.drovr/logs/ — per-cycle stdout',
  },
  verdicts: {
    GO: 'a cycle would launch now',
    WAIT: 'transient; retry on a later tick, no action needed',
    STOP: 'needs a human — mode is off, or the program produced no yield for several cycles',
  },
  exitReasons: {
    context: 'the runner hit its context ceiling and wound down — normal and healthy',
    capacity: 'quota thinned mid-cycle, so it wound down early',
    seam: 'the milestone completed at a clean boundary — the best outcome',
    abandoned:
      'the watch hit maxCycleHours with the runner still alive, so drovr stopped looking. ' +
      'Says nothing about delivery: if the runner writes a report afterwards the next tick ' +
      'appends the real outcome and that later record is the operative one',
    blocked: 'every remaining item is waiting on a human answer',
    crash: 'the process exited without writing a report — check ~/.drovr/logs/',
    stalled:
      'the runner went idle without reporting and ignored every nudge — its terminal was ' +
      'freed and the next tick starts a fresh cycle. Repeated stalls latch the program.',
  },
  gotchas: [
    'A WAIT reason naming another program means it is queued behind it, not short of quota.',
    'Priority is a drain order: each step down raises the admission bar by priorityStepCycles, ' +
      'so "held back for <program>" is a pool with room being kept for something more important.',
    'The three quota buckets bind simultaneously; the reason names whichever is tightest.',
    'A 5h (session) hold recovers in hours. A weekly hold recovers in days. Read the binding bucket.',
    'Pool headroom is summed per bucket and is a display figure: it can look free while no ' +
      'single account has room in all three at once. Read capacity.cyclesFundable, never pool \u00f7 cost.',
    'run-cycle blocks for hours. Use tick, which detaches, or read cycles.jsonl to follow progress.',
    'control.json can change under you between ticks — the TUI and the CLI both write it. ' +
      'Re-read it rather than caching a copy.',
  ],
};

export const COMMANDS: Command[] = [
  {
    name: 'status',
    usage: 'drovr status [--json]',
    summary: 'pool capacity, cost estimate, and the verdict for every program',
    details: [
      'Previews what a tick would do: programs are evaluated in priority order and each admitted',
      'one reserves capacity, so a program shown as WAIT may be waiting on a program listed above',
      'it rather than on quota.',
      'Verdicts are GO (a cycle would launch), WAIT (retry next tick) or STOP (mode off, or the',
      'program is stuck and needs a human).',
      'The pool line is in account-units, never percentages: one usable account contributes at',
      'most 1.00, so "fable 0.81 across 3 accounts" is 27% of the theoretical pool, not 81% free.',
      'The capacity line beneath it is what admission actually uses. One Fable token decrements',
      'all three buckets on whichever account served the request, so an account is spendable only',
      'where it has room in all three at once: capacity is the sum over accounts of each',
      'account\u2019s own tightest bucket, and can be zero while every pool figure looks healthy.',
    ],
    flags: [
      {
        flag: '--json',
        describes: 'structured output; every value carries its units and meaning alongside it',
      },
    ],
  },
  {
    name: 'watch',
    usage: 'drovr watch [seconds]',
    summary: 'live view with keyboard controls (default 15s refresh)',
    details: [
      'Shows the pool bars, every teamclaude account with its three buckets and reset countdowns',
      '(► the account the fable route serves next, ✗ one it refuses), then the programs.',
      'Interactive and TTY-only. Keys: j/k select, space enable, [ ] priority, m mode, p pause,',
      'P extend pause, +/- cap, < > reserve, r refresh, t tick now, o open its asks page,',
      's start selected program now (y to confirm — bypasses admission, like "drovr start"),',
      'x interrupt selected cycle, q quit.',
      'Not for agent use — call the individual commands instead.',
    ],
    writes: 'control.json, when a key is pressed',
  },
  {
    name: 'tick',
    usage: 'drovr tick',
    summary: 'evaluate once and launch cycles where capacity allows',
    details: [
      'What launchd runs. Admission itself returns in seconds: each admitted program is handed to',
      'a detached run-cycle worker rather than awaited.',
      'A launched cycle opens as an interactive claude terminal in that program’s own Orca worktree,',
      'so a human can read it and talk to it while it runs. drovr watches it but never kills it.',
      'It publishes nothing: a tick writes only local state. Read it with drovr status,',
      'drovr watch, or decisions.jsonl.',
    ],
    writes: 'decisions.jsonl, cycles.jsonl, and launches cycle processes',
  },
  {
    name: 'run-cycle',
    usage: 'drovr run-cycle <program>',
    summary: 'run one cycle now, bypassing the capacity check',
    details: [
      'Normally launched by tick. Blocks for the whole cycle (hours) and holds the program lock,',
      'so a second invocation for the same program is refused.',
      'It opens the cycle in Orca and then only watches — for the runner’s report file, or for the',
      'agent to disappear. Killing the runner is never drovr’s decision.',
      'If the program already has a cycle in flight whose watcher died, it re-attaches to that cycle',
      'instead of starting one: same ledger record, no new terminal, no prompt sent.',
    ],
    writes: 'cycles.jsonl',
  },
  {
    name: 'add',
    usage: 'drovr add <name> <path> [flags]',
    summary: 'track a new program',
    flags: [
      { flag: '--priority <n>', describes: 'lower keeps running deeper into a draining pool (default 0)' },
      { flag: '--deadline <YYYY-MM-DD>', describes: 'promotes one priority step inside the horizon' },
      { flag: '--asks <page>', describes: 'aice asks page; omit and onboarding creates one' },
      { flag: '--no-aice', describes: 'the program has no aice install' },
      { flag: '--no-direnv', describes: 'do not run the cycle through direnv exec' },
      { flag: '--model <alias>', describes: 'runner model for this program (default fable)' },
    ],
    details: [
      'The path must exist and the name must be unique. The aice install comes from the repo’s',
      'own .envrc, so a new program usually needs nothing else.',
      'The first tick afterwards runs an onboarding cycle, which reconstructs state and stops for',
      'confirmation rather than delivering.',
    ],
    examples: ['drovr add mrr ~/code/mrr --priority 3', 'drovr add acme ~/code/acme --deadline 2026-10-01'],
    writes: 'control.json',
  },
  {
    name: 'report',
    usage: 'drovr report <program> --exit <reason> [flags]',
    summary: 'end a cycle by writing its report — run by the loop agent, as its final action',
    flags: [
      { flag: '--exit <reason>', describes: 'required: context | capacity | seam | blocked' },
      { flag: '--startup-tokens <n>', describes: 'tokens spent before the first productive action; omit only if unmeasured' },
      { flag: '--tickets-moved <n>', describes: 'yield: tickets moved this cycle' },
      { flag: '--prs-opened <n>', describes: 'yield: PRs opened this cycle' },
      { flag: '--commits <n>', describes: 'yield: commits landed this cycle' },
      { flag: '--asks-raised <n>', describes: 'questions raised for Craig this cycle (default 0)' },
      { flag: '--pause-until <when>', describes: 'rest the program until then ("48h", "7d", or an ISO date) — everything left is waiting on time, not on a person' },
      { flag: '--cadence <every>', describes: 'standing request: this program only needs a cycle per window, e.g. "7d"' },
    ],
    details: [
      'Validates the report and writes last-cycle.json atomically, so drovr can never read a',
      'half-written or malformed file. A refusal names the flag at fault — fix it and re-run.',
      'The report ends the cycle: drovr closes the session once it exists, so run this only',
      'after everything else is durable, and start nothing afterwards.',
      'Give any yield flag and the others default to 0. Give none and yield is recorded as',
      'unknown, which is not the same as zero — it will not count against the program.',
      '--pause-until is for waiting on the world (soak tests, external actors, release dates);',
      'waiting on Craig is an ask plus --exit blocked instead. A resting cycle’s zero yield',
      'does not count toward the stuck latch — it said why. Craig can end the rest early with',
      '`drovr resume <program>`. Both flags cap at 35 days.',
    ],
    examples: ['drovr report sunnyt --exit seam --startup-tokens 14000 --commits 6 --asks-raised 1'],
    writes: '~/.drovr/programs/<program>/last-cycle.json',
  },
  {
    name: 'notify',
    usage: 'drovr notify [message] [--json]',
    summary: 'text Craig now, or send a test to prove the alert path works',
    details: [
      'With no message, sends a canned test naming the host and time. With one, sends that text.',
      'Reads phoneNumber and originationNumber from control.json; fails if phoneNumber is unset.',
      'Sends on the DEFAULT aws profile deliberately — the named profiles are SSO-backed and',
      'expire, which is exactly the state an unattended overnight supervisor finds them in.',
      'Acceptance and delivery are different events a minute or so apart, so this waits for the',
      'delivery status rather than reporting the exit code. Delivery is the line that matters.',
      'With originationNumber set it sends via End User Messaging, because SNS publish cannot',
      'resolve a specific origination number and fails at delivery after accepting the call.',
      'Delivery status is only readable on the SNS path; the other reports unknown and says why.',
    ],
    flags: [
      { flag: '--json', describes: 'acceptance, delivery verdict, to/from numbers, transport and MessageId' },
      { flag: '--no-verify', describes: 'skip the delivery check and return as soon as the API accepts' },
    ],
    examples: ['drovr notify', 'drovr notify "stage deploy finished"'],
    writes: 'sends an SMS',
  },
  {
    name: 'tidy',
    usage: 'drovr tidy',
    summary: 'close cycle terminals drovr left behind',
    details: [
      'Only the terminal drovr itself opened for a program, and only when no claude is in it.',
      'A program with a cycle in flight is skipped entirely.',
      'Cycle starts tidy automatically; this is for when nothing is running.',
    ],
    writes: 'closes Orca terminals',
  },
  {
    name: 'cap',
    usage: 'drovr cap [program] [n|global]',
    summary: 'how many working cycles a program may run per day',
    details: [
      'With no argument it reports the global cap and any per-program overrides.',
      'Only cycles that did work count: crashes, deferrals and cycles that came back blocked on',
      'unanswered asks are all free, so a bad afternoon does not cost a program its day.',
    ],
    examples: ['drovr cap', 'drovr cap 12', 'drovr cap aice-x 20', 'drovr cap aice-x global'],
    writes: 'control.json',
  },
  {
    name: 'start',
    usage: 'drovr start <program>',
    summary: 'launch a cycle now, ignoring every capacity check',
    details: [
      'Detached, so it returns immediately — unlike run-cycle, which blocks for the whole cycle.',
      'Use it to clear a crash latch once the cause is fixed, or to run something out of turn.',
      'A cycle already in flight with a dead watcher is re-watched rather than restarted; tick',
      'does the same on its own, so this is only faster.',
    ],
    writes: 'cycles.jsonl, and launches a cycle',
  },
  {
    name: 'rm',
    usage: 'drovr rm <name>',
    summary: 'stop tracking a program',
    details: ['Ledger history and ~/.drovr/programs/<name> are left in place.'],
    writes: 'control.json',
  },
  {
    name: 'mode',
    usage: 'drovr mode <off|low|normal|away>',
    summary: 'switch between preset reserve levels',
    details: [
      'Each mode is a ceiling on total usage, so the remainder is always held for Craig:',
      'off reserves everything, low 75%, normal 45%, away 15%.',
    ],
    writes: 'control.json',
  },
  {
    name: 'reserve',
    usage: 'drovr reserve [percent]',
    summary: 'how much quota is held for Craig rather than for programs',
    details: [
      'With no argument it reports the current reserve. With a percentage it sets one, which is',
      'the same setting a mode changes — just expressed the way it is usually thought about.',
      'The 5h burst ceiling keeps its ratio to the weekly one, so tightening the reserve cannot',
      'silently widen bursts.',
      'It applies to the current mode, so switching modes switches reserve levels with it.',
    ],
    examples: ['drovr reserve', 'drovr reserve 60'],
    writes: 'control.json',
  },
  {
    name: 'pause',
    usage: 'drovr pause <30m|3h|2d>  |  drovr pause <program> <duration>',
    summary: 'hold all cycles for a while, or just one program’s',
    details: [
      'Does not interrupt a cycle already running; it only stops new ones starting.',
      'With a program name, only that program rests — a cycle can also rest its own program',
      'with `drovr report --pause-until` when everything left is waiting on time.',
    ],
    writes: 'control.json',
  },
  {
    name: 'resume',
    usage: 'drovr resume [program]',
    summary: 'clear a pause — the global one, or one program’s',
    writes: 'control.json',
  },
  {
    name: 'cadence',
    usage: 'drovr cadence [program <every|off>]',
    summary: 'run a program at most once per window ("12h", "7d") instead of every tick',
    details: [
      'For programs that only need periodic attention. Measured from the last cycle start;',
      'nothing has run yet means the first cycle is never held. With no arguments, lists',
      'every program’s cadence. A cycle can set its own with `drovr report --cadence`.',
    ],
    examples: ['drovr cadence', 'drovr cadence joinery 7d', 'drovr cadence joinery off'],
    writes: 'control.json',
  },
  {
    name: 'ledger',
    usage: 'drovr ledger [program] [n] [--json] [--closing]',
    summary: 'recent cycles with their exit reason, yield and closing message',
    details: [
      'Exit reasons: context (hit the context ceiling), capacity (quota thinned), seam (milestone',
      'complete), blocked (everything waiting on an ask), crash (exited without a report),',
      'stalled (went idle without reporting and ignored every nudge), abandoned (still alive',
      'when the watch ran out — superseded by the real outcome if a report lands later).',
      'A program name keeps only that program’s cycles; n is the count after filtering.',
    ],
    flags: [
      {
        flag: '--json',
        describes: 'structured cycle records, with the meaning of each exit reason included',
      },
      {
        flag: '--closing',
        describes: 'print each runner’s last message under its row, lifted from its claude transcript',
      },
    ],
  },
  {
    name: 'release',
    usage: 'drovr release <program>',
    summary: "free a program's terminal when its runner outlived the cycle that started it",
    details: [
      'A runner that outlives its watch (maxCycleHours) keeps its terminal, and every later',
      'cycle for that program is refused because the terminal is occupied. Nothing releases it',
      'automatically: an idle runner with no report may hold unsaved work, and ending it is',
      "a decision drovr will not make for you. `drovr tidy` cannot do this — it only closes",
      'tabs that have no agent at all.',
      '',
      'Refuses, without touching it, when the runner is working or waiting on a dialog:',
      '/exit typed into a live turn is swallowed and the terminal stays held. Answer whatever it',
      'is waiting on in Orca first, then run this.',
    ],
    writes: "sends /exit to the program's runner and closes its terminal",
  },
  {
    name: 'usage',
    usage: 'drovr usage [--json]',
    summary: "how much of the pool Craig's own sessions take, against the reserve held for them",
    details: [
      'The mode ceilings exist to keep capacity free for Craig\'s foreground work. This is the',
      'only place drovr says whether the fraction he picked actually covers it. Measured from',
      'one usage sample per tick, so it is empty until the tick has fired a few times, and',
      'reports nothing rather than a confident number below 24 samples.',
      '',
      'yours = total account usage minus what drovr\'s own ledger accounts for, in account-units',
      '(N usable accounts = N.0). The p90 peak is what a reserve would have to cover; compare it',
      'to the reserve percentage on the line above. Nothing here feeds an admission decision —',
      'a gate that moved with measured behaviour would be a feedback loop.',
    ],
    flags: [{ flag: '--json', describes: 'per-bucket split and the p90 peak, with units named inline' }],
  },
  {
    name: 'service',
    usage: 'drovr service <status|install|uninstall|print> [seconds]',
    summary: 'manage the launchd agent that runs tick',
    details: [
      'tech.propra.drovr runs tick on [seconds] (default 600).',
      'status reports whether launchd has it loaded, and when a tick last actually recorded a',
      'decision — loaded only proves it is scheduled.',
      'install writes the plist and reloads the agent; launchd holds the plist it loaded, not',
      'the file on disk, so install always bootouts and bootstraps rather than only rewriting.',
      'print emits the plist without writing anything.',
    ],
    flags: [
      {
        flag: '--json',
        describes: 'structured state for both agents, each with the exact command that fixes it',
      },
    ],
    writes: 'both launchd plists, for install',
  },
  {
    name: 'init',
    usage: 'drovr init',
    summary: 'write a starter control.json',
    writes: 'control.json',
  },
  {
    name: 'help',
    usage: 'drovr help [command] [--json]',
    summary: 'this list, or detail for one command',
    details: ['--json emits the whole command tree, for an agent discovering the interface.'],
  },
];

const pad = (text: string, width: number): string => text.padEnd(width);

export const renderList = (): string => {
  const width = Math.max(...COMMANDS.map((command) => command.name.length)) + 2;
  const lines = COMMANDS.map((command) => `  ${pad(command.name, width)}${command.summary}`);
  return [
    'drovr — capacity-aware supervisor for long-horizon delivery loops',
    '',
    OVERVIEW,
    '',
    'Commands:',
    ...lines,
    '',
    'Every read command accepts --json, whose values carry their own units and meanings — parse',
    'that rather than these columns.',
    '',
    'Run `drovr help <command>` for detail, or `drovr help --json` for the whole tree plus the',
    'verdict vocabulary, exit reasons, and state-file locations.',
  ].join('\n');
};

export const renderCommand = (command: Command): string => {
  const parts = [command.usage, '', `  ${command.summary}`];

  if (command.details !== undefined) parts.push('', ...command.details.map((line) => `  ${line}`));

  if (command.flags !== undefined) {
    const width = Math.max(...command.flags.map((entry) => entry.flag.length)) + 2;
    parts.push('', 'Flags:', ...command.flags.map((e) => `  ${pad(e.flag, width)}${e.describes}`));
  }

  if (command.examples !== undefined) {
    parts.push('', 'Examples:', ...command.examples.map((line) => `  ${line}`));
  }

  parts.push('', `Writes: ${command.writes ?? 'nothing — read-only'}`);
  return parts.join('\n');
};

export const findCommand = (name: string): Command | undefined =>
  COMMANDS.find((command) => command.name === name);

export const helpTree = (): unknown => ({
  tool: 'drovr',
  overview: OVERVIEW,
  usingThis: AGENT_NOTES,
  commands: COMMANDS,
});
