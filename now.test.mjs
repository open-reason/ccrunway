// node --test now.test.mjs
// `ccrunway now` against a temp CCRUNWAY_HOME (pace.json, turn ledgers, status-line
// snapshots written here) and Codex's fixtures/codex-nov10 through CODEX_HOME, at a fixed
// clock (CCRUNWAY_NOW). Nothing here touches ~/.claude, ~/.ccrunway or ~/.codex.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const NOW = Date.parse('2026-11-10T12:40:00Z');
const NOV10 = path.join(here, 'fixtures', 'codex-nov10');

function env(codex = null) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway now-'));
  const home = path.join(dir, 'home');
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  mkdirSync(path.join(dir, 'codex'), { recursive: true });
  return {
    dir,
    home,
    env: {
      ...process.env,
      CCRUNWAY_HOME: home,
      CODEX_HOME: codex ?? path.join(dir, 'codex'),
      CCRUNWAY_NOW: String(NOW),
      NO_COLOR: '1',
    },
  };
}
const now = (e, ...argv) => {
  const r = spawnSync(
    process.execPath,
    [path.join(here, 'cli.mjs'), 'now', ...argv, '--settings', path.join(e.dir, 'settings.json')],
    { env: e.env, encoding: 'utf8' },
  );
  return { ...r, json: argv.includes('--json') ? JSON.parse(r.stdout) : null };
};
const writeJSON = (file, obj) => writeFileSync(file, JSON.stringify(obj));

// pace.json: the meter's rises, reset `resetMin` from NOW
const meter = (e, readings, resetMin = 180) =>
  writeJSON(path.join(e.home, 'pace.json'), {
    resetsAt: NOW + resetMin * MIN,
    readings: readings.map(([m, pct]) => ({ t: NOW - m * MIN, pct })),
  });
// rises from `from`% at NOW − 20 min to `to`% at NOW, evenly, with one older reading
const climb = (e, from, to, resetMin) => {
  const r = [[30, from - 2], [20, from]];
  for (let p = from + 1; p <= to; p++) r.push([20 - (20 * (p - from)) / (to - from), p]);
  meter(e, r, resetMin);
};
const turn = (e, sid, agoMin, pct, extra = {}) =>
  appendFileSync(
    path.join(e.home, 'sessions', `${sid}.turns.jsonl`),
    `${JSON.stringify({ t: NOW - agoMin * MIN, start: NOW - (agoMin + 1) * MIN, model: 'fable-5-2', pct, ...extra })}\n`,
  );
// a status-line snapshot: name, model, chat size, the prompt cache
const snap = (e, sid, { name, model = 'claude-fable-5-2', display = 'Fable 5.2', ctx, warm }) =>
  writeJSON(path.join(e.home, 'sessions', `${sid}.json`), {
    session_id: sid,
    session_name: name,
    transcript_path: '/nonexistent',
    model: { id: model, display_name: display },
    context_window: { current_usage: { input_tokens: 2, cache_read_input_tokens: ctx - 2 } },
    prompt_cache: {
      warm,
      expires_at: Math.floor((NOW + (warm ? 30 : -10) * MIN) / 1000),
      recache_tokens_if_cold: ctx,
    },
  });

test('now --json: Claude from pace.json, the ledgers and the snapshots; the menu bar`s numbers, the status line`s words', async () => {
  const e = env();
  meter(e, [
    [30, 40],
    [10, 42],
  ]);
  turn(e, 's1-aaaa', 15, 1);
  turn(e, 's1-aaaa', 8, 1, { helper: 0.4, hmodel: 'haiku-5-5', agents: [{ name: 'tests', model: 'haiku-5-5', pct: 0.4 }] });
  turn(e, 's1-aaaa', 3, 1);
  turn(e, 's2-bbbb', 4, 0.5);
  snap(e, 's1-aaaa', { name: 'Ledger turn flow', ctx: 200_000, warm: false });
  snap(e, 's2-bbbb', { name: '', model: 'claude-opus-5-5', display: 'Opus 5.5', ctx: 40_000, warm: true });

  const r = now(e, '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim().split('\n').length, 1, 'one line, one object');
  const j = r.json;
  assert.equal(j.schema, 1);
  assert.equal(j.ok, true);
  assert.equal(j.installed, false);
  assert.equal(j.muted_until, null);
  assert.match(j.at, /^2026-11-10T\d\d:40:00[+-]\d\d:\d\d$/, 'ISO with the local offset, no Z');
  assert.equal(Date.parse(j.at), NOW);

  const c = j.claude;
  assert.equal(c.state, 'green');
  assert.match(c.summary, /^✓ on track · ~\d+% spare at \d{1,2}:\d\d[ap]m$/);
  assert.equal(Date.parse(c.resets_at), NOW + 180 * MIN);
  assert.equal(c.meter_pct, 42, 'the reading, as the menu bar`s 5h 42%');
  assert.equal(c.minutes_early, null);
  assert.equal(typeof c.spare_pct_at_reset, 'number');
  assert.ok(c.pace_pct_per_hour > 0);

  // the same chats as the menu bar, in its order, with its rates
  process.env.CCRUNWAY_HOME = e.home;
  const { claudePace } = await import('./menubar/claude-read.mjs');
  const { verdictText } = await import('./codex-range.mjs');
  const m = claudePace(NOW);
  assert.deepEqual(
    c.chats.map((x) => x.id),
    m.chats.map((x) => x.id),
  );
  assert.equal(c.pace_pct_per_hour, Math.round(m.perHour * 10) / 10);
  assert.equal(c.chats[0].pace_pct_per_hour, Math.round(m.chats[0].perHour * 10) / 10);
  assert.equal(Date.parse(c.run_out_at), m.verdict.runOutAt - (m.verdict.runOutAt % 1000));
  assert.match(verdictText(m.verdict), new RegExp(`~${c.spare_pct_at_reset}% spare`));

  const [s1, s2] = c.chats;
  assert.equal(s1.id, 's1-aaaa');
  assert.equal(s1.name, 'Ledger turn flow');
  assert.equal(s1.model, 'Fable 5.2');
  assert.equal(s1.context_tokens, 200_000);
  assert.ok(s1.now_pct_per_hour > 0, 'three prompts in the window: a prompt rate');
  assert.deepEqual(s1.helpers, [{ name: 'tests', model: 'Haiku', pct_per_hour: s1.helpers[0].pct_per_hour }]);
  // cold over 150k: the status line's cold-launch price (k = 1 with two rises)
  const { launchPoints } = await import('./launch.mjs');
  assert.equal(s1.cache.warm, false);
  assert.equal(Date.parse(s1.cache.expires_at), Math.floor((NOW - 10 * MIN) / 1000) * 1000);
  assert.equal(s1.next_send_cost_pct, Math.round(launchPoints('claude-fable-5-2', 200_000) * 10) / 10);
  assert.equal(s1.next_send_warn, true, 'over 150k and 2 points: the status line warns');
  assert.equal(s2.name, null);
  assert.equal(s2.cache.warm, true);
  assert.equal(s2.next_send_cost_pct, null, 'warm: no next-send cost');
  assert.equal(s2.next_send_warn, false);

  // nothing in CODEX_HOME
  assert.equal(j.codex.state, 'none');
  assert.equal(j.codex.summary, 'no 5-hour meter seen');
  assert.deepEqual(j.codex.chats, []);
});

test('now: text is a few lines per tool; the cold chat names its next-send cost; muted still shows the data', () => {
  const e = env();
  meter(e, [
    [30, 40],
    [10, 42],
  ]);
  turn(e, 's1-aaaa', 3, 1);
  snap(e, 's1-aaaa', { name: 'Ledger turn flow', ctx: 200_000, warm: false });
  writeJSON(path.join(e.home, 'config.json'), { mutedUntil: Date.now() + 30 * MIN });
  const r = now(e);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split('\n');
  assert.match(lines[0], /^status line muted until \d{1,2}:\d\d[ap]m$/);
  assert.match(lines[1], /^Claude Code: ✓ on track · ~\d+% spare at /);
  assert.match(lines[2], /^ {2}meter 42% · pace \S+%\/h · resets \d{1,2}:\d\d[ap]m$/);
  assert.match(lines[3], /^ {2}Ledger turn flow · Fable 5\.2 · 200k · \S+%\/h · cache cold: next send ≈4%$/);
  assert.equal(lines.at(-1), 'Codex: no 5-hour meter seen');
  assert.doesNotMatch(r.stdout, /\x1b\[/, 'no colour when stdout is not a terminal');
  assert.equal(now(e, '--json').json.muted_until != null, true);
});

test('now: no data at all is state none and exits 0, also with --exit-code', () => {
  const e = env();
  const r = now(e, '--json', '--exit-code');
  assert.equal(r.status, 0);
  assert.equal(r.json.claude.state, 'none');
  assert.equal(r.json.claude.top_drain, null);
  assert.equal(r.json.codex.state, 'none');
  assert.equal(now(e).stdout, 'Claude Code: no 5-hour meter seen\nCodex: no 5-hour meter seen\n');
});

test('now --exit-code: 10 amber, 11 red, 0 green; without it 0; the red one says how early', () => {
  const amber = env();
  climb(amber, 42, 50, 120); // 0.4%/min: out 125 min from now, 5 after the reset
  const a = now(amber, '--json', '--exit-code', '--tool', 'claude');
  assert.equal(a.json.claude.state, 'amber', JSON.stringify(a.json.claude));
  assert.equal(a.status, 10);
  assert.match(a.json.claude.summary, /^⚠ tight · ~\d+% spare at /);
  assert.equal(a.json.codex, undefined, '--tool claude leaves Codex out');
  assert.equal(now(amber, '--json', '--tool', 'claude').status, 0);

  const red = env();
  climb(red, 35, 55, 120); // 1%/min: out 45 min from now, 75 before the reset
  const r = now(red, '--json', '--exit-code');
  assert.equal(r.json.claude.state, 'red');
  assert.equal(r.status, 11);
  assert.equal(r.json.claude.minutes_early, 75);
  assert.equal(r.json.claude.spare_pct_at_reset, null);
  assert.equal(Date.parse(r.json.claude.run_out_at), NOW + 45 * MIN);
  assert.match(r.json.claude.summary, /^✗ runs out \d{1,2}:\d\d[ap]m, 1h 15m early$/);
  // a meter rising with no ledger behind it: the top drain is outside Claude Code
  assert.equal(r.json.claude.outside, true);
  assert.equal(r.json.claude.top_drain.part, 'outside Claude Code');
  assert.match(now(red).stdout, /^ {2}top drain: outside Claude Code \d+%\/h$/m);

  const green = env();
  climb(green, 40, 42, 180);
  assert.equal(now(green, '--exit-code').status, 0);
});

test('now --tool codex: the Codex fixture, as the menu bar computes it', async () => {
  const e = env(NOV10);
  const r = now(e, '--json', '--tool', 'codex', '--exit-code');
  const x = r.json.codex;
  assert.equal(r.json.claude, undefined);
  process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway now-menu-'));
  const { readCodex } = await import('./codex-sessions.mjs');
  const { codexPace } = await import('./codex-pace.mjs');
  const { codexRange } = await import('./codex-range.mjs');
  const data = readCodex(NOW, NOV10);
  const v = codexRange(data, NOW);
  const t = codexPace(data, NOW);
  assert.equal(x.state, v.state);
  assert.equal(r.status, { red: 11, amber: 10 }[v.state] ?? 0);
  assert.equal(Date.parse(x.run_out_at), v.runOutAt - (v.runOutAt % 1000));
  assert.equal(x.pace_pct_per_hour, Math.round(t.perHour * 10) / 10);
  assert.equal(x.chats.length, t.chats.length);
  assert.equal(x.chats[0].name, 'Improve the settings page');
  assert.equal(x.chats[0].model, 'gpt-5.6-sol');
  assert.equal(x.chats[0].cache, null, 'Codex has no prompt-cache data');
  assert.equal(x.chats[0].next_send_cost_pct, null);
  assert.equal(x.chats[0].now_pct_per_hour, null, 'Codex logs no prompts');
  assert.equal(x.top_drain.chat, 'Improve the settings page');
});

test('now --chat: id prefix or exact name in any case; no match is NO_SUCH_CHAT, exit 1', () => {
  const e = env();
  meter(e, [
    [30, 40],
    [10, 42],
  ]);
  turn(e, 's1-aaaa', 3, 1);
  turn(e, 's2-bbbb', 4, 0.5);
  snap(e, 's1-aaaa', { name: 'Ledger turn flow', ctx: 60_000, warm: true });
  assert.deepEqual(
    now(e, '--json', '--chat', 'S2').json.claude.chats.map((c) => c.id),
    ['s2-bbbb'],
  );
  assert.deepEqual(
    now(e, '--json', '--chat', 'ledger TURN flow').json.claude.chats.map((c) => c.id),
    ['s1-aaaa'],
  );
  const miss = now(e, '--json', '--chat', 'ledger');
  assert.equal(miss.status, 1);
  assert.equal(miss.json.ok, false);
  assert.equal(miss.json.error.code, 'NO_SUCH_CHAT');
  assert.equal(miss.stdout.trim().split('\n').length, 1);
  const text = now(e, '--chat', 'nope');
  assert.equal(text.status, 1);
  assert.equal(text.stdout, '');
  assert.match(text.stderr, /no chat matches "nope"/);
});
