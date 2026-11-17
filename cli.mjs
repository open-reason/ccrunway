#!/usr/bin/env node
// ccrunway's command line. `ccrunway` with no command prints the help.
// Every change takes effect on the next hook or status line refresh; no restart.
// Text is for people, one line per fact. --json, on every command, is for agents: exactly
// one JSON object on stdout with "schema": 1 and "ok"; a failure is
// {"schema":1,"ok":false,"error":{code, message, fix}} (fix: a command to run, or null).
// Exit codes: 0 ok, 1 failed (error.code says why), 2 bad usage (USAGE), 3 not installed
// (NOT_INSTALLED) for the commands that only change the status line; `now --exit-code`
// adds 10 amber and 11 red. Nothing asks a question without a terminal or under --json:
// it fails with NEEDS_CONFIRM and names the --yes command instead.
// COMMANDS below drives the parsing, the checks and `help --json`, so they cannot drift.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { doctor, doctorText } from './doctor.mjs';
import { clockNow, filterChats, nowReport, nowText, worstExit } from './now.mjs';
import { clock, isoLocal } from './range.mjs';
import { here, isOurHook, isOurStatus, settingsPath } from './settings.mjs';
import { home, mutedUntil, readConfig, readJSON, writeConfig } from './state.mjs';
import { menubarOff, menubarOn, menubarState } from './swiftbar.mjs';

const VERSION = readJSON(path.join(here, 'package.json'), {})?.version ?? '?';
const SCHEMA = 1;

const F = {
  json: { description: 'one JSON object on stdout (schema 1), nothing else' },
  settings: { value: 'path', description: 'another settings.json (default ~/.claude/settings.json)' },
  'dry-run': { description: 'print the resulting settings, write nothing' },
  node: { value: 'abs path', description: 'the node binary the hooks and status line run with' },
  yes: { description: 'answer yes to installing SwiftBar' },
  tool: { value: 'claude|codex', choices: ['claude', 'codex'], description: 'one tool only' },
  chat: { value: 'id|name', description: 'chats whose id starts with this or whose name is this (any case)' },
  'exit-code': { description: 'exit 10 when the worst tool shown is amber, 11 when red' },
  force: { description: 'install on an OS other than macOS (untested)' },
  purge: { description: 'also delete the data folder and the installed copy (CCRUNWAY_HOME)' },
};

const COMMANDS = [
  {
    name: 'now',
    args: '',
    flags: ['json', 'tool', 'chat', 'exit-code', 'settings'],
    needs_install: false,
    description:
      "each tool's 5-hour meter, pace, verdict, top drain and chats (cache, next-send cost); works before install",
  },
  {
    name: 'status',
    args: '',
    flags: ['json', 'settings'],
    needs_install: false,
    description: 'installed or not, the wrapped status line, mute, debug, menu bar',
  },
  {
    name: 'doctor',
    args: '',
    flags: ['json', 'settings'],
    needs_install: false,
    description:
      'check the install, check by check: OS, node, settings, status line, wrapped line, hooks, app copy, data folder, meter, turns, menu bar, SwiftBar running; exit 1 when a required check fails',
  },
  {
    name: 'install',
    args: '',
    flags: ['json', 'settings', 'dry-run', 'node', 'force'],
    needs_install: false,
    description: 'add the status line and hooks to settings.json; your current status line keeps printing above ours',
  },
  {
    name: 'uninstall',
    args: '',
    flags: ['json', 'settings', 'dry-run', 'purge'],
    needs_install: false,
    description:
      'remove them, put your status line back, turn the menu bar item off; the data stays unless --purge',
  },
  {
    name: 'mute',
    args: '[<time>]',
    flags: ['json', 'settings'],
    needs_install: true,
    description: 'show "muted" instead of the runway line for 30m, 2h, 1d (default 1h); the meter history keeps updating',
  },
  {
    name: 'unmute',
    args: '',
    flags: ['json', 'settings'],
    needs_install: true,
    description: 'show the runway line again',
  },
  {
    name: 'debug',
    args: 'on|off',
    flags: ['json', 'settings'],
    needs_install: true,
    description: "add the reset's seconds and the meter's age to the line",
  },
  {
    name: 'menubar',
    args: '[status|on|off]',
    flags: ['json', 'yes'],
    needs_install: false,
    description:
      "Claude Code's and Codex's pace in the macOS menu bar through SwiftBar. on installs SwiftBar (Homebrew, or a download) if missing, after asking (--yes); off undoes only what on did; no argument = status",
  },
  { name: 'help', args: '', flags: ['json'], needs_install: false, description: 'this help' },
  { name: 'version', args: '', flags: ['json'], needs_install: false, description: 'the version' },
];

const EXIT_CODES = {
  0: 'ok',
  1: 'failed; error.code says why (doctor: a required check failed, see checks)',
  2: 'bad usage: unknown command, flag or argument (USAGE)',
  3: 'not installed, for a command that needs it (NOT_INSTALLED; fix: npx ccrunway install)',
  10: 'now --exit-code: the worst tool shown is amber',
  11: 'now --exit-code: the worst tool shown is red',
};
const ENV = [
  { name: 'CCRUNWAY_HOME', description: `where the data lives (default ~/.ccrunway; now ${home()})` },
  { name: 'CODEX_HOME', description: "Codex's folder, read for the Codex numbers (default ~/.codex)" },
  { name: 'NO_COLOR', description: 'no colour in text output' },
  { name: 'CCRUNWAY_NOW', description: 'tests: the clock `now` reads at (ms or ISO)' },
  { name: 'CCRUNWAY_PLATFORM', description: 'tests: the OS install and doctor see (e.g. linux)' },
];
const STATE_DOC = {
  none: 'no 5-hour meter reading for this tool',
  cold: 'under 5 min of readings, the reset passed, or no rise yet: no verdict',
  green: 'runs out 15 min or more after the reset',
  amber: 'runs out 0–15 min after the reset',
  red: 'runs out before the reset',
};

const flagName = (f) => `--${f}${F[f].value ? ` <${F[f].value}>` : ''}`;
const HELP = `ccrunway ${VERSION}: when you will hit the Claude Code 5-hour limit at this pace, and why

  now [--tool claude|codex] [--chat <id|name>] [--exit-code]
                           each tool's meter, pace, verdict, top drain and chats, with a
                           cold cache's next-send cost; --exit-code exits 10 amber, 11 red
  install                  add the status line and hooks to ~/.claude/settings.json;
                           your current status line keeps printing above ours.
                           --node <absolute path> picks the node they run with;
                           macOS only (--force tries anyway, untested)
  doctor                   is it set up and working? one line per check, with the fix
  uninstall                remove them and put your status line back; --purge also
                           deletes the data folder
  status                   installed or not, the wrapped status line, mute, debug, menu bar
  mute [<time>]            show "muted" instead of the runway line for a while:
                           30m, 2h, 1d (default 1h); the meter history keeps updating
  unmute                   show the runway line again
  debug on|off             add the reset's seconds and the meter's age to the line
  menubar [status|on|off]  Claude Code's and Codex's pace in the macOS menu bar, through
                           SwiftBar (installed with Homebrew, or downloaded, if missing;
                           asks first, --yes to skip the question). off undoes only what
                           on did; no argument shows its state

  Every command takes --json: one JSON object on stdout ("schema": 1, "ok"); \`help --json\`
  lists the commands, flags and exit codes. Exit codes: 0 ok, 1 failed, 2 bad usage,
  3 not installed (mute, unmute, debug). install and uninstall take --settings <path>
  (another settings.json) and --dry-run (print the result, write nothing). Data lives in
  ${home()} (CCRUNWAY_HOME).
`;

const argv = process.argv.slice(2);
const JSON_OUT = argv.includes('--json');
const out = (s) => process.stdout.write(`${s}\n`);
const emit = (obj) => out(JSON.stringify({ schema: SCHEMA, ok: true, ...obj }));

// text: the message on stderr; --json: the error object on stdout
function fail(message, { code = 'FAILED', fix = null, exit = 1, extra = {}, text = message } = {}) {
  if (JSON_OUT) out(JSON.stringify({ schema: SCHEMA, ok: false, error: { code, message, fix }, ...extra }));
  else process.stderr.write(`${text}\n`);
  process.exit(exit);
}
const usage = (message, text = message) =>
  fail(message, { code: 'USAGE', fix: 'npx ccrunway help', exit: 2, text });

// argv after the command → { pos, opt }, checked against the command's flags
function parse(spec, rest) {
  const pos = [];
  const opt = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    if (!spec.flags.includes(name)) usage(`unknown flag --${name} for ${spec.name}`);
    const f = F[name];
    if (!f.value) {
      opt[name] = true;
      continue;
    }
    const v = inline ?? rest[i + 1];
    if (v == null || (inline == null && v.startsWith('--'))) usage(`${flagName(name)} needs a value`);
    if (inline == null) i++;
    if (f.choices && !f.choices.includes(v)) usage(`--${name} takes ${f.choices.join(' or ')}, not "${v}"`);
    opt[name] = v;
  }
  return { pos, opt };
}

function installed(opt) {
  try {
    const s = JSON.parse(readFileSync(settingsPath(opt), 'utf8'));
    const hooks = Object.values(s.hooks || {})
      .flat()
      .some((g) => (g.hooks || []).some(isOurHook));
    return hooks || isOurStatus(s.statusLine);
  } catch {
    return false;
  }
}

function state(opt) {
  const c = readConfig();
  const muted = mutedUntil();
  const meta = readJSON(path.join(home(), 'install.json'), null);
  return {
    version: VERSION,
    installed: installed(opt),
    settings: settingsPath(opt),
    home: home(),
    wraps: meta?.prevStatusLine?.command ?? null,
    debug: c.debug === true,
    muted_until: muted ? isoLocal(muted) : null,
    menubar: menubarState(),
  };
}

function menubarLines(m) {
  const lines = [
    `menu bar: ${
      !m.on
        ? 'off'
        : m.hidden
          ? `set up (${m.link}), but SwiftBar now reads another folder, so it does not show`
          : `on (${m.link})`
    }`,
  ];
  if (m.on || m.swiftbar)
    lines.push(
      `swiftbar: ${
        m.swiftbar
          ? `${m.swiftbar_running ? 'running' : 'not running (open it to see the item)'}, ${m.swiftbar}${m.swiftbar_installed_by ? ` (installed by ccrunway with ${m.swiftbar_installed_by})` : ''}`
          : 'not installed: run `npx ccrunway menubar on`'
      }`,
    );
  return lines;
}

function duration(s = '1h') {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)?$/i.exec(String(s).trim());
  if (!m) usage(`can't read "${s}": use something like 30m, 2h or 1d`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || 'h').toLowerCase()];
}

// install.mjs / uninstall.mjs, which print their own text or JSON
const script = (name, rest) => {
  const r = spawnSync(process.execPath, [path.join(here, name), ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
};

// --- dispatch ---------------------------------------------------------------------------

let [cmd, ...rest] = argv;
const ALIAS = { '--help': 'help', '-h': 'help', '--version': 'version', '-v': 'version' };
if (cmd === undefined || (cmd === '--json' && rest.length === 0)) cmd = 'help';
cmd = ALIAS[cmd] ?? cmd;
// --help after a command is help too
if (rest.includes('--help') || rest.includes('-h')) {
  rest = rest.filter((a) => a === '--json');
  cmd = 'help';
}
const spec = COMMANDS.find((c) => c.name === cmd);
if (!spec) usage(`unknown command "${cmd}"`, `unknown command "${cmd}"\n\n${HELP}`);
const { pos, opt } = parse(spec, rest);
const maxArgs = spec.args ? 1 : 0;
if (pos.length > maxArgs) usage(`${cmd} takes ${spec.args || 'no arguments'}, got "${pos.join(' ')}"`);
if (spec.needs_install && !installed(opt))
  fail(`ccrunway is not installed in ${settingsPath(opt)}`, {
    code: 'NOT_INSTALLED',
    fix: 'npx ccrunway install',
    exit: 3,
    text: `ccrunway is not installed in ${settingsPath(opt)}: run \`npx ccrunway install\``,
  });

switch (cmd) {
  case 'help':
    if (!JSON_OUT) {
      out(HELP.trimEnd());
      break;
    }
    emit({
      version: VERSION,
      commands: COMMANDS.map((c) => ({
        name: c.name,
        args: c.args,
        flags: c.flags.map((f) => ({ name: flagName(f), description: F[f].description })),
        description: c.description,
        needs_install: c.needs_install,
      })),
      exit_codes: EXIT_CODES,
      states: STATE_DOC,
      env: ENV,
    });
    break;

  case 'version':
    if (JSON_OUT) emit({ version: VERSION });
    else out(VERSION);
    break;

  case 'doctor': {
    const d = doctor(opt);
    if (JSON_OUT) emit(d);
    else out(doctorText(d));
    // a failed check is data, not an error: the object above, then exit 1
    process.exitCode = d.ok ? 0 : 1;
    break;
  }

  case 'install':
    script('install.mjs', rest);
    break;

  case 'uninstall':
    script('uninstall.mjs', rest);
    break;

  case 'now': {
    const now = clockNow();
    const report = nowReport(now, opt.tool ? [opt.tool] : ['claude', 'codex']);
    if (opt.chat != null && !filterChats(report, opt.chat))
      fail(`no chat matches "${opt.chat}" in the last 20 min`, {
        code: 'NO_SUCH_CHAT',
        fix: `npx ccrunway now${opt.tool ? ` --tool ${opt.tool}` : ''}`,
      });
    const muted = mutedUntil();
    if (JSON_OUT)
      emit({
        at: isoLocal(now),
        installed: installed(opt),
        muted_until: muted ? isoLocal(muted) : null,
        ...report,
      });
    else out(nowText(report, muted));
    if (opt['exit-code']) process.exit(worstExit(report));
    break;
  }

  case 'status': {
    const s = state(opt);
    if (JSON_OUT) {
      emit(s);
      break;
    }
    out(`ccrunway ${s.version}`);
    out(`installed: ${s.installed ? 'yes' : 'no'} (${s.settings})`);
    out(`wraps: ${s.wraps ?? 'nothing (no earlier status line)'}`);
    out(`muted: ${s.muted_until ? `until ${clock(Date.parse(s.muted_until))}` : 'no'}`);
    out(`debug: ${s.debug ? 'on' : 'off'}`);
    for (const l of menubarLines(s.menubar)) out(l);
    out(`data: ${s.home}`);
    break;
  }

  case 'mute': {
    const until = Date.now() + duration(pos[0]);
    writeConfig({ mutedUntil: until });
    if (JSON_OUT) emit({ muted_until: isoLocal(until) });
    else out(`ccrunway muted until ${clock(until)}`);
    break;
  }

  case 'unmute':
    writeConfig({ mutedUntil: null });
    if (JSON_OUT) emit({ muted_until: null });
    else out('ccrunway unmuted');
    break;

  case 'debug': {
    const v = pos[0];
    if (v !== 'on' && v !== 'off') usage('say debug on or debug off', 'say on or off');
    writeConfig({ debug: v === 'on' });
    if (JSON_OUT) emit({ debug: v === 'on' });
    else out(`ccrunway debug ${v}`);
    break;
  }

  case 'menubar': {
    const v = pos[0] ?? 'status';
    if (!['status', 'on', 'off'].includes(v)) usage('say menubar on, menubar off or menubar status');
    if (v === 'status') {
      const m = menubarState();
      if (JSON_OUT) emit({ menubar: m });
      else for (const l of menubarLines(m)) out(l);
      break;
    }
    // under --json the lines are kept for the object, never printed
    const log = [];
    const say = JSON_OUT ? (l) => log.push(l) : out;
    const info = {};
    const code =
      v === 'on' ? menubarOn({ yes: opt.yes === true, out: say, prompt: !JSON_OUT, info }) : menubarOff({ out: say });
    if (!JSON_OUT) process.exit(code);
    if (code !== 0)
      fail(log.at(-1) ?? 'menu bar not set up', { code: info.code ?? 'FAILED', fix: info.fix ?? null, extra: { log } });
    emit({ menubar: menubarState(), log });
    break;
  }
}
