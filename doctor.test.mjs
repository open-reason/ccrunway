// node --test doctor.test.mjs
// `ccrunway doctor` against an install into temp settings and a temp CCRUNWAY_HOME, with
// pace.json, a turn ledger and a status-line snapshot written as now.test.mjs writes them;
// SwiftBar under CCRUNWAY_SB_ROOT. Nothing here touches ~/.claude or ~/.ccrunway.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;

function env(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway doctor-'));
  mkdirSync(path.join(dir, 'root', 'home'), { recursive: true });
  return {
    dir,
    home: path.join(dir, 'data'),
    settings: path.join(dir, 'claude', 'settings.json'),
    env: {
      ...process.env,
      CCRUNWAY_HOME: path.join(dir, 'data'),
      CCRUNWAY_SB_ROOT: path.join(dir, 'root'),
      CCRUNWAY_SB_BREW: '',
      NO_COLOR: '1',
      ...extra,
    },
  };
}
const cli = (e, ...argv) =>
  spawnSync(process.execPath, [path.join(here, 'cli.mjs'), ...argv, '--settings', e.settings], {
    env: e.env,
    encoding: 'utf8',
    input: '',
  });
const write = (file, obj) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof obj === 'string' ? obj : JSON.stringify(obj));
};
const doctor = (e) => {
  const r = cli(e, 'doctor', '--json');
  const lines = r.stdout.split('\n').filter(Boolean);
  assert.equal(lines.length, 1, `one object: ${r.stdout}${r.stderr}`);
  const j = JSON.parse(lines[0]);
  assert.equal(j.schema, 1);
  return { status: r.status, ...j, by: Object.fromEntries(j.checks.map((c) => [c.id, c])) };
};

// installed, with someone's status line (statusLine) wrapped, and a warm meter
function installed({ statusLine = "printf 'their line'", readingMin = 2 } = {}) {
  const e = env();
  write(e.settings, statusLine ? { statusLine: { type: 'command', command: statusLine } } : {});
  const r = cli(e, 'install');
  assert.equal(r.status, 0, r.stderr);
  const now = Date.now();
  write(path.join(e.home, 'pace.json'), {
    resetsAt: now + 180 * MIN,
    readings: [
      { t: now - 30 * MIN, pct: 40 },
      { t: now - readingMin * MIN, pct: 42 },
    ],
  });
  write(
    path.join(e.home, 'sessions', 's1-aaaa.turns.jsonl'),
    `${JSON.stringify({ t: now - 5 * MIN, start: now - 6 * MIN, model: 'fable-5-2', pct: 1 })}\n`,
  );
  snap(e, true);
  return e;
}
const snap = (e, limits, sid = 's1-aaaa') =>
  write(path.join(e.home, 'sessions', `${sid}.json`), {
    session_id: sid,
    model: { id: 'claude-fable-5-2', display_name: 'Fable 5.2' },
    ...(limits ? { rate_limits: { five_hour: { used_percentage: 42, resets_at: Date.now() / 1000 + 3600 } } } : {}),
    _at: Date.now(),
  });

const IDS = [
  'platform',
  'node',
  'settings',
  'status_line',
  'wrapped',
  'hooks',
  'app',
  'data_dir',
  'meter',
  'turns',
  'five_hour_meter',
  'menubar',
];

test('doctor: a full install passes every required check, exit 0; text has one line per check', () => {
  const e = installed();
  const d = doctor(e);
  assert.equal(d.status, 0, JSON.stringify(d.checks, null, 1));
  assert.equal(d.ok, true);
  assert.deepEqual(
    d.checks.map((c) => c.id),
    IDS,
  );
  for (const c of d.checks) {
    assert.deepEqual(Object.keys(c), ['id', 'ok', 'required', 'detail', 'fix']);
    if (c.required) assert.equal(c.ok, true, c.id);
  }
  assert.match(d.by.wrapped.detail, /^`printf 'their line'` in \d+ ms$/);
  assert.equal(d.by.meter.ok, true);
  assert.equal(d.by.turns.ok, true);
  assert.equal(d.by.five_hour_meter.ok, true);
  assert.equal(d.by.menubar.ok, null, 'menu bar off: skipped');
  assert.equal(d.by.menubar.required, false);

  const t = cli(e, 'doctor');
  assert.equal(t.status, 0);
  const lines = t.stdout.trimEnd().split('\n');
  assert.equal(lines.length, IDS.length + 1);
  assert.match(lines[0], /^✓ platform {2,}macOS$/);
  assert.match(lines.at(-2), /^– menubar {2,}skipped: off$/);
  assert.match(lines.at(-1), /^ok: every required check passes$/);
});

test('doctor: not installed fails status_line, hooks and app with fix `npx ccrunway install`, exit 1 (not 3)', () => {
  const e = env();
  const d = doctor(e);
  assert.equal(d.status, 1);
  assert.equal(d.ok, false, 'failures are data: ok false at the top, no error object');
  assert.equal(d.error, undefined);
  for (const id of ['settings', 'status_line', 'hooks', 'app', 'data_dir']) {
    assert.equal(d.by[id].ok, false, id);
    assert.equal(d.by[id].fix, 'npx ccrunway install', id);
  }
  assert.equal(d.by.wrapped.ok, null);
  assert.equal(d.by.meter.ok, false);
  assert.match(d.by.meter.detail, /no 5-hour reading yet — open Claude Code and send a message/);
  assert.equal(d.by.five_hour_meter.ok, null, 'no snapshots: skipped');
  const t = cli(e, 'doctor');
  assert.equal(t.status, 1);
  assert.match(t.stdout, /^✗ status_line {2,}no ccrunway statusLine — fix: npx ccrunway install$/m);
  assert.match(t.stdout.trimEnd().split('\n').at(-1), /^not ok: .*status_line, .*hooks, app/);
});

test('doctor: an app copy of another version fails app', () => {
  const e = installed();
  const pkg = path.join(e.home, 'app', 'package.json');
  write(pkg, { ...JSON.parse(readFileSync(pkg, 'utf8')), version: '0.0.1' });
  const d = doctor(e);
  assert.equal(d.status, 1);
  assert.equal(d.by.app.ok, false);
  assert.match(d.by.app.detail, /is 0\.0\.1, this CLI is /);
  assert.match(d.by.app.fix, /^npx ccrunway install/);
});

test('doctor: a wrapped status line that hangs or fails fails wrapped, within the 4 s limit', () => {
  const slow = installed({ statusLine: 'sleep 10' });
  const t0 = Date.now();
  const d = doctor(slow);
  assert.ok(Date.now() - t0 < 6000, 'the 4 s limit holds');
  assert.equal(d.by.wrapped.ok, false);
  assert.equal(d.by.wrapped.required, true);
  assert.match(d.by.wrapped.detail, /took over 4 s/);
  assert.equal(d.status, 1);

  const bad = doctor(installed({ statusLine: 'exit 1' }));
  assert.equal(bad.by.wrapped.ok, false);
  assert.match(bad.by.wrapped.detail, /exited 1/);
  assert.equal(bad.ok, false);

  const none = doctor(installed({ statusLine: null }));
  assert.equal(none.by.wrapped.ok, null);
  assert.equal(none.by.wrapped.required, false);
  assert.equal(none.ok, true);
});

test('doctor: a meter reading 2 h old is meter false, still ok at the top; a snapshot with no 5-hour limit says so', () => {
  const e = installed({ readingMin: 120 });
  // the snapshot still has the meter but is old too
  const old = new Date(Date.now() - 120 * MIN);
  utimesSync(path.join(e.home, 'sessions', 's1-aaaa.json'), old, old);
  const d = doctor(e);
  assert.equal(d.by.meter.ok, false);
  assert.equal(d.by.meter.required, false);
  assert.match(d.by.meter.detail, /last reading 2h ago \(42%\)/);
  assert.equal(d.ok, true);
  assert.equal(d.status, 0);
  assert.match(cli(e, 'doctor').stdout, /^ok: every required check passes \(not yet: meter\)$/m);

  // a flat meter: no new rise, but a fresh snapshot still carries it
  snap(e, true);
  assert.equal(doctor(e).by.meter.ok, true);

  snap(e, false);
  const n = doctor(e);
  assert.equal(n.by.five_hour_meter.ok, false);
  assert.match(n.by.five_hour_meter.detail, /API-key session or a plan without one/);
  assert.equal(n.ok, true);
});

test('doctor: a hook whose node is gone fails hooks; a missing event is named', () => {
  const e = installed();
  const s = JSON.parse(readFileSync(e.settings, 'utf8'));
  s.hooks.Stop[0].hooks[0].command = s.hooks.Stop[0].hooks[0].command.replace(/^"[^"]+"/, '"/nope/node"');
  delete s.hooks.PreModelSwitch;
  write(e.settings, s);
  const d = doctor(e);
  assert.equal(d.by.hooks.ok, false);
  assert.match(d.by.hooks.detail, /missing on PreModelSwitch; node gone: \/nope\/node/);
  assert.equal(d.by.status_line.ok, true);
  assert.equal(d.status, 1);
});

test('doctor: not macOS fails platform with no fix command', () => {
  const e = installed();
  e.env.CCRUNWAY_PLATFORM = 'linux';
  const d = doctor(e);
  assert.equal(d.by.platform.ok, false);
  assert.equal(d.by.platform.fix, null);
  assert.match(d.by.platform.detail, /^linux: ccrunway supports macOS only; --force installs anyway, untested$/);
  assert.equal(d.status, 1);
});
