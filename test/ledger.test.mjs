// node --test test/ledger.test.mjs
// The turn ledger (range plan S2) from a trimmed transcript fixture: placeholders for
// every prompt and reply, real entry shapes. Temp CCRUNWAY_HOME; nothing under ~ is touched.

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
const src = path.join(here, '..', 'src');
const fx = (f) => path.join(here, 'fixtures', f);
process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-ledger-'));
const { closeTurn, openTurn, readTurns } = await import('../src/ledger.mjs');

// opus: 24.1 out, 5.9 write; sonnet: 16.9 out, 4.1 write (points per Mtok)
const A = (24.1 * 2000 + 5.9 * 40_000) / 1e6; // req_A, 3 entries in the turn + 1 resume repeat
const B = (24.1 * 1000 + 5.9 * 10_000) / 1e6;
const S = (16.9 * 3000 + 4.1 * 20_000 + 16.9 * 1000 + 4.1 * 5000) / 1e6; // helper, S1 twice
const close = (a, b) => Math.abs(a - b) < 1e-4;

// a transcript dir laid out like ~/.claude/projects/<proj>/: <sid>.jsonl + <sid>/subagents/
function layout(sid) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-proj-'));
  const tp = path.join(dir, `${sid}.jsonl`);
  copyFileSync(fx('transcript-history.jsonl'), tp);
  return { dir, tp, sub: path.join(dir, sid, 'subagents') };
}

test('ledger: one turn from the fixture, deduped by requestId, helper calls included', () => {
  const sid = 'fixture-1';
  const { tp, sub } = layout(sid);
  const start = Date.parse('2026-11-12T10:00:00.000Z');
  openTurn(sid, tp, start);
  appendFileSync(tp, readFileSync(fx('transcript-turn.jsonl')));
  mkdirSync(sub, { recursive: true });
  copyFileSync(fx('transcript-subagent.jsonl'), path.join(sub, 'agent-a1.jsonl'));
  const line = closeTurn(sid, tp, start + 15_000);

  assert.equal(line.model, 'opus-5-5');
  assert.ok(close(line.pct, A + B + S), `pct ${line.pct} ≠ ${A + B + S}`);
  assert.ok(close(line.helper, S), `helper ${line.helper} ≠ ${S}`);
  assert.equal(line.start, start);
  // without the dedupe, req_A alone would count 4 times (and its first entries at 8 tokens)
  assert.ok(line.pct < A * 2 + B + S);
  assert.deepEqual(
    readTurns(sid).map((t) => t.pct),
    [line.pct],
  );

  // the next turn: nothing new in the transcript, and the helper file is already read
  openTurn(sid, tp, start + 60_000);
  appendFileSync(tp, readFileSync(fx('transcript-turn.jsonl'))); // a resume repeats entries
  assert.equal(closeTurn(sid, tp, start + 70_000), null, 'repeated requestIds cost nothing');
  assert.equal(readTurns(sid).length, 1);
});

test('ledger: helpers by name, from agent-*.meta.json; a file without one is name null', () => {
  const sid = 'fixture-agents';
  const { tp, sub } = layout(sid);
  const start = Date.parse('2026-11-12T10:00:00.000Z');
  openTurn(sid, tp, start);
  appendFileSync(tp, readFileSync(fx('transcript-turn.jsonl')));
  mkdirSync(sub, { recursive: true });
  const helperText = readFileSync(fx('transcript-subagent.jsonl'), 'utf8');
  writeFileSync(path.join(sub, 'agent-atelemetry-1.jsonl'), helperText);
  writeFileSync(
    path.join(sub, 'agent-atelemetry-1.meta.json'),
    JSON.stringify({
      agentType: 'telemetry',
      name: 'telemetry',
      description: 'Telemetry: who was active',
    }),
  );
  // a second helper on the same model, its own requestIds, and no meta file
  writeFileSync(path.join(sub, 'agent-a2.jsonl'), helperText.replace(/req_S/g, 'req_T'));
  const line = closeTurn(sid, tp, start + 15_000);

  assert.ok(close(line.helper, 2 * S), `helper ${line.helper} ≠ ${2 * S}`);
  assert.deepEqual(line.agents.map((a) => [a.name, a.model]).sort(), [
    [null, 'sonnet-5-5'],
    ['telemetry', 'sonnet-5-5'],
  ]);
  assert.ok(close(line.agents[0].pct + line.agents[1].pct, line.helper));
  assert.deepEqual(readTurns(sid)[0].agents, line.agents);
});

test('ledger: Stop before any UserPromptSubmit anchors and books nothing', () => {
  const sid = 'fixture-2';
  const { tp } = layout(sid);
  assert.equal(closeTurn(sid, tp, Date.parse('2026-11-12T10:00:00Z')), null);
  assert.deepEqual(readTurns(sid), []);
});

// the real hook process: UserPromptSubmit, the turn written, Stop; then the status
// line shows the pace bar once this session has 3 turns
test('hook.mjs keeps the ledger; the status line shows the pace bar from the first turn', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-ledger-e2e-'));
  const env = { ...process.env, CCRUNWAY_HOME: home, NO_COLOR: '1' };
  const run = (script, stdin) =>
    spawnSync(process.execPath, [path.join(src, script)], {
      input: JSON.stringify(stdin),
      env,
      encoding: 'utf8',
    });
  const sid = 'e2e';
  const { tp } = layout(sid);
  const turnText = readFileSync(fx('transcript-turn.jsonl'), 'utf8');
  const hookIn = (ev) => ({ hook_event_name: ev, session_id: sid, transcript_path: tp });

  const t0 = Date.now();
  const r1 = run('hook.mjs', { ...hookIn('UserPromptSubmit'), prompt: '[placeholder]' });
  assert.equal(r1.stdout, '');
  // the fixture's entries, re-dated to now so the turn's timestamp filter keeps them
  const iso = new Date(t0 + 500).toISOString();
  appendFileSync(tp, turnText.replace(/2026-11-12T10:00:\d\d\.\d{3}Z/g, iso));
  const r2 = run('hook.mjs', hookIn('Stop'));
  assert.equal(r2.status, 0);
  assert.equal(r2.stdout, '');
  const turns = readFileSync(path.join(home, 'sessions', `${sid}.turns.jsonl`), 'utf8')
    .trim()
    .split('\n')
    .map(JSON.parse);
  assert.equal(turns.length, 1);
  assert.ok(close(turns[0].pct, A + B), 'no helper dir here: the main calls only');

  // 1% every 4 min to 60%, reset in 2 h 30 min → amber; then 3 turns of ~1%
  const reset = Math.floor((t0 + 150 * 60_000) / 1000);
  const readings = [];
  for (let i = 0; i <= 20; i++) readings.push({ t: t0 - (80 - 4 * i) * 60_000, pct: 40 + i });
  writeFileSync(
    path.join(home, 'pace.json'),
    JSON.stringify({ resetsAt: reset * 1000, readings, askedAt: null, noted: false }),
  );
  const snap = JSON.parse(readFileSync(fx('statusline-opus-259k.json'), 'utf8'));
  snap.session_id = sid;
  snap.rate_limits.five_hour = { used_percentage: 60, resets_at: reset };
  const one = run('statusline.mjs', snap).stdout;
  // one turn: no per-prompt rate yet, but its spend over its own minutes (at least 5):
  // ~0.11 points in 5 min ≈ 1%/h against a safe 16%/h → 1 bar
  assert.match(one, /^ccrunway · pace ▮▯▯▯ +(\d+|<1)%\/h · /, 'one turn: the time-based rate');

  // 40 points over 150 min: safe 0.27%/min; turns every 2 min at 2% = 1%/min → 4 bars
  const lines = [0, 1, 2].map(
    (i) =>
      `${JSON.stringify({ t: t0 - (5 - 2 * i) * 60_000 + 30_000, start: t0 - (5 - 2 * i) * 60_000, model: 'opus-5-5', pct: 2, helper: 0 })}\n`,
  );
  writeFileSync(path.join(home, 'sessions', `${sid}.turns.jsonl`), lines.join(''));
  const four = run('statusline.mjs', snap).stdout;
  // amber: the drain is this chat; the three lines above have no parts, so no part is named
  assert.match(
    four,
    /^ccrunway · pace ▮▮▮▮ +\d+%\/h · .*⚠ .*\n\u2800{9}· top drain: this chat \d+%\/h\n$/,
  );
});

test('simulate.mjs range green 3: the verdict with 3 pace bars, tagged sim', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-sim-'));
  const env = { ...process.env, CCRUNWAY_HOME: home, NO_COLOR: '1' };
  const node = (args, stdin = '') =>
    spawnSync(process.execPath, args, { input: stdin, env, encoding: 'utf8' });
  const sim = node([path.join(src, 'simulate.mjs'), 'range', 'green', '3']);
  assert.match(sim.stdout, /green with 3 pace bars/);
  const snap = JSON.parse(readFileSync(fx('statusline-opus-259k.json'), 'utf8'));
  snap.rate_limits.five_hour = {
    used_percentage: 20,
    resets_at: Math.floor((Date.now() + 90 * 60_000) / 1000),
  };
  const line = node([path.join(src, 'statusline.mjs')], JSON.stringify(snap)).stdout;
  assert.match(line, /^ccrunway · pace ▮▮▮▯ +\d+%\/h · .*✓ on track · ~\d+% spare at \S+ · sim\n$/);
  node([path.join(src, 'simulate.mjs'), 'range', 'cold', '4']);
  const cold = node([path.join(src, 'statusline.mjs')], JSON.stringify(snap)).stdout;
  assert.doesNotMatch(cold, /▮/, 'no bar in the cold state');
  assert.equal(node([path.join(src, 'simulate.mjs'), 'range', 'green', '5']).status, 1);
});

test('ledger: Stop before the turn reaches the transcript; the next prompt books it', () => {
  // seen live 2026-11-12: Stop ran before Claude Code wrote the reply's entries, so
  // 9 of 11 turns were lost when the next UserPromptSubmit skipped past them
  const sid = 'race-1';
  const { tp } = layout(sid);
  const start = Date.parse('2026-11-12T10:00:00.000Z');
  openTurn(sid, tp, start);
  assert.equal(closeTurn(sid, tp, start + 5000), null, 'nothing written yet');
  appendFileSync(tp, readFileSync(fx('transcript-turn.jsonl'))); // lands after Stop
  openTurn(sid, tp, start + 20_000); // the next prompt
  const turns = readTurns(sid);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].start, start);
  assert.ok(close(turns[0].pct, A + B), `pct ${turns[0].pct} ≠ ${A + B}`);
  // a Stop and a catch-up for the same turn merge into one entry
  appendFileSync(
    path.join(process.env.CCRUNWAY_HOME, 'sessions', `${sid}.turns.jsonl`),
    `${JSON.stringify({ t: start + 21_000, start, model: 'opus-5-5', pct: 0.5, helper: 0 })}\n`,
  );
  assert.equal(readTurns(sid).length, 1);
  assert.ok(close(readTurns(sid)[0].pct, A + B + 0.5));
});
