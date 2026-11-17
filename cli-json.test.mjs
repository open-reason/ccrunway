// node --test cli-json.test.mjs
// The agent contract of cli.mjs: --json on every command is exactly one object on stdout
// with schema 1 and ok; errors carry {code, message, fix}; exit 2 bad usage, 3 not
// installed; nothing asks without a terminal or under --json. Temp CCRUNWAY_HOME, temp
// settings, SwiftBar under CCRUNWAY_SB_ROOT (menubar.test.mjs): nothing real is touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function env(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway json-'));
  const root = path.join(dir, 'root');
  mkdirSync(path.join(root, 'home'), { recursive: true });
  mkdirSync(path.join(dir, 'codex'), { recursive: true });
  return {
    dir,
    home: path.join(dir, 'data'),
    settings: path.join(dir, 'claude', 'settings.json'),
    env: {
      ...process.env,
      CCRUNWAY_HOME: path.join(dir, 'data'),
      CODEX_HOME: path.join(dir, 'codex'),
      CCRUNWAY_SB_ROOT: root,
      CCRUNWAY_SB_BREW: '',
      NO_COLOR: '1',
      ...extra,
    },
  };
}
const run = (e, ...argv) =>
  spawnSync(process.execPath, [path.join(here, 'cli.mjs'), ...argv], {
    env: e.env,
    encoding: 'utf8',
    input: '', // not a terminal
  });
// one line, one object, schema 1
function json(r) {
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `exactly one line on stdout, got: ${r.stdout}${r.stderr}`);
  const j = JSON.parse(lines[0]);
  assert.equal(j.schema, 1);
  assert.equal(typeof j.ok, 'boolean');
  if (!j.ok) {
    assert.equal(typeof j.error.code, 'string');
    assert.equal(typeof j.error.message, 'string');
    assert.ok('fix' in j.error);
  }
  return j;
}

test('help --json lists every command with its flags; text help has the new ones', () => {
  const e = env();
  const j = json(run(e, 'help', '--json'));
  assert.equal(j.ok, true);
  const names = j.commands.map((c) => c.name);
  for (const n of ['now', 'doctor', 'status', 'install', 'uninstall', 'mute', 'unmute', 'debug', 'menubar', 'update', 'help', 'version'])
    assert.ok(names.includes(n), n);
  const flags = (n) => j.commands.find((c) => c.name === n).flags.map((f) => f.name);
  assert.ok(flags('install').includes('--node <abs path>'));
  assert.ok(flags('now').includes('--exit-code'));
  assert.ok(flags('install').includes('--force'));
  assert.ok(!flags('uninstall').includes('--force'), '--force is install`s only');
  assert.ok(flags('uninstall').includes('--purge'));
  assert.ok(j.env.some((v) => v.name === 'CCRUNWAY_PLATFORM'));
  assert.ok(j.env.some((v) => v.name === 'CCRUNWAY_REGISTRY'));
  assert.ok(flags('update').includes('--check'));
  for (const c of j.commands) {
    assert.ok(flags(c.name).includes('--json'), `${c.name} takes --json`);
    assert.equal(typeof c.needs_install, 'boolean');
    assert.ok(c.description);
  }
  assert.deepEqual(
    j.commands.filter((c) => c.needs_install).map((c) => c.name),
    ['mute', 'unmute', 'debug'],
  );
  assert.deepEqual(Object.keys(j.exit_codes), ['0', '1', '2', '3', '10', '11']);
  assert.deepEqual(Object.keys(j.states), ['none', 'cold', 'green', 'amber', 'red']);
  assert.ok(j.env.some((v) => v.name === 'CCRUNWAY_HOME'));
  assert.deepEqual(json(run(e, '--help', '--json')), j);

  const text = run(e, '--help').stdout;
  assert.match(text, /^ {2}now \[--tool claude\|codex\]/m);
  assert.match(text, /--node <absolute path>/);
  assert.match(text, /^ {2}doctor /m);
  assert.match(text, /--force/);
  assert.match(text, /--purge/);
  assert.match(text, /menubar \[status\|on\|off\]/);
  assert.match(text, /default 1h/);
});

test('every command --json: one object, schema 1', () => {
  const e = env();
  const s = ['--settings', e.settings];
  // before install: the status-line commands say NOT_INSTALLED, exit 3
  for (const cmd of [['mute', '2h'], ['unmute'], ['debug', 'on']]) {
    const r = run(e, ...cmd, '--json', ...s);
    assert.equal(r.status, 3, cmd.join(' '));
    const j = json(r);
    assert.equal(j.error.code, 'NOT_INSTALLED');
    assert.equal(j.error.fix, 'npx ccrunway install');
  }
  const dry = json(run(e, 'install', '--dry-run', '--json', ...s));
  assert.equal(dry.dry_run, true);
  assert.ok(dry.settings_after.statusLine.command.includes('statusline.mjs'));
  assert.ok(!existsSync(e.settings), 'dry run writes nothing');

  const node = path.join(e.dir, 'my node', 'node');
  mkdirSync(path.dirname(node), { recursive: true });
  symlinkSync(process.execPath, node);
  const ins = json(run(e, 'install', '--json', '--node', node, ...s));
  assert.equal(ins.ok, true);
  assert.equal(ins.settings, e.settings);
  assert.ok(existsSync(ins.backup));
  assert.equal(ins.wraps, null);
  assert.equal(ins.skill, path.join(e.dir, 'claude', 'skills', 'ccrunway', 'SKILL.md'));
  assert.equal(ins.app, path.join(e.home, 'app'));
  assert.equal(ins.node, node);
  assert.match(ins.version, /^\d+\.\d+\.\d+/);
  assert.equal(ins.next_step, 'open a new Claude Code session');
  assert.deepEqual(ins.next_steps, ['open a new Claude Code session', 'npx ccrunway doctor']);

  const st = json(run(e, 'status', '--json', ...s));
  assert.equal(st.installed, true);
  assert.equal(st.menubar.on, false);

  const mute = json(run(e, 'mute', '30m', '--json', ...s));
  assert.match(mute.muted_until, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.ok(Math.abs(Date.parse(mute.muted_until) - (Date.now() + 30 * 60_000)) < 5000);
  assert.equal(json(run(e, 'status', '--json', ...s)).muted_until, mute.muted_until);
  assert.equal(json(run(e, 'unmute', '--json', ...s)).muted_until, null);
  assert.equal(json(run(e, 'debug', 'on', '--json', ...s)).debug, true);
  assert.equal(json(run(e, 'debug', 'off', '--json', ...s)).debug, false);
  assert.equal(json(run(e, 'version', '--json')).version, ins.version);
  const n = json(run(e, 'now', '--json', ...s));
  assert.equal(n.installed, true);
  assert.equal(n.claude.state, 'none');
  assert.deepEqual(json(run(e, 'menubar', '--json')).menubar, st.menubar);

  const udry = json(run(e, 'uninstall', '--dry-run', '--json', ...s));
  assert.equal(udry.dry_run, true);
  assert.equal(udry.settings_after, null, 'install created the file: uninstall would remove it');
  const un = json(run(e, 'uninstall', '--json', ...s));
  assert.equal(un.ok, true);
  assert.equal(un.was_installed, true);
  assert.equal(un.deleted_settings, true);
  assert.equal(un.restored_from_backup, false);
  assert.equal(un.skill_removed, true);
  assert.equal(un.menubar_off, false);
  assert.equal(un.purged, false);
  assert.equal(un.data_kept, e.home);
  assert.ok(!existsSync(e.settings));
  const none = run(e, 'uninstall', '--json', ...s);
  assert.equal(none.status, 1);
  assert.equal(json(none).error.code, 'NO_SETTINGS');
});

test('uninstall --json restores the backup bytes of a settings file someone had', () => {
  const e = env();
  const s = ['--settings', e.settings];
  mkdirSync(path.dirname(e.settings), { recursive: true });
  const theirs = '{\n    "theme": "dark",\n  "statusLine": {"type": "command", "command": "my line"}\n}\n';
  writeFileSync(e.settings, theirs);
  assert.equal(json(run(e, 'install', '--json', ...s)).wraps, 'my line');
  const un = json(run(e, 'uninstall', '--json', ...s));
  assert.equal(un.restored_from_backup, true);
  assert.equal(un.deleted_settings, false);
  assert.equal(readFileSync(e.settings, 'utf8'), theirs);
});

test('bad usage: exit 2 and USAGE, as JSON when --json is anywhere', () => {
  const e = env();
  const cases = [
    ['frobnicate', '--json'],
    ['--json', 'frobnicate'],
    ['now', '--frob', '--json'],
    ['now', '--tool', 'gemini', '--json'],
    ['now', '--chat', '--json'],
    ['now', 'extra', '--json'],
    ['menubar', 'sideways', '--json'],
    ['status', '--yes', '--json'],
  ];
  for (const argv of cases) {
    const r = run(e, ...argv);
    assert.equal(r.status, 2, argv.join(' '));
    assert.equal(json(r).error.code, 'USAGE', argv.join(' '));
  }
  const text = run(e, 'frobnicate');
  assert.equal(text.status, 2);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /unknown command "frobnicate"/);
});

test('menubar: bare means status; on --json with no SwiftBar and no terminal is NEEDS_CONFIRM, exit 1', () => {
  const e = env({ CCRUNWAY_SB_BREW: '/opt/homebrew/bin/brew' });
  const bare = run(e, 'menubar');
  assert.equal(bare.status, 0);
  assert.equal(bare.stdout, 'menu bar: off\n');
  assert.ok(!existsSync(path.join(e.home, 'menubar.json')), 'bare menubar sets nothing up');
  assert.deepEqual(json(run(e, 'menubar', 'status', '--json')), json(run(e, 'menubar', '--json')));

  const r = run(e, 'menubar', 'on', '--json');
  assert.equal(r.status, 1);
  const j = json(r);
  assert.equal(j.error.code, 'NEEDS_CONFIRM');
  assert.equal(j.error.fix, 'npx ccrunway menubar on --yes');
  assert.ok(!j.log.some((l) => /\(test\) .*brew install/.test(l)), 'nothing installed');
  // no brew: the download asks the same way
  const d = env();
  const dl = json(run(d, 'menubar', 'on', '--json'));
  assert.equal(dl.error.code, 'NEEDS_CONFIRM');

  const yes = run(e, 'menubar', 'on', '--yes', '--json');
  assert.equal(yes.status, 0, yes.stdout);
  const on = json(yes);
  assert.equal(on.menubar.on, true);
  assert.ok(on.log.some((l) => /brew install --cask swiftbar/.test(l)));
  const off = json(run(e, 'menubar', 'off', '--json'));
  assert.equal(off.menubar.on, false);
});
