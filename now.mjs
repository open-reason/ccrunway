// `ccrunway now`: where each tool's 5-hour limit stands, for a person (text) or an agent
// (--json). Nothing is recomputed: the numbers are the menu bar's (menubar/claude-read.mjs
// claudePace, codex-pace.mjs codexPace, the verdict from codex-range.mjs verdictOf /
// codexRange, as menubar/menubar.mjs combines them) and the summary is the status line's
// own words (range.mjs verdictWords), so an agent can repeat what the user sees.
//   state     cold | green | amber | red as range.mjs gives them; none = no meter reading
//             for that tool at all (no pace.json readings / no Codex rate_limits)
//   cache     a Claude chat's prompt cache from its status-line snapshot (sessions/<id>.json):
//             warm, and when it expires. next_send_cost_pct whenever it is cold, priced as
//             the status line's cold-launch warning (launch.mjs launchPoints, scaled by
//             fillScale below 1), so an agent can answer "what will my next send cost?" on
//             any chat; next_send_warn is true where the status line warns (over
//             COLD_MIN_TOKENS and from MIN_POINTS), and text shows the cost only then.
//             Codex has no such data: null
//   top_drain drain.mjs's top chat and part in %/h (share × the tool's %/h), as the menu's
//             `Top drain:` row; in --json whatever the verdict, in text on amber and red only
//             (where the status line and the menu show it)
// Reading Codex updates CCRUNWAY_HOME/codex-sessions.json, the offsets cache the menu bar
// keeps too; nothing else is written. CCRUNWAY_NOW (ms or ISO) fixes the clock for tests.

import { codexPace, readingsOf } from './codex-pace.mjs';
import { codexRange, verdictOf } from './codex-range.mjs';
import { readCodex } from './codex-sessions.mjs';
import { palette } from './colors.mjs';
import { COLD_MIN_TOKENS, MIN_POINTS, launchPoints } from './launch.mjs';
import { readAllTurns } from './ledger.mjs';
import { claudePace } from './menubar/claude-read.mjs';
import { P, readPace } from './pace.mjs';
import { cacheCold, ctxTokens, fmtK, ms } from './price.mjs';
import { clock, fmtRate, isoLocal, verdictWords } from './range.mjs';
import { applySim, readJSON, snapPath } from './state.mjs';

const MIN = 60_000;
export const TOOLS = { claude: 'Claude Code', codex: 'Codex' };
// --exit-code: the worst state shown
export const STATE_EXIT = { none: 0, cold: 0, green: 0, amber: 10, red: 11 };

export function clockNow() {
  const v = process.env.CCRUNWAY_NOW;
  if (!v) return Date.now();
  const t = /^\d+$/.test(v) ? Number(v) : Date.parse(v);
  return Number.isFinite(t) ? t : Date.now();
}

const r1 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10);
const r2 = (n) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 100) / 100);

// the tool's pace (claudePace/codexPace shape or null), its verdict, whether a meter exists
function readClaude(now) {
  let t = null;
  try {
    t = claudePace(now);
  } catch {}
  let v = t?.verdict ?? null;
  // nothing spent in 20 min: the menu shows no section, the status line still has a verdict
  if (!t) {
    const p = readPace();
    if (p?.readings?.length) {
      let turns = [];
      try {
        turns = readAllTurns(now - 2 * P.KEEP_MIN * MIN);
      } catch {}
      v = verdictOf(p, turns, now);
    }
  }
  return { t, v };
}

function readCodexTool(now) {
  let data = null;
  try {
    data = readCodex(now);
  } catch {
    return { t: null, v: null };
  }
  let t = null;
  try {
    t = codexPace(data, now);
  } catch {}
  const v = readingsOf(data?.meters)?.readings?.length ? codexRange(data, now) : null;
  return { t, v };
}

// a Claude chat's cache from its snapshot, with simulate.mjs's cold overlay as the status
// line applies it
function claudeCache(id, now, k) {
  const snap = readJSON(snapPath(id));
  if (!snap) return { cache: { warm: null, expires_at: null }, cost: null, warn: false };
  const live = applySim(id, snap, now);
  const pc = live.prompt_cache;
  const cache = {
    warm: pc ? !cacheCold(live, now) : null,
    expires_at: pc?.expires_at != null ? isoLocal(ms(pc.expires_at)) : null,
  };
  if (cache.warm !== false) return { cache, cost: null, warn: false };
  // what Claude Code says it would write again; the context size if it does not say
  const tokens = ctxTokens(live);
  const write = pc?.recache_tokens_if_cold || tokens;
  const pct = launchPoints(live.model?.id, write) * Math.min(1, k > 0 ? k : 1);
  return { cache, cost: r1(pct), warn: tokens > COLD_MIN_TOKENS && pct >= MIN_POINTS };
}

const chatLabel = (c, tool) => c.name || `${tool} chat ${String(c.id).slice(0, 8)}`;

// one tool → the JSON shape of `now`
export function toolReport(tool, { t, v }, now) {
  const name = TOOLS[tool];
  const state = v ? v.state : 'none';
  const resetsAt = v?.resetsAt ?? t?.resetsAt ?? null;
  // the reading as the menu's `5h NN%` and the status line's gauge show it, not pace()'s
  // fill-estimated meter (42.99 would round to a 43 nobody sees)
  const meter = v?.meter ?? null;
  const k = t?.fillScale ?? 1;
  let top = null;
  const d = t?.drain;
  if (d) {
    const c = d.outside ? null : t.chats.find((x) => x.id === d.chat);
    top = {
      chat: d.outside ? null : c ? chatLabel(c, name) : d.chat,
      chat_id: d.outside ? null : d.chat,
      part: d.outside ? `outside ${name}` : (d.label ?? null),
      share: r2(d.share),
      pct_per_hour: r1(d.share * (t.perHour || 0)),
    };
  }
  const chats = (t?.chats || []).map((c) => {
    const claude = tool === 'claude';
    const { cache, cost, warn } = claude
      ? claudeCache(c.id, now, k)
      : { cache: null, cost: null, warn: false };
    return {
      id: c.id,
      name: c.name ?? null,
      model: c.model ?? null,
      context_tokens: c.ctx ?? null,
      pace_pct_per_hour: r1(c.perHour),
      now_pct_per_hour: r1(c.nowPerHour ?? null),
      cache,
      next_send_cost_pct: cost,
      next_send_warn: warn,
      helpers: (c.helpers || []).map((h) => ({
        name: claude ? (h.name ?? null) : (h.task || h.nickname || null),
        model: h.model ?? null,
        pct_per_hour: r1(h.perHour),
      })),
    };
  });
  return {
    state,
    summary: v ? verdictWords(v, v.spare) : `no 5-hour meter seen`,
    meter_pct: r1(meter),
    resets_at: isoLocal(resetsAt),
    run_out_at: isoLocal(v?.runOutAt ?? null),
    minutes_early:
      state === 'red' && v.runOutAt && v.resetsAt ? Math.round((v.resetsAt - v.runOutAt) / MIN) : null,
    spare_pct_at_reset: v?.spare ?? null,
    pace_pct_per_hour: r1(t?.perHour ?? 0),
    top_drain: top,
    outside: Boolean(t?.outside),
    chats,
  };
}

// → { claude?, codex? } for the tools asked for
export function nowReport(now = clockNow(), tools = ['claude', 'codex']) {
  const out = {};
  if (tools.includes('claude')) out.claude = toolReport('claude', readClaude(now), now);
  if (tools.includes('codex')) out.codex = toolReport('codex', readCodexTool(now), now);
  return out;
}

// --chat: id prefix or exact name, case-insensitive; → whether any chat matched
export function filterChats(report, q) {
  const s = String(q).toLowerCase();
  let any = false;
  for (const r of Object.values(report)) {
    r.chats = r.chats.filter(
      (c) => String(c.id).toLowerCase().startsWith(s) || String(c.name ?? '').toLowerCase() === s,
    );
    any ||= r.chats.length > 0;
  }
  return any;
}

export const worstExit = (report) =>
  Math.max(0, ...Object.values(report).map((r) => STATE_EXIT[r.state] ?? 0));

// text: a short block per tool. Colour only on a terminal (and never under NO_COLOR)
export function nowText(report, mutedUntil = 0) {
  const C = palette();
  const plain = (s) => s;
  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const tint = (state) =>
    tty ? ({ red: C.danger, amber: C.warning, green: C.accent }[state] ?? C.muted) : plain;
  const muted = tty ? C.muted : plain;
  const lines = [];
  if (mutedUntil) lines.push(muted(`status line muted until ${clock(mutedUntil)}`));
  for (const [tool, r] of Object.entries(report)) {
    const name = TOOLS[tool];
    if (r.state === 'none') {
      lines.push(`${name}: ${muted('no 5-hour meter seen')}`);
      continue;
    }
    lines.push(`${name}: ${tint(r.state)(r.summary)}`);
    const facts = [
      r.meter_pct != null ? `meter ${Math.round(r.meter_pct)}%` : null,
      `pace ${fmtRate(r.pace_pct_per_hour) || '0%/h'}`,
      r.resets_at ? `resets ${clock(Date.parse(r.resets_at))}` : null,
    ];
    lines.push(`  ${facts.filter(Boolean).join(' · ')}`);
    const d = r.top_drain;
    if (d && (r.state === 'amber' || r.state === 'red')) {
      const who = d.chat ? `${d.chat}${d.part ? `, ${d.part}` : ''}` : d.part;
      lines.push(`  top drain: ${who} ${fmtRate(d.pct_per_hour) || '<1%/h'}`);
    }
    for (const c of r.chats) {
      const parts = [
        chatLabel(c, name),
        c.model,
        c.context_tokens ? fmtK(c.context_tokens) : null,
        fmtRate(c.pace_pct_per_hour) || '0%/h',
      ];
      if (c.cache?.warm === false)
        parts.push(
          c.next_send_warn
            ? `cache cold: next send ≈${Math.max(1, Math.round(c.next_send_cost_pct))}%`
            : 'cache cold',
        );
      lines.push(`  ${parts.filter(Boolean).join(' · ')}`);
    }
    if (r.outside) lines.push(muted(`  spend outside ${name} in the last 20 min`));
  }
  return lines.join('\n');
}
