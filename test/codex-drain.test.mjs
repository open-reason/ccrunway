// node --test test/codex-drain.test.mjs
// The top drain, outside spend and cold resume in the menu bar (codex-pace.mjs codexParts,
// withDrain; drain.mjs with CODEX labels; codex-sessions.mjs `reads`, `cold`, `open`;
// menubar/menubar.mjs drainRow; menubar/claude-read.mjs).
// Fixtures (real Codex session files of this Mac, cut to session_meta, turn_context,
// token_count and task_* lines, no prompt, reply or tool text):
//   codex-nov07/   one astra chat and its three astra helpers (codex-pace.test.mjs)
//   codex-nov01/   "Nov1-long-chat", gpt-6.1-sol: its last turn on Nov 1 (15:15–15:22Z), then
//                  a resume at 2026-11-02T09:20:05Z, 18 h later, at 448k tokens with 13k
//                  read from the cache; the calls after it until 09:45Z

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'src');
const fixtures = path.join(here, 'fixtures');
const fresh = (tag) => mkdtempSync(path.join(os.tmpdir(), `ccrunway-drain-${tag}-`));
process.env.CCRUNWAY_HOME = fresh('home');

const S = await import('../src/codex-sessions.mjs');
const C = await import('../src/codex-pace.mjs');
const { drain, CODEX } = await import('../src/drain.mjs');
const { drainRow, section, codexHelper, simulated } = await import('../src/menubar/menubar.mjs');
const { codexRange } = await import('../src/codex-range.mjs');
const { writeJSON } = await import('../src/state.mjs');

const MIN = 60_000;
const NOV07 = path.join(
  fixtures,
  'codex-nov07/sessions/2026/11/07/rollout-2026-11-07T22-11-38-01a1b7da-4983-78f2-9cc2-14737b9c612d.jsonl',
);
const NOV01 = path.join(
  fixtures,
  'codex-nov01/sessions/2026/11/01/rollout-2026-11-01T14-55-38-01a19764-f3c4-7ea2-a13b-e11ee3332a3f.jsonl',
);
const NOV01_ID = '01a19764-f3c4-7ea2-a13b-e11ee3332a3f';
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

// a whole Codex section as the menu shows it, for a replay
function menu(file, at, sim = null) {
  const data = S.readReplay(file, Date.parse(at));
  let t = C.codexPace(data, data.now);
  if (t) t.verdict = codexRange(data, data.now);
  if (sim) t = simulated(t, sim, data.now);
  return { data, t, rows: section('Codex', 'openai', t, data.now, codexHelper) };
}

test('parts: one call splits into long chat, long answers and the rest, summing to its price', () => {
  const c = {
    model: 'gpt-6.1-sol',
    last_token_usage: { input_tokens: 200_000, cached_input_tokens: 190_000, output_tokens: 2000 },
  };
  const p = C.codexParts(c);
  assert.ok(near(p.chat, (190_000 * 3.3) / 1e6));
  assert.ok(near(p.answers, (2000 * 396) / 1e6));
  assert.ok(near(p.other, (10_000 * 52) / 1e6));
  assert.equal(p.reads, undefined); // big reads are off by default
  const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
  assert.ok(near(sum(p), C.priceCall(c)));
  // a helper's call is all `helpers`; a cold resume's all `chat reload`
  assert.deepEqual(Object.keys(C.codexParts(c, true)), ['helpers']);
  assert.deepEqual(Object.keys(C.codexParts({ ...c, cold: true })), ['reload']);
  // big reads on: the estimate (chars ÷ 3) capped at the call's uncached input
  const read = { ...c, reads: 45_000 }; // ≈ 15k tokens, more than the 10k uncached
  const on = C.codexParts(read, false, true);
  assert.ok(near(on.reads, (10_000 * 52) / 1e6));
  assert.equal(on.other, undefined);
  assert.ok(near(sum(on), C.priceCall(c)));
  const small = C.codexParts({ ...c, reads: 3000 * 3 }, false, true);
  assert.ok(near(small.reads, (3000 * 52) / 1e6));
});

test('Nov 7: helpers dominate; the top drain is the chat, astra helpers, as a share of all', () => {
  const at = Date.parse('2026-11-07T21:50:00Z');
  const data = S.readReplay(NOV07, at);
  const turns = C.codexTurns(data);
  const sums = {};
  for (const x of turns) for (const k in x.parts) sums[k] = (sums[k] || 0) + x.parts[k];
  const total = turns.reduce((a, x) => a + x.pct, 0);
  assert.ok(
    near(
      Object.values(sums).reduce((a, b) => a + b, 0),
      total,
      1e-6,
    ),
  );
  assert.ok(sums.helpers > 0.6 * total, `${sums.helpers} of ${total}`);
  assert.ok(sums.helpers > sums.chat + sums.answers + sums.other);
  const d = drain(turns, null, at, 1, () => false, CODEX);
  assert.equal(d.sid, '01a1b7da-4983-78f2-9cc2-14737b9c612d');
  assert.equal(d.part, 'helpers');
  assert.equal(d.label, 'astra helpers'); // all three helpers ran on astra
  assert.ok(near(d.share, sums.helpers / total, 1e-6));
  // the same denominator as the chat shares: one chat, so its share is 1
  const { t, rows } = menu(NOV07, '2026-11-07T21:50:00Z');
  assert.equal(t.verdict.state, 'red');
  assert.equal(t.chats[0].share, 1);
  // in %/h: the part's share (62%) of the tool's %/h
  const top = rows.find((l) => l.startsWith('Top drain:'));
  assert.match(
    top,
    /^Top drain: Summarise the helper agents res…, astra helpers \d+%\/h \| color=#a5271d,#ff6b5e /,
  );
  assert.equal(top.match(/(\d+)%\/h/)[1], String(Math.round(t.drain.share * t.perHour)));
  // non-astra helpers read `helpers`
  const sol = turns.map((x) => (x.hmodel ? { ...x, hmodel: 'gpt-6.1-sol' } : x));
  assert.equal(drain(sol, null, at, 1, () => false, CODEX).label, 'helpers');
});

test('top drain row: amber and red only, under the verdict; the chat by its menu name', () => {
  const base = {
    perHour: 20,
    bars: 3,
    chats: [{ id: 'a', name: 'refactor-api', perHour: 14, share: 0.64, helpers: [] }],
    drain: { chat: 'a', label: 'long chat', share: 0.41 },
  };
  const v = (state) => ({ ...base, verdict: { state, runOutAt: 1, resetsAt: 2, meter: 50 } });
  assert.equal(drainRow(v('red'), 'Codex'), 'Top drain: refactor-api, long chat 8%/h'); // 0.41 × 20
  assert.equal(drainRow(v('amber'), 'Codex'), 'Top drain: refactor-api, long chat 8%/h');
  assert.equal(drainRow(v('green'), 'Codex'), null);
  assert.equal(drainRow(v('cold'), 'Codex'), null);
  // only `other` to show: the chat and its own %/h
  const plain = { ...v('red'), drain: { chat: 'a', label: null, share: 0.8 } };
  assert.equal(drainRow(plain, 'Codex'), 'Top drain: refactor-api 16%/h');
  // no name: the row's fallback name
  const unnamed = { ...v('red'), chats: [{ ...base.chats[0], name: null, id: '0123456789' }] };
  unnamed.drain = { chat: '0123456789', label: 'helpers', share: 0.5 };
  assert.equal(
    drainRow(unnamed, 'Claude Code'),
    'Top drain: Claude Code chat 01234567, helpers 10%/h',
  );
  assert.equal(
    drainRow({ ...v('red'), drain: { outside: true, share: 0.35 } }, 'Codex'),
    'Top drain: outside Codex 7%/h',
  );
  // in the section: right after the verdict row
  const rows = section('Codex', 'openai', v('red'), Date.now(), codexHelper);
  assert.match(rows[3], /^Top drain: refactor-api, long chat 8%\/h \| color=/);
  assert.ok(
    !section('Codex', 'openai', v('green'), Date.now(), codexHelper).some((l) =>
      l.startsWith('Top drain'),
    ),
  );
});

test('outside Codex: ≥ 2 points beyond the calls, under half explained, no turn open', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const reset = now + 3 * 60 * MIN;
  const id = 'chat-1';
  // the meter 40 → 50 over 20 min; one chat spending ~2 model points in that time
  const meters = [];
  for (let m = 25; m >= 0; m -= 2.5)
    meters.push({ t: now - m * MIN, pct: 50 - Math.round(m / 2.5), resetsAt: reset });
  const call = (t, out) => ({
    t,
    thread: id,
    model: 'gpt-6.1-sol',
    last_token_usage: { input_tokens: 100_000, cached_input_tokens: 100_000, output_tokens: out },
  });
  const calls = [call(now - 10 * MIN, 2000), call(now - 2 * MIN, 2000)];
  const threads = { [id]: { name: 'docs-cleanup', root: id, helper: false, open: null } };
  const t = C.codexPace({ calls, meters, threads }, now);
  assert.ok(t.outside, 'outside row');
  assert.deepEqual(Object.keys(t.drain), ['outside', 'share']);
  // the rows add up: the chat and outside shares sum to 1; outside joins the tool's %/h
  assert.ok(near(t.chats[0].share + t.outside.share, 1));
  assert.ok(near(t.chats[0].perHour + t.outside.perHour, t.perHour, 1e-6));
  // the meter is the measure: 42 → 50 since the reading at −20 min = 24%/h, of which the
  // calls explain 2.2 points (fillScale is 4 here and is not added on top of the gap)
  assert.ok(near(t.perHour, 24, 1e-6), `${t.perHour}`);
  assert.ok(near(t.outside.share, (8 - 2 * C.priceCall(calls[0])) / 8, 1e-6), `${t.outside.share}`);
  const rows = section(
    'Codex',
    'openai',
    { ...t, verdict: { state: 'red', runOutAt: now + 60 * MIN, resetsAt: reset, meter: 50 } },
    now,
    codexHelper,
  );
  assert.ok(rows.some((l) => /^Outside Codex +\d+%\/h \| color=/.test(l)));
  assert.ok(rows.some((l) => /^Top drain: outside Codex \d+%\/h \|/.test(l)));
  // a turn open in any file: the gap may be that turn, nothing is called outside
  const busy = { [id]: { ...threads[id], open: now - 30_000 } };
  assert.equal(C.codexPace({ calls, meters, threads: busy }, now).outside, undefined);
  // an open turn older than OPEN_MAX_MIN counts as ended (Codex was killed)
  const stale = { [id]: { ...threads[id], open: now - 61 * MIN } };
  assert.ok(C.codexPace({ calls, meters, threads: stale }, now).outside);
  // the calls explain half or more: no outside
  const heavy = [call(now - 10 * MIN, 12_000), call(now - 2 * MIN, 12_000)];
  assert.equal(C.codexPace({ calls: heavy, meters, threads }, now).outside, undefined);
  // the files' task events → open
  const f = {};
  const out = { calls: [], meters: [] };
  const ev = (ts, type) => JSON.stringify({ timestamp: ts, type: 'event_msg', payload: { type } });
  S.parseRollout(`${ev('2026-11-13T11:59:00Z', 'task_started')}\n`, f, out);
  assert.equal(f.open, Date.parse('2026-11-13T11:59:00Z'));
  S.parseRollout(`${ev('2026-11-13T11:59:30Z', 'task_complete')}\n`, f, out);
  assert.equal(f.open, null);
  S.parseRollout(
    `${ev('2026-11-13T11:59:40Z', 'task_started')}\n${ev('2026-11-13T11:59:50Z', 'turn_aborted')}\n`,
    f,
    out,
  );
  assert.equal(f.open, null);
});

test('cold resume: Nov 1, 448k after 18 h, booked as chat reload with its cost', () => {
  const data = S.readReplay(NOV01, Date.parse('2026-11-02T09:45:00Z'));
  const cold = data.calls.filter((c) => c.cold);
  assert.equal(cold.length, 1); // the calls just after it read from the cache again
  assert.equal(new Date(cold[0].t).toISOString(), '2026-11-02T09:20:05.631Z');
  assert.equal(cold[0].last_token_usage.input_tokens, 448_276);
  assert.equal(data.threads[NOV01_ID].name, 'Nov1-long-chat');
  // its uncached input at the cached weight (COLD_AT_CACHED): 448,276 × 3.3 + 33 × 396
  // = 1.49 points, not 22.7 at the uncached weight; the meter rose 0–1 points across it
  assert.ok(near(C.priceCall(cold[0]), (448_276 * 3.3 + 33 * 396) / 1e6));
  assert.deepEqual(Object.keys(C.codexParts(cold[0])), ['reload']);
  assert.ok(near(C.codexParts(cold[0]).reload, C.priceCall(cold[0])));
  // at 09:26: red, the submenu shows its cost (fillScale 1 yet); the reload is no longer
  // the top drain, the chat's cached reads are
  const { t, rows } = menu(NOV01, '2026-11-02T09:26:00Z');
  assert.equal(t.verdict.state, 'red');
  assert.equal(t.drain.label, 'long chat');
  const cost = Math.max(1, Math.round(C.priceCall(cold[0]) * t.fillScale));
  assert.ok(cost >= 1 && cost <= 3);
  assert.ok(rows.includes(`--resumed cold, cost ≈${cost}% | refresh=true`));
  // later the meter's rises scale it down; out of the 20 min window it is gone
  const later = menu(NOV01, '2026-11-02T09:31:00Z').t;
  assert.ok(later.fillScale < 1 && later.chats[0].reload < C.priceCall(cold[0]));
  const gone = C.codexPace(
    S.readReplay(NOV01, Date.parse('2026-11-02T09:45:00Z')),
    Date.parse('2026-11-02T09:45:00Z'),
  );
  assert.equal(gone.chats[0].reload, null);
  // the rule: idle over 6 h, input over 100k, under half from the cache
  const f = {};
  const out = { calls: [], meters: [] };
  const tc = (ts, input, cached, total) =>
    JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: total },
          last_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: 10 },
        },
      },
    });
  S.parseRollout(
    [
      tc('2026-11-02T00:00:00Z', 200_000, 190_000, 1),
      tc('2026-11-02T05:59:00Z', 200_000, 10_000, 2), // 5 h 59 m: not cold
      tc('2026-11-02T12:00:00Z', 90_000, 10_000, 3), // under 100k: not cold
      tc('2026-11-02T18:01:00Z', 200_000, 120_000, 4), // 60% from the cache: not cold
      tc('2026-11-03T00:02:00Z', 200_000, 10_000, 5), // cold
    ].join('\n'),
    f,
    out,
  );
  assert.deepEqual(
    out.calls.map((c) => !!c.cold),
    [false, false, false, false, true],
  );
});

test('big reads: a tool result is input to the call after the one that asked for it', () => {
  const f = {};
  const out = { calls: [], meters: [] };
  let n = 0;
  const tc = (ts) =>
    JSON.stringify({
      timestamp: ts,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          total_token_usage: { total_tokens: ++n },
          last_token_usage: {
            input_tokens: 50_000,
            cached_input_tokens: 30_000,
            output_tokens: 10,
          },
        },
      },
    });
  const result = (ts, chars, image = false) =>
    JSON.stringify({
      timestamp: ts,
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'c',
        output: [
          { type: 'input_text', text: 'x'.repeat(chars) },
          ...(image
            ? [{ type: 'input_image', image_url: `data:image/png;base64,${'A'.repeat(90_000)}` }]
            : []),
        ],
      },
    });
  S.parseRollout(
    [
      tc('2026-11-13T10:00:00Z'), // asks for a tool
      result('2026-11-13T10:00:05Z', 45_000), // its result, written before its token_count
      tc('2026-11-13T10:00:05Z'),
      tc('2026-11-13T10:00:10Z'), // fed the result
      result('2026-11-13T10:00:12Z', 20_000), // under BIG_READ_CHARS: not a big read
      tc('2026-11-13T10:00:12Z'),
      tc('2026-11-13T10:00:15Z'),
      result('2026-11-13T10:00:17Z', 1000, true), // an image is not text
      tc('2026-11-13T10:00:17Z'),
      tc('2026-11-13T10:00:20Z'),
    ].join('\n'),
    f,
    out,
  );
  assert.deepEqual(
    out.calls.map((c) => c.reads ?? 0),
    [0, 0, 45_000, 0, 0, 0, 0],
  );
  // off by default: the 20k uncached is `other`; on: chars ÷ 3 = 15k of it is `big reads`
  const off = C.codexParts({ ...out.calls[2], model: 'gpt-6.1-sol' });
  assert.equal(off.reads, undefined);
  const on = C.codexParts({ ...out.calls[2], model: 'gpt-6.1-sol' }, false, true);
  assert.ok(near(on.reads, (15_000 * 52) / 1e6));
  assert.ok(near(on.other, (5000 * 52) / 1e6));
});

test('replay: the CLI prints the Codex section as of --at; --sim forces a verdict', () => {
  const run = (...a) =>
    execFileSync(process.execPath, [path.join(src, 'codex-pace.mjs'), '--replay', ...a], {
      env: process.env,
      encoding: 'utf8',
    });
  const out = run(NOV01, '--at', '2026-11-02T09:26:00Z').split('\n');
  assert.equal(out[0], 'as of 2026-11-02T09:26:00.000Z');
  assert.ok(out.includes('--resumed cold, cost ≈1% | refresh=true'));
  assert.ok(out.some((l) => l.startsWith('Top drain: Nov1-long-chat, long chat ')));
  assert.ok(out.every((l) => l.length < 300)); // the template image's base64 is cut
  // default --at: the file's last event
  assert.equal(run(NOV01).split('\n')[0], 'as of 2026-11-02T09:34:17.655Z');
  const sim = run(NOV07, '--at', '2026-11-07T21:41:00Z', '--sim', 'amber');
  assert.match(sim, /^Tight: .* · sim \|/m);
  assert.match(sim, /^Top drain: Summarise the helper agents res…, astra helpers \d+%\/h \|/m);
  assert.throws(() => run(NOV01, '--sim', 'purple'));
});

test('claude-read: the status line drain with the chat name; outside with no chats', async () => {
  const home = fresh('claude');
  process.env.CCRUNWAY_HOME = home;
  const { claudePace } = await import('../src/menubar/claude-read.mjs');
  const now = Date.now();
  const reset = now + 3 * 60 * MIN;
  mkdirSync(path.join(home, 'sessions'), { recursive: true });
  const line = (sid, t, pct, parts) =>
    appendFileSync(
      path.join(home, 'sessions', `${sid}.turns.jsonl`),
      `${JSON.stringify({ t, start: t - MIN, model: 'opus-5-5', pct, helper: 0, parts })}\n`,
    );
  writeJSON(path.join(home, 'pace.json'), {
    resetsAt: reset,
    readings: [
      { t: now - 30 * MIN, pct: 40 },
      { t: now - 10 * MIN, pct: 42 },
    ],
  });
  line('s1', now - 8 * MIN, 1.5, { browser: 1, other: 0.5 });
  line('s2', now - 4 * MIN, 0.5, { answers: 0.5 });
  writeJSON(path.join(home, 'sessions', 's1.json'), { session_name: 'fix-login-flow' });
  const r = claudePace(now);
  assert.deepEqual(r.drain, { chat: 's1', label: 'browser', share: 0.5 });
  assert.equal(r.outside, undefined);
  r.verdict = { state: 'red', runOutAt: now + 60 * MIN, resetsAt: reset, meter: 42 };
  assert.equal(
    drainRow(r, 'Claude Code'),
    `Top drain: fix-login-flow, browser ${Math.round(0.5 * r.perHour)}%/h`,
  );
  // claude.ai alone: the meter rose 6 points, no ledger turn in the window
  const home2 = fresh('claude-out');
  process.env.CCRUNWAY_HOME = home2;
  writeJSON(path.join(home2, 'pace.json'), {
    resetsAt: reset,
    readings: [
      { t: now - 25 * MIN, pct: 40 },
      { t: now - 2 * MIN, pct: 46 },
    ],
  });
  const o = claudePace(now);
  assert.deepEqual(o.chats, []);
  assert.equal(o.outside.share, 1);
  assert.ok(near(o.outside.perHour, (6 / 20) * 60));
  assert.ok(o.bars >= 1);
  const rows = section('Claude Code', 'anthropic', o, now, () => '');
  assert.ok(
    rows.some((l) =>
      /^Outside Claude Code +18%\/h \| color=#6b665c,#a8a294 font=Menlo refresh=true$/.test(l),
    ),
  );
});
