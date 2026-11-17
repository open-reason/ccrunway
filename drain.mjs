// Top drain (range plan S3): which session spent the most over the window the verdict's
// rate uses (pace.mjs WINDOW_MIN), and on what.
//   top session = the biggest sum of ledger points in the window (a turn's points spread
//                 evenly over its start..end, as in pace.mjs)
//   its part    = its biggest named part (parts.mjs); `other` is never named
//   share       = that part ÷ all points of all sessions in the window. Both are model
//                 points, so pace.mjs's fillScale cancels. With no named part the share
//                 is the session's own.
//   label       = `this chat` for the status line's own session, else the session_name in
//                 sessions/<sid>.json in double quotes, cut to NAME_MAX; `another chat`
//                 without one
// Untracked: the meter is the account's, the ledgers only cover sessions with the hook.
// When the meter rose in the window by OUTSIDE_GAP points or more above what the ledgers
// explain, and they explain under OUTSIDE_SHARE of the rise, the drain is `outside Claude
// Code` (claude.ai, the desktop app, another machine). The ledgers are scaled down to
// meter points when fillScale < 1 (the model reads ~1.3× high) and never up: a scale
// above 1 is itself spend the ledgers do not have. A turn is priced only at its Stop, so
// while any session has a turn open (`busy`) the gap may be that turn: nothing is called
// outside then.
// The menu bar (Codex plan S3) runs the same drain() on Codex calls with CODEX's labels
// (`kind`), and outsideGap() (meter points the ledgers don't explain) for its
// `Outside <tool>` row.

import { P } from './pace.mjs';
import { partsOf } from './parts.mjs';
import { isFable } from './price.mjs';
import { fmtRate } from './range.mjs';
import { readJSON, snapPath } from './state.mjs';

const MIN = 60_000;
export const NAME_MAX = 20;
export const OUTSIDE_SHARE = 0.5;
export const OUTSIDE_GAP = 2; // points; the meter moves in whole percents
const LABELS = {
  helpers: 'helpers',
  answers: 'long answers',
  browser: 'browser',
  images: 'images',
  reads: 'big reads',
  reload: 'chat reload',
  fable: 'Fable',
};
// the part names, and which helper model gets its own label when it is most of `helpers`
export const CLAUDE = { labels: LABELS, tag: isFable, tagLabel: 'Fable helpers' };
export const CODEX = {
  labels: {
    chat: 'long chat',
    helpers: 'helpers',
    answers: 'long answers',
    reads: 'big reads',
    reload: 'chat reload',
  },
  tag: (m) => String(m || '').includes('astra'),
  tagLabel: 'astra helpers',
};

// meter points gained between `from` and `now` (rises only, whole percents)
export function meterRise(readings, from, now) {
  const seen = (readings || []).filter((r) => r.t <= now);
  if (!seen.length) return 0;
  const base = seen.filter((r) => r.t <= from).at(-1) ?? seen[0];
  return Math.max(0, seen.at(-1).pct - base.pct);
}

// turns: every session's ledger entries ({sid, t, start, pct, helper, hmodel, parts});
// readings: pace.json's; scale: pace()'s fillScale. Returns null (nothing spent),
// { outside: true }, or { sid, part, label, share } with part/label null when unnamed.
// busy: () => boolean, asked only when the gap is there (ledger.mjs anyOpenTurn).
// kind: CLAUDE (the status line) or CODEX (the menu bar's Codex section)
export function drain(
  turns,
  readings,
  now = Date.now(),
  scale = 1,
  busy = () => false,
  kind = CLAUDE,
) {
  const { by, total } = sums(turns, now, kind);
  const rise = meterRise(readings, now - P.WINDOW_MIN * MIN, now);
  const explained = Math.min(scale || 1, 1) * total;
  if (rise - explained >= OUTSIDE_GAP && explained < OUTSIDE_SHARE * rise && !busy())
    return { outside: true };
  if (!(total > 0)) return null;
  const [sid, top] = [...by].sort((a, b) => b[1].sum - a[1].sum)[0];
  const named = Object.entries(top.parts)
    .filter(([k, v]) => kind.labels[k] && v > 0)
    .sort((a, b) => b[1] - a[1])[0];
  if (!named) return { sid, part: null, label: null, share: top.sum / total };
  const [part, points] = named;
  const tagged = part === 'helpers' && top.tagged > points / 2;
  return { sid, part, label: tagged ? kind.tagLabel : kind.labels[part], share: points / total };
}

// the window's points per session (sum, parts, tagged helper points) and in all
function sums(turns, now, kind) {
  const from = now - P.WINDOW_MIN * MIN;
  const by = new Map();
  let total = 0;
  for (const x of turns || []) {
    const end = x.t;
    const start = Math.min(x.start ?? end, end);
    if (end <= from || start >= now || !(x.pct > 0)) continue;
    const d = end - start;
    const f = d > 0 ? (Math.min(end, now) - Math.max(start, from)) / d : 1;
    const s = by.get(x.sid) || { sum: 0, parts: {}, tagged: 0 };
    s.sum += x.pct * f;
    total += x.pct * f;
    const parts = partsOf(x);
    for (const k in parts) s.parts[k] = (s.parts[k] || 0) + parts[k] * f;
    if (x.hmodel && kind.tag(x.hmodel)) s.tagged += (parts.helpers || 0) * f;
    by.set(x.sid, s);
  }
  return { by, total };
}

// meter points the ledgers don't explain over the window, as drain() weighs them (for the
// menu bar's `Outside <tool>` row, once drain() has called it outside)
export function outsideGap(turns, readings, now = Date.now(), scale = 1) {
  const { total } = sums(turns, now, CLAUDE);
  const rise = meterRise(readings, now - P.WINDOW_MIN * MIN, now);
  return Math.max(0, rise - Math.min(scale || 1, 1) * total);
}

// `this chat`, `"Ledger.mjs turn flow"`, `another chat`
export function sessionLabel(sid, own) {
  if (sid === own) return 'this chat';
  const name = String(readJSON(snapPath(sid))?.session_name || '').trim();
  if (!name) return 'another chat';
  return `"${name.length > NAME_MAX ? `${name.slice(0, NAME_MAX - 1)}…` : name}"`;
}

// the text after `top drain: `; perHour: the tool's %/h over the window, so the part reads
// as its own %/h (share × perHour), the unit of the menu bar's top drain (one
// unit everywhere); without it, the share
export function drainText(d, own, perHour = null) {
  if (!d) return null;
  if (d.outside) return 'outside Claude Code';
  const pct =
    perHour != null
      ? fmtRate(d.share * perHour) || '<1%/h'
      : `${Math.max(1, Math.round(d.share * 100))}%`;
  return `${sessionLabel(d.sid, own)}${d.label ? `, ${d.label}` : ''} ${pct}`;
}
