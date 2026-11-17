// node --test codex-range.test.mjs
// The verdict in the menu bar (codex-range.mjs, menubar/menubar.mjs, menubar/simulate.mjs):
// the bands and the cold rule on a synthetic Codex meter, the words, the title's width with
// 0, 1 and 2 red tools, and the simulation overlay.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-codex-range-'));

const { codexRange, verdictOf, verdictShort, verdictText } = await import('./codex-range.mjs');
const { section, simFor, simulated, titlePng, titleParts, paceLine } = await import(
  './menubar/menubar.mjs'
);

const MIN = 60_000;
const NOW = new Date(2026, 10, 13, 13, 0).getTime(); // 13:00 local
const RESET = NOW + 2 * 60 * MIN; // 15:00

// Codex meter readings as readCodex() returns them: one rise every `every` min for `span` min
// up to `to`%, ending at NOW
function meters(to, every, span) {
  const out = [];
  for (let m = span; m >= 0; m -= every)
    out.push({ t: NOW - m * MIN, pct: to - Math.round(m / every), resetsAt: RESET });
  return out;
}
const data = (m) => ({ calls: [], meters: m, threads: {} });

test('bands: red before the reset, amber under 15 min after, green from 15 min after', () => {
  // 1% every 2 min at 50%: 50 left ÷ 0.5%/min = 100 min → 14:40, 20 min before 15:00
  const red = codexRange(data(meters(50, 2, 20)), NOW);
  assert.equal(red.state, 'red');
  assert.equal(red.meter, 50);
  assert.ok(Math.abs(red.runOutAt - (NOW + 100 * MIN)) < MIN, `${red.runOutAt - NOW}`);
  // 1% every 2.5 min at 50%: 0.4%/min → 125 min, 5 min after the reset
  const amber = codexRange(data(meters(50, 2.5, 20)), NOW);
  assert.equal(amber.state, 'amber');
  assert.ok(amber.spare >= 1 && amber.spare <= 5, `${amber.spare}`);
  // 1% every 4 min: 0.25%/min → 200 min
  const green = codexRange(data(meters(50, 4, 20)), NOW);
  assert.equal(green.state, 'green');
  assert.equal(green.spare, 20); // 50 left − 120 min × 0.25
});

test('cold: under 5 min of readings, no readings, a reset that has passed', () => {
  const four = codexRange(data(meters(50, 1, 4)), NOW);
  assert.equal(four.state, 'cold');
  assert.equal(four.resetsAt, RESET);
  assert.equal(codexRange(data(meters(50, 1, 5)), NOW).state, 'red');
  assert.equal(codexRange(data([]), NOW).state, 'cold');
  const after = codexRange(data(meters(50, 2, 20)), RESET + MIN);
  assert.equal(after.state, 'cold');
  assert.equal(after.meter, null);
  // the tool-neutral form takes a pace record (as claude-read.mjs passes pace.json)
  assert.equal(verdictOf(null, [], NOW).state, 'cold');
});

test('words: the pace line short form and the verdict row, 24-hour', () => {
  const red = { state: 'red', runOutAt: RESET - 40 * MIN, resetsAt: RESET, meter: 62 };
  assert.equal(verdictShort(red), 'out 14:20');
  assert.equal(verdictText(red), 'Runs out 14:20, 40 min before the 15:00 reset');
  assert.equal(
    verdictText({ ...red, runOutAt: RESET - 70 * MIN }),
    'Runs out 13:50, 1h 10m before the 15:00 reset',
  );
  const amber = { state: 'amber', runOutAt: RESET + 5 * MIN, resetsAt: RESET, spare: 3 };
  assert.equal(verdictShort(amber), '~3% spare');
  assert.equal(verdictText(amber), 'Tight: ~3% spare at the 15:00 reset');
  const green = { state: 'green', runOutAt: RESET + 90 * MIN, resetsAt: RESET, spare: 15 };
  assert.equal(verdictText(green), 'On track: ~15% spare at the 15:00 reset');
  assert.equal(
    verdictText({ state: 'cold', runOutAt: null, resetsAt: RESET }),
    'checking pace… · resets 15:00',
  );
  assert.equal(verdictText({ state: 'cold', runOutAt: null, resetsAt: null }), 'checking pace…');
  // the menu rows
  const t = { bars: 4, perHour: 48, chats: [], verdict: { ...red } };
  assert.equal(paceLine(t), '▮▮▮▮ 48%/h · 5h 62% · out 14:20 | refresh=true');
  const rows = section('Codex', 'openai', t, NOW, () => '');
  assert.match(
    rows[2],
    /^Runs out 14:20, 40 min before the 15:00 reset \| color=#[0-9a-f]{6},#ff6b5e /,
  );
  const amberT = { bars: 3, perHour: 22, chats: [], verdict: { ...amber, meter: 55 } };
  assert.equal(paceLine(amberT), '▮▮▮▯ 22%/h · 5h 55% · ~3% spare | refresh=true');
  const coldT = {
    bars: 2,
    perHour: 8,
    chats: [],
    verdict: { state: 'cold', resetsAt: RESET, meter: 12 },
  };
  assert.equal(paceLine(coldT), '▮▮▯▯ 8%/h · 5h 12% | refresh=true');
});

test('title: the run-out time after a red tool only, the earlier one when both are red', () => {
  const red = (h) => ({
    bars: 4,
    verdict: { state: 'red', runOutAt: new Date(2026, 10, 13, h, 30).getTime() },
  });
  const amber = { bars: 3, verdict: { state: 'amber', runOutAt: RESET + 5 * MIN } };
  const cold = { bars: 3, verdict: { state: 'cold' } };
  const names = (a, b) => titleParts(a, b).map(([n]) => n);
  assert.deepEqual(names(amber, amber), names({ bars: 3 }, { bars: 3 }));
  // cold still shows its bars; only no data reads —
  assert.deepEqual(names(cold, null), names({ bars: 3 }, null));
  assert.ok(names(cold, null).filter((n) => n === 'dash').length === 1);
  const struck = (a, b) => titleParts(a, b).filter(([, , , s]) => s).map(([n]) => n);
  assert.deepEqual(struck(red(14), red(18)), ['d1', 'd4', 'colon', 'd3', 'd0']);
  // the earlier run-out wins, after its own bars
  assert.deepEqual(struck(red(18), red(14)), ['d1', 'd4', 'colon', 'd3', 'd0']);
  const order = names(red(18), red(14));
  assert.ok(order.indexOf('colon') > order.indexOf('openai'));
  const w0 = titlePng({ bars: 4 }, { bars: 3 }).width / 2;
  const w1 = titlePng(red(14), { bars: 3 }).width / 2;
  const w2 = titlePng(red(14), red(18)).width / 2;
  assert.equal(w0, 110); // 134 with the old leading mark (36 px + 12 px gap)
  assert.equal(w2, w1); // both red is as wide as one red: one time
  assert.ok(w1 < 180, `${w1} pt`);
});

test('simulation: per tool, 2 min, off; a red sim shows 4 bars and a time', () => {
  const sim = (...a) =>
    execFileSync(process.execPath, [path.join(here, 'menubar', 'simulate.mjs'), ...a], {
      env: process.env,
      encoding: 'utf8',
    });
  sim('range', 'red', 'claude');
  const now = Date.now();
  assert.equal(simFor('claude', now), 'red');
  assert.equal(simFor('codex', now), null);
  assert.equal(simFor('claude', now + 3 * MIN), null); // over after 2 min
  sim('range', 'amber');
  assert.equal(simFor('claude', now), 'amber');
  assert.equal(simFor('codex', now), 'amber');
  sim('range', 'off');
  assert.equal(simFor('codex', now), null);
  assert.throws(() => sim('range', 'purple'));
  // the overlay on a tool with no data: an empty section, the verdict and bars to match
  const r = simulated(null, 'red', NOW);
  assert.equal(r.verdict.state, 'red');
  assert.equal(r.bars, 4);
  assert.equal(r.sim, true);
  assert.ok(titleParts(null, r).some(([, , , struck]) => struck));
  const a = simulated({ bars: 1, perHour: 2, resetsAt: RESET, meter: 40, chats: [] }, 'amber', NOW);
  assert.equal(a.verdict.state, 'amber');
  assert.equal(a.resetsAt, RESET);
  assert.ok(a.verdict.spare >= 1);
  assert.equal(simulated(null, 'cold', NOW).verdict.state, 'cold');
});
