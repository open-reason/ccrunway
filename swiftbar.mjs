// `ccrunway menubar on|off`: Claude Code's and Codex's pace in the macOS menu bar, drawn by
// SwiftBar (https://github.com/swiftbar/SwiftBar), which runs menubar/plugin/ccrunway.5s.sh
// every 5 s. The plugin reads files on this Mac and sends nothing.
//
// on:
//   - copies the code to CCRUNWAY_HOME/app if `ccrunway install` has not (Codex-only use)
//   - SwiftBar missing: offers `brew install --cask swiftbar` when brew is on the PATH, else
//     downloads the pinned release below into ~/Applications and checks its SHA-256 (a
//     mismatch installs nothing). Asks first on a terminal; --yes answers for you, and
//     without a terminal or --yes, or under --json (which never asks), nothing is
//     installed and the failure's code is NEEDS_CONFIRM. A LaunchAgent opens a SwiftBar we
//     installed at login (SwiftBar's own "Launch at login" can only be set from the app)
//   - SwiftBar has a plugin folder: a link to our plugin goes in beside the user's own
//     plugins, never over a file of theirs. It has none: the folder becomes
//     CCRUNWAY_HOME/menubar, which holds only that link, and SwiftBar restarts to read it
//     (not app/menubar/plugin itself: a re-install replaces app/)
// off: removes only what `on` did, as recorded in CCRUNWAY_HOME/menubar.json: the link, the
//   plugin folder setting if SwiftBar still has ours, the LaunchAgent, and a SwiftBar we
//   downloaded. A SwiftBar Homebrew installed stays (brew owns it); we quit it.
//
// Tests: CCRUNWAY_SB_ROOT=<dir> puts the Applications folders, the LaunchAgents folder and
// SwiftBar's preferences (a plist file, written with the real `defaults`) under <dir>;
// open, pkill, launchctl and brew are printed, not run (brew and open are simulated with
// files), and CCRUNWAY_SWIFTBAR_URL / CCRUNWAY_SWIFTBAR_SHA256 swap the download.

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readSync,
  readdirSync,
  readlinkSync,
  rmSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PLUGIN, appDir, copyApp, stableNode } from './settings.mjs';
import { home, readJSON, writeJSON } from './state.mjs';

// notarised (Developer ID, Ameba Labs, X93LWC49WV, ticket stapled; spctl accepted,
// checked 2026-11-13); needs macOS 12+
export const SWIFTBAR = {
  version: '2.1.1',
  url: 'https://github.com/swiftbar/SwiftBar/releases/download/v2.1.1/SwiftBar.v2.1.1.b597.zip',
  sha256: 'fcdec490782d6587046304044951c63de49ac422fc63892a6fab2dd7bc70c0cd',
  id: 'com.ameba.SwiftBar',
};
const LABEL = 'ccrunway.swiftbar';

const ROOT = process.env.CCRUNWAY_SB_ROOT || '';
const userHome = () => (ROOT ? path.join(ROOT, 'home') : os.homedir());
const prefs = () => (ROOT ? path.join(ROOT, 'swiftbar-prefs') : SWIFTBAR.id);
const agentPath = () => path.join(userHome(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
export const recordPath = () => path.join(home(), 'menubar.json');
export const ownFolder = () => path.join(home(), 'menubar');
const plugin = () => path.join(appDir(), 'menubar', 'plugin', PLUGIN);
const download = () => ({
  url: (ROOT && process.env.CCRUNWAY_SWIFTBAR_URL) || SWIFTBAR.url,
  sha256: (ROOT && process.env.CCRUNWAY_SWIFTBAR_SHA256) || SWIFTBAR.sha256,
});

const tilde = (p) => (p && p.startsWith(`${userHome()}/`) ? `~${p.slice(userHome().length)}` : p);
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
// ours: a link to some ccrunway app's plugin (this one or another CCRUNWAY_HOME's)
const ours = (p) => {
  if (!isLink(p)) return false;
  const t = readlinkSync(p);
  return t === plugin() || /\/app\/menubar\/plugin\/ccrunway\.5s\.sh$/.test(t);
};

export function swiftbarApp() {
  const sys = ROOT ? path.join(ROOT, 'Applications') : '/Applications';
  for (const a of [path.join(sys, 'SwiftBar.app'), path.join(userHome(), 'Applications', 'SwiftBar.app')])
    if (existsSync(a)) return a;
  return null;
}

// SwiftBar's plugin folder, ~ expanded, or null
export function pluginFolder() {
  try {
    let f = execFileSync('defaults', ['read', prefs(), 'PluginDirectory'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (f === '~') f = userHome();
    else if (f.startsWith('~/')) f = path.join(userHome(), f.slice(2));
    return f.replace(/\/$/, '') || null;
  } catch {
    return null;
  }
}

export function running() {
  if (ROOT) return existsSync(path.join(ROOT, 'running'));
  return spawnSync('pgrep', ['-xq', 'SwiftBar']).status === 0;
}

// open, pkill, launchctl, brew: run, or under the test root printed and simulated.
// toStderr: under --json stdout holds one JSON object, so brew's progress goes to stderr
function act(out, cmd, argv, toStderr = false) {
  const brew = path.basename(cmd) === 'brew';
  // brew's own progress shows; the rest is quiet
  const shown = toStderr ? ['ignore', 2, 2] : 'inherit';
  if (!ROOT) return spawnSync(cmd, argv, { stdio: brew ? shown : 'ignore' }).status === 0;
  out(`  (test) ${cmd} ${argv.join(' ')}`);
  if (cmd === 'open') writeFileSync(path.join(ROOT, 'running'), '');
  if (cmd === 'pkill') rmSync(path.join(ROOT, 'running'), { force: true });
  if (brew) {
    if (process.env.CCRUNWAY_SB_BREW_FAILS) return false;
    mkdirSync(path.join(ROOT, 'Applications', 'SwiftBar.app'), { recursive: true });
  }
  return true;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function quit(out) {
  if (!running()) return;
  // a signal, not an AppleScript quit: that would ask for Automation consent
  act(out, 'pkill', ['-x', 'SwiftBar']);
  for (let i = 0; i < 20 && running(); i++) sleep(250);
}

export function brewPath() {
  if (ROOT) return process.env.CCRUNWAY_SB_BREW || null;
  for (const dir of (process.env.PATH || '').split(path.delimiter).concat(['/opt/homebrew/bin', '/usr/local/bin'])) {
    const p = path.join(dir, 'brew');
    if (dir && existsSync(p)) return p;
  }
  return null;
}

// true, false (answered no), or null: no one to ask (no terminal, or prompt off for --json)
function ask(question, yes, prompt = true) {
  if (yes) return true;
  if (!prompt || !process.stdin.isTTY) return null;
  process.stdout.write(`${question} [Y/n] `);
  const buf = Buffer.alloc(256);
  let n = 0;
  try {
    n = readSync(0, buf, 0, buf.length, null);
  } catch {
    return false;
  }
  const a = buf.toString('utf8', 0, n).trim().toLowerCase();
  return a === '' || a === 'y' || a === 'yes';
}

function macosMajor() {
  if (ROOT) return 99;
  try {
    return Number(execFileSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).split('.')[0]) || 0;
  } catch {
    return 0;
  }
}

// a failure's code for --json: why, and the command that would get past it
const why = (info, code, fix = null) => Object.assign(info, { code, fix });
const declined = (answer) => (answer === null ? 'NEEDS_CONFIRM' : 'DECLINED');

// → { app, by: 'brew' | 'download' } or null, with what happened in out() and, on null,
// the reason in info ({ code, fix })
function installSwiftBar(out, yes, prompt, info) {
  const brew = brewPath();
  if (brew) {
    const a = ask('SwiftBar draws the menu bar item. Install it with `brew install --cask swiftbar`?', yes, prompt);
    if (!a) {
      out('menu bar not set up: SwiftBar is needed. Run `brew install --cask swiftbar`, or `npx ccrunway menubar on --yes`');
      why(info, declined(a), 'npx ccrunway menubar on --yes');
      return null;
    }
    if (!act(out, brew, ['install', '--cask', 'swiftbar'], !prompt) || !swiftbarApp()) {
      out('menu bar not set up: `brew install --cask swiftbar` failed');
      why(info, 'SWIFTBAR_INSTALL_FAILED', 'brew install --cask swiftbar');
      return null;
    }
    out(`SwiftBar installed with Homebrew: ${tilde(swiftbarApp())}`);
    return { app: swiftbarApp(), by: 'brew' };
  }
  if (macosMajor() < 12) {
    out(`menu bar not set up: SwiftBar ${SWIFTBAR.version} needs macOS 12 or newer`);
    why(info, 'MACOS_TOO_OLD');
    return null;
  }
  const { url, sha256 } = download();
  const a = ask(`SwiftBar draws the menu bar item. Download SwiftBar ${SWIFTBAR.version} from github.com/swiftbar/SwiftBar into ~/Applications?`, yes, prompt);
  if (!a) {
    out('menu bar not set up: SwiftBar is needed. Run `npx ccrunway menubar on --yes` to download it');
    why(info, declined(a), 'npx ccrunway menubar on --yes');
    return null;
  }
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-swiftbar-'));
  const dest = path.join(userHome(), 'Applications', 'SwiftBar.app');
  try {
    const zip = path.join(tmp, 'SwiftBar.zip');
    try {
      execFileSync('curl', ['-fsSL', '-m', '180', url, '-o', zip], { stdio: 'ignore' });
    } catch {
      out(`menu bar not set up: could not download SwiftBar (${url})`);
      why(info, 'SWIFTBAR_DOWNLOAD_FAILED', 'npx ccrunway menubar on --yes');
      return null;
    }
    const got = createHash('sha256').update(readFileSync(zip)).digest('hex');
    if (got !== sha256) {
      out(`menu bar not set up: the SwiftBar download's SHA-256 is ${got}, expected ${sha256}. Nothing was installed.`);
      why(info, 'SWIFTBAR_CHECKSUM_MISMATCH');
      return null;
    }
    try {
      execFileSync('ditto', ['-x', '-k', zip, path.join(tmp, 'x')], { stdio: 'ignore' });
      if (!existsSync(path.join(tmp, 'x', 'SwiftBar.app'))) throw new Error('no app');
      mkdirSync(path.dirname(dest), { recursive: true });
      execFileSync('ditto', [path.join(tmp, 'x', 'SwiftBar.app'), dest], { stdio: 'ignore' });
    } catch {
      rmSync(dest, { recursive: true, force: true });
      out('menu bar not set up: could not unpack SwiftBar into ~/Applications');
      why(info, 'SWIFTBAR_INSTALL_FAILED');
      return null;
    }
    out(`SwiftBar ${SWIFTBAR.version} installed in ~/Applications (SHA-256 checked)`);
    return { app: dest, by: 'download' };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function writeAgent(app) {
  const file = agentPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  writeFileSync(
    file,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/open</string><string>-g</string><string>${esc(app)}</string></array>
  <key>RunAtLoad</key><true/>
</dict>
</plist>
`,
  );
  return file;
}

// → exit code; lines through out(). prompt false (--json): never ask. info gets the
// failure's { code, fix } when it returns 1
export function menubarOn({ yes = false, out = console.log, prompt = true, info = {} } = {}) {
  if (!ROOT && process.platform !== 'darwin') {
    out('menu bar not set up: SwiftBar is macOS only');
    why(info, 'NOT_MACOS');
    return 1;
  }
  copyApp();
  const rec = readJSON(recordPath(), null) || {};
  // the node the status line runs with, so both survive `brew upgrade` alike
  rec.node = readJSON(path.join(home(), 'install.json'), null)?.node || stableNode();
  let app = swiftbarApp();
  if (!app) {
    const got = installSwiftBar(out, yes, prompt, info);
    if (!got) return 1;
    app = got.app;
    rec.installedBy = got.by;
    rec.app = got.app;
    writeJSON(recordPath(), rec); // before anything else can fail: off must know
  }
  const folder = pluginFolder();
  let restart = false;
  let link;
  if (folder && folder !== ownFolder()) {
    // the user's own plugin folder: our link beside their plugins
    link = path.join(folder, PLUGIN);
    if (!existsSync(folder)) {
      out(`menu bar not set up: SwiftBar's plugin folder ${tilde(folder)} does not exist`);
      why(info, 'PLUGIN_FOLDER_MISSING');
      return 1;
    }
    if ((existsSync(link) || isLink(link)) && !ours(link)) {
      out(`menu bar not set up: ${tilde(link)} is already there and is not ccrunway's; left it alone`);
      why(info, 'PLUGIN_FILE_TAKEN');
      return 1;
    }
  } else {
    link = path.join(ownFolder(), PLUGIN);
    mkdirSync(ownFolder(), { recursive: true });
    if (!folder) {
      execFileSync('defaults', ['write', prefs(), 'PluginDirectory', '-string', ownFolder()]);
      rec.folderSet = ownFolder();
      restart = true;
    }
  }
  if (isLink(link)) unlinkSync(link);
  symlinkSync(plugin(), link);
  rec.link = link;
  if (rec.installedBy && !rec.agent) rec.agent = writeAgent(app);
  writeJSON(recordPath(), rec);
  out(`menu bar: ${tilde(link)}${rec.folderSet ? " (SwiftBar's plugin folder, set by ccrunway)" : ''}`);
  if (rec.agent) out(`SwiftBar opens at login (${tilde(rec.agent)})`);
  // SwiftBar reads its plugin folder once, at launch
  if (restart) quit(out);
  if (!running()) act(out, 'open', ['-g', app]);
  out(`SwiftBar: ${tilde(app)}. The item shows within 5 s: [Anthropic] bars, [OpenAI] bars`);
  return 0;
}

export function menubarOff({ out = console.log } = {}) {
  const rec = readJSON(recordPath(), null);
  if (!rec) {
    // no record: still take away a link of ours in the usual places
    for (const l of [path.join(ownFolder(), PLUGIN), pluginFolder() && path.join(pluginFolder(), PLUGIN)])
      if (l && ours(l)) unlinkSync(l);
    out('menu bar: was not on');
    return 0;
  }
  if (rec.link && ours(rec.link)) unlinkSync(rec.link);
  if (rec.folderSet && pluginFolder() === rec.folderSet) {
    try {
      execFileSync('defaults', ['delete', prefs(), 'PluginDirectory'], { stdio: 'ignore' });
    } catch {}
  }
  try {
    if (!readdirSync(ownFolder()).length) rmdirSync(ownFolder());
  } catch {}
  if (rec.agent && existsSync(rec.agent)) {
    act(out, 'launchctl', ['bootout', `gui/${process.getuid?.() ?? 501}/${LABEL}`]);
    unlinkSync(rec.agent);
  }
  // a SwiftBar with our folder taken away, or one we put here, would show nothing
  if (rec.installedBy || rec.folderSet) quit(out);
  if (rec.installedBy === 'download' && rec.app && /\/SwiftBar\.app$/.test(rec.app)) {
    rmSync(rec.app, { recursive: true, force: true });
    out(`removed SwiftBar (ccrunway downloaded it): ${tilde(rec.app)}`);
  } else if (rec.installedBy === 'brew') {
    out('SwiftBar stays (Homebrew installed it): `brew uninstall --cask swiftbar` removes it');
  }
  rmSync(recordPath(), { force: true });
  out('menu bar: off');
  return 0;
}

// for `ccrunway status`
export function menubarState() {
  const rec = readJSON(recordPath(), null);
  const app = swiftbarApp();
  const folder = pluginFolder();
  const on = Boolean(rec?.link && ours(rec.link) && existsSync(rec.link));
  return {
    on,
    link: rec?.link ?? null,
    // set up, but SwiftBar now reads another folder
    hidden: on && path.dirname(rec.link) !== folder,
    swiftbar: app,
    swiftbar_running: app ? running() : false,
    swiftbar_installed_by: rec?.installedBy ?? null,
  };
}
