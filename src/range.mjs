// Range: when the 5-hour meter runs out at the current pace, next to when it resets,
// like an EV's range.
//
// The run-out time is pace.mjs's limitAt: now + (100 − meter) ÷ the rate of meter
// rises over the last WINDOW_MIN. Idle minutes add no rises, so the run-out time
// moves later while nothing happens.
//   cold  = pace() has no rate yet (under MIN_SPAN_MIN of readings), the reset has
//           passed, or no rise in any kept reading (nothing to project)
//   green = runs out ≥ AMBER_MIN after the reset
//   amber = runs out 0–AMBER_MIN after the reset: an estimate, so a thin margin is not safe
//   red   = runs out before the reset

import { withPending } from './ledger.mjs';
import { P, spent } from './pace.mjs';

const MIN = 60_000;
export const AMBER_MIN = 15;

// pc: pace.mjs's pace() result (null while cold); resetsAt in ms, for the cold case
export function range(pc, now = Date.now(), resetsAt = pc?.resetsAt ?? null) {
  const reset = pc?.resetsAt ?? resetsAt;
  // no rate yet, or the window already reset and no reading of the new one has come in
  if (!pc || (reset != null && now >= reset))
    return { state: 'cold', runOutAt: null, resetsAt: reset };
  const runOutAt = pc.limitAt ?? null; // null: the meter has not risen at all
  if (runOutAt == null) return { state: 'cold', runOutAt: null, resetsAt: reset };
  if (reset == null) return { state: 'green', runOutAt, resetsAt: reset };
  const marginMin = (runOutAt - reset) / MIN;
  const state = marginMin < 0 ? 'red' : marginMin < AMBER_MIN ? 'amber' : 'green';
  return { state, runOutAt, resetsAt: reset };
}

// the spare on green and amber: the share of the limit left at the reset at the rate behind
// runOutAt (all of what is left is used by runOutAt), like an EV's arrival charge. Over 10
// rounded to 5, else at least 1. meter: the 5-hour % now
export function spareAt(r, meter, now = Date.now()) {
  const left = Math.max(0, 100 - (meter ?? 0));
  const used = r.runOutAt && r.resetsAt ? (left * (r.resetsAt - now)) / (r.runOutAt - now) : 0;
  const raw = left - used;
  return raw > 10 ? Math.round(raw / 5) * 5 : Math.max(1, Math.round(raw));
}

// local 24-hour clock for the menu bar: 14:30 (a 12-hour time without am/pm is ambiguous
// across a 5-hour window)
export function clock24(t) {
  const d = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// local 12-hour clock: 2:40pm, or 2:35:07pm with seconds
export function clock(t, seconds = false) {
  const d = new Date(t);
  const h = d.getHours();
  const pad = (n) => String(n).padStart(2, '0');
  const s = seconds ? `:${pad(d.getSeconds())}` : '';
  return `${h % 12 || 12}:${pad(d.getMinutes())}${s}${h < 12 ? 'am' : 'pm'}`;
}

// ISO 8601 with the local offset, for `--json`: 2026-11-17T14:30:00+01:00. toISOString()
// gives UTC with a Z, which an agent then has to convert before saying it to the user
export function isoLocal(t) {
  if (t == null || !Number.isFinite(+t)) return null;
  const d = new Date(+t);
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${off < 0 ? '-' : '+'}${pad(off / 60)}:${pad(off % 60)}`;
}

// 40 min, 1h 10m
export const span = (m) => {
  const n = Math.max(1, Math.round(m));
  return n < 60 ? `${n} min` : `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}`;
};

// the status line's verdict words, uncoloured (statusline.mjs colours them by state;
// `ccrunway now` repeats them as its summary, so an agent can say what the user sees).
// r: range()'s result; spare: spareAt()'s, used on green and amber; reset: the reset
// already formatted (the status line adds seconds in debug), or null
export function verdictWords(r, spare, reset = r?.resetsAt ? clock(r.resetsAt) : null) {
  if (!r || r.state === 'cold') return `checking…${reset ? ` · resets ${reset}` : ''}`;
  if (r.state === 'red') return `✗ runs out ${clock(r.runOutAt)}, ${span((r.resetsAt - r.runOutAt) / MIN)} early`;
  const at = reset && spare != null ? ` · ~${spare}% spare at ${reset}` : '';
  return r.state === 'amber' ? `⚠ tight${at}` : `✓ on track${at}`;
}

// Pace of one chat (S2, one rule since 2026-11-13): how hard it is pushing against the
// pace that lands exactly on the reset. 4 bars; the 3rd is on pace. The status line's
// pace bar and the menu bar's Claude chat rows both use chatRate(), so they agree.
//   safe rate     = (100 − meter) ÷ minutes to reset                        %/min
//   chat rate     = the greater of two:                                     %/min
//   (a) per prompt  its average %/turn over its last PACE_TURNS turns that started in the
//                   last WINDOW_MIN, ÷ its minutes per turn; only from MIN_TURNS such turns
//       minutes/turn = the median gap between consecutive turn starts in those turns:
//                   send to next send, so Claude's work and your reading count, but one
//                   long break does not (a mean of the span would)
//   (b) by time     its points in the last WINDOW_MIN (a turn's points spread over its
//                   start..end, pace.mjs spent), the open turn ledger.mjs prices before its
//                   Stop included, ÷ its own active minutes: from its first turn start in
//                   the window (or the window's start) to now, at least MIN_SPAN_MIN.
//                   A long single prompt (a browser task) has no gaps for (a) to measure;
//                   (b) reads it from its first minute
//   ratio < 0.5 → 1, < 0.9 → 2, ≤ 1.1 → 3, > 1.1 → 4 (barsOf)
// Turns are priced in model points; `scale` (pace.mjs fillScale, meter points per model
// point) puts them in the meter's units before comparing with the safe rate.
// No rate with nothing spent in the window (idle over WINDOW_MIN); no bars with no meter
// or no time left to the reset. The %/h shown is the winning rate × 60, unlabelled.
// Codex has no prompts: its chat rows are (b) alone (codex-pace.mjs breakdown).
export const PACE_TURNS = 10;
export const MIN_TURNS = 3;
export const BAR_EDGES = [0.5, 0.9, 1.1];
const MIN_GAP_MIN = 0.1; // a floor so two near-simultaneous turns can't divide by ~0

// (a) alone, as bars: { bars: 1–4, perHour } or null
export const paceBars = (turns, meter, resetsAt, now = Date.now(), scale = 1) =>
  paceRate(turns, meter, resetsAt, now, scale)?.bars ?? null;
export function paceRate(turns, meter, resetsAt, now = Date.now(), scale = 1) {
  const safe = safeRate(meter, resetsAt, now);
  const rate = promptRate(turns, now, scale);
  return rate == null || safe == null ? null : { bars: barsOf(rate, safe), perHour: rate * 60 };
}

// (a) in %/min, or null under MIN_TURNS turns started in the window
export function promptRate(turns, now = Date.now(), scale = 1) {
  const from = now - P.WINDOW_MIN * MIN;
  const last = (turns || []).filter((x) => (x.start ?? x.t) >= from).slice(-PACE_TURNS);
  if (last.length < MIN_TURNS) return null;
  const perTurn = (scale * last.reduce((a, x) => a + x.pct, 0)) / last.length;
  const starts = last.map((x) => x.start ?? x.t);
  const gaps = starts
    .slice(1)
    .map((s, i) => (s - starts[i]) / MIN)
    .sort((a, b) => a - b);
  const mid = gaps.length >> 1;
  const median = gaps.length % 2 ? gaps[mid] : (gaps[mid - 1] + gaps[mid]) / 2;
  return perTurn / Math.max(median, MIN_GAP_MIN);
}

// (b) in %/min over spends ({t, start?, pct}), or null with nothing spent in the window.
// → { rate, points (unscaled), spanMin }. codex-pace.mjs breakdown uses it per chat and,
// over every chat, for the tool-wide pace
export function timeRate(spends, now = Date.now(), scale = 1) {
  const from = now - P.WINDOW_MIN * MIN;
  const live = (spends || []).filter((x) => x.pct > 0 && x.t > from && (x.start ?? x.t) < now);
  const points = spent(live, from, now);
  if (!(points > 0)) return null;
  const first = Math.min(...live.map((x) => Math.max(x.start ?? x.t, from)));
  const spanMin = Math.min(P.WINDOW_MIN, Math.max(P.MIN_SPAN_MIN, (now - first) / MIN));
  return { rate: (scale * points) / spanMin, points, spanMin };
}

// one chat's pace: the greater of (a) and (b). turns: its ledger turns; open: its pending
// turn (ledger.mjs pendingTurn) or null. (a) sees the open turn where the hook will book
// it (withPending), (b) sees it as it is, from the last booking to now.
// → { bars (null with no meter or reset), perHour } or null
export function chatRate(turns, meter, resetsAt, now = Date.now(), scale = 1, open = null) {
  const a = promptRate(withPending(turns || [], open), now, scale);
  const b = timeRate(open ? [...(turns || []), open] : turns, now, scale)?.rate ?? null;
  if (a == null && b == null) return null;
  const rate = Math.max(a ?? 0, b ?? 0);
  const safe = safeRate(meter, resetsAt, now);
  return { bars: safe == null ? null : barsOf(rate, safe), perHour: rate * 60 };
}

// (100 − meter) ÷ minutes to reset, or null (no meter, no reset, or the reset passed)
function safeRate(meter, resetsAt, now) {
  if (meter == null || resetsAt == null) return null;
  const toResetMin = (resetsAt - now) / MIN;
  return toResetMin > 0 ? Math.max(0, 100 - meter) / toResetMin : null;
}

// rate ÷ safe rate (same unit) → 1–4 bars; no safe rate left is 4. Shared with the menu
// bar's tool-wide pace (codex-pace.mjs)
export function barsOf(rate, safe) {
  if (safe <= 0) return 4;
  const ratio = rate / safe;
  return ratio < BAR_EDGES[0] ? 1 : ratio < BAR_EDGES[1] ? 2 : ratio <= BAR_EDGES[2] ? 3 : 4;
}

// simulate.mjs: a rate that fits a bar count, from the live safe rate (%/h)
export const SIM_RATIO = { 1: 0.3, 2: 0.7, 3: 1, 4: 1.5 };
export function simRate(bars, meter, resetsAt, now = Date.now()) {
  const toResetMin = resetsAt == null ? 0 : (resetsAt - now) / MIN;
  if (!SIM_RATIO[bars] || toResetMin <= 0) return null;
  return (Math.max(0, 100 - (meter ?? 0)) / toResetMin) * 60 * SIM_RATIO[bars];
}

// 34%/h; under 1 → <1%/h
export const fmtRate = (perHour) =>
  perHour == null ? '' : perHour < 1 ? '<1%/h' : `${Math.round(perHour)}%/h`;
