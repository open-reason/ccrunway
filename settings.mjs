// Shared by install.mjs, uninstall.mjs and cli.mjs: find, add and remove ccrunway's
// entries in a Claude Code settings.json without touching anyone else's.

import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from './state.mjs';

export const here = path.dirname(fileURLToPath(import.meta.url));
// where install copies the code, so the hooks survive a cleared npx cache
export const appDir = () => path.join(home(), 'app');
// Copies the runtime files to appDir() unless this already is that copy; returns its path.
// Swapped in whole (app.new → app) so a refresh never runs half of each version.
export function copyApp() {
  const app = appDir();
  if (path.resolve(here) === path.resolve(app)) return app;
  const tmp = `${app}.new`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(path.join(tmp, 'menubar'), { recursive: true });
  const runtime = (f) =>
    (/\.mjs$/.test(f) && !/\.test\.mjs$/.test(f)) ||
    ['claude-five-weights.json', 'codex-weights.json', 'package.json'].includes(f);
  for (const f of readdirSync(here))
    if (runtime(f)) copyFileSync(path.join(here, f), path.join(tmp, f));
  for (const f of readdirSync(path.join(here, 'menubar')))
    if (runtime(f)) copyFileSync(path.join(here, 'menubar', f), path.join(tmp, 'menubar', f));
  for (const d of ['skill', 'menubar/plugin', 'menubar/sprites'])
    cpSync(path.join(here, d), path.join(tmp, d), { recursive: true });
  // SwiftBar runs only an executable plugin; a umask or a tarball may drop the bit
  chmodSync(path.join(tmp, 'menubar', 'plugin', PLUGIN), 0o755);
  rmSync(app, { recursive: true, force: true });
  renameSync(tmp, app);
  return app;
}
export const PLUGIN = 'ccrunway.5s.sh';

// the node running this, by the name the PATH gives it when that is the same binary:
// Homebrew's /opt/homebrew/bin/node survives `brew upgrade`, its Cellar path does not.
// A PATH name in a per-shell temp folder does not survive the shell: fnm puts a
// fnm_multishells/<pid>_<time>/bin link on each shell's PATH and macOS clears the temp
// folders, so there the link's target is used instead.
const TEMP = () => [os.tmpdir(), '/private/var/folders', '/var/folders', '/tmp', '/private/tmp'];
export const isTempPath = (p) =>
  p.includes(`${path.sep}fnm_multishells${path.sep}`) ||
  TEMP().some((t) => {
    const r = path.resolve(t);
    return p === r || p.startsWith(`${r}${path.sep}`);
  });
export function stableNode(PATH = process.env.PATH, execPath = process.execPath) {
  const real = (p) => {
    try {
      return realpathSync(p);
    } catch {
      return null;
    }
  };
  const me = real(execPath);
  const keep = (p) => (isTempPath(p) ? (real(p) ?? p) : p);
  for (const dir of (PATH || '').split(path.delimiter)) {
    const p = path.join(dir, 'node');
    if (path.isAbsolute(p) && !p.includes('_npx') && me && real(p) === me) return keep(p);
  }
  return keep(execPath);
}

// the OS ccrunway thinks it runs on; CCRUNWAY_PLATFORM is for tests only (the Linux
// paths of install and doctor, on a Mac)
export const platform = () => process.env.CCRUNWAY_PLATFORM || process.platform;
export const MIN_NODE = 20;
const major = (v) => Number(/^v?(\d+)\./.exec(String(v).trim())?.[1]) || null;
export const nodeMajor = () => major(process.version);
// another node binary's major version, by running it (2 s); null if it does not run
export function binMajor(bin) {
  try {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
    return r.status === 0 ? major(r.stdout) : null;
  } catch {
    return null;
  }
}
// one word for /bin/sh, in double quotes: a home folder or node path may hold a space
const dq = (s) => `"${String(s).replace(/(["\\$`])/g, '\\$1')}"`;
const undq = (s) => s.replace(/\\(.)/g, '$1');
const WORD = '"((?:[^"\\\\]|\\\\.)*)"';
// a CCRUNWAY_HOME set at install goes into the commands, so the hooks write there however
// Claude Code was started; unset, the commands are as they always were
export const envPrefix = () => (process.env.CCRUNWAY_HOME ? `CCRUNWAY_HOME=${dq(path.resolve(home()))} ` : '');
const LEAD = new RegExp(`^(?:CCRUNWAY_HOME=${WORD} )?${WORD}`);
// the node binary a hook or status line command runs: its first quoted word after the
// optional CCRUNWAY_HOME=
export const cmdNode = (command) => {
  const m = LEAD.exec(command || '');
  return m ? undq(m[2]) : null;
};
// the CCRUNWAY_HOME a command carries, or null
export const cmdHome = (command) => {
  const m = LEAD.exec(command || '');
  return m?.[1] != null ? undq(m[1]) : null;
};

// the turn ledger needs the first two; PostToolUse sizes tool results; PreModelSwitch
// prices a model switch before it happens
export const EVENTS = ['UserPromptSubmit', 'Stop', 'PostToolUse', 'PreModelSwitch'];

const cmd = (node, file) => `${envPrefix()}${dq(node)} ${dq(path.join(appDir(), file))}`;
export const hookCmd = (node = process.execPath) => cmd(node, 'hook.mjs');
export const statusCmd = (node = process.execPath) => cmd(node, 'statusline.mjs');
// the skill's command line: a `ccrunway mute` from Claude Code reaches the same home
export const cliCmd = (node = process.execPath) => cmd(node, 'cli.mjs');

// this home's app copy, the default ~/.ccrunway/app, or any app copy a command names with
// its CCRUNWAY_HOME baked in (an uninstall run without that variable still finds it)
const mentions = (command, file) => {
  const f = file.replace('.', '\\.');
  return (
    command.includes(path.join(appDir(), file)) ||
    new RegExp(`\\.ccrunway/app/${f}`).test(command) ||
    (cmdHome(command) != null && new RegExp(`/app/${f}"$`).test(command))
  );
};

// ours: the app copy under CCRUNWAY_HOME (or the default ~/.ccrunway/app)
export const isOurHook = (h) => mentions(h?.command || '', 'hook.mjs');
export const isOurStatus = (s) => mentions(s?.command || '', 'statusline.mjs');

export function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (next != null && !next.startsWith('--')) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

export const settingsPath = (opt) =>
  path.resolve(opt.settings || path.join(os.homedir(), '.claude', 'settings.json'));

// remove hooks that match `which` (default: ours and the old names); drop groups and
// events left empty by that
export function stripHooks(settings, which = isOurHook) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    if (!Array.isArray(hooks[ev])) continue;
    hooks[ev] = hooks[ev]
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !which(h)) }))
      .filter((g) => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) settings.hooks = undefined;
  return settings;
}

// the status line plus the four hooks, each in a group of its own after anyone else's,
// 5 s timeout; call stripHooks first. node: the absolute node binary found at install,
// so nothing depends on the PATH Claude Code was started with.
export function addRunway(settings, node = process.execPath) {
  settings.statusLine = { type: 'command', command: statusCmd(node), refreshInterval: 5 };
  settings.hooks ||= {};
  for (const ev of EVENTS) {
    settings.hooks[ev] ||= [];
    settings.hooks[ev].push({ hooks: [{ type: 'command', command: hookCmd(node), timeout: 5 }] });
  }
  return settings;
}

export const serialize = (obj) => `${JSON.stringify(obj, null, 2)}\n`;
