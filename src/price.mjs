// Prices a step in 5-hour points (100 points = the whole window, so points read as %).
//   points = (w_out·output + w_write·cache_write) / 1e6 × seat_scale
// Weights: claude-five-weights.json next to this file (measured on one Max seat,
// ±8–11%). Cache reads cost 0.
//
// seat_scale (calibration.json under CCRUNWAY_HOME) starts at 1.0. statusline.mjs calls
// observe() on every refresh: each new API call it sees (a new current_usage) adds its
// unscaled price to `pending`; when rate_limits.five_hour.used_percentage moves up by
// exactly one point, {observed: 1, predicted: pending} becomes a sample and pending
// resets (any other move — a reset, a jump of 2+ — just resets pending). From 5 samples
// on, seat_scale = Σobserved / Σpredicted over the last 50, clamped to 0.2–5.
// Known bias [assumption]: the status line shows only the latest call, so calls that
// land between two refreshes are missed and seat_scale reads high on busy turns.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { home, readJSON, writeJSON } from './state.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const WEIGHTS = [path.join(here, 'claude-five-weights.json')];
// used only if the weights file is missing (same numbers as 2026-11-09/10)
const FALLBACK = {
  'fable-5-1': { w_out: 109.2, w_write: 29.6 },
  'fable-5-2': { w_out: 84.3, w_write: 20.0 },
  'opus-5-5': { w_out: 24.1, w_write: 5.9 },
  'sonnet-5-5': { w_out: 16.9, w_write: 4.1 },
  'haiku-5-5': { w_out: 0, w_write: 1.0 },
};

let cache;
export function weights() {
  if (cache) return cache;
  for (const file of WEIGHTS) {
    try {
      cache = JSON.parse(readFileSync(file, 'utf8')).models;
      if (cache) return cache;
    } catch {}
  }
  cache = FALLBACK;
  return cache;
}

// 'claude-fable-5-1[1m]' → fable-5-1; 'claude-sonnet-5' → sonnet-5-5; 'fable' → fable-5-1.
// Family first, then the nearest version (ties and no version → the lowest); unknown → opus.
export function modelKey(id) {
  const m = weights();
  const s = String(id || '').toLowerCase();
  const fam = ['fable', 'opus', 'sonnet', 'haiku'].find((f) => s.includes(f));
  const keys = Object.keys(m).filter((k) => k.startsWith(`${fam}-`));
  if (!fam || !keys.length) return Object.keys(m).find((k) => k.startsWith('opus-')) || 'opus-5-5';
  const ver = (str) => {
    const v = str.match(/(\d+)(?:[-.](\d+))?/);
    return v ? Number(v[1]) + (v[2] ? Number(v[2]) / 10 : 0) : null;
  };
  const want = ver(s.slice(s.indexOf(fam) + fam.length));
  const sorted = keys.sort((a, b) => ver(a.slice(fam.length)) - ver(b.slice(fam.length)));
  if (want == null) return sorted[0];
  return sorted.reduce((best, k) =>
    Math.abs(ver(k.slice(fam.length)) - want) < Math.abs(ver(best.slice(fam.length)) - want)
      ? k
      : best,
  );
}

export const isFable = (id) => modelKey(id).startsWith('fable-');
export const w = (id) => weights()[modelKey(id)];

const calPath = () => path.join(home(), 'calibration.json');
// Off in S1 (2026-11-11): every open session's status line fed one shared file, and
// their meter readings disagree (7% in one, 8% in another), so each flip counted as
// a point used; 13 fake samples in 30 s pulled the scale to ~0.6. The weights were
// measured on a Max seat, so 1.0 is the default. CCRUNWAY_CALIBRATE=1
// turns it back on; S3 needs one meter reading per seat, rising only.
export const CALIBRATE = process.env.CCRUNWAY_CALIBRATE === '1';
export const seatScale = () => (CALIBRATE ? readJSON(calPath(), {})?.seat_scale || 1 : 1);

export function price({ model, outTokens = 0, writeTokens = 0 }, scale = seatScale()) {
  const { w_out, w_write } = w(model);
  return ((w_out * outTokens + w_write * writeTokens) / 1e6) * scale;
}

// tokens in the chat right now, from a status-line snapshot
export function ctxTokens(snap) {
  const u = snap?.context_window?.current_usage || {};
  return (
    (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0)
  );
}

// what the next send costs if the cache is cold: the whole chat is written again.
// prompt_cache is undocumented, so fall back to the context size.
export function coldResendPoints(snap) {
  const tokens = snap?.prompt_cache?.recache_tokens_if_cold || ctxTokens(snap);
  return price({ model: snap?.model?.id, writeTokens: tokens });
}

// seconds-or-ms epoch → ms
export const ms = (t) =>
  t == null ? null : typeof t === 'number' && t < 1e12 ? t * 1000 : +new Date(t);

export function cacheCold(snap, now = Date.now()) {
  const pc = snap?.prompt_cache;
  if (!pc) return false;
  if (pc.warm === false) return true;
  const exp = ms(pc.expires_at);
  return exp != null && !Number.isNaN(exp) && exp < now;
}

export const fmtK = (n) => `${Math.round((n || 0) / 1000)}k`;
export const fmtPct = (p) => `${p < 10 ? (Math.round(p * 10) / 10).toFixed(1) : Math.round(p)}%`;

// Called from the status line; see the header for the method.
export function observe(snap) {
  const u = snap?.context_window?.current_usage;
  const pct = snap?.rate_limits?.five_hour?.used_percentage;
  if (!u && pct == null) return;
  const cal = readJSON(calPath(), null) || { seat_scale: 1, samples: [], pending: 0 };
  let changed = false;
  if (u) {
    const sig = [
      snap.session_id,
      snap.prompt_id,
      u.output_tokens,
      u.cache_creation_input_tokens,
      u.cache_read_input_tokens,
    ].join(':');
    if (sig !== cal.lastSig) {
      cal.lastSig = sig;
      cal.pending += price(
        {
          model: snap.model?.id,
          outTokens: u.output_tokens || 0,
          writeTokens: u.cache_creation_input_tokens || 0,
        },
        1,
      );
      changed = true;
    }
  }
  if (pct != null && pct !== cal.lastPct) {
    if (cal.lastPct != null && pct - cal.lastPct === 1 && cal.pending > 0) {
      cal.samples.push({ o: 1, p: Math.round(cal.pending * 1000) / 1000, at: Date.now() });
      cal.samples = cal.samples.slice(-50);
      if (cal.samples.length >= 5) {
        const o = cal.samples.reduce((a, s) => a + s.o, 0);
        const p = cal.samples.reduce((a, s) => a + s.p, 0);
        cal.seat_scale = Math.min(5, Math.max(0.2, Math.round((o / p) * 1000) / 1000));
      }
    }
    cal.pending = 0;
    cal.lastPct = pct;
    changed = true;
  }
  if (changed) writeJSON(calPath(), cal);
}
