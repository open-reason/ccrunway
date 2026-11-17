// node --test statusline.test.mjs
// Every test runs the real scripts in a temp CCRUNWAY_HOME.
// Nothing here touches ~/.claude/settings.json or ~/.ccrunway.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'statusline-opus-259k.json'), 'utf8'),
);

function env() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-test-'));
  return {
    dir,
    env: {
      ...process.env,
      CCRUNWAY_HOME: dir,
      NO_COLOR: '1',
    },
  };
}

const run = (e, script, stdin, argv = []) => {
  const r = spawnSync(process.execPath, [path.join(here, script), ...argv], {
    input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin ?? {}),
    env: e.env,
    encoding: 'utf8',
  });
  return { ...r, json: r.stdout.trim().startsWith('{') ? JSON.parse(r.stdout) : null };
};

// a status-line snapshot shaped like the real one, with a chosen model and size
function snapshot(sid, { model, ctx, write = 0, cold = false, recache }) {
  const s = structuredClone(SAMPLE);
  s.session_id = sid;
  s.transcript_path = '/nonexistent';
  s.model = { id: model, display_name: model };
  s.context_window.current_usage = {
    input_tokens: 2,
    output_tokens: 300,
    cache_creation_input_tokens: write,
    cache_read_input_tokens: ctx - write - 2,
  };
  s.prompt_cache.recache_tokens_if_cold = recache ?? ctx;
  s.prompt_cache.warm = !cold;
  s.prompt_cache.expires_at = Math.floor(Date.now() / 1000) + (cold ? -600 : 3000);
  return s;
}

test('price: model ids map by family then version; a 362k Fable resend ≈ 9.9 points', async () => {
  process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-test-'));
  const p = await import('./price.mjs');
  assert.equal(p.modelKey('claude-opus-5-5'), 'opus-5-5');
  assert.equal(p.modelKey('claude-fable-5-1'), 'fable-5-1');
  assert.equal(p.modelKey('claude-fable-5-2[1m]'), 'fable-5-2');
  assert.equal(p.modelKey('claude-sonnet-5'), 'sonnet-5-5');
  assert.equal(p.modelKey('fable'), 'fable-5-1');
  assert.equal(p.modelKey('gpt-9'), 'opus-5-5');
  const s = snapshot('x', { model: 'claude-fable-5-1', ctx: 362_000, recache: 334_348 });
  assert.ok(Math.abs(p.coldResendPoints(s) - 9.9) < 0.05);
  s.prompt_cache = undefined; // undocumented field gone → ctx × w_write
  assert.ok(Math.abs(p.coldResendPoints(s) - (362_000 * 29.6) / 1e6) < 0.01);
});

test('hook never breaks Claude Code: bad stdin → exit 0, no output', () => {
  const e = env();
  for (const input of [
    'not json',
    '{}',
    JSON.stringify({ hook_event_name: 'Nope', session_id: 'z' }),
    JSON.stringify({ hook_event_name: 'Stop', session_id: 'z', transcript_path: '/nonexistent' }),
    JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      session_id: 'z',
      transcript_path: '/nonexistent',
      prompt: 'clear',
    }),
  ]) {
    const r = run(e, 'hook.mjs', input);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  }
});

// a pace.json with the meter rising 1% every 4 min up to 60% (0.25%/min over 20 min)
function seedPace(dir, resetsAtMs, now = Date.now()) {
  const readings = [];
  for (let i = 0; i <= 20; i++) readings.push({ t: now - (80 - 4 * i) * 60_000, pct: 40 + i });
  writeFileSync(
    path.join(dir, 'pace.json'),
    JSON.stringify({ resetsAt: resetsAtMs, readings, askedAt: null, noted: false }),
  );
}
const clock12 = (t) => new RegExp(`\\d{1,2}:\\d\\d${t ? ':\\d\\d' : ''}[ap]m`).source;

test('status line colours: run-out by state in brand tokens on light, terminal red on dark, none with NO_COLOR', () => {
  const e = env();
  // 40 points left at 0.25%/min = 160 min; reset in 4 h → runs out first: red
  const reset = Math.floor((Date.now() + 240 * 60_000) / 1000);
  seedPace(e.dir, reset * 1000);
  const snap = snapshot('col', { model: 'claude-opus-5-5', ctx: 90_000 });
  snap.rate_limits.five_hour = { used_percentage: 60, resets_at: reset };
  const { NO_COLOR, ...colour } = e.env;
  const ESC = '\x1b[';
  const light = run(
    { ...e, env: { ...colour, CCRUNWAY_THEME: 'light' } },
    'statusline.mjs',
    snap,
  ).stdout;
  assert.match(light, new RegExp(`\\x1b\\[38;2;165;39;29m✗ runs out ${clock12()}`)); // --or-danger
  const dark = run(
    { ...e, env: { ...colour, CCRUNWAY_THEME: 'dark' } },
    'statusline.mjs',
    snap,
  ).stdout;
  assert.match(dark, new RegExp(`\\x1b\\[31m✗ runs out ${clock12()}`));
  const none = run(e, 'statusline.mjs', snap).stdout;
  assert.ok(!none.includes(ESC));
});

test('pace: rises only, stale sessions ignored, needs 5 min, sprint at 1%/min', async () => {
  process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-test-'));
  const { observe, pace } = await import('./pace.mjs');
  const t0 = Date.parse('2026-11-11T15:00:00Z');
  const resets = Math.floor((t0 + 4 * 3600_000) / 1000);
  const at = (min, pct) =>
    observe(
      { rate_limits: { five_hour: { used_percentage: pct, resets_at: resets } } },
      t0 + min * 60_000,
    );

  at(0, 8); // a stale session's reading first…
  const settled = at(0.01, 10); // …and the live one a moment later replaces it
  assert.deepEqual(
    settled.readings.map((r) => r.pct),
    [10],
  );
  at(1, 11);
  assert.equal(pace(at(2, 10), t0 + 2 * 60_000), null, 'under 5 minutes: no rate yet');
  at(3, 11); // another session still on 11 — no new rise
  at(6, 11);
  const calm = pace(undefined, t0 + 6 * 60_000);
  assert.equal(calm.state, 'fine', '1 point in 6 min, 4 h left');

  for (let m = 7; m <= 12; m++) at(m, 11 + (m - 6)); // +6 points in 6 min
  const hot = pace(undefined, t0 + 12 * 60_000);
  assert.equal(hot.state, 'sprint');
  assert.ok(hot.rate >= 1);

  // a new window starts over
  const fresh = observe(
    { rate_limits: { five_hour: { used_percentage: 1, resets_at: resets + 18_000 } } },
    t0 + 13 * 60_000,
  );
  assert.equal(fresh.readings.length, 1);
});

test('range line: cold until 5 min of readings, then run-out (reset); seconds in debug', () => {
  const e = env();
  const reset = Math.floor((Date.now() + 150 * 60_000) / 1000);
  const snap = snapshot('rl', { model: 'claude-opus-5-5', ctx: 60_000 });
  snap.rate_limits.five_hour = { used_percentage: 60, resets_at: reset };
  const cold = run(e, 'statusline.mjs', snap).stdout;
  assert.match(
    cold,
    new RegExp(`^ccrunway · pace ▯▯▯▯ +–%/h · .*checking… · resets ${clock12()}\\n$`),
  );
  assert.doesNotMatch(cold, /→|⚑|5-hour limit|cache/);
  assert.ok(existsSync(path.join(e.dir, 'sessions', 'rl.json')), 'snapshot still written');
  assert.equal(JSON.parse(readFileSync(path.join(e.dir, 'pace.json'), 'utf8')).readings.length, 1);

  seedPace(e.dir, reset * 1000); // run-out 160 min from now, reset in 150 → amber
  // amber with no ledger at all: nothing here explains the meter's rise
  const warm = run(e, 'statusline.mjs', snap).stdout;
  assert.match(
    warm,
    new RegExp(
      `^ccrunway · pace ▯▯▯▯ +–%/h · .*⚠ tight · ~\\d+% spare at ${clock12()}\\n\\u2800{9}· top drain: outside Claude Code\\n$`,
    ),
  );
  const dbg = run({ ...e, env: { ...e.env, CCRUNWAY_DEBUG_SECONDS: '1' } }, 'statusline.mjs', snap);
  assert.match(
    dbg.stdout,
    new RegExp(
      `^ccrunway · pace ▯▯▯▯ +–%/h · .*⚠ tight · ~\\d+% spare at ${clock12(true)} · meter \\d+s old\\n\\u2800{9}· top drain: outside Claude Code\\n$`,
    ),
  );
  // no rate_limits yet (before the first response): grey, no reset
  const none = structuredClone(snap);
  none.rate_limits = undefined;
  assert.match(
    run(env(), 'statusline.mjs', none).stdout,
    /^ccrunway · pace ▯▯▯▯ +–%\/h · .*checking…\n$/,
  );
});

test('gauges: model, chat size and 5h used lead the line; no week; big chat in amber', () => {
  const e = env();
  const snap = snapshot('g1', { model: 'Opus 5.5', ctx: 120_000 });
  snap.rate_limits.five_hour = {
    used_percentage: 45,
    resets_at: Math.floor(Date.now() / 1000) + 9000,
  };
  snap.rate_limits.seven_day = { used_percentage: 52, resets_at: 0 };
  assert.match(
    run(e, 'statusline.mjs', snap).stdout,
    /^ccrunway · pace ▯▯▯▯ +–%\/h · Opus 5\.5 · 120k · 5h 45% · checking… · resets /,
  );
  const big = snapshot('g2', { model: 'Opus 5.5', ctx: 400_000 });
  big.rate_limits.seven_day = { used_percentage: 85, resets_at: 0 };
  const { NO_COLOR, ...colour } = e.env;
  const out = run({ ...e, env: { ...colour, CCRUNWAY_THEME: 'dark' } }, 'statusline.mjs', big).stdout;
  assert.ok(out.includes('\x1b[33m400k\x1b[0m'), 'big chat in amber');
  assert.ok(!out.includes('wk '), 'the week is not shown');
});

test('weights: the copy next to price.mjs wins (the packed layout)', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-pack-'));
  for (const f of ['price.mjs', 'state.mjs'])
    writeFileSync(path.join(dir, f), readFileSync(path.join(here, f)));
  writeFileSync(
    path.join(dir, 'claude-five-weights.json'),
    JSON.stringify({ models: { 'opus-5-5': { w_out: 1, w_write: 2 } } }),
  );
  const r = spawnSync(
    process.execPath,
    [
      '-e',
      "import('./price.mjs').then((m) => console.log(JSON.stringify(m.w('claude-opus-5-5'))))",
    ],
    { cwd: dir, encoding: 'utf8' },
  );
  assert.equal(r.stdout.trim(), '{"w_out":1,"w_write":2}');
});

// the status line install found, saved where install saves it
const wrap = (e, command) =>
  writeFileSync(
    path.join(e.dir, 'install.json'),
    JSON.stringify({ prevStatusLine: command == null ? null : { type: 'command', command } }),
  );

test('wrap: the earlier status line prints first with the same stdin, then the runway line', () => {
  const e = env();
  const prev = path.join(e.dir, 'prev status.sh'); // a space in the path, quoted below
  writeFileSync(
    prev,
    '#!/bin/sh\nin=$(cat)\necho "theirs: $(printf %s "$in" | grep -o \'"session_id": *"[^"]*"\')"\necho "line two"\n',
  );
  chmodSync(prev, 0o755);
  wrap(e, `"${prev}" --flag`);
  const snap = snapshot('w1', { model: 'Opus 5.5', ctx: 60_000 });
  const lines = run(e, 'statusline.mjs', snap).stdout.split('\n');
  assert.equal(lines[0], 'theirs: "session_id":"w1"');
  assert.equal(lines[1], 'line two');
  assert.match(lines[2], /^ccrunway · pace /);
  assert.equal(lines[3], '');
});

test('wrap: no earlier status line → only ours; a failing or hanging one → ours still prints', () => {
  const snap = snapshot('w2', { model: 'Opus 5.5', ctx: 60_000 });
  const none = env();
  assert.match(run(none, 'statusline.mjs', snap).stdout, /^ccrunway · /);
  const nul = env();
  wrap(nul, null);
  assert.match(run(nul, 'statusline.mjs', snap).stdout, /^ccrunway · /);

  const bad = env();
  wrap(bad, 'echo half; echo oops >&2; exit 3');
  const r = run(bad, 'statusline.mjs', snap);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /^ccrunway · /, 'a failing command prints nothing of its own');
  assert.equal(r.stderr, '');

  const gone = env();
  wrap(gone, '/nonexistent/statusline');
  assert.match(run(gone, 'statusline.mjs', snap).stdout, /^ccrunway · /);

  const slow = env();
  wrap(slow, 'sleep 10; echo late');
  const t0 = Date.now();
  const s = run(slow, 'statusline.mjs', snap).stdout;
  assert.ok(Date.now() - t0 < 8000, 'gives up after 4 s');
  assert.match(s, /^ccrunway · /);
});

test('cli: mute shows `muted until`, unmute brings the line back; debug on adds the meter age', () => {
  const e = env();
  const snap = snapshot('m1', { model: 'Opus 5.5', ctx: 60_000 });
  // mute, unmute and debug change only the status line: they need it installed
  const settings = path.join(e.dir, 'settings.json');
  const cli = (...a) => run(e, 'cli.mjs', '', [...a, '--settings', settings]);
  assert.equal(cli('mute', '30m').status, 3);
  const line = `"${process.execPath}" "${path.join(e.dir, 'app', 'statusline.mjs')}"`;
  writeFileSync(settings, JSON.stringify({ statusLine: { type: 'command', command: line } }));
  assert.match(cli('mute', '30m').stdout, /^ccrunway muted until \d/);
  assert.match(run(e, 'statusline.mjs', snap).stdout, /^ccrunway · muted until \d{1,2}:\d\d[ap]m\n$/);
  assert.ok(existsSync(path.join(e.dir, 'sessions', 'm1.json')), 'still records while muted');
  assert.equal(JSON.parse(cli('status', '--json').stdout).muted_until != null, true);
  cli('unmute');
  assert.match(run(e, 'statusline.mjs', snap).stdout, /^ccrunway · pace /);
  cli('debug', 'on');
  assert.match(run(e, 'statusline.mjs', snap).stdout, / · meter \d+s old\n$/);
  const st = JSON.parse(cli('status', '--json').stdout);
  assert.equal(st.debug, true);
  assert.equal(st.muted_until, null);
  assert.equal(cli('mute', 'soon').status, 2);
});
