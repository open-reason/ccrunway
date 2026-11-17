// node --test drain.test.mjs
// Range plan S3: tool result sizes, a turn's parts, the top drain across sessions, the
// untracked case, and the big-result note. Fixtures hold placeholders, no real text.
// Temp CCRUNWAY_HOME; nothing under ~ is touched.

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
process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-drain-'));
const { closeTurn, openTurn, readLedger, readTurns } = await import('./ledger.mjs');
const { BIG_RESULT_TOKENS, CHARS_PER_TOKEN, IMAGE_TOKENS, bigResult, noteTool, resultSize } =
  await import('./tools.mjs');
const { RELOAD_MIN, partsOf, split } = await import('./parts.mjs');
const { NAME_MAX, drain, drainText, meterRise } = await import('./drain.mjs');
const { fmtRate, paceBars, paceRate, simRate } = await import('./range.mjs');

const MIN = 60_000;
const close = (a, b, eps = 2e-4) => Math.abs(a - b) < eps;
const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);
// fable-5-2: 84.3 out, 20.0 write; sonnet: 16.9 out, 4.1 write; opus: 24.1, 5.9
const F = { out: 84.3, write: 20.0 };

function layout(sid, history = 'transcript-history.jsonl') {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-proj-'));
  const tp = path.join(dir, `${sid}.jsonl`);
  copyFileSync(fx(history), tp);
  return { dir, tp, sub: path.join(dir, sid, 'subagents') };
}
const tool = (name, response, input = {}) => ({
  hook_event_name: 'PostToolUse',
  tool_name: name,
  tool_input: input,
  tool_response: response,
});

test('tools: a result is sized as the model sees it', () => {
  assert.equal(CHARS_PER_TOKEN, 3);
  assert.equal(IMAGE_TOKENS, 1250);
  // Bash: stdout + stderr, not the diff Claude Code keeps beside them
  const bash = {
    stdout: 'x'.repeat(900),
    stderr: 'y'.repeat(100),
    bashEditDiff: { files: ['z'.repeat(5000)] },
  };
  assert.deepEqual(resultSize('Bash', bash), { chars: 1000, images: 0 });
  // Read: the content plus a line-number prefix per line
  const read = {
    type: 'text',
    file: { filePath: '/p/a.ts', content: 'x'.repeat(3000), numLines: 100 },
  };
  assert.deepEqual(resultSize('Read', read), { chars: 3700, images: 0 });
  // Edit / Write: a short confirmation, whatever the file's size
  assert.equal(resultSize('Edit', { originalFile: 'x'.repeat(90_000), newString: 'y' }).chars, 200);
  // content blocks: text counted, an image counted once and its base64 skipped
  const shot = [
    { type: 'text', text: 'x'.repeat(300) },
    {
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'A'.repeat(80_000) },
    },
  ];
  assert.deepEqual(resultSize('mcp__claude-in-chrome__computer', shot), { chars: 300, images: 1 });
  assert.deepEqual(resultSize('Read', { type: 'image', file: { base64: 'A'.repeat(9000) } }), {
    chars: 0,
    images: 1,
  });
  assert.equal(resultSize('Read', {}, { file_path: '/p/shot.PNG' }).images, 1);
  // output saved to a file: the chat gets a preview only
  assert.equal(
    resultSize('Bash', { stdout: 'x'.repeat(200_000), persistedOutputPath: '/p/o.txt' }).chars,
    2200,
  );
  assert.equal(resultSize('mcp__x__y', 'x'.repeat(600)).chars, 600);
  assert.equal(resultSize('WebFetch', { result: 'x'.repeat(60_000), url: 'u' }).chars, 2200);
  assert.equal(resultSize('mcp__x__y', 'x'.repeat(60_000)).chars, 60_000);
});

test('tools: PostToolUse lines carry tool, kind and tokens; helper calls are skipped', () => {
  const sid = 'tools-1';
  const a = noteTool(
    sid,
    tool('mcp__claude-in-chrome__get_page_text', [{ type: 'text', text: 'x'.repeat(6000) }]),
    1,
  );
  assert.deepEqual(a, { t: 1, tool: 'get_page_text', kind: 'browser', tokens: 2000 });
  const b = noteTool(sid, tool('Read', { type: 'image', file: {} }, { file_path: '/p/s.png' }), 2);
  assert.deepEqual(b, { t: 2, tool: 'Read', kind: 'images', tokens: 1250 });
  const c = noteTool(sid, tool('Bash', { stdout: 'x'.repeat(300), stderr: '' }), 3);
  assert.deepEqual(c, { t: 3, tool: 'Bash', kind: 'reads', tokens: 100 });
  assert.equal(noteTool(sid, { ...tool('Read', 'x'.repeat(900)), agent_id: 'a1' }, 4), null);
  const file = path.join(process.env.CCRUNWAY_HOME, 'sessions', `${sid}.tools.jsonl`);
  assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 3);
  // the big result: over 10k tokens only, the largest one, a browser tool named `browser`
  assert.equal(BIG_RESULT_TOKENS, 10_000);
  assert.equal(bigResult([a, b, c]), null);
  assert.deepEqual(
    bigResult([
      c,
      { tool: 'Read', kind: 'reads', tokens: 50_000 },
      { tool: 'WebFetch', kind: 'reads', tokens: 12_000 },
    ]),
    { tool: 'Read', tokens: 50_000 },
  );
  assert.equal(
    bigResult([{ tool: 'get_page_text', kind: 'browser', tokens: 11_000 }]).tool,
    'browser',
  );
});

test('parts: a Fable turn with a browser result, a Read and a helper', () => {
  const sid = 'parts-1';
  const { tp, sub } = layout(sid);
  const start = Date.parse('2026-11-12T10:00:00.000Z');
  openTurn(sid, tp, start);
  appendFileSync(tp, readFileSync(fx('transcript-tools.jsonl')));
  // 54k chars of page text → 18k tokens; a 30k-token Read
  noteTool(
    sid,
    tool('mcp__claude-in-chrome__get_page_text', [{ type: 'text', text: 'x'.repeat(54_000) }]),
    start + 3000,
  );
  noteTool(sid, tool('Read', 'x'.repeat(90_000)), start + 5000);
  mkdirSync(sub, { recursive: true });
  copyFileSync(fx('transcript-subagent.jsonl'), path.join(sub, 'agent-a1.jsonl'));
  const line = closeTurn(sid, tp, start + 15_000);

  const helpers = (16.9 * 3000 + 4.1 * 20_000 + 16.9 * 1000 + 4.1 * 5000) / 1e6; // sonnet, exact
  const answers = (F.out * 2000) / 1e6; // 500 + 500 + 1000 output tokens, exact
  const writes = (F.write * 54_000) / 1e6; // 2k + 21k + 31k cache writes
  const browser = (F.write * 18_000) / 1e6;
  const reads = (F.write * 30_000) / 1e6;
  assert.equal(line.model, 'fable-5-2');
  assert.equal(line.hmodel, 'sonnet-5-5');
  assert.ok(close(line.parts.helpers, helpers) && close(line.helper, helpers));
  assert.ok(close(line.parts.answers, answers));
  assert.ok(close(line.parts.browser, browser));
  assert.ok(close(line.parts.reads, reads));
  // the rest of the cache writes on Fable is the model's part; nothing was a reload
  assert.ok(close(line.parts.fable, writes - browser - reads));
  assert.equal(line.parts.reload, undefined);
  assert.equal(line.parts.other, undefined);
  assert.ok(close(sum(line.parts), line.pct, 5e-4), 'the parts sum to the turn');
  assert.deepEqual(readTurns(sid)[0].parts, line.parts);
  // the 30k Read is the turn's big result
  assert.deepEqual(readLedger(sid).big, { tool: 'Read', tokens: 30_000 });
});

test('parts: estimates are capped at the cache writes; a reload is named; other models get `other`', () => {
  // tools claim 100k tokens, the calls wrote 10k: capped, the rest is handed back
  const capped = split(
    [{ model: 'claude-opus-5-5', outTokens: 1000, writeTokens: 10_000, readTokens: 90_000 }],
    'opus-5-5',
    0,
    { browser: 75_000, reads: 25_000 },
  );
  assert.ok(close(capped.parts.browser, (5.9 * 7500) / 1e6));
  assert.ok(close(capped.parts.reads, (5.9 * 2500) / 1e6));
  assert.ok(close(sum(capped.parts), (24.1 * 1000 + 5.9 * 10_000) / 1e6, 5e-4));
  assert.deepEqual(capped.left, { browser: 67_500, reads: 22_500 });
  // a cold resume: one call writes the whole 400k chat and reads next to nothing
  assert.equal(RELOAD_MIN, 50_000);
  const cold = split(
    [
      { model: 'claude-opus-5-5', outTokens: 500, writeTokens: 400_000, readTokens: 15_000 },
      { model: 'claude-opus-5-5', outTokens: 500, writeTokens: 6000, readTokens: 415_000 },
    ],
    'opus-5-5',
    0,
    { reads: 4000 },
  );
  assert.ok(close(cold.parts.reload, (5.9 * 400_000) / 1e6));
  assert.ok(close(cold.parts.reads, (5.9 * 4000) / 1e6));
  assert.ok(close(cold.parts.other, (5.9 * 2000) / 1e6));
  assert.equal(cold.left, null);
  // a 60k Read into a 30k chat writes more than it reads, but the Read explains it
  const read = split(
    [{ model: 'claude-opus-5-5', outTokens: 100, writeTokens: 61_000, readTokens: 30_000 }],
    'opus-5-5',
    0,
    { reads: 60_000 },
  );
  assert.ok(close(read.parts.reads, (5.9 * 60_000) / 1e6));
  assert.ok(close(read.parts.reload, (5.9 * 1000) / 1e6));
  // a new chat's first load (under 50k) is not a reload
  const first = split(
    [{ model: 'claude-opus-5-5', outTokens: 100, writeTokens: 30_000, readTokens: 0 }],
    'opus-5-5',
  );
  assert.equal(first.parts.reload, undefined);
});

test('parts: tool results that Stop could not place wait for the catch-up booking', () => {
  const sid = 'parts-carry';
  const { tp } = layout(sid);
  const start = Date.parse('2026-11-12T10:00:00.000Z');
  openTurn(sid, tp, start);
  noteTool(sid, tool('Read', 'x'.repeat(90_000)), start + 5000);
  assert.equal(
    closeTurn(sid, tp, start + 6000),
    null,
    'Stop ran before the transcript had the turn',
  );
  assert.deepEqual(readLedger(sid).big, { tool: 'Read', tokens: 30_000 });
  appendFileSync(tp, readFileSync(fx('transcript-tools.jsonl')));
  openTurn(sid, tp, start + 60_000);
  const t = readTurns(sid)[0];
  assert.ok(close(t.parts.reads, (F.write * 30_000) / 1e6));
  // the next turn starts with an empty tools file, and its Stop clears the note
  const file = path.join(process.env.CCRUNWAY_HOME, 'sessions', `${sid}.tools.jsonl`);
  assert.equal(readFileSync(file, 'utf8'), '');
  closeTurn(sid, tp, start + 70_000);
  assert.equal(readLedger(sid).big, null);
});

test('ledger lines from before S3 (no parts) still read and merge', () => {
  const sid = 'old-lines';
  const dir = path.join(process.env.CCRUNWAY_HOME, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${sid}.turns.jsonl`),
    [
      { t: 2000, start: 1000, model: 'opus-5-5', pct: 0.5, helper: 0.2 },
      {
        t: 3000,
        start: 1000,
        model: 'opus-5-5',
        pct: 0.3,
        helper: 0,
        parts: { answers: 0.1, other: 0.2 },
      },
      { t: 9000, start: 8000, model: 'opus-5-5', pct: 0.4, helper: 0 },
    ]
      .map((l) => `${JSON.stringify(l)}\n`)
      .join(''),
  );
  const turns = readTurns(sid);
  assert.equal(turns.length, 2);
  assert.ok(close(turns[0].pct, 0.8));
  assert.ok(close(turns[0].parts.helpers, 0.2) && close(turns[0].parts.answers, 0.1));
  assert.ok(close(turns[0].parts.other, 0.5));
  assert.deepEqual(partsOf(turns[1]), { helpers: 0, other: 0.4 });
  assert.equal(drain(turns, [], 10_000).label, 'helpers');
});

// two sessions' ledgers over the last 20 min
const NOW = Date.parse('2026-11-12T12:00:00.000Z');
const turn = (sid, minsAgo, pct, parts, extra = {}) => ({
  sid,
  start: NOW - (minsAgo + 1) * MIN,
  t: NOW - minsAgo * MIN,
  pct,
  parts,
  ...extra,
});

test('drain: the top session, its biggest part, and its share of all spend', () => {
  const turns = [
    turn('mine', 2, 2, { browser: 1.4, answers: 0.4, other: 0.2 }),
    turn('mine', 6, 1, { browser: 0.6, answers: 0.3, other: 0.1 }),
    turn('theirs', 4, 1, { answers: 0.7, other: 0.3 }),
    turn('theirs', 40, 9, { reload: 9 }), // outside the window
  ];
  const d = drain(turns, [], NOW);
  assert.equal(d.sid, 'mine');
  assert.equal(d.label, 'browser');
  assert.ok(close(d.share, 2 / 4)); // 2.0 browser points of 4 spent by both
  assert.equal(drainText(d, 'mine'), 'this chat, browser 50%');
  // the scale cancels: the same turns priced 1.3× high give the same share
  const d13 = drain(
    turns.map((x) => ({
      ...x,
      pct: x.pct * 1.3,
      parts: Object.fromEntries(Object.entries(x.parts).map(([k, v]) => [k, v * 1.3])),
    })),
    [],
    NOW,
    1 / 1.3,
  );
  assert.ok(close(d13.share, d.share));
  // a turn half inside the window counts half
  const edge = drain(
    [
      { sid: 'mine', start: NOW - 30 * MIN, t: NOW - 10 * MIN, pct: 4, parts: { answers: 4 } },
      turn('theirs', 1, 3, { images: 3 }),
    ],
    [],
    NOW,
  );
  assert.equal(edge.label, 'images');
  assert.ok(close(edge.share, 3 / 5));
  assert.equal(drain([], [], NOW), null);
});

test('drain: `this chat` vs a named session vs `another chat`; Fable helpers', () => {
  const dir = path.join(process.env.CCRUNWAY_HOME, 'sessions');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, 'helper-chat.json'),
    JSON.stringify({ session_name: 'Placeholder session name, long' }),
  );
  writeFileSync(
    path.join(dir, 'short-chat.json'),
    JSON.stringify({ session_name: 'Placeholder name' }),
  );
  const turns = [
    turn(
      'helper-chat',
      3,
      7.5,
      { helpers: 7, answers: 0.3, fable: 0.2 },
      { hmodel: 'fable-5-2', helper: 7 },
    ),
    turn('me', 2, 2.5, { answers: 1.5, other: 1 }),
  ];
  const d = drain(turns, [], NOW);
  assert.equal(d.label, 'Fable helpers');
  assert.equal(NAME_MAX, 20);
  assert.equal(drainText(d, 'me'), '"Placeholder session…", Fable helpers 70%');
  assert.equal(drainText(d, 'helper-chat'), 'this chat, Fable helpers 70%');
  assert.equal(
    drainText({ ...d, sid: 'short-chat' }, 'me'),
    '"Placeholder name", Fable helpers 70%',
  );
  assert.equal(drainText({ ...d, sid: 'no-snapshot' }, 'me'), 'another chat, Fable helpers 70%');
  // helpers on another model read `helpers`; the turn's own Fable cost reads `Fable`
  const sonnet = drain(
    [turn('me', 2, 3, { helpers: 2, answers: 1 }, { hmodel: 'sonnet-5-5' })],
    [],
    NOW,
  );
  assert.equal(drainText(sonnet, 'me'), 'this chat, helpers 67%');
  const fable = drain([turn('me', 2, 3, { fable: 2, answers: 1 })], [], NOW);
  assert.equal(drainText(fable, 'me'), 'this chat, Fable 67%');
  // only `other`: the session is named with its own share, no part
  const plain = drain([turn('me', 2, 3, { other: 3 }), turn('x', 2, 1, { other: 1 })], [], NOW);
  assert.equal(drainText(plain, 'me'), 'this chat 75%');
});

test('drain: the meter rose more than the ledgers explain → outside Claude Code', () => {
  const rises = (from, to) =>
    Array.from({ length: to - from + 1 }, (_, i) => ({
      t: NOW - (25 - 3 * i) * MIN,
      pct: from + i,
    }));
  const readings = rises(40, 48); // 40% at −25 min … 48% at −1 min: 7 points in the window
  assert.equal(meterRise(readings, NOW - 20 * MIN, NOW), 7);
  const some = [turn('me', 2, 2, { answers: 2 })];
  assert.deepEqual(drain(some, readings, NOW), { outside: true }); // 2 of 7 explained
  assert.deepEqual(drain([], readings, NOW), { outside: true });
  assert.equal(drainText({ outside: true }, 'me'), 'outside Claude Code');
  // half or more explained: the ledgers' own top drain
  const most = [turn('me', 2, 4, { answers: 4 })];
  assert.equal(drain(most, readings, NOW).sid, 'me');
  // priced 1.3× high and scaled down: 4 × 0.77 = 3.1 of 7 → outside; never scaled up
  assert.deepEqual(drain(most, readings, NOW, 1 / 1.3), { outside: true });
  assert.deepEqual(drain(some, readings, NOW, 4), { outside: true });
  // a gap under 2 points is the meter's whole-percent step, not spend
  const small = rises(40, 42).map((r, i) => ({ ...r, t: NOW - (15 - 5 * i) * MIN }));
  assert.equal(drain([turn('me', 2, 0.4, { answers: 0.4 })], small, NOW).sid, 'me');
  // a turn still running somewhere is unpriced: nothing is called outside
  assert.equal(drain(some, readings, NOW, 1, () => true).sid, 'me');
  assert.equal(
    drain([], readings, NOW, 1, () => true),
    null,
  );
});

test('pace unit: the session rate in % of the limit per hour, beside the bars', () => {
  const RESET = NOW + 100 * MIN; // meter 50: safe 0.5%/min = 30%/h
  const turns = (pct) =>
    Array.from({ length: 5 }, (_, i) => ({
      start: NOW - (5 - i) * 2 * MIN,
      t: NOW - (5 - i) * 2 * MIN + MIN,
      pct,
    }));
  assert.deepEqual(paceRate(turns(1), 50, RESET, NOW), { bars: 3, perHour: 30 });
  assert.equal(paceBars(turns(1), 50, RESET, NOW), 3);
  assert.equal(paceRate(turns(1), 50, RESET, NOW, 0.5).perHour, 15);
  assert.equal(paceRate(turns(1).slice(0, 2), 50, RESET, NOW), null);
  assert.equal(fmtRate(34.4), '34%/h');
  assert.equal(fmtRate(0.6), '<1%/h');
  assert.equal(fmtRate(1), '1%/h');
  // simulate: the live safe rate × a ratio per bar count
  assert.equal(simRate(3, 50, RESET, NOW), 30);
  assert.equal(simRate(4, 50, RESET, NOW), 45);
  assert.equal(Math.round(simRate(1, 50, RESET, NOW)), 9);
  assert.equal(simRate(2, 50, null, NOW), null);
});

// the real processes: hook.mjs on PostToolUse and Stop, then the status line
test('status line: drain only when amber or red; big result for one turn, any colour', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-drain-e2e-'));
  const env = { ...process.env, CCRUNWAY_HOME: home, NO_COLOR: '1' };
  const run = (script, stdin, args = []) =>
    spawnSync(process.execPath, [path.join(here, script), ...args], {
      input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
      env,
      encoding: 'utf8',
    });
  const sid = 'e2e-drain';
  const { tp } = layout(sid);
  const hookIn = (ev, more = {}) => ({
    hook_event_name: ev,
    session_id: sid,
    transcript_path: tp,
    ...more,
  });
  const t0 = Date.now();
  run('hook.mjs', hookIn('UserPromptSubmit', { prompt: '[placeholder]' }));
  const post = run('hook.mjs', hookIn('PostToolUse', tool('Read', 'x'.repeat(150_000))));
  assert.equal(post.status, 0);
  assert.equal(post.stdout, '');
  run(
    'hook.mjs',
    hookIn(
      'PostToolUse',
      tool('mcp__claude-in-chrome__get_page_text', [{ type: 'text', text: 'x'.repeat(6000) }]),
    ),
  );
  const iso = new Date(t0 + 500).toISOString();
  appendFileSync(
    tp,
    readFileSync(fx('transcript-tools.jsonl'), 'utf8').replace(
      /2026-11-12T10:00:\d\d\.\d{3}Z/g,
      iso,
    ),
  );
  run('hook.mjs', hookIn('Stop'));
  const sessions = path.join(home, 'sessions');
  const booked = JSON.parse(readFileSync(path.join(sessions, `${sid}.turns.jsonl`), 'utf8').trim());
  assert.ok(booked.parts.reads > booked.parts.browser && booked.parts.browser > 0);

  // 1% every 4 min to 60%; the run-out is ~160 min out: reset in 130 min → green, 150 → amber, 240 → red
  const pace = (resetMin) => {
    const reset = Math.floor((t0 + resetMin * MIN) / 1000);
    const readings = [];
    for (let i = 0; i <= 20; i++) readings.push({ t: t0 - (80 - 4 * i) * MIN, pct: 40 + i });
    writeFileSync(
      path.join(home, 'pace.json'),
      JSON.stringify({ resetsAt: reset * 1000, readings, askedAt: null, noted: false }),
    );
    const snap = JSON.parse(readFileSync(fx('statusline-opus-259k.json'), 'utf8'));
    snap.session_id = sid;
    snap.rate_limits.five_hour = { used_percentage: 60, resets_at: reset };
    return snap;
  };
  // this session's ledger explains the window: 3 turns, the browser the biggest part
  const lines = [0, 1, 2].map((i) => ({
    t: t0 - (5 - 2 * i) * MIN + 30_000,
    start: t0 - (5 - 2 * i) * MIN,
    model: 'opus-5-5',
    pct: 2,
    helper: 0,
    parts: { browser: 1.2, answers: 0.5, other: 0.3 },
  }));
  writeFileSync(
    path.join(sessions, `${sid}.turns.jsonl`),
    lines.map((l) => `${JSON.stringify(l)}\n`).join(''),
  );

  const green = run('statusline.mjs', pace(130)).stdout;
  assert.match(
    green,
    /^ccrunway · pace ▮+▯* +\d+%\/h · .*✓ on track · .* · big result: Read 50k\n$/,
  );
  assert.doesNotMatch(green, /top drain/, 'no drain on a green line');

  const amber = run('statusline.mjs', pace(150)).stdout;
  assert.match(
    amber,
    /^ccrunway · pace ▮▮▮▮ +\d+%\/h · .*⚠ tight · .* · big result: Read 50k\n\u2800{9}· top drain: this chat, browser \d+%\/h\n$/,
  );
  const red = run('statusline.mjs', pace(240)).stdout;
  assert.match(
    red,
    /^ccrunway · .*✗ runs out .* · big result: Read 50k\n\u2800{9}· top drain: this chat, browser \d+%\/h\n$/,
  );

  // another session reads the same drain under that session's name, and no big result
  writeFileSync(
    path.join(sessions, `${sid}.json`),
    JSON.stringify({ session_name: 'Placeholder name' }),
  );
  const other = pace(240);
  other.session_id = 'e2e-other';
  const theirs = run('statusline.mjs', other).stdout;
  assert.match(theirs, /early\n\u2800{9}· top drain: "Placeholder name", browser \d+%\/h\n$/);
  assert.doesNotMatch(theirs, /big result|pace ▮/);

  // a simulated red on a green seat: the verdict is forced, the drain is the real one
  run('simulate.mjs', '', ['range', 'red', '4']);
  const sim = run('statusline.mjs', pace(130)).stdout;
  assert.match(
    sim,
    /^ccrunway · pace ▮▮▮▮ +\d+%\/h · .*✗ runs out .* · big result: Read 50k · sim\n\u2800{9}· top drain: this chat, browser \d+%\/h\n$/,
  );
  run('simulate.mjs', '', ['range', 'cold']);
  assert.doesNotMatch(run('statusline.mjs', pace(130)).stdout, /top drain|big result|pace ▮/);
  writeFileSync(path.join(home, 'range.sim.json'), '{}');

  // the next turn has no big result: its Stop clears the note
  run('hook.mjs', hookIn('UserPromptSubmit', { prompt: '[placeholder]' }));
  assert.match(
    run('statusline.mjs', pace(130)).stdout,
    /big result: Read 50k\n$/,
    'still there for this turn',
  );
  run('hook.mjs', hookIn('PostToolUse', tool('Bash', { stdout: 'x'.repeat(900), stderr: '' })));
  run('hook.mjs', hookIn('Stop'));
  assert.doesNotMatch(run('statusline.mjs', pace(130)).stdout, /big result/);
});

test('hook.mjs PostToolUse never breaks: no session, no response, bad input → exit 0, no output', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-drain-bad-'));
  const env = { ...process.env, CCRUNWAY_HOME: home };
  for (const input of [
    '{"hook_event_name":"PostToolUse"}',
    '{"hook_event_name":"PostToolUse","session_id":"s"}',
    '{"hook_event_name":"PostToolUse","session_id":"s","tool_name":"Read","tool_response":null}',
    'not json',
  ]) {
    const r = spawnSync(process.execPath, [path.join(here, 'hook.mjs')], {
      input,
      env,
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout + r.stderr, '');
  }
});
