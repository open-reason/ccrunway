#!/usr/bin/env node
// The verdict on a 5-hour limit for the menu bar: when the meter runs out at the current
// pace, next to when it resets.
//
// Codex gets the Claude status line's own maths, so one mental model covers both tools:
//   readings  = the Codex session files' meter (rate_limits.primary), folded as pace.json
//               keeps Claude's (pace.mjs fold: rises only, per reset window)
//   rate      = pace.mjs pace(): the meter's rises over the last WINDOW_MIN (20) plus the
//               priced calls since the last rise (model fill, scaled by fillScale)
//   run-out   = now + (100 − meter) ÷ rate
//   state     = range.mjs range(): green ≥ AMBER_MIN (15) min after the reset, amber under
//               that, red before it; cold under MIN_SPAN_MIN (5) of readings
// verdictOf() is tool-neutral; menubar/claude-read.mjs runs it on pace.json and the ledgers.
//
// The words, 24-hour local time:
//   pace line, after the rate   red: out 14:30        amber, green: ~3% spare
//   verdict row                 red:   Runs out 14:30, 40 min before the 15:10 reset
//                               amber: Tight: ~3% spare at the 19:15 reset
//                               green: On track: ~15% spare at the 15:10 reset
//                                      (the status line's `✓ on track · ~15% spare at …`)
//                               cold:  checking pace… · resets 15:10
// `node codex-range.mjs` prints the live Codex verdict as JSON.

import { fileURLToPath } from 'node:url';
import { codexSpends, readingsOf } from './codex-pace.mjs';
import { readCodex } from './codex-sessions.mjs';
import { pace } from './pace.mjs';
import { clock24, range, spareAt, span } from './range.mjs';

const MIN = 60_000;

// p: a pace record ({resetsAt, readings}); turns: priced spends {t, start?, pct}.
// → { state, runOutAt, resetsAt, meter, spare } where meter is the last reading's whole %
// (null once the reset has passed) and spare the % left at the reset (green and amber)
export function verdictOf(p, turns, now = Date.now()) {
  const reset = p?.resetsAt ?? null;
  const pc = pace(p, now, turns);
  const r = range(pc, now, reset);
  const live = p?.readings?.length && !(reset != null && now >= reset);
  const meter = live ? Math.round(p.readings.at(-1).pct) : null;
  const spare =
    r.state === 'green' || r.state === 'amber' ? spareAt(r, pc?.cur ?? meter, now) : null;
  return { ...r, meter, spare };
}

// readCodex()'s result → the Codex verdict
export const codexRange = (data, now = Date.now()) =>
  verdictOf(readingsOf(data?.meters), codexSpends(data), now);

// 40 min, 1h 10m (as the status line)
export { span };

// the pace line's short form: `out 14:30` / `~3% spare`; '' when cold
export function verdictShort(v) {
  if (v?.state === 'red') return `out ${clock24(v.runOutAt)}`;
  if (v?.spare != null) return `~${v.spare}% spare`;
  return '';
}

// the verdict row
export function verdictText(v) {
  const reset = v?.resetsAt ? clock24(v.resetsAt) : null;
  if (!v || v.state === 'cold') return `checking pace…${reset ? ` · resets ${reset}` : ''}`;
  if (v.state === 'red')
    return `Runs out ${clock24(v.runOutAt)}, ${span((v.resetsAt - v.runOutAt) / MIN)} before the ${reset} reset`;
  const spare = v.spare != null && reset ? `~${v.spare}% spare at the ${reset} reset` : '';
  if (v.state === 'amber') return spare ? `Tight: ${spare}` : 'Tight';
  return spare ? `On track: ${spare}` : 'On track';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const now = Date.now();
  process.stdout.write(`${JSON.stringify(codexRange(readCodex(now), now), null, 2)}\n`);
}
