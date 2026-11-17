// node --test test/range.test.mjs
// Synthetic meter readings for scenarios 1–3 of the range plan,
// plus the colour edges. pace() takes the record directly, so nothing is written.

import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-range-'));
const { P, pace } = await import('../src/pace.mjs');
const { AMBER_MIN, BAR_EDGES, MIN_TURNS, chatRate, clock, paceBars, range } = await import(
  '../src/range.mjs'
);

const MIN = 60_000;
const RESET = new Date(2026, 10, 12, 14, 35).getTime(); // 2:35pm local

// rises of 1% every `every` minutes from `from`% at `start` up to `to`%
function rises(start, from, to, every) {
  const out = [];
  for (let pct = from, t = start; pct <= to; pct++, t += every * MIN) out.push({ t, pct });
  return out;
}
const record = (readings) => ({ resetsAt: RESET, readings, askedAt: null, noted: false });

test('pace window is 20 min, cold under 5 min of readings', () => {
  assert.equal(P.WINDOW_MIN, 20);
  assert.equal(P.MIN_SPAN_MIN, 5);
});

test('scenario 1: window just started → cold, reset only', () => {
  const now = RESET - 4.5 * 3600_000;
  const p = record(rises(now - 4 * MIN, 1, 3, 2)); // 4 min of readings
  assert.equal(pace(p, now), null);
  const r = range(pace(p, now), now, RESET);
  assert.deepEqual(r, { state: 'cold', runOutAt: null, resetsAt: RESET });
  // no readings at all: still the reset from the status line
  assert.deepEqual(range(null, now, RESET), { state: 'cold', runOutAt: null, resetsAt: RESET });
  // a reset that has passed is a new window with no rate yet
  const old = pace(record(rises(RESET - 30 * MIN, 90, 99, 2)), RESET + MIN);
  assert.equal(range(old, RESET + MIN).state, 'cold');
});

test('scenario 2: coding on pace → run-out = now + (100 − meter) ÷ rate; green or amber', () => {
  // 1% every 2 min for the last 20+ min: 0.5%/min. At 50% with 2 h to reset,
  // the 50 points left last 100 min → 20 min before reset: red
  let now = RESET - 120 * MIN;
  let r = range(pace(record(rises(now - 40 * MIN, 30, 50, 2)), now), now);
  assert.equal(r.state, 'red');
  assert.equal(Math.round((r.runOutAt - now) / MIN), 100);

  // 1% every 3 min at 60% with 2 h to reset: 40 ÷ (1/3) = 120 min. The 20-min
  // window holds 7 rises (the one at −21 min is the base), so the rate is 7/20 and
  // run-out is 40 ÷ 0.35 ≈ 114 min: 6 min before the reset → red
  r = range(pace(record(rises(now - 60 * MIN, 40, 60, 3)), now), now);
  assert.equal(r.state, 'red');

  // a little slower: 1% every 4 min, 60%, 2 h 15 min to reset: 5/20 = 0.25%/min,
  // 40 ÷ 0.25 = 160 min, 25 min past the reset → green
  now = RESET - 135 * MIN;
  r = range(pace(record(rises(now - 80 * MIN, 40, 60, 4)), now), now);
  assert.equal(r.state, 'green');
  assert.equal(Math.round((r.runOutAt - RESET) / MIN), 25);

  // the same pace with 2 h 30 min to reset: run-out 10 min past the reset → amber
  now = RESET - 150 * MIN;
  r = range(pace(record(rises(now - 80 * MIN, 40, 60, 4)), now), now);
  assert.equal(r.state, 'amber');
  assert.equal(Math.round((r.runOutAt - RESET) / MIN), 10);
});

test('scenario 3: idle → the run-out time keeps moving later', () => {
  const last = RESET - 150 * MIN; // the last rise, at 60%
  const p = record(rises(last - 80 * MIN, 40, 60, 4));
  const at = [0, 5, 10, 15].map((m) => range(pace(p, last + m * MIN), last + m * MIN));
  for (let i = 1; i < at.length; i++)
    assert.ok(at[i].runOutAt > at[i - 1].runOutAt, `later at step ${i}`);
  assert.deepEqual(
    at.map((r) => r.state),
    ['amber', 'green', 'green', 'green'],
  );
  // past 20 min with no rise: one point over the minutes since the last rise, so the
  // run-out time is still shown and still moves later
  const idle = [21, 40].map((m) => range(pace(p, last + m * MIN), last + m * MIN));
  assert.ok(idle[0].runOutAt > at.at(-1).runOutAt);
  assert.ok(idle[1].runOutAt > idle[0].runOutAt);
  assert.equal(idle[1].state, 'green');
  // a new window, one reading 30 min ago and no rise yet: under one point in 30 min,
  // so it reads green, not 'checking' (light use after a reset)
  const flat = record([{ t: last - 30 * MIN, pct: 0 }]);
  assert.equal(range(pace(flat, last), last).state, 'green');
});

test('colour edges: exactly 15 min past reset is green, 0 min is amber, before is red', () => {
  const now = RESET - 60 * MIN;
  const at = (limitAt) => range({ limitAt, resetsAt: RESET }, now).state;
  assert.equal(AMBER_MIN, 15);
  assert.equal(at(RESET + 15 * MIN), 'green');
  assert.equal(at(RESET + 15 * MIN - 1), 'amber');
  assert.equal(at(RESET), 'amber');
  assert.equal(at(RESET - 1), 'red');
  assert.equal(at(null), 'cold');
});

test('clock: local 12-hour, optional seconds', () => {
  assert.equal(clock(RESET), '2:35pm');
  assert.equal(clock(RESET + 7000, true), '2:35:07pm');
  assert.equal(clock(new Date(2026, 10, 12, 0, 5).getTime()), '12:05am');
  assert.equal(clock(new Date(2026, 10, 12, 12, 0).getTime()), '12:00pm');
});

// S2: a steady seat, the meter rising 1% every `every` min from 1% at T0, and turns
// every 2 min whose model price runs `bias` × the meter (the model reads ~1.3× on
// this seat). The run-out time sampled every 30 s around the 7 → 8% rise.
function steady({ every, bias, from, to, turns: withTurns = true }) {
  const T0 = RESET - 4 * 3600_000;
  const readings = rises(T0, 1, 12, every);
  const turns = [];
  for (let m = 2; m < 12 * every; m += 2)
    turns.push({ start: T0 + (m - 2) * MIN, t: T0 + m * MIN, pct: (2 * bias) / every });
  const tick = T0 + 7 * every * MIN; // the 7 → 8% rise
  const out = [];
  for (let s = from; s <= to; s += 0.5) {
    const now = tick + s * MIN;
    const seen = record(readings.filter((r) => r.t <= now));
    const done = withTurns ? turns.filter((x) => x.t <= now) : [];
    out.push(pace(seen, now, done).limitAt);
  }
  const jumps = out.slice(1).map((x, i) => Math.abs(x - out[i]) / MIN);
  return Math.max(...jumps);
}

test('model fill: no jump over 10 min in the run-out time when the meter goes 7 → 8%', () => {
  for (const every of [6, 8, 12]) {
    const meterOnly = steady({ every, bias: 1, from: -5, to: 5, turns: false });
    assert.ok(meterOnly > 10, `meter only jumps ${meterOnly.toFixed(1)} min (every ${every})`);
    for (const bias of [1, 1.3, 0.77]) {
      const filled = steady({ every, bias, from: -5, to: 5 });
      assert.ok(filled <= 10, `fill jumps ${filled.toFixed(1)} min (every ${every}, ×${bias})`);
    }
  }
});

test('model fill: capped below the next whole percent, scaled to the meter', async () => {
  const { fillAt, fillScale } = await import('../src/pace.mjs');
  const readings = rises(RESET - 60 * MIN, 1, 5, 10); // 5% at −20 min
  // 3 points of turns since the last rise: the fill stops at 0.99
  const big = [{ start: RESET - 15 * MIN, t: RESET - 5 * MIN, pct: 3 }];
  assert.equal(fillAt(readings, big, RESET, 1), P.FILL_CAP);
  // a turn half done at T counts half
  assert.equal(
    fillAt(readings, [{ start: RESET - 10 * MIN, t: RESET, pct: 0.4 }], RESET - 5 * MIN),
    0.2,
  );
  // turns priced 1.3× what the meter did: the scale is 1/1.3
  const turns = [];
  for (let m = 0; m < 60; m++)
    turns.push({ start: RESET - (60 - m) * MIN, t: RESET - (59 - m) * MIN, pct: 0.13 });
  assert.ok(Math.abs(fillScale(readings, turns) - 1 / 1.3) < 0.01);
  assert.equal(fillScale(readings.slice(0, 3), turns), 1, 'under 3 rises: unscaled');
  // no turns: S1 behaviour, unchanged
  const p = pace(record(readings), RESET - 5 * MIN);
  assert.deepEqual(pace(record(readings), RESET - 5 * MIN, []), p);
  assert.equal(p.fill, 0);
});

test("pace bar: 1–4 bars by this session's %/min against the safe rate; none under 3 turns", () => {
  const now = RESET - 100 * MIN;
  // meter 50, 100 min to reset: safe = 0.5%/min. Turns every 2 min → on pace = 1%/turn
  const turns = (pct, n = 10, gap = 2) =>
    Array.from({ length: n }, (_, i) => ({
      start: now - (n - i) * gap * MIN,
      t: now - (n - i) * gap * MIN + MIN,
      pct,
    }));
  assert.deepEqual(BAR_EDGES, [0.5, 0.9, 1.1]);
  assert.equal(MIN_TURNS, 3);
  assert.equal(paceBars(turns(0.2), 50, RESET, now), 1); // 0.2×
  assert.equal(paceBars(turns(0.49), 50, RESET, now), 1);
  assert.equal(paceBars(turns(0.5), 50, RESET, now), 2); // the 0.5× edge
  assert.equal(paceBars(turns(0.89), 50, RESET, now), 2);
  assert.equal(paceBars(turns(0.9), 50, RESET, now), 3); // on pace: 0.9–1.1×
  assert.equal(paceBars(turns(1.1), 50, RESET, now), 3);
  assert.equal(paceBars(turns(1.11), 50, RESET, now), 4);
  assert.equal(paceBars(turns(3), 50, RESET, now), 4);
  // only the last 10 turns count
  assert.equal(paceBars([...turns(5, 20), ...turns(0.2)], 50, RESET, now), 1);
  // only turns that started in the last 20 min: 2 left is under MIN_TURNS
  assert.equal(paceBars(turns(1, 10, 9), 50, RESET, now), null);
  // under 3 turns, no reset, or the reset passed: no bar
  assert.equal(paceBars(turns(1, 2), 50, RESET, now), null);
  assert.equal(paceBars(turns(1, 3), 50, RESET, now), 3);
  assert.equal(paceBars(turns(1), 50, null, now), null);
  assert.equal(paceBars(turns(1), 50, RESET, RESET + MIN), null);
  // one long break between turns does not slow the session down (median gap)
  const pause = turns(1);
  for (const x of pause.slice(0, 5)) {
    x.start -= 60 * MIN;
    x.t -= 60 * MIN;
  }
  assert.equal(paceBars(pause, 50, RESET, now), 3);
});

test('pace bar: turns are scaled to meter points before the comparison', () => {
  const now = RESET - 100 * MIN; // 50 points left over 100 min: safe 0.5%/min
  const turns = [0, 1, 2].map((i) => ({ start: now - (3 - i) * MIN, t: now, pct: 0.6 }));
  assert.equal(paceBars(turns, 50, RESET, now), 4); // 0.6%/min > 1.1 × 0.5
  assert.equal(paceBars(turns, 50, RESET, now, 0.5), 2); // 0.3%/min: 0.6 × safe
});

test('chat pace: the greater of per prompt (last 20 min, ≥ 3 turns) and spend over its own minutes', () => {
  const now = RESET - 100 * MIN; // meter 50, 100 min to reset: safe 0.5%/min = 30%/h
  const turn = (startMin, endMin, pct) => ({
    start: now - startMin * MIN,
    t: now - endMin * MIN,
    pct,
  });
  const near = (a, b) => Math.abs(a - b) < 1e-9;

  // per prompt wins: 3 quick prompts a minute apart, 1 point each → 1%/min (60%/h); by
  // time it is 3 points over the 6 min since the first → 30%/h
  const quick = [turn(6, 5.5, 1), turn(5, 4.5, 1), turn(4, 3.5, 1)];
  let r = chatRate(quick, 50, RESET, now);
  assert.ok(near(r.perHour, 60), `${r.perHour}`);
  assert.equal(r.bars, 4);

  // by time wins: one long prompt still running (the open turn), 2.5 points in 5 min:
  // no per-prompt rate (1 turn), 30%/h by time → on pace
  const open = { ...turn(5, 0, 2.5), pending: true, inTurn: true };
  r = chatRate([], 50, RESET, now, 1, open);
  assert.ok(near(r.perHour, 30), `${r.perHour}`);
  assert.equal(r.bars, 3);

  // its own minutes, not the window's: 2 points since 8 min ago → 15%/h, not 6
  assert.ok(near(chatRate([turn(8, 1, 2)], 50, RESET, now).perHour, 15));
  // at least MIN_SPAN_MIN: 1 point a minute ago → over 5 min, 12%/h
  assert.ok(near(chatRate([turn(1, 0.5, 1)], 50, RESET, now).perHour, 12));
  // a turn that started before the window counts from the window's start, its points
  // spread over its start..end: half of 4 points in the last 20 min → 6%/h
  assert.ok(near(chatRate([turn(40, 0, 4)], 50, RESET, now).perHour, 6));
  // the meter's scale multiplies both rules
  assert.ok(near(chatRate(quick, 50, RESET, now, 0.5).perHour, 30));

  // per prompt only counts turns that started in the window: three old ones and two new
  // ones give no per-prompt rate, so by time: 2 points over 4 min → floor 5 → 24%/h
  const mixed = [
    turn(30, 29, 5),
    turn(28, 27, 5),
    turn(26, 25, 5),
    turn(4, 3.5, 1),
    turn(3, 2.5, 1),
  ];
  assert.ok(near(chatRate(mixed, 50, RESET, now).perHour, 24));

  // idle over 20 min: no rate
  assert.equal(chatRate([turn(40, 30, 5), turn(35, 25, 5), turn(30, 21, 5)], 50, RESET, now), null);
  // no meter or the reset passed: a rate, no bars
  assert.equal(chatRate(quick, null, RESET, now).bars, null);
  assert.equal(chatRate(quick, 50, RESET, RESET + MIN), null, 'nothing in the window by then');

  // an idle lump after the last Stop (helpers still running): per prompt adds it to the
  // last turn (no new start), by time spreads it from that Stop to now
  const lump = { start: now - 3.5 * MIN, t: now, pct: 3, pending: true, inTurn: false };
  r = chatRate(quick, 50, RESET, now, 1, lump);
  // per prompt: (1 + 1 + 4) ÷ 3 per 1-min gap = 2%/min; by time 6 points over 6 min = 1
  assert.ok(near(r.perHour, 120), `${r.perHour}`);
});
