#!/usr/bin/env node
// ccrunway's command line. `ccrunway` with no command prints the help.
// Every change takes effect on the next hook or status line refresh; no restart.
// Output is plain text, one line per fact; `status --json` is for scripts.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { clock } from './range.mjs';
import { args, here, isOurHook, isOurStatus, settingsPath } from './settings.mjs';
import { home, mutedUntil, readConfig, readJSON, writeConfig } from './state.mjs';
import { menubarOff, menubarOn, menubarState } from './swiftbar.mjs';

const VERSION = readJSON(path.join(here, 'package.json'), {})?.version ?? '?';

const HELP = `ccrunway ${VERSION}: when you will hit the Claude Code 5-hour limit at this pace, and why

  install                  add the status line and hooks to ~/.claude/settings.json;
                           your current status line keeps printing above ours
  uninstall                remove them and put your status line back
  status [--json]          installed or not, the wrapped status line, mute, debug
  mute [<time>]            show "muted" instead of the runway line for a while:
                           30m, 2h, 1d (default 1h); the meter history keeps updating
  unmute                   show the runway line again
  debug on|off             add the reset's seconds and the meter's age to the line
  menubar on|off           Claude Code's and Codex's pace in the macOS menu bar, through
                           SwiftBar (installed with Homebrew, or downloaded, if missing;
                           asks first, --yes to skip the question). off undoes only what
                           on did

  install and uninstall take --settings <path> (another settings.json) and --dry-run
  (print the result, write nothing). Data lives in ${home()} (CCRUNWAY_HOME).
`;

const [cmd, ...rest] = process.argv.slice(2);
const opt = args(rest);
const out = (s) => process.stdout.write(`${s}\n`);
const fail = (s) => {
  process.stderr.write(`${s}\n`);
  process.exit(1);
};

function installed() {
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

function state() {
  const c = readConfig();
  const muted = mutedUntil();
  const meta = readJSON(path.join(home(), 'install.json'), null);
  return {
    version: VERSION,
    installed: installed(),
    settings: settingsPath(opt),
    home: home(),
    wraps: meta?.prevStatusLine?.command ?? null,
    debug: c.debug === true,
    muted_until: muted ? new Date(muted).toISOString() : null,
    menubar: menubarState(),
  };
}

function duration(s = '1h') {
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)?$/i.exec(String(s).trim());
  if (!m) fail(`can't read "${s}": use something like 30m, 2h or 1d`);
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] || 'h').toLowerCase()];
}

const script = (name) => {
  const r = spawnSync(process.execPath, [path.join(here, name), ...rest], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
};

switch (cmd) {
  case undefined:
  case 'help':
  case '--help':
  case '-h':
    out(HELP.trimEnd());
    break;

  case '--version':
  case '-v':
  case 'version':
    out(VERSION);
    break;

  case 'install':
    script('install.mjs');
    break;

  case 'uninstall':
    script('uninstall.mjs');
    break;

  case 'status': {
    const s = state();
    if (rest.includes('--json')) {
      out(JSON.stringify(s));
      break;
    }
    out(`ccrunway ${s.version}`);
    out(`installed: ${s.installed ? 'yes' : 'no'} (${s.settings})`);
    out(`wraps: ${s.wraps ?? 'nothing (no earlier status line)'}`);
    out(`muted: ${s.muted_until ? `until ${clock(s.muted_until)}` : 'no'}`);
    out(`debug: ${s.debug ? 'on' : 'off'}`);
    const m = s.menubar;
    out(
      `menu bar: ${
        !m.on
          ? 'off'
          : m.hidden
            ? `set up (${m.link}), but SwiftBar now reads another folder, so it does not show`
            : `on (${m.link})`
      }`,
    );
    if (m.on || m.swiftbar)
      out(
        `swiftbar: ${
          m.swiftbar
            ? `${m.swiftbar_running ? 'running' : 'not running (open it to see the item)'}, ${m.swiftbar}${m.swiftbar_installed_by ? ` (installed by ccrunway with ${m.swiftbar_installed_by})` : ''}`
            : 'not installed: run `ccrunway menubar on`'
        }`,
      );
    out(`data: ${s.home}`);
    break;
  }

  case 'mute': {
    const until = Date.now() + duration(rest[0]);
    writeConfig({ mutedUntil: until });
    out(`ccrunway muted until ${clock(until)}`);
    break;
  }

  case 'unmute':
    writeConfig({ mutedUntil: null });
    out('ccrunway unmuted');
    break;

  case 'debug': {
    const v = rest[0];
    if (v !== 'on' && v !== 'off') fail('say on or off');
    writeConfig({ debug: v === 'on' });
    out(`ccrunway debug ${v}`);
    break;
  }

  case 'menubar': {
    const v = rest.find((a) => !a.startsWith('--')) ?? 'on';
    if (v === 'on') process.exit(menubarOn({ yes: rest.includes('--yes'), out }));
    if (v === 'off') process.exit(menubarOff({ out }));
    fail('say menubar on or menubar off');
    break;
  }

  default:
    fail(`unknown command "${cmd}"\n\n${HELP}`);
}
