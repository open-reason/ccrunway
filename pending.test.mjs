// node --test pending.test.mjs
// Pending spend (ledger.mjs pendingSpend): a chat's spend the hook has not booked yet,
// priced read only until the next Stop (or catch-up) books it: a background helper's after
// its chat's Stop, and the chat's own calls while a turn runs, split into parts as the
// booking will split them. The status line and the menu bar show it on that chat instead
// of `outside Claude Code`. Fixtures as in ledger.test.mjs; temp CCRUNWAY_HOME, nothing under
// ~ is touched.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (f) => path.join(here, 'fixtures', f);
process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-pending-'));
const L = await import('./ledger.mjs');
const { claudePace } = await import('./menubar/claude-read.mjs');

const MIN = 60_000;
const close = (a, b) => Math.abs(a - b) < 1e-4;
// sonnet: 16.9 out, 4.1 write; opus: 24.1 out, 5.9 write (points per Mtok)
const S1 = (16.9 * 3000 + 4.1 * 20_000) / 1e6;
const S2 = (16.9 * 1000 + 4.1 * 5000) / 1e6;
const sub = readFileSync(fx('transcript-subagent.jsonl'), 'utf8').trim().split('\n');

function layout(sid) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-proj-'));
  const tp = path.join(dir, `${sid}.jsonl`);
  copyFileSync(fx('transcript-history.jsonl'), tp);
  const subDir = path.join(dir, sid, 'subagents');
  mkdirSync(subDir, { recursive: true });
  return { tp, subDir };
}

// one helper call as Claude Code writes it in agent-*.jsonl
const call = (id, iso, model, out, write) =>
  `${JSON.stringify({
    parentUuid: 's0',
    isSidechain: true,
    agentId: 'b1',
    type: 'assistant',
    requestId: id,
    timestamp: iso,
    uuid: `u-${id}`,
    message: {
      id: `msg_${id}`,
      model,
      role: 'assistant',
      content: [{ type: 'text', text: '[placeholder]' }],
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: write,
        cache_read_input_tokens: 1000,
        output_tokens: out,
      },
    },
  })}\n`;

test('pending: only the helper calls the ledger has not booked; 0 after the hook books them', () => {
  const sid = 'pend-1';
  const { tp, subDir } = layout(sid);
  const a1 = path.join(subDir, 'agent-a1.jsonl');
  const start = Date.parse('2026-11-12T10:00:00.000Z');
  assert.equal(L.pendingSpend(sid), null, 'no ledger yet');
  L.openTurn(sid, tp, start);
  appendFileSync(tp, readFileSync(fx('transcript-turn.jsonl')));
  writeFileSync(a1, `${sub.slice(0, 4).join('\n')}\n`); // req_old, prompt, req_S1 ×2
  const booked = L.closeTurn(sid, tp, start + 15_000);
  assert.ok(close(booked.helper, S1), `booked helper ${booked.helper} ≠ ${S1}`);
  assert.equal(L.pendingSpend(sid).pct, 0, 'everything written so far is booked');

  // the helper keeps running after Stop: req_S2, a repeat of req_S1, and a second file
  // whose only call is from before the turn
  appendFileSync(a1, `${sub[4]}\n${sub[3]}\n`);
  writeFileSync(path.join(subDir, 'agent-a2.jsonl'), `${sub[0]}\n`);
  const before = readFileSync(L.ledgerPath(sid), 'utf8');
  const p = L.pendingSpend(sid);
  assert.ok(close(p.pct, S2), `pending ${p.pct} ≠ ${S2}`);
  assert.match(p.model, /sonnet/);
  assert.deepEqual(p.parts, { helpers: p.pct });
  assert.equal(p.start, start + 15_000, 'the last Stop');
  assert.equal(p.open, false);
  assert.ok(Date.now() - p.lastWrite < 5000);
  assert.equal(readFileSync(L.ledgerPath(sid), 'utf8'), before, 'read only');

  // the next prompt's catch-up books it to the last turn: pending is 0, nothing twice
  L.openTurn(sid, tp, start + 60_000);
  assert.equal(L.pendingSpend(sid).pct, 0);
  const turns = L.readTurns(sid);
  assert.equal(turns.length, 1);
  assert.ok(close(turns[0].helper, S1 + S2));

  // inside a turn: pending is that turn's, and its Stop books exactly it
  appendFileSync(a1, call('req_S3', '2026-11-12T10:01:05.000Z', 'claude-sonnet-5', 1000, 5000));
  const q = L.pendingSpend(sid);
  assert.ok(close(q.pct, S2) && q.open && q.start === start + 60_000);
  const line = L.closeTurn(sid, tp, start + 70_000);
  assert.ok(close(line.helper, q.pct), 'Stop books what pending showed');
  assert.equal(L.pendingSpend(sid).pct, 0);

  // a file with more unread bytes than the cap is skipped, and named
  appendFileSync(a1, call('req_S4', new Date().toISOString(), 'claude-sonnet-5', 1000, 5000));
  const capped = L.pendingSpend(sid, 10);
  assert.equal(capped.pct, 0);
  assert.deepEqual(capped.skipped, ['agent-a1.jsonl']);
});

test('pending: the per-turn bar adds an idle lump to the last turn, a running turn as its own', () => {
  const turns = [
    { t: 1000, start: 0, pct: 1, helper: 0, parts: { answers: 1 } },
    { t: 3000, start: 2000, pct: 1, helper: 0.5, parts: { helpers: 0.5, other: 0.5 } },
  ];
  const p = { pct: 2, model: 'opus-5-5', helper: 2, hmodel: 'opus-5-5', parts: { helpers: 2 } };
  const idle = L.pendingTurn('s', { ...p, start: 3000, open: false }, 9000);
  const merged = L.withPending(turns, idle);
  assert.equal(merged.length, 2, 'no new turn start: the median gap stays send to send');
  assert.deepEqual(
    { pct: merged[1].pct, helper: merged[1].helper, start: merged[1].start },
    { pct: 3, helper: 2.5, start: 2000 },
  );
  assert.deepEqual(merged[1].parts, { helpers: 2.5, other: 0.5 });
  assert.equal(turns[1].pct, 1, 'the ledger turns are not changed');
  const running = L.pendingTurn('s', { ...p, start: 5000, open: true }, 9000);
  assert.equal(L.withPending(turns, running).length, 3);
  assert.equal(L.pendingTurn('s', { pct: 0, start: 1 }, 2), null);
  // an idle tail ends when it was written, not now: the chat does not look active
  const tail = L.pendingTurn('s', { ...p, start: 3000, lastWrite: 3500, open: false }, 9000);
  assert.deepEqual([tail.start, tail.t], [3000, 3500]);
  assert.equal(
    L.pendingTurn('s', { ...p, start: 3000, lastWrite: 3500, open: true }, 9000).t,
    9000,
  );
  // a running turn's own calls merge by part, helpers stay apart
  const main = L.pendingTurn(
    's',
    { pct: 1, model: 'opus-5-5', parts: { answers: 0.4, other: 0.6 }, start: 3000 },
    9000,
  );
  const m = L.withPending(turns, main)[1];
  assert.deepEqual({ pct: m.pct, helper: m.helper }, { pct: 2, helper: 0.5 });
  assert.deepEqual(m.parts, { helpers: 0.5, other: 1.1, answers: 0.4 });
});

test('a running helper reads as its chat`s helpers, not outside Claude Code (status line, menu bar)', () => {
  const home = process.env.CCRUNWAY_HOME;
  const sid = 'pend-live';
  const { tp, subDir } = layout(sid);
  const t0 = Date.now();
  // a short turn 10 min ago, Stop 9 min ago
  L.openTurn(sid, tp, t0 - 10 * MIN);
  const iso = new Date(t0 - 10 * MIN + 500).toISOString();
  appendFileSync(
    tp,
    readFileSync(fx('transcript-turn.jsonl'), 'utf8').replace(
      /2026-11-12T10:00:\d\d\.\d{3}Z/g,
      iso,
    ),
  );
  assert.ok(L.closeTurn(sid, tp, t0 - 9 * MIN).pct < 0.5);
  // a background helper since: ~4.4 points of Opus, not yet booked
  writeFileSync(
    path.join(subDir, 'agent-b1.jsonl'),
    call('req_H1', new Date(t0 - 5 * MIN).toISOString(), 'claude-opus-5-5', 100_000, 200_000) +
      call('req_H2', new Date(t0 - MIN).toISOString(), 'claude-opus-5-5', 20_000, 50_000),
  );
  const helper = (24.1 * 120_000 + 5.9 * 250_000) / 1e6;
  assert.ok(close(L.pendingSpend(sid).pct, helper));

  // the meter: 1% every 4 min to 60% (5 points in the last 20 min, the ledger has < 0.5);
  // the reset in 4 h → red, so the top drain shows
  const reset = Math.floor((t0 + 240 * MIN) / 1000);
  const readings = [];
  for (let i = 0; i <= 20; i++) readings.push({ t: t0 - (80 - 4 * i) * MIN, pct: 40 + i });
  writeFileSync(
    path.join(home, 'pace.json'),
    JSON.stringify({ resetsAt: reset * 1000, readings, askedAt: null, noted: false }),
  );
  const snap = JSON.parse(readFileSync(fx('statusline-opus-259k.json'), 'utf8'));
  snap.session_id = sid;
  snap.session_name = 'Placeholder chat'; // the status line writes it to sessions/<sid>.json
  snap.rate_limits.five_hour = { used_percentage: 60, resets_at: reset };
  const out = spawnSync(process.execPath, [path.join(here, 'statusline.mjs')], {
    input: JSON.stringify(snap),
    env: { ...process.env, CCRUNWAY_HOME: home, NO_COLOR: '1' },
    encoding: 'utf8',
  }).stdout;
  assert.match(out, /✗ runs out .*\n⠀{9}· top drain: this chat, helpers \d+%\/h\n$/);

  const t = claudePace(Date.now());
  assert.equal(t.outside, undefined, 'no Outside Claude Code row');
  assert.equal(t.drain.chat, sid);
  assert.equal(t.drain.label, 'helpers');
  const chat = t.chats.find((c) => c.id === sid);
  assert.equal(chat.name, 'Placeholder chat');
  assert.ok(chat.helpers.length === 1 && chat.helpers[0].model === 'Opus');
  assert.ok(Date.now() - chat.lastT < 5000, 'not idle while its helper runs');

  // once a Stop books it, the ledger says the same and pending is 0
  L.openTurn(sid, tp, Date.now());
  assert.equal(L.pendingSpend(sid).pct, 0);
  assert.equal(claudePace(Date.now()).drain.label, 'helpers');
});

// opus: 24.1 out, 5.9 write
const OPUS = (out, write) => (24.1 * out + 5.9 * write) / 1e6;
const toolLine = (sid, tokens) =>
  appendFileSync(
    path.join(process.env.CCRUNWAY_HOME, 'sessions', `${sid}.tools.jsonl`),
    `${JSON.stringify({ t: Date.now(), tool: 'Read', kind: 'reads', tokens })}\n`,
  );

test('pending: a running turn`s own calls, with parts, as its Stop books them; the rest after it', () => {
  const sid = 'pend-main';
  const { tp } = layout(sid);
  const start = Date.parse('2026-11-12T11:00:00.000Z');
  const at = (s) => new Date(start + s * 1000).toISOString();
  L.openTurn(sid, tp, start);
  assert.equal(L.pendingSpend(sid).pct, 0, 'the prompt, no call yet');

  // two calls in, and a 30k-token read: 0.177 points of cache writes wanted, 0.118 there
  appendFileSync(
    tp,
    call('req_C1', at(2), 'claude-opus-5-5', 1000, 10_000) +
      call('req_C2', at(5), 'claude-opus-5-5', 1000, 10_000),
  );
  toolLine(sid, 30_000);
  const before = readFileSync(L.ledgerPath(sid), 'utf8');
  const p = L.pendingSpend(sid);
  assert.ok(close(p.pct, 2 * OPUS(1000, 10_000)), `pending ${p.pct}`);
  assert.equal(p.open, true);
  assert.equal(p.start, start);
  assert.equal(p.helper, 0);
  assert.equal(p.model, 'opus-5-5');
  assert.ok(close(p.parts.answers, (24.1 * 2000) / 1e6));
  assert.ok(close(p.parts.reads, (5.9 * 20_000) / 1e6), 'the read capped at the cache writes');
  assert.equal(p.parts.helpers, undefined);
  assert.equal(readFileSync(L.ledgerPath(sid), 'utf8'), before, 'read only');

  // the Stop books exactly that, carries the read's rest, and pending is 0
  const line = L.closeTurn(sid, tp, start + 10_000);
  assert.equal(line.pct, p.pct);
  assert.deepEqual(line.parts, p.parts);
  assert.equal(L.pendingSpend(sid).pct, 0, 'nothing twice');
  const carry = JSON.parse(readFileSync(L.ledgerPath(sid), 'utf8')).carry;
  assert.ok(carry?.start === start && carry.left.reads > 0);

  // the turn's last call lands after the Stop: pending is only that call, with the
  // carried read, as the catch-up at the next prompt books it
  appendFileSync(
    tp,
    call('req_C2', at(5), 'claude-opus-5-5', 1500, 10_000) + // the same request, grown: seen
      call('req_C3', at(11), 'claude-opus-5-5', 500, 30_000),
  );
  const q = L.pendingSpend(sid);
  assert.ok(close(q.pct, OPUS(500, 30_000)), `pending ${q.pct}`);
  assert.equal(q.open, false);
  assert.ok(q.parts.reads > 0, 'the carried read');
  L.openTurn(sid, tp, start + 60_000);
  const turns = L.readTurns(sid);
  assert.equal(turns.length, 1);
  assert.ok(close(turns[0].pct, line.pct + q.pct));
  assert.ok(close(turns[0].parts.reads, line.parts.reads + q.parts.reads));
  assert.equal(L.pendingSpend(sid).pct, 0);

  // a transcript with more unread bytes than the cap is skipped, and named
  appendFileSync(tp, call('req_C4', at(62), 'claude-opus-5-5', 500, 1000));
  assert.deepEqual(L.pendingSpend(sid, 10).skipped, [`${sid}.jsonl`]);
  assert.ok(L.pendingSpend(sid).pct > 0);
});

test('a running single-prompt turn reads as its chat`s spend (status line, menu bar)', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-pending-run-'));
  const prevHome = process.env.CCRUNWAY_HOME;
  process.env.CCRUNWAY_HOME = home;
  try {
    const sid = 'pend-run';
    const { tp } = layout(sid);
    const t0 = Date.now();
    // one prompt 4 min ago, still running: ~5 points of Opus written, no Stop yet
    L.openTurn(sid, tp, t0 - 4 * MIN);
    appendFileSync(
      tp,
      call('req_R1', new Date(t0 - 3 * MIN).toISOString(), 'claude-opus-5-5', 120_000, 200_000) +
        call('req_R2', new Date(t0 - MIN).toISOString(), 'claude-opus-5-5', 60_000, 100_000),
    );
    assert.deepEqual(L.readTurns(sid), [], 'nothing booked');
    const spent = OPUS(180_000, 300_000);
    assert.ok(close(L.pendingSpend(sid).pct, spent));

    // the meter: 1% every 4 min to 60%, reset in 4 h → red, so the top drain shows
    const reset = Math.floor((t0 + 240 * MIN) / 1000);
    const readings = [];
    for (let i = 0; i <= 20; i++) readings.push({ t: t0 - (80 - 4 * i) * MIN, pct: 40 + i });
    writeFileSync(
      path.join(home, 'pace.json'),
      JSON.stringify({ resetsAt: reset * 1000, readings, askedAt: null, noted: false }),
    );
    const snap = JSON.parse(readFileSync(fx('statusline-opus-259k.json'), 'utf8'));
    snap.session_id = sid;
    snap.session_name = 'Running chat';
    snap.rate_limits.five_hour = { used_percentage: 60, resets_at: reset };
    const out = spawnSync(process.execPath, [path.join(here, 'statusline.mjs')], {
      input: JSON.stringify(snap),
      env: { ...process.env, CCRUNWAY_HOME: home, NO_COLOR: '1' },
      encoding: 'utf8',
    }).stdout;
    assert.match(out, /✗ runs out .*\n⠀{9}· top drain: this chat, long answers \d+%\/h\n$/);

    const t = claudePace(Date.now());
    assert.equal(t.outside, undefined);
    const chat = t.chats.find((c) => c.id === sid);
    assert.ok(chat, 'the running chat has a row');
    assert.equal(chat.name, 'Running chat');
    assert.ok(chat.perHour > 0);
    assert.deepEqual(chat.helpers, []);
    assert.ok(Date.now() - chat.lastT < 5000, 'not idle while its turn runs');
    assert.equal(t.drain.chat, sid);
    assert.equal(t.drain.label, 'long answers');
    // one pace rule: the status line's number is the menu row's (by time: one prompt)
    const shown = Number(out.match(/pace [▮▯]+ +(\d+)%\/h/)[1]);
    assert.equal(shown, Math.round(chat.perHour), `${shown} vs ${chat.perHour}`);

    // its Stop books it: the same row from the ledger, nothing pending
    const line = L.closeTurn(sid, tp, Date.now());
    assert.ok(close(line.pct, spent));
    assert.equal(L.pendingSpend(sid).pct, 0);
    const after = claudePace(Date.now()).chats.find((c) => c.id === sid);
    assert.ok(Math.abs(after.perHour - chat.perHour) / chat.perHour < 0.05);
  } finally {
    process.env.CCRUNWAY_HOME = prevHome;
  }
});
