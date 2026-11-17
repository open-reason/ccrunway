// node --test codex-pace.test.mjs
// Codex session files → calls, meter and helpers (codex-sessions.mjs), the tool-wide pace and
// per-chat split (codex-pace.mjs), the Claude side of the menu bar (menubar/claude-read.mjs)
// and the title image (menubar/menubar.mjs).
// Fixtures: real Codex session files of this Mac, trimmed to the lines the code reads
// (session_meta, turn_context, token_count) with no prompt or reply text:
//   codex-nov07/   one astra chat that spawned three astra helpers at 21:39Z (the meter went
//                  0 → 61% in a minute); the parent's file writes one call twice
//   codex-nov10/   one gpt-5.6-sol chat, 11:32–12:46Z, meter 0 → 100%, one gpt-6-luna call
//                  at the end (a model with no weights)

import assert from 'node:assert/strict';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtures = path.join(here, 'fixtures');
const fresh = (tag) => mkdtempSync(path.join(os.tmpdir(), `ccrunway-codex-${tag}-`));
process.env.CCRUNWAY_HOME = fresh('home');

const S = await import('./codex-sessions.mjs');
const { breakdown, codexPace, priceCall, shortModel, weightOf } = await import('./codex-pace.mjs');
const { writeJSON } = await import('./state.mjs');

const MIN = 60_000;
const NOV07 = path.join(fixtures, 'codex-nov07');
const NOV10 = path.join(fixtures, 'codex-nov10');
const PARENT = '01a1b7da-4983-78f2-9cc2-14737b9c612d';

// a replay: a fresh state, the fixture's files read as of `when`
function replay(root, when) {
  process.env.CCRUNWAY_HOME = fresh('home');
  const now = Date.parse(when);
  return { now, data: S.readCodex(now, root) };
}

test('weights: known ids, prefixes, the default for anything else', () => {
  assert.equal(weightOf('gpt-6.1-sol').key, 'gpt-6.1-sol');
  assert.equal(weightOf('gpt-6-astra-2026-11').key, 'gpt-6-astra');
  const w = weightOf('gpt-6-luna');
  assert.equal(w.known, false);
  assert.equal(w.key, 'gpt-6.1-sol');
  // input_tokens includes the cached part: only the rest is priced as uncached
  const c = {
    model: 'gpt-5.6-sol',
    last_token_usage: { input_tokens: 180_000, cached_input_tokens: 170_000, output_tokens: 1000 },
  };
  assert.ok(Math.abs(priceCall(c) - (170_000 * 8 + 10_000 * 57 + 1000 * 446) / 1e6) < 1e-9);
  assert.equal(shortModel('gpt-6.1-sol'), 'sol');
  assert.equal(shortModel('gpt-6-astra'), 'astra');
});

test('Nov 7: three helpers under their chat, by name, the duplicate call skipped', () => {
  const { data } = replay(NOV07, '2026-11-07T22:30:00Z');
  // every call once: the parent's file has 37 token_count lines for 35 calls
  assert.equal(data.calls.length, 35 + 4 + 8 + 11);
  const helpers = Object.entries(data.threads).filter(([, t]) => t.helper);
  assert.deepEqual(helpers.map(([, t]) => t.nickname).sort(), ['Bernoulli', 'Goodall', 'Peirce']);
  for (const [id, t] of helpers) {
    assert.notEqual(id, PARENT); // the parent's session_meta copied into the helper is ignored
    assert.equal(t.root, PARENT);
    assert.equal(t.model, 'gpt-6-astra');
  }
  assert.equal(data.threads[PARENT].name, 'Summarise the helper agents results');
  assert.equal(data.threads[PARENT].helper, false);
  // the meter: only the 5-hour limit's readings ("premium" has none), resets_at to the minute
  assert.ok(data.meters.every((m) => m.resetsAt % MIN === 0));
  assert.equal(new Set(data.meters.map((m) => m.resetsAt)).size, 1);
});

test('Nov 7 at 21:41Z: one chat, its three astra helpers, 4 bars', () => {
  const { now, data } = replay(NOV07, '2026-11-07T21:41:00Z');
  const r = codexPace(data, now);
  assert.equal(r.bars, 4);
  assert.equal(r.chats.length, 1);
  const [c] = r.chats;
  assert.equal(c.id, PARENT);
  assert.equal(c.share, 1);
  assert.equal(c.model, 'gpt-6-astra');
  assert.deepEqual(c.fallback, []);
  assert.equal(c.helpers.length, 3);
  assert.deepEqual(
    new Set(c.helpers.map((h) => h.nickname)),
    new Set(['Goodall', 'Bernoulli', 'Peirce']),
  );
  // helpers by rate; together they are part of the chat's rate, not more
  const rates = c.helpers.map((h) => h.perHour);
  assert.deepEqual(
    rates,
    [...rates].sort((a, b) => b - a),
  );
  const sum = rates.reduce((a, b) => a + b, 0);
  assert.ok(sum > 0.5 * c.perHour && sum < c.perHour, `${sum} vs ${c.perHour}`);
  // the meter rose 0 → 66 in ~2 min; the window is at least MIN_SPAN_MIN (5), so ≥ 600%/h
  // is the floor's reading of it, within ±30% of the priced one
  const rise = (data.meters.at(-1).pct - data.meters[0].pct) * (60 / 5);
  assert.ok(Math.abs(r.perHour - rise) / rise < 0.3, `${r.perHour} vs ${rise}`);
});

test('Nov 10 at 11:50Z: %/h within ±30% of the meter rise over the same minutes', () => {
  const { now, data } = replay(NOV10, '2026-11-10T11:50:00Z');
  const r = codexPace(data, now);
  const first = data.calls[0].t;
  const min = (now - Math.max(first, now - 20 * MIN)) / MIN;
  const rise = ((data.meters.at(-1).pct - data.meters[0].pct) / min) * 60;
  assert.ok(Math.abs(r.perHour - rise) / rise < 0.3, `${r.perHour} vs ${rise}`);
  assert.equal(r.chats[0].name, 'Improve the settings page');
  assert.equal(r.chats[0].model, 'gpt-5.6-sol');
  assert.deepEqual(r.chats[0].helpers, []);
});

test('Nov 10 at 12:47Z: the gpt-6-luna call is priced as the default and named', () => {
  const { now, data } = replay(NOV10, '2026-11-10T12:47:00Z');
  const r = codexPace(data, now);
  assert.deepEqual(r.chats[0].fallback, ['gpt-6-luna']);
  // more than 20 min after the last call: nothing in the window, the title shows —
  const later = Date.parse('2026-11-10T13:10:00Z');
  assert.equal(codexPace(S.readCodex(later, NOV10), later), null);
});

test('byte offsets: reading in pieces (a torn line included) = reading once', () => {
  const root = fresh('codex');
  cpSync(NOV07, root, { recursive: true });
  const dir = path.join(root, 'sessions', '2026', '11', '07');
  const name = readdirSync(dir).find((f) => f.includes(PARENT));
  const full = readFileSync(path.join(dir, name), 'utf8');
  const cut = full.indexOf('token_count', Math.floor(full.length / 2)); // inside a line
  writeFileSync(path.join(dir, name), full.slice(0, cut));
  const now = Date.parse('2026-11-07T23:00:00Z');
  process.env.CCRUNWAY_HOME = fresh('home');
  const a = S.readCodex(now, root);
  appendFileSync(path.join(dir, name), full.slice(cut));
  const b = S.readCodex(now, root);
  assert.ok(a.calls.length < b.calls.length);
  const again = S.readCodex(now, root); // nothing new: nothing added
  assert.equal(again.calls.length, b.calls.length);
  const once = replay(NOV07, '2026-11-07T23:00:00Z').data;
  assert.deepEqual(b.calls, once.calls);
});

test('breakdown: bars against the safe rate, 0.5 / 0.9 / 1.1', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const reset = now + 5 * 60 * MIN; // meter 50 → safe 10%/h
  // one chat spending evenly over the whole 20 min window
  const at = (perHour) => [
    { t: now - MIN, start: now - 20 * MIN, pct: (perHour * 20) / 60, chat: 'a' },
  ];
  const bars = (perHour) => breakdown(at(perHour), 50, reset, now).bars;
  assert.equal(bars(4.9), 1);
  assert.equal(bars(8.9), 2);
  assert.equal(bars(10), 3);
  assert.equal(bars(11.5), 4);
  assert.ok(Math.abs(breakdown(at(10), 50, reset, now).perHour - 10) < 1e-9);
  // the meter's scale multiplies the rate
  assert.ok(Math.abs(breakdown(at(10), 50, reset, now, 0.5).perHour - 5) < 1e-9);
  // unknown reset: a rate, no bars
  assert.equal(breakdown(at(10), null, null, now).bars, null);
  assert.equal(breakdown([], 50, reset, now), null);
  // two chats, a helper: shares and the helper under its chat
  const two = breakdown(
    [
      { t: now - MIN, pct: 3, chat: 'a' },
      { t: now - MIN, pct: 1, chat: 'a', helper: 'h1' },
      { t: now - 2 * MIN, pct: 1, chat: 'b' },
    ],
    50,
    reset,
    now,
  );
  assert.deepEqual(
    two.chats.map((c) => [c.chat, c.share]),
    [
      ['a', 0.8],
      ['b', 0.2],
    ],
  );
  assert.equal(two.chats[0].helpers[0].key, 'h1');
  // a window that started 2 min ago is divided by MIN_SPAN_MIN (5), not 20
  assert.equal(two.spanMin, 5);

  // each chat over its OWN minutes: a ran the whole window, b joined 8 min ago. The tool
  // is 6 points over 20 min = 18%/h; b is 2 points over 8 min = 15%/h, not 6
  const own = breakdown(
    [
      { t: now - MIN, start: now - 20 * MIN, pct: 4, chat: 'a' },
      { t: now, start: now - 8 * MIN, pct: 1, chat: 'b' },
      { t: now, start: now - 8 * MIN, pct: 1, chat: 'b', helper: 'h1' },
    ],
    50,
    reset,
    now,
  );
  assert.ok(Math.abs(own.perHour - 18) < 1e-9);
  const [a, b] = own.chats;
  assert.ok(Math.abs(a.perHour - 12) < 1e-9, `${a.perHour}`);
  assert.ok(Math.abs(b.perHour - 15) < 1e-9, `${b.perHour}`);
  assert.equal(b.spanMin, 8);
  assert.ok(Math.abs(b.helpers[0].perHour - 7.5) < 1e-9, 'the helper over its chat`s minutes');
});

test('claude-read: the ccrunway files → the same breakdown, helpers apart', async () => {
  process.env.CCRUNWAY_HOME = fresh('home');
  const now = Date.now();
  const { claudePace, spendsOf } = await import('./menubar/claude-read.mjs');
  assert.equal(claudePace(now), null); // ccrunway not installed: nothing to show
  const home = process.env.CCRUNWAY_HOME;
  const reset = now + 3 * 60 * MIN;
  writeJSON(path.join(home, 'pace.json'), {
    resetsAt: reset,
    readings: [
      { t: now - 30 * MIN, pct: 40 },
      { t: now - 10 * MIN, pct: 42 },
    ],
  });
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const line = (sid, t, pct, helper = 0) =>
    appendFileSync(
      path.join(home, 'sessions', `${sid}.turns.jsonl`),
      `${JSON.stringify({ t, start: t - MIN, model: 'opus-5-5', pct, helper, hmodel: helper ? 'haiku-5-5' : undefined })}\n`,
    );
  line('s1', now - 15 * MIN, 1);
  line('s1', now - 5 * MIN, 2, 0.5);
  line('s2', now - 3 * MIN, 1);
  writeJSON(path.join(home, 'sessions', 's1.json'), {
    session_name: 'Ledger turn flow',
    model: { display_name: 'Opus 5.5' },
    context_window: { current_usage: { input_tokens: 2, cache_read_input_tokens: 174_000 } },
  });
  const r = claudePace(now);
  assert.equal(r.chats[0].name, 'Ledger turn flow');
  assert.equal(r.chats[0].model, 'Opus 5.5');
  assert.equal(r.chats[0].ctx, 174_002);
  assert.ok(Math.abs(r.chats[0].share - 0.75) < 1e-9);
  assert.deepEqual(
    r.chats[0].helpers.map((h) => h.model),
    ['Haiku'],
  );
  assert.equal(r.chats[1].name, null);
  // the meter as the status line has it: the last rise + the model fill, under the next %
  assert.ok(r.meter >= 42 && r.meter < 43, `${r.meter}`);
  assert.ok(r.bars >= 1 && r.bars <= 4);
  assert.deepEqual(
    spendsOf([{ sid: 'x', t: 1, pct: 2, helper: 0.5, hmodel: 'haiku-5-5' }]).map((s) => s.pct),
    [1.5, 0.5],
  );
});

test('menu bar: Claude helpers a row each by name, the unnamed rest as helpers', async () => {
  const { fromHelperKey, spendsOf } = await import('./menubar/claude-read.mjs');
  const { claudeHelper } = await import('./menubar/menubar.mjs');
  const turn = {
    sid: 'x',
    t: 1,
    pct: 3,
    helper: 1,
    hmodel: 'opus-5-5',
    agents: [
      { name: 'telemetry', model: 'opus-5-5', pct: 0.5 },
      { name: 'ads', model: 'opus-5-5', pct: 0.3 },
    ],
  };
  const helpers = spendsOf([turn]).filter((s) => s.helper != null);
  assert.deepEqual(
    helpers.map((s) => [fromHelperKey(s.helper), Math.round(s.pct * 10) / 10]),
    [
      [{ name: 'telemetry', model: 'Opus' }, 0.5],
      [{ name: 'ads', model: 'Opus' }, 0.3],
      [{ name: null, model: 'Opus' }, 0.2],
    ],
  );
  assert.equal(claudeHelper({ name: 'telemetry', model: 'Opus' }), '└ telemetry · Opus');
  assert.equal(claudeHelper({ name: null, model: 'Haiku' }), '└ helpers · Haiku');
});

test('menu bar: the title PNG reads back; — for a tool with no data; layout A rows', async () => {
  const { readMask } = await import('./menubar/png.mjs');
  const { render, titlePng, titleParts } = await import('./menubar/menubar.mjs');
  const none = titleParts(null, null).map(([n]) => n);
  assert.deepEqual(none, ['anthropic', 'dash', 'gap', 'openai', 'dash']);
  const both = titleParts({ bars: 3 }, { bars: 4 });
  assert.equal(both.filter(([n]) => n === 'full').length, 7);
  const { png, width } = titlePng({ bars: 3 }, null);
  const back = readMask(png);
  assert.equal(back.width, width);
  assert.equal(back.height, 36);
  assert.ok(back.alpha.some((a) => a === 255));
  const { now, data } = replay(NOV07, '2026-11-07T21:41:00Z');
  const out = render(null, codexPace(data, now), now).split('\n');
  assert.match(out[0], /^\| image=[A-Za-z0-9+/=]+ width=\d+ height=18$/);
  assert.ok(
    out.includes('— nothing spent in the last 20 min | color=#6b665c,#a8a294 refresh=true'),
  );
  assert.ok(out.some((l) => /^▮▮▮▮ \d+%\/h \| refresh=true$/.test(l)));
  assert.ok(out.some((l) => l.startsWith('Summarise the helper agents re')));
  assert.equal(out.filter((l) => /^└ \w+ · astra +\d+%\/h/.test(l)).length, 3);
});

test('helper rows: └ per level, the task name before the nickname', async () => {
  const { codexHelper } = await import('./menubar/menubar.mjs');
  const h = { task: 'or360_activity', nickname: 'Ohm', model: 'gpt-5.6-sol', depth: 1 };
  assert.match(codexHelper(h), /^└ or360_activity · /);
  assert.match(codexHelper({ ...h, task: null, depth: 2 }), /^└└ Ohm · /);
});

test('chat rows: two chats with one name get the last 4 characters of their ids', async () => {
  const { section, codexHelper } = await import('./menubar/menubar.mjs');
  const chat = (id, perHour) => ({ id, name: 'same', perHour, share: 0.5, helpers: [] });
  const t = {
    perHour: 10,
    bars: 1,
    chats: [chat('aaaa-1111', 6), chat('bbbb-2222', 4), { ...chat('cccc-3333', 1), name: 'other' }],
  };
  const rows = section('Codex', 'openai', t, Date.now(), codexHelper).map((l) => l.split('   ')[0]);
  assert.ok(rows.includes('same · 1111') && rows.includes('same · 2222') && rows.includes('other'));
});
