// node --test install.test.mjs
// install, uninstall and the CLI against settings files and CCRUNWAY_HOME in temp
// folders. Nothing here touches ~/.claude or ~/.ccrunway.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EVENTS = ['PostToolUse', 'PreModelSwitch', 'Stop', 'UserPromptSubmit'];

// dir: a temp folder with a space in it, like a home folder can have
function env() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway install-'));
  const home = path.join(dir, 'home');
  return {
    dir,
    home,
    settings: path.join(dir, 'claude', 'settings.json'),
    env: { ...process.env, CCRUNWAY_HOME: home, NO_COLOR: '1' },
  };
}

const run = (e, script, argv = [], stdin = '') =>
  spawnSync(process.execPath, [path.join(here, script), ...argv], {
    input: stdin,
    env: e.env,
    encoding: 'utf8',
  });
const cli = (e, ...argv) => run(e, 'cli.mjs', [...argv, '--settings', e.settings]);
const write = (file, obj) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const text = typeof obj === 'string' ? obj : `${JSON.stringify(obj, null, 2)}\n`;
  writeFileSync(file, text);
  return text;
};
const read = (file) => JSON.parse(readFileSync(file, 'utf8'));
const cmds = (s) =>
  Object.values(s.hooks || {})
    .flat()
    .flatMap((g) => g.hooks.map((h) => h.command));

// someone's settings: their own status line, hooks of their own, keys we never touch.
// Odd formatting on purpose: the round trip must give these exact bytes back.
const theirs = (otherStatus = 'npx -y ccusage statusline') => ({
  theme: 'dark',
  model: 'opus',
  statusLine: { type: 'command', command: otherStatus, padding: 0 },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: '/usr/local/bin/notify done' }] }],
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: 'my-guard', timeout: 3 }] },
    ],
  },
});

test('install: hooks and status line run the copy in CCRUNWAY_HOME/app with the absolute node, quoted', () => {
  const e = env();
  write(e.settings, theirs());
  const r = cli(e, 'install');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^backup: .*settings\..+\.json$/m);
  assert.match(r.stdout, /open a new Claude Code session/);
  assert.match(r.stdout, /your status line stays on top: npx -y ccusage statusline/);

  const s = read(e.settings);
  const app = path.join(e.home, 'app');
  // the node running install, by its PATH name when that is the same binary
  const node = read(path.join(e.home, 'install.json')).node;
  assert.ok(path.isAbsolute(node));
  assert.equal(realpathSync(node), realpathSync(process.execPath));
  const q = (f) => `"${node}" "${path.join(app, f)}"`;
  assert.deepEqual(s.statusLine, { type: 'command', command: q('statusline.mjs'), refreshInterval: 5 });
  for (const ev of EVENTS) {
    const mine = s.hooks[ev].filter((g) => g.hooks.some((h) => h.command === q('hook.mjs')));
    assert.equal(mine.length, 1, ev);
    assert.deepEqual(mine[0], { hooks: [{ type: 'command', command: q('hook.mjs'), timeout: 5 }] });
    assert.equal(s.hooks[ev].at(-1), mine[0], `${ev}: our group comes after anyone else's`);
  }
  assert.deepEqual(s.hooks.PreToolUse, theirs().hooks.PreToolUse);
  assert.deepEqual(s.hooks.Stop[0], theirs().hooks.Stop[0]);
  assert.equal(s.theme, 'dark');

  // the copy runs on its own: no test files, the weights beside it, and it prints a line
  for (const f of ['hook.mjs', 'statusline.mjs', 'cli.mjs', 'price.mjs', 'claude-five-weights.json', 'package.json'])
    assert.ok(existsSync(path.join(app, f)), f);
  assert.ok(!readdirSync(app).some((f) => f.endsWith('.test.mjs')));
  const meta = read(path.join(e.home, 'install.json'));
  assert.ok(!existsSync(path.join(path.dirname(app), 'app.new')));
  assert.deepEqual(meta.prevStatusLine, theirs().statusLine);
  // the skill names the installed CLI, not this checkout
  const skill = readFileSync(path.join(path.dirname(e.settings), 'skills', 'ccrunway', 'SKILL.md'), 'utf8');
  assert.ok(skill.includes(q('cli.mjs')));
  assert.ok(!skill.includes('{{CLI}}'));
  const st = JSON.parse(cli(e, 'status', '--json').stdout);
  assert.equal(st.installed, true);
  assert.equal(st.wraps, 'npx -y ccusage statusline');
});

test('--node picks the node, quoted: a path with a space works', () => {
  const e = env();
  write(e.settings, {});
  cli(e, 'install', '--node', '/opt/my node/bin/node');
  const s = read(e.settings);
  assert.match(s.statusLine.command, /^"\/opt\/my node\/bin\/node" ".*\/app\/statusline\.mjs"$/);
  assert.match(s.hooks.Stop[0].hooks[0].command, /^"\/opt\/my node\/bin\/node" ".*\/app\/hook\.mjs"$/);
});

test('install → uninstall gives byte-identical settings; re-install is idempotent', () => {
  const e = env();
  const before = write(
    e.settings,
    '{\n    "theme": "dark",\n  "statusLine": {"type": "command", "command": "~/bin/my line"},\n  "hooks": {"Stop": [{"hooks": [{"type": "command", "command": "notify"}]}]}\n}\n',
  );
  const dry = cli(e, 'install', '--dry-run');
  assert.equal(dry.status, 0);
  assert.equal(readFileSync(e.settings, 'utf8'), before, 'dry run writes nothing');
  assert.ok(!existsSync(e.home), 'dry run makes no data folder');
  assert.match(read(e.settings).statusLine.command, /my line/);

  cli(e, 'install');
  const once = readFileSync(e.settings, 'utf8');
  assert.equal(cli(e, 'install').status, 0);
  assert.equal(readFileSync(e.settings, 'utf8'), once, 'second install: same file');
  assert.equal(read(path.join(e.home, 'install.json')).prevStatusLine.command, '~/bin/my line');
  assert.equal(cmds(read(e.settings)).filter((c) => c.endsWith('hook.mjs"')).length, 4);

  const off = cli(e, 'uninstall');
  assert.equal(off.status, 0, off.stderr);
  assert.match(off.stdout, /restored the backup bytes/);
  assert.equal(readFileSync(e.settings, 'utf8'), before);
  assert.ok(!existsSync(path.join(path.dirname(e.settings), 'skills')), 'skill removed, empty folder too');
  assert.equal(JSON.parse(cli(e, 'status', '--json').stdout).installed, false);
});

test('no settings file and no status line: install wraps nothing, uninstall removes the file again', () => {
  const e = env();
  const r = cli(e, 'install');
  assert.equal(r.status, 0);
  assert.match(r.stdout, /no earlier status line to wrap/);
  assert.equal(read(path.join(e.home, 'install.json')).prevStatusLine, null);
  cli(e, 'uninstall');
  assert.ok(!existsSync(e.settings));
});

test('a change made after install survives uninstall; only our entries go', () => {
  const e = env();
  write(e.settings, theirs());
  cli(e, 'install');
  const s = read(e.settings);
  s.model = 'sonnet';
  write(e.settings, s);
  cli(e, 'uninstall');
  assert.deepEqual(read(e.settings), { ...theirs(), model: 'sonnet' });
});

test('the installed copy prints the wrapped line, then ours, from its own folder', () => {
  const e = env();
  write(e.settings, theirs("printf 'their line'"));
  cli(e, 'install');
  const command = read(e.settings).statusLine.command;
  const snap = readFileSync(path.join(here, 'fixtures', 'statusline-opus-259k.json'), 'utf8');
  const r = spawnSync('/bin/sh', ['-c', command], { input: snap, env: e.env, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split('\n');
  assert.equal(lines[0], 'their line');
  assert.match(lines[1], /^ccrunway · pace /);
  // the hook from the copy writes the ledger into CCRUNWAY_HOME
  const hook = read(e.settings).hooks.UserPromptSubmit.at(-1).hooks[0].command;
  const h = spawnSync('/bin/sh', ['-c', hook], { input: '{}', env: e.env, encoding: 'utf8' });
  assert.equal(h.status, 0);
  assert.equal(h.stdout, '');
  assert.ok(statSync(path.join(e.home, 'sessions')).isDirectory());
});
