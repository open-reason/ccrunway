#!/usr/bin/env node
// Codex pace for the menu bar: how fast all Codex chats together spend the Codex 5-hour
// limit, and which chats and helpers spend it.
//
//   points of a call = (cached·w_cached + (input − cached)·w_uncached + output·w_output) / 1e6
//                      weights per model from codex-weights.json; cached input is charged on
//                      Codex (memory: codex-meter-charges-cache-reads). An unknown model is
//                      priced as the file's `default` and the chat says so (`fallback`)
//   scale            = pace.mjs fillScale: meter points per model point between the first and
//                      last 1% rise kept, from 3 rises on (the weights are one-day fits)
//   %/h              = scale × points spent in the last WINDOW_MIN ÷ the minutes covered × 60.
//                      The minutes covered run from the window's first call (at least
//                      MIN_SPAN_MIN), so a chat that started 4 min ago is not divided by 20
//   bars             = %/h against the safe rate, (100 − meter) ÷ hours to reset, with
//                      range.mjs's BAR_EDGES (barsOf): < 0.5 → 1, < 0.9 → 2, ≤ 1.1 → 3, > 1.1 → 4
//   per chat         = the same over that chat's calls, its helpers' calls included (a helper
//                      belongs to the top chat that spawned it), but over the chat's OWN minutes:
//                      from its first call in the window to now, at least MIN_SPAN_MIN
//                      (range.mjs timeRate, rule (b) of a chat's pace), so a chat that joined
//                      5 min ago is not diluted by the tool's 20. Its helpers' rates use the
//                      same minutes. share = its points ÷ the tool's. Codex has no prompts, so
//                      this is a Codex chat's whole rule, and a Claude chat's 20-min average; the
//                      menu adds its per-prompt rate beside it (claude-read.mjs nowPerHour)
//
// breakdown() is the tool-neutral part; menubar/claude-read.mjs feeds it Claude Code's
// ledgers. `node codex-pace.mjs` prints the live result as JSON.
//
// S3, the top drain: each call split into parts (codexParts), model points
//   long chat     the cached input (charged on every step, so it grows with the chat)
//   long answers  the output
//   helpers       a helper's whole call, booked to its top chat (`astra helpers` when astra
//                 calls are most of it, as drain.mjs says `Fable helpers`)
//   chat reload   a cold resume's whole call (codex-sessions.mjs `cold`), its uncached input
//                 at the cached weight (COLD_AT_CACHED)
//   big reads     the uncached input of a call fed a tool result over BIG_READ_MIN tokens,
//                 estimated as chars ÷ CHARS_PER_TOKEN and capped at that call's uncached
//                 input. Off (BIG_READS) for now: see codex-sessions.mjs
//                 for the measured ratio
//   other         the rest of the uncached input; never named
// drain.mjs drain() picks the top chat, its biggest named part and the share, and calls
// spend outside Codex (web or cloud tasks, another Mac) by Claude's rule; no turn open =
// no task_started without its task_complete in any session file (codex-sessions.mjs).
// withDrain() adds both to a tool's pace, for Claude Code's too.
//
// `node codex-pace.mjs --replay <rollout file> [--at <ISO time>] [--sim amber|red]`
// prints the dropdown's Codex section for a recorded chat as if now were --at (default: the
// file's last event); --sim forces a verdict as menubar/simulate.mjs does.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHARS_PER_TOKEN, anyOpen, readCodex, readReplay } from './codex-sessions.mjs';
import { CODEX, drain, outsideGap } from './drain.mjs';
import { P, fillScale, fold, pace, spent } from './pace.mjs';
import { barsOf, timeRate } from './range.mjs';

export const BIG_READS = false;

const MIN = 60_000;
const here = path.dirname(fileURLToPath(import.meta.url));

let table;
export function codexWeights() {
  table ||= JSON.parse(readFileSync(path.join(here, 'codex-weights.json'), 'utf8'));
  return table;
}

// { key, w, known }: the exact id, else the longest known id it starts with, else the default
export function weightOf(model) {
  const t = codexWeights();
  const id = String(model || '').toLowerCase();
  const key =
    (t.models[id] && id) ||
    Object.keys(t.models)
      .filter((k) => id.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
  return key
    ? { key, w: t.models[key], known: true }
    : { key: t.default, w: t.models[t.default], known: false };
}

// A cold resume's uncached input is charged at the model's cached weight, not the uncached
// one. Checked 2026-11-13 on every cold resume in ~/.codex/sessions (n=6, Nov 1–2, all
// gpt-6.1-sol, 124k–435k uncached): the meter rose 0–1 whole points across the cold call
// and the call after it, in all six (two of them just after a reset, from 0). The uncached
// weight priced the cold call alone at 6.5–22.7 points (2.6–10 after the local fillScale);
// the cached weight at 0.48–1.49 (0.2–0.65 scaled), within a point of every rise
export const COLD_AT_CACHED = true;

// the weight of a call's uncached input: the cached one on a cold resume (COLD_AT_CACHED)
const freshWeight = (c, w) => (c.cold && COLD_AT_CACHED ? w.cached : w.uncached);

// one call's points (100 = the whole window), unscaled
export function priceCall(c) {
  const u = c.last_token_usage || {};
  const { w } = weightOf(c.model);
  const cached = u.cached_input_tokens || 0;
  const fresh = Math.max(0, (u.input_tokens || 0) - cached);
  return (cached * w.cached + fresh * freshWeight(c, w) + (u.output_tokens || 0) * w.output) / 1e6;
}

// 'gpt-6.1-sol' → 'sol', 'gpt-6-astra' → 'astra'
export const shortModel = (id) =>
  String(id || '?')
    .split('-')
    .at(-1);

// The tool-wide pace and the per-chat split over the last WINDOW_MIN.
//   spends   [{t, start?, pct, chat, helper?}] model points; helper: a key under the chat
//            (null or absent: the chat's own)
//   meter    % of the limit used now; resetsAt ms; k: fillScale
// Returns null when nothing was spent in the window, else
//   { perHour, bars, total, spanMin, chats: [{chat, perHour, share, spanMin,
//     helpers: [{key, perHour}]}] }
// with chats by share and bars null when the meter or the reset is unknown.
export function breakdown(spends, meter, resetsAt, now = Date.now(), k = 1) {
  const from = now - P.WINDOW_MIN * MIN;
  const tool = timeRate(spends, now, k);
  if (!tool) return null;
  const { points: total, spanMin } = tool;
  const perHour = tool.rate * 60;
  const bars = barsAt(perHour, meter, resetsAt, now);
  const by = new Map();
  for (const x of spends || []) {
    const pts = x.pct > 0 && (x.start ?? x.t) < now ? spent([x], from, now) : 0;
    if (!(pts > 0)) continue;
    const c = by.get(x.chat) || { chat: x.chat, own: [], helpers: new Map() };
    c.own.push(x);
    if (x.helper != null) c.helpers.set(x.helper, (c.helpers.get(x.helper) || 0) + pts);
    by.set(x.chat, c);
  }
  const chats = [...by.values()]
    .map((c) => ({ ...c, ...timeRate(c.own, now, k) }))
    .sort((a, b) => b.points - a.points)
    .map((c) => ({
      chat: c.chat,
      perHour: c.rate * 60,
      share: c.points / total,
      spanMin: c.spanMin,
      helpers: [...c.helpers]
        .sort((a, b) => b[1] - a[1])
        .map(([key, pts]) => ({ key, perHour: ((k * pts) / c.spanMin) * 60 })),
    }));
  return { perHour, bars, total, spanMin, chats };
}

// a tool-wide %/h → bars against the safe rate; null when the meter or the reset is unknown
export function barsAt(perHour, meter, resetsAt, now = Date.now()) {
  const toResetMin = resetsAt == null ? 0 : (resetsAt - now) / MIN;
  return meter != null && toResetMin > 0
    ? barsOf(perHour / 60, Math.max(0, 100 - meter) / toResetMin)
    : null;
}

// A tool's pace (codexPace / claudePace shape, or null) with its top drain and outside spend.
// d: drain()'s result; gap: outsideGap()'s meter points; total: the chats' model points in
// the window (breakdown's total); k: fillScale; readings: the meter's rises.
//   top drain  { chat, label, share } or { outside: true, share }
//   outside    once drain() calls it, the meter is the measure, split as drain.mjs splits it:
//              rise = explained (min(k, 1) × total) + gap, over the minutes the rise covers
//              (WINDOW_MIN, or since the first reading, at least MIN_SPAN_MIN). The tool's %/h
//              is the rise's; each chat keeps its part of the explained points, outside gets
//              the gap: { perHour, share }, and the rows add up to 100%. (Adding the gap to
//              rates scaled by k > 1 would count it twice: k > 1 is the gap itself)
export function withDrain(
  t,
  d,
  { gap = 0, total = 0, k = 1, readings = [] } = {},
  now = Date.now(),
) {
  if (!d) return t;
  if (!d.outside) {
    if (t) t.drain = { chat: d.sid, label: d.label, share: d.share };
    return t;
  }
  const from = now - P.WINDOW_MIN * MIN;
  const first = (readings || []).filter((r) => r.t <= now)[0]?.t ?? now;
  const min = (readings || []).some((r) => r.t <= from)
    ? P.WINDOW_MIN
    : Math.max(P.MIN_SPAN_MIN, (now - first) / MIN);
  const explained = Math.min(k || 1, 1) * total;
  const rise = explained + gap;
  if (!(rise > 0)) return t;
  const r = t || { perHour: 0, bars: null, chats: [] };
  const perHour = (rise / min) * 60;
  for (const c of r.chats) {
    const was = c.perHour;
    c.share = (c.share * explained) / rise;
    c.perHour = c.share * perHour;
    for (const h of c.helpers || []) h.perHour *= was > 0 ? c.perHour / was : 0;
  }
  r.outside = { perHour: (gap / min) * 60, share: gap / rise };
  r.perHour = perHour;
  r.bars = barsAt(perHour, r.meter, r.resetsAt, now) ?? r.bars;
  r.drain = { outside: true, share: gap / rise };
  return r;
}

// one call's points by part (model points, summing to priceCall). helper: the call is a
// helper's; bigReads: book `big reads` (BIG_READS)
export function codexParts(c, helper = false, bigReads = BIG_READS) {
  const u = c.last_token_usage || {};
  const { w } = weightOf(c.model);
  const cached = u.cached_input_tokens || 0;
  const fresh = Math.max(0, (u.input_tokens || 0) - cached);
  const chat = (cached * w.cached) / 1e6;
  const answers = ((u.output_tokens || 0) * w.output) / 1e6;
  const uncached = (fresh * freshWeight(c, w)) / 1e6;
  let parts;
  if (helper) parts = { helpers: chat + answers + uncached };
  else if (c.cold) parts = { reload: chat + answers + uncached };
  else {
    const readTokens = bigReads ? Math.min(fresh, (c.reads || 0) / CHARS_PER_TOKEN) : 0;
    const reads = (readTokens * w.uncached) / 1e6;
    parts = { chat, answers, reads, other: uncached - reads };
  }
  const out = {};
  for (const [k, v] of Object.entries(parts)) if (v > 0) out[k] = v;
  return out;
}

// readCodex()'s calls as drain.mjs turns: {sid: the top chat, t, pct, parts, hmodel}
export function codexTurns(data, bigReads = BIG_READS) {
  const { calls = [], threads = {} } = data || {};
  return calls.map((c) => {
    const sid = threads[c.thread]?.root ?? c.thread;
    const helper = sid !== c.thread;
    const x = { sid, t: c.t, pct: priceCall(c), parts: codexParts(c, helper, bigReads) };
    if (helper) x.hmodel = c.model;
    return x;
  });
}

// the meter readings as pace.mjs keeps them (rises only, per reset window), in memory
export function readingsOf(meters) {
  let p = null;
  for (const m of meters || []) p = fold(p, m.pct, m.resetsAt, m.t).p;
  return p;
}

// readCodex()'s calls, priced, as breakdown()'s spends (and pace()'s turns): a helper's
// calls under the top chat that spawned it
export function codexSpends(data) {
  const { calls = [], threads = {} } = data || {};
  return calls.map((c) => {
    const chat = threads[c.thread]?.root ?? c.thread;
    return { t: c.t, pct: priceCall(c), chat, helper: chat !== c.thread ? c.thread : null };
  });
}

// helpers in tree order: each helper's own helpers right after it, so a helper's helper
// sits under its parent in the menu (└└); a parent outside the window leaves it at the top
function treeOrder(hs) {
  const ids = new Set(hs.map((h) => h.id));
  const out = [];
  const add = (parent) => {
    for (const h of hs)
      if ((ids.has(h.parent) ? h.parent : null) === parent) {
        out.push(h);
        add(h.id);
      }
  };
  add(null);
  return out;
}

// Codex, for the menu bar: readCodex()'s result → null (no calls in the window, or no
// readings at all) or { perHour, bars, meter, resetsAt, fillScale, chats, drain?, outside? }
// where each chat is { id, name, perHour, share, model, ctx, lastT, fallback: [model],
// reload, helpers: [{ id, nickname, task, parent, depth, model, perHour }], in tree order }; reload: the meter points of its
// cold resumes in the window (fillScale × their points), or null
export function codexPace(data, now = Date.now()) {
  const { calls = [], meters = [], threads = {} } = data || {};
  const turns = codexSpends(data);
  const p = readingsOf(meters);
  let meter = null;
  let resetsAt = null;
  let k = 1;
  if (p?.readings?.length) {
    k = fillScale(p.readings, turns);
    if (p.resetsAt == null || p.resetsAt > now) {
      meter = pace(p, now, turns)?.cur ?? p.readings.at(-1).pct;
      resetsAt = p.resetsAt;
    }
  }
  const dt = codexTurns(data);
  const d = drain(dt, p?.readings, now, k, () => anyOpen(threads, now), CODEX);
  const b = breakdown(turns, meter, resetsAt, now, k);
  if (!b && !d?.outside) return null;
  const from = now - P.WINDOW_MIN * MIN;
  const chats = (b?.chats || []).map((c) => {
    const th = threads[c.chat] || {};
    const mine = calls.filter((x) => (threads[x.thread]?.root ?? x.thread) === c.chat);
    const fallback = [...new Set(mine.map((x) => x.model).filter((m) => m && !weightOf(m).known))];
    const cold = mine.filter((x) => x.cold && x.t > from && x.t <= now);
    return {
      id: c.chat,
      name: th.name ?? null,
      perHour: c.perHour,
      share: c.share,
      model: th.model ?? mine.at(-1)?.model ?? null,
      ctx: th.ctx ?? null,
      lastT: Math.max(0, ...mine.map((x) => x.t)) || null,
      fallback,
      reload: cold.length ? k * cold.reduce((a, x) => a + priceCall(x), 0) : null,
      helpers: treeOrder(
        c.helpers.map((h) => ({
          id: h.key,
          nickname: threads[h.key]?.nickname ?? null,
          task: threads[h.key]?.task ?? null,
          parent: threads[h.key]?.parent ?? null,
          depth: threads[h.key]?.depth || 1,
          model: threads[h.key]?.model ?? null,
          perHour: h.perHour,
        })),
      ),
    };
  });
  const t = {
    perHour: b?.perHour ?? 0,
    bars: b?.bars ?? null,
    meter,
    resetsAt,
    fillScale: k,
    chats,
  };
  const gap = d?.outside ? outsideGap(dt, p?.readings, now, k) : 0;
  return withDrain(t, d, { gap, total: b?.total ?? 0, k, readings: p?.readings }, now);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = (name) => {
    const i = args.indexOf(name);
    return i < 0 ? null : (args[i + 1] ?? '');
  };
  const file = opt('--replay');
  if (file == null) {
    const now = Date.now();
    process.stdout.write(`${JSON.stringify(codexPace(readCodex(now), now), null, 2)}\n`);
  } else {
    const at = opt('--at');
    const sim = opt('--sim');
    const when = at ? Date.parse(at) : null;
    if (
      !file ||
      (at != null && !Number.isFinite(when)) ||
      (sim != null && !['amber', 'red', 'green', 'cold'].includes(sim))
    ) {
      process.stderr.write(
        'usage: node codex-pace.mjs --replay <rollout file> [--at <ISO time>] [--sim amber|red]\n',
      );
      process.exit(1);
    }
    // loaded after this module has run (no top-level await): menubar.mjs and codex-range.mjs
    // import this file, and waiting here would wait on itself
    Promise.all([import('./menubar/menubar.mjs'), import('./codex-range.mjs')]).then(
      ([M, { codexRange }]) => {
        const data = readReplay(file, when);
        const { now } = data;
        let t = codexPace(data, now);
        if (t) t.verdict = codexRange(data, now);
        if (sim) t = M.simulated(t, sim, now);
        const rows = M.section('Codex', 'openai', t, now, M.codexHelper).map((l) =>
          l.replace(/(templateImage=)[A-Za-z0-9+/=]+/, '$1…'),
        );
        process.stdout.write(`as of ${new Date(now).toISOString()}\n${rows.join('\n')}\n`);
      },
    );
  }
}
