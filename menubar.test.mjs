// node --test menubar.test.mjs
// `ccrunway menubar on|off` under CCRUNWAY_SB_ROOT: the Applications folders, LaunchAgents
// and SwiftBar's preferences live in a temp folder, and open, pkill, launchctl and brew are
// printed instead of run. Nothing here touches the real SwiftBar, ~/Library or ~/.ccrunway.

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function env(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway menubar-'));
  const root = path.join(dir, 'root');
  mkdirSync(path.join(root, 'home'), { recursive: true });
  return {
    dir,
    root,
    home: path.join(dir, 'data'),
    prefs: path.join(root, 'swiftbar-prefs'),
    env: {
      ...process.env,
      CCRUNWAY_HOME: path.join(dir, 'data'),
      CCRUNWAY_SB_ROOT: root,
      CCRUNWAY_SB_BREW: '',
      NO_COLOR: '1',
      ...extra,
    },
  };
}
const cli = (e, ...argv) =>
  spawnSync(process.execPath, [path.join(here, 'cli.mjs'), ...argv], {
    env: e.env,
    encoding: 'utf8',
    input: '', // not a terminal: no question can be answered
  });
const folderOf = (e) => {
  try {
    return execFileSync('defaults', ['read', e.prefs, 'PluginDirectory'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
};
const isLink = (p) => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};
const sysApp = (e) => path.join(e.root, 'Applications', 'SwiftBar.app');
const userApp = (e) => path.join(e.root, 'home', 'Applications', 'SwiftBar.app');
const agent = (e) => path.join(e.root, 'home', 'Library', 'LaunchAgents', 'ccrunway.swiftbar.plist');
const plugin = (e) => path.join(e.home, 'app', 'menubar', 'plugin', 'ccrunway.5s.sh');

// a zip shaped like the SwiftBar release, and its SHA-256
function fakeRelease(e) {
  const src = path.join(e.dir, 'rel', 'SwiftBar.app');
  mkdirSync(path.join(src, 'Contents'), { recursive: true });
  writeFileSync(path.join(src, 'Contents', 'Info.plist'), '<plist/>');
  const zip = path.join(e.dir, 'SwiftBar.zip');
  execFileSync('ditto', ['-c', '-k', '--keepParent', src, zip]);
  return { url: pathToFileURL(zip).href, sha: createHash('sha256').update(readFileSync(zip)).digest('hex') };
}

test('no SwiftBar, brew on the PATH: installs it with brew, sets our folder, opens it; off leaves SwiftBar', () => {
  const e = env({ CCRUNWAY_SB_BREW: '/opt/homebrew/bin/brew' });
  const r = cli(e, 'menubar', 'on', '--yes');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /\(test\) \/opt\/homebrew\/bin\/brew install --cask swiftbar/);
  assert.ok(existsSync(sysApp(e)));
  const link = path.join(e.home, 'menubar', 'ccrunway.5s.sh');
  assert.equal(folderOf(e), path.join(e.home, 'menubar'));
  assert.equal(readlinkSync(link), plugin(e));
  assert.ok(lstatSync(plugin(e)).mode & 0o111, 'the plugin is executable');
  assert.ok(existsSync(agent(e)), 'a SwiftBar we installed opens at login');
  assert.ok(readFileSync(agent(e), 'utf8').includes(sysApp(e)));
  assert.match(r.stdout, /\(test\) open -g /);
  const rec = JSON.parse(readFileSync(path.join(e.home, 'menubar.json'), 'utf8'));
  assert.equal(rec.installedBy, 'brew');

  const st = JSON.parse(cli(e, 'status', '--json').stdout).menubar;
  assert.equal(st.on, true);
  assert.equal(st.hidden, false);
  assert.equal(st.swiftbar_running, true);

  // again: same state, no second install
  const again = cli(e, 'menubar', 'on', '--yes');
  assert.equal(again.status, 0);
  assert.doesNotMatch(again.stdout, /brew install/);
  assert.equal(readlinkSync(link), plugin(e));

  const off = cli(e, 'menubar', 'off');
  assert.equal(off.status, 0);
  assert.ok(!isLink(link));
  assert.ok(!existsSync(path.join(e.home, 'menubar')), 'our empty folder is gone');
  assert.equal(folderOf(e), null, 'the plugin folder setting is gone');
  assert.ok(!existsSync(agent(e)));
  assert.match(off.stdout, /\(test\) launchctl bootout gui\/\d+\/ccrunway\.swiftbar/);
  assert.match(off.stdout, /\(test\) pkill -x SwiftBar/);
  assert.ok(existsSync(sysApp(e)), 'SwiftBar stays: brew installed it');
  assert.match(off.stdout, /brew uninstall --cask swiftbar/);
  assert.ok(!existsSync(path.join(e.home, 'menubar.json')));
  assert.equal(JSON.parse(cli(e, 'status', '--json').stdout).menubar.on, false);
});

test('no SwiftBar, no brew: downloads the pinned release, checks its SHA-256; off removes it', () => {
  const e = env();
  const rel = fakeRelease(e);
  e.env.CCRUNWAY_SWIFTBAR_URL = rel.url;

  e.env.CCRUNWAY_SWIFTBAR_SHA256 = '0'.repeat(64);
  const bad = cli(e, 'menubar', 'on', '--yes');
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /SHA-256 is [0-9a-f]{64}, expected 0{64}\. Nothing was installed\./);
  assert.ok(!existsSync(userApp(e)));
  assert.equal(folderOf(e), null);

  e.env.CCRUNWAY_SWIFTBAR_SHA256 = rel.sha;
  const r = cli(e, 'menubar', 'on', '--yes');
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /SwiftBar 2\.1\.1 installed in ~\/Applications \(SHA-256 checked\)/);
  assert.ok(existsSync(path.join(userApp(e), 'Contents', 'Info.plist')));
  assert.ok(existsSync(agent(e)));

  const off = cli(e, 'menubar', 'off');
  assert.match(off.stdout, /removed SwiftBar \(ccrunway downloaded it\)/);
  assert.ok(!existsSync(userApp(e)));
  assert.ok(!existsSync(agent(e)));
});

test('without a terminal or --yes nothing is installed', () => {
  const e = env({ CCRUNWAY_SB_BREW: '/opt/homebrew/bin/brew' });
  const r = cli(e, 'menubar', 'on');
  assert.equal(r.status, 1);
  assert.match(r.stdout, /SwiftBar is needed\. Run `brew install --cask swiftbar`, or `npx ccrunway menubar on --yes`/);
  assert.doesNotMatch(r.stdout, /\(test\) .*brew install/);
  assert.ok(!existsSync(sysApp(e)));
  assert.equal(folderOf(e), null);
  const off = cli(e, 'menubar', 'off');
  assert.equal(off.status, 0);
  assert.match(off.stdout, /was not on/);
});

test("the user's own SwiftBar and plugin folder: our link beside theirs, never over one; off leaves theirs", () => {
  const e = env();
  mkdirSync(sysApp(e), { recursive: true });
  writeFileSync(path.join(e.root, 'running'), '');
  const folder = path.join(e.root, 'home', 'plugins');
  mkdirSync(folder);
  writeFileSync(path.join(folder, 'weather.10m.sh'), '#!/bin/sh\necho sun\n');
  execFileSync('defaults', ['write', e.prefs, 'PluginDirectory', '-string', '~/plugins']);

  const r = cli(e, 'menubar', 'on');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(readlinkSync(path.join(folder, 'ccrunway.5s.sh')), plugin(e));
  assert.doesNotMatch(r.stdout, /pkill|open -g/, 'running, same folder: no restart');
  assert.ok(!existsSync(agent(e)), 'not our SwiftBar: no login item');

  cli(e, 'menubar', 'off');
  assert.ok(!existsSync(path.join(folder, 'ccrunway.5s.sh')));
  assert.ok(existsSync(path.join(folder, 'weather.10m.sh')));
  assert.equal(folderOf(e), '~/plugins');
  assert.ok(existsSync(path.join(e.root, 'running')), 'their SwiftBar keeps running');

  // a file of theirs with our name: left alone
  writeFileSync(path.join(folder, 'ccrunway.5s.sh'), '#!/bin/sh\necho mine\n');
  const clash = cli(e, 'menubar', 'on');
  assert.equal(clash.status, 1);
  assert.match(clash.stdout, /is already there and is not ccrunway's; left it alone/);
  assert.equal(readFileSync(path.join(folder, 'ccrunway.5s.sh'), 'utf8'), '#!/bin/sh\necho mine\n');
});

test('their SwiftBar with no plugin folder: ours is set and SwiftBar restarts to read it', () => {
  const e = env();
  mkdirSync(sysApp(e), { recursive: true });
  writeFileSync(path.join(e.root, 'running'), '');
  const r = cli(e, 'menubar', 'on');
  assert.equal(r.status, 0, r.stdout);
  assert.equal(folderOf(e), path.join(e.home, 'menubar'));
  assert.match(r.stdout, /\(test\) pkill -x SwiftBar[\s\S]*\(test\) open -g /);
  const off = cli(e, 'menubar', 'off');
  assert.equal(folderOf(e), null);
  assert.ok(existsSync(sysApp(e)));
  assert.doesNotMatch(off.stdout, /removed SwiftBar|brew uninstall/);
});

test("the menu bar records the status line's node, not a Cellar path brew upgrade removes", () => {
  const e = env();
  mkdirSync(sysApp(e), { recursive: true });
  mkdirSync(e.home, { recursive: true });
  writeFileSync(path.join(e.home, 'install.json'), JSON.stringify({ node: '/opt/homebrew/bin/node' }));
  assert.equal(cli(e, 'menubar', 'on').status, 0);
  const rec = JSON.parse(readFileSync(path.join(e.home, 'menubar.json'), 'utf8'));
  assert.equal(rec.node, '/opt/homebrew/bin/node');
  cli(e, 'menubar', 'off');
});

test('the linked plugin finds node and draws both tools; uninstall turns the item off', () => {
  const e = env();
  mkdirSync(sysApp(e), { recursive: true });
  const settings = path.join(e.dir, 'claude', 'settings.json');
  assert.equal(cli(e, 'install', '--settings', settings).status, 0);
  assert.equal(cli(e, 'menubar', 'on').status, 0);
  const link = path.join(e.home, 'menubar', 'ccrunway.5s.sh');
  // as SwiftBar runs it: a minimal PATH, no CCRUNWAY_HOME; node from install.json
  const { CCRUNWAY_HOME, ...rest } = e.env;
  const r = spawnSync('/bin/bash', [link], {
    env: { ...rest, PATH: '/usr/bin:/bin', HOME: path.join(e.root, 'home'), CODEX_HOME: path.join(e.dir, 'no-codex') },
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.match(lines[0], /^\| image=[A-Za-z0-9+/=]+ width=\d+ height=18$/);
  assert.ok(lines.some((l) => l.startsWith('**Claude Code**')));
  assert.ok(lines.some((l) => l.startsWith('**Codex**')));

  const off = cli(e, 'uninstall', '--settings', settings);
  assert.match(off.stdout, /menu bar: off/);
  assert.ok(!isLink(link));
});

test('install turns the menu bar on when SwiftBar is there, never downloads it; --no-menubar skips it', () => {
  const settings = (e) => path.join(e.dir, 'claude', 'settings.json');
  // SwiftBar with the user's plugin folder: our link beside theirs
  const e = env();
  mkdirSync(sysApp(e), { recursive: true });
  writeFileSync(path.join(e.root, 'running'), '');
  const folder = path.join(e.root, 'home', 'plugins');
  mkdirSync(folder);
  execFileSync('defaults', ['write', e.prefs, 'PluginDirectory', '-string', '~/plugins']);
  const r = cli(e, 'install', '--settings', settings(e), '--json');
  assert.equal(r.status, 0, r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.menubar.on, true);
  assert.equal(j.menubar.hint, 'npx ccrunway menubar off');
  assert.equal(readlinkSync(path.join(folder, 'ccrunway.5s.sh')), plugin(e));
  assert.equal(folderOf(e), '~/plugins', 'their folder setting unchanged');
  // uninstall takes it off again
  cli(e, 'uninstall', '--settings', settings(e));
  assert.ok(!existsSync(path.join(folder, 'ccrunway.5s.sh')));

  // SwiftBar with no plugin folder (or-otel's coach off clears it): ours is set
  const n = env();
  mkdirSync(sysApp(n), { recursive: true });
  const rn = cli(n, 'install', '--settings', settings(n));
  assert.equal(rn.status, 0, rn.stdout);
  assert.match(rn.stdout, /^menu bar: on \(.*\); `npx ccrunway menubar off` removes it$/m);
  assert.equal(folderOf(n), path.join(n.home, 'menubar'));

  // no SwiftBar: nothing installed, a hint instead
  const x = env();
  const rx = cli(x, 'install', '--settings', settings(x), '--json');
  const jx = JSON.parse(rx.stdout);
  assert.equal(jx.menubar.on, false);
  assert.match(jx.menubar.detail, /SwiftBar is not installed/);
  assert.ok(!existsSync(sysApp(x)) && !existsSync(userApp(x)), 'nothing downloaded');
  assert.ok(!existsSync(path.join(x.home, 'menubar.json')));

  // --no-menubar
  const s = env();
  mkdirSync(sysApp(s), { recursive: true });
  const rs = cli(s, 'install', '--settings', settings(s), '--no-menubar', '--json');
  assert.equal(JSON.parse(rs.stdout).menubar.on, false);
  assert.equal(folderOf(s), null);
  assert.ok(!existsSync(path.join(s.home, 'menubar.json')));
});
