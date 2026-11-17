// Claude Code for the menu bar: the same tool-wide pace and per-chat split as Codex
// (codex-pace.mjs breakdown), read from ccrunway's own files under CCRUNWAY_HOME, the
// way statusline.mjs reads them.
//   pace.json                the 5-hour meter's rises (every session's status line feeds it)
//   sessions/*.turns.jsonl   every session's priced turns {t, start, pct, helper, hmodel}
//                            (hook.mjs on Stop); a turn's helper points are inside its pct
//   sessions/<sid>.json      the session's last status-line stdin: session_name, model,
//                            context_window (chat size)
// Needs `ccrunway install`; without pace.json or turns it returns null.
// The verdict is the status line's: pace.json and the ledgers through range.mjs
// (codex-range.mjs verdictOf), so the menu says what the status line says.
// The meter is pace()'s (meter + model fill) and the scale its fillScale, as on the status
// line, so the menu's rate is in the meter's units.
// A chat row has two rates: its 20-min average, breakdown()'s
// spend over its own minutes, so the chats add up to the tool line and its helpers fit
// inside it; and `now`, range.mjs promptRate, its last prompts' cost over the median gap
// between them, the half of the status line's chatRate that warns about a quick run of
// prompts. The tool-wide pace line is breakdown()'s; helpers have the average only.
// The top drain and outside spend are the status line's own: drain.mjs drain() over the
// same ledgers and pace.json with its parts and labels, `busy` = ledger.mjs anyOpenTurn;
// codex-pace.mjs withDrain() adds them to the section. Spend outside Claude Code shows even
// with no chat in the window (claude.ai alone).
// Spend not booked yet (ledger.mjs pendingAll, read only, chats whose ledger moved in the
// last 2 h): a running turn's own calls, which Stop books only when the turn ends, and
// background helpers still running after their chat's Stop, are added as an open turn on
// that chat, as the status line adds its own; a transcript or helper file written in the
// last minute counts as an open turn for the outside rule.

import { breakdown, withDrain } from '../codex-pace.mjs';
import { verdictOf } from '../codex-range.mjs';
import { drain, outsideGap } from '../drain.mjs';
import {
  anyOpenTurn,
  pendingAll,
  pendingBusy,
  pendingTurn,
  readAllTurns,
  withPending,
} from '../ledger.mjs';
import { P, fillScale, pace, readPace } from '../pace.mjs';
import { ctxTokens } from '../price.mjs';
import { promptRate } from '../range.mjs';
import { readJSON, snapPath } from '../state.mjs';

const MIN = 60_000;

// 'opus-5-5' / 'claude-haiku-5-5' → 'Opus' / 'Haiku'
export const familyName = (key) => {
  const fam = ['fable', 'opus', 'sonnet', 'haiku'].find((f) => String(key || '').includes(f));
  return fam ? fam[0].toUpperCase() + fam.slice(1) : 'helper';
};

// a helper's key under its chat: `<name>\t<model>` from the ledger's agents, or the model
// alone for a line without them (before 14 Nov 2026) → { name, model }
const helperKey = (name, model) => `${name ?? ''}\t${model || 'helper'}`;
export const fromHelperKey = (key) => {
  const [name, model] = String(key).includes('\t') ? String(key).split('\t') : ['', key];
  return { name: name || null, model: familyName(model) };
};

// turns → spends for breakdown(): each turn's own points and its helpers' points apart,
// both under the session; helpers keyed by name and model, so two helpers on one model
// get a row each; what the agents do not cover stays under the turn's helper model
export function spendsOf(turns) {
  const out = [];
  for (const x of turns || []) {
    const helper = Math.min(x.helper || 0, x.pct);
    out.push({ t: x.t, start: x.start, pct: x.pct - helper, chat: x.sid });
    if (!(helper > 0)) continue;
    let left = helper;
    for (const a of x.agents || []) {
      const pct = Math.min(a.pct, left);
      if (!(pct > 0)) continue;
      left -= pct;
      out.push({ t: x.t, start: x.start, pct, chat: x.sid, helper: helperKey(a.name, a.model) });
    }
    if (left > 1e-6)
      out.push({
        t: x.t,
        start: x.start,
        pct: left,
        chat: x.sid,
        helper: helperKey(null, x.hmodel),
      });
  }
  return out;
}

// null, or { perHour, bars, meter, resetsAt, fillScale, verdict, chats, drain?, outside? }
// where each chat is { id, name, perHour, nowPerHour, share, model, ctx, lastT, helpers: [{ name,
// model, perHour }] }; name null for a helper the ledger has no name for
export function claudePace(now = Date.now()) {
  const p = readPace();
  let turns = [];
  try {
    turns = readAllTurns(now - 2 * P.KEEP_MIN * MIN);
  } catch {}
  // each recent chat's unbooked spend (running turn, background helpers), as an open turn
  let pending = [];
  try {
    pending = pendingAll(now - 2 * P.KEEP_MIN * MIN);
    for (const x of pending) {
      const open = pendingTurn(x.sid, x, now);
      if (open) turns.push(open);
    }
  } catch {}
  let meter = null;
  let resetsAt = null;
  let k = 1;
  if (p?.readings?.length) {
    const pc = pace(p, now, turns);
    k = pc?.fillScale ?? fillScale(p.readings, turns);
    if (p.resetsAt == null || p.resetsAt > now) {
      meter = pc?.cur ?? p.readings.at(-1).pct;
      resetsAt = p.resetsAt;
    }
  }
  const b = breakdown(spendsOf(turns), meter, resetsAt, now, k);
  const d = drain(turns, p?.readings, now, k, () => anyOpenTurn(now) || pendingBusy(pending, now));
  if (!b && !d?.outside) return null;
  const chats = (b?.chats || []).map((c) => {
    const snap = readJSON(snapPath(c.chat)) || {};
    const mine = turns.filter((x) => x.sid === c.chat);
    const open = mine.find((x) => x.pending) ?? null;
    const prompt = promptRate(
      withPending(
        mine.filter((x) => !x.pending),
        open,
      ),
      now,
      k,
    );
    return {
      id: c.chat,
      name: String(snap.session_name || '').trim() || null,
      perHour: c.perHour,
      nowPerHour: prompt == null ? null : prompt * 60,
      share: c.share,
      model: snap.model?.display_name ?? familyName(mine.at(-1)?.model),
      ctx: ctxTokens(snap) || null,
      lastT: mine.at(-1)?.t ?? null,
      helpers: c.helpers.map((h) => ({ ...fromHelperKey(h.key), perHour: h.perHour })),
    };
  });
  const verdict = p?.readings?.length ? verdictOf(p, turns, now) : null;
  const t = {
    perHour: b?.perHour ?? 0,
    bars: b?.bars ?? null,
    meter,
    resetsAt,
    fillScale: k,
    verdict,
    chats,
  };
  const gap = d?.outside ? outsideGap(turns, p?.readings, now, k) : 0;
  return withDrain(t, d, { gap, total: b?.total ?? 0, k, readings: p?.readings }, now);
}
