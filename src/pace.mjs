// Row 15, pace: how fast the 5-hour meter is climbing, whatever the cause.
//
// One file for the seat (CCRUNWAY_HOME/pace.json), fed by every session's status line.
// The meter comes as whole percents and sessions can disagree (one still shows 7
// while another shows 8), so the file keeps only rises: the first time each higher
// level was seen. A lower reading in the same window is a stale session and is
// ignored; a new resets_at starts a new window.
//
// rate over W minutes = levels gained since (now − W) / minutes, and only once at
// least MIN_SPAN_MIN of readings exist, because one whole-percent step right after
// we start watching would otherwise read as a huge rate.
//   sprint  = ≥ SPRINT_RATE %/min over the last SPRINT_WINDOW_MIN, or the limit
//             is under SPRINT_TO_LIMIT_MIN away at the WINDOW_MIN pace
//   careful = at the WINDOW_MIN pace, the limit comes before the reset
// limitAt (the WINDOW_MIN pace) is the run-out time range.mjs shows.
//
// Model fill (range plan S2): the meter moves in whole percents, so between two
// rises the run-out time slides later and then jumps back at the next rise (by
// 1 ÷ rate minutes: 10 min at 0.1%/min). pace() takes every session's priced turns
// (ledger.mjs) and adds, to the meter at any moment T, the points those turns spent
// since the last rise before T, scaled to the meter (fillScale) and capped at FILL_CAP
// so the estimate never claims the next whole percent. A turn's points are spread
// evenly over its start..end. The fill
// goes on both ends of the rate (now and now − WINDOW_MIN), so a steady pace gives a
// steady rate and a run-out time that holds still between rises.

import path from 'node:path';
import { ms } from './price.mjs';
import { home, readJSON, writeJSON } from './state.mjs';

export const P = {
  SPRINT_RATE: 1, // %/min
  SPRINT_WINDOW_MIN: 5,
  SPRINT_TO_LIMIT_MIN: 30,
  WINDOW_MIN: 20,
  MIN_SPAN_MIN: 5,
  ASK_EVERY: 5, // points between two asks
  KEEP_MIN: 60,
  FILL_CAP: 0.99, // points: the fill stays below the next whole percent
  MIN_FIT_RISES: 3, // rises before the model's points are scaled to the meter's
  FILL_SCALE_MAX: 4, // the scale stays within 1/4–4
  FILL_GRACE_MIN: 5, // how far the rate's window may lag now while a turn runs
};

const MIN = 60_000;
const SETTLE_MS = MIN;
const file = () => path.join(home(), 'pace.json');
export const readPace = () => readJSON(file(), null);
export const writePace = (p) => writeJSON(file(), p);

// fold one status line reading in; returns the (possibly new) pace record
export function observe(snap, now = Date.now()) {
  const fh = snap?.rate_limits?.five_hour;
  const pct = fh?.used_percentage;
  if (pct == null) return readPace();
  const { p, changed } = fold(readPace(), pct, ms(fh.resets_at) || null, now);
  if (changed) writePace(p);
  return p;
}

// one meter reading (pct at `now`, window ending at resetsAt ms) into a pace record, in
// memory: { p, changed }. observe() stores the result; codex-pace.mjs folds the Codex
// session files' readings, oldest first, into a record it never writes.
export function fold(prev, pct, resetsAt, now = Date.now()) {
  let p = prev;
  if (!p || p.resetsAt !== resetsAt) p = { resetsAt, readings: [], askedAt: null, noted: false };
  const last = p.readings.at(-1);
  let changed = !last;
  if (last && pct > last.pct && p.readings.length === 1 && now - last.t < SETTLE_MS) {
    // the first reading can come from a session that has not caught up yet: in the
    // first minute a higher one replaces it instead of counting as a rise
    p.readings[0] = { t: last.t, pct };
    changed = true;
  } else if (!last || pct > last.pct) {
    p.readings.push({ t: now, pct });
    changed = true;
  }
  const keep = now - P.KEEP_MIN * MIN;
  // drop old rises, but keep the one just before the cut as the baseline
  while (p.readings.length > 2 && p.readings[1].t < keep) {
    p.readings.shift();
    changed = true;
  }
  return { p, changed };
}

// points the turns spent between a and b (ms); a turn's points spread evenly over it
export function spent(turns, a, b) {
  let sum = 0;
  for (const x of turns || []) {
    const end = x.t;
    const start = Math.min(x.start ?? end, end);
    if (end <= a || start >= b) continue;
    const d = end - start;
    sum += d > 0 ? (x.pct * (Math.min(end, b) - Math.max(start, a))) / d : x.pct;
  }
  return Math.max(sum, 0);
}

// meter points per model point, measured between the first and the last rise kept
// (the only moments the meter's level is known exactly). 1 until MIN_FIT_RISES rises.
// The model runs ~1.3× the meter on this seat (memory: anthropic-bills-below-list), and
// an unscaled fill reaches the cap early, which brings back the jump it is there to stop.
export function fillScale(readings, turns) {
  const rises = (readings || []).slice(1);
  if (rises.length < P.MIN_FIT_RISES || !turns?.length) return 1;
  const a = rises[0];
  const b = rises.at(-1);
  const model = spent(turns, a.t, b.t);
  if (!(model > 0)) return 1;
  return Math.min(P.FILL_SCALE_MAX, Math.max(1 / P.FILL_SCALE_MAX, (b.pct - a.pct) / model));
}

// the fill at T: scaled points since the last rise at or before T, under FILL_CAP
export function fillAt(readings, turns, T, k = 1) {
  if (!turns?.length || !readings?.length) return 0;
  const rise = readings.filter((r) => r.t <= T).at(-1);
  if (!rise) return 0;
  return Math.min(k * spent(turns, rise.t, T), P.FILL_CAP);
}

function rate(readings, windowMin, now, turns, k) {
  if (!readings?.length) return null;
  const cur = readings.at(-1).pct + fillAt(readings, turns, now, k);
  const from = now - windowMin * MIN;
  const before = readings.filter((r) => r.t <= from).at(-1);
  const base = before ? before.pct + fillAt(readings, turns, from, k) : readings[0].pct;
  const spanMin = (now - (before ? from : readings[0].t)) / MIN;
  if (spanMin < P.MIN_SPAN_MIN) return null;
  return (cur - base) / spanMin;
}

// what the pace says right now: null until there are enough readings.
// turns: every session's ledger lines ({t, start, pct}); [] = meter only
export function pace(p = readPace(), now = Date.now(), turns = []) {
  if (!p?.readings?.length) return null;
  const k = fillScale(p.readings, turns);
  const fill = fillAt(p.readings, turns, now, k);
  const cur = p.readings.at(-1).pct + fill;
  // with turns, the rate is read at the last moment the estimate is complete (the last
  // turn end or rise), not at now: a turn in progress is priced only at its Stop, so a
  // window ending at now would see the rate sag between turn ends and leap at each one.
  // After FILL_GRACE_MIN with nothing new, the window follows now again, so an idle
  // seat's rate falls off smoothly. With no turns it is now (S1, meter only).
  let at = now;
  if (turns?.length) {
    const lastEnd = turns.reduce((m, x) => (x.t <= now && x.t > m ? x.t : m), 0);
    const known = Math.max(lastEnd, p.readings.at(-1).t, now - P.FILL_GRACE_MIN * MIN);
    at = Math.min(now, known);
  }
  const rW = rate(p.readings, P.WINDOW_MIN, at, turns, k);
  const r5 = rate(p.readings, P.SPRINT_WINDOW_MIN, at, turns, k);
  if (rW == null) return null;
  const toLimitMin = rW > 0 ? (100 - cur) / rW : Number.POSITIVE_INFINITY;
  // the run-out time: after WINDOW_MIN with no rise, count the last rise as one point
  // over the minutes since it, so an idle seat's run-out keeps moving later instead of
  // vanishing. A window with no rise yet is under one point since its first reading:
  // the same bound, so light use reads green instead of 'checking' for an hour
  const sinceRiseMin = (now - p.readings.at(-1).t) / MIN;
  const rRun = rW > 0 ? rW : sinceRiseMin > 0 ? 1 / sinceRiseMin : 0;
  const toRunOutMin = rRun > 0 ? (100 - cur) / rRun : Number.POSITIVE_INFINITY;
  const toResetMin = p.resetsAt ? (p.resetsAt - now) / MIN : Number.POSITIVE_INFINITY;
  const sprint = (r5 != null && r5 >= P.SPRINT_RATE) || toLimitMin < P.SPRINT_TO_LIMIT_MIN;
  const careful = !sprint && toLimitMin < toResetMin;
  return {
    cur,
    fill,
    fillScale: k,
    rate: Math.max(rW, r5 ?? 0),
    toLimitMin,
    limitAt: Number.isFinite(toRunOutMin) ? now + toRunOutMin * MIN : null,
    resetsAt: p.resetsAt,
    state: sprint ? 'sprint' : careful ? 'careful' : 'fine',
  };
}
