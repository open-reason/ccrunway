#!/usr/bin/env node
// The SwiftBar plugin's output (ccrunway.5s.sh runs it every 5 s): Claude Code's and
// Codex's pace in the macOS menu bar.
//
// Title: one image, [Anthropic] ▮▮▮▯ [OpenAI] ▮▮▯▯
//   the vendor marks white, like the other menu bar icons; each tool's bars as in the status line: filled 1–2 muted, 3 accent, 4 red,
//   unfilled ▯ muted. A tool with nothing spent in the last 20 min or no meter yet shows a
//   muted —; a cold verdict (under 5 min of readings) still shows bars. A red verdict adds the run-out
//   time after that tool's bars, red, struck through, 24-hour: ▮▮▮▮ 1̶4̶:̶3̶0̶. Amber adds
//   nothing. Composed from sprites/ tinted with colors.mjs's tokens; @2x,
//   SPRITE_H px high, shown at SPRITE_H / 2 pt. Dark menu bar only.
//
// Dropdown, layout A:
//   **Claude Code**                    bold, the vendor mark as a template image
//   ▮▮▮▮ 48%/h · 5h 62% · out 14:30    the tool's pace, the meter, the verdict's short form
//   ▮▮▮▯ 22%/h · 5h 55% · ~3% spare    (red: the run-out time; amber, green: the spare at the
//                                      reset). SwiftBar rows take one colour, so the bars
//                                      are in the text colour; cold: no verdict short form
//   Runs out 14:30, 40 min before the 15:10 reset     the verdict (codex-range.mjs), in the
//   Tight: ~3% spare at the 19:15 reset               state's colour; cold, muted:
//   On track: ~15% spare at the 15:10 reset           checking pace… · resets 15:10
//   Top drain: my-feature, long chat 9%/h        S3, amber or red only, in the verdict's
//   Top drain: fix-login, helpers 8%/h            colour: the top chat by its name in the
//   Top drain: outside Codex 6%/h                 list below (the status line's `this chat`
//                                                 has no meaning in a menu of all chats),
//                                                 its biggest part, in %/h like every other
//                                                 number in the menu (shares
//                                                 read as a second unit); no part to
//                                                 name: `<chat> NN%/h`
//   CHATS · LAST 20 MIN                caption, small, muted
//   <chat>   14%/h                     by spend; muted with `· idle N min` after IDLE_MIN
//   --<model> · 182k · last turn 1 min ago        submenu; `--<model> priced as <default>`
//                                                 when the model has no Codex weights
//   --resumed cold, cost ≈14%                     S3, Codex: a cold resume in the window
//   └ <task> · sol   5%/h            Codex helpers under their chat, muted, smaller; └└ for
//                                      a helper's helper; the nickname without a task
//   └ telemetry · Opus   4%/h          Claude helpers, a row each by name and model (the
//   └ helpers · Haiku   4%/h           ledger's agents); `helpers` for spend booked before
//                                      the ledger kept names, or a helper with none
//   Outside Codex   5%/h               S3, muted, last: spend the meter shows and no chat
//                                      explains (drain.mjs's rule; codex-pace.mjs withDrain)
//   ---                                between the tools
// simulate.mjs range: a verdict overlay per tool for 2 min (SIM_FILE), tagged `· sim`.
// Format: https://github.com/swiftbar/SwiftBar#plugin-api (image=, templateImage=, md=,
// color=light,dark, size=, `--` submenu, `---` separator). Rows carry refresh=true, so macOS
// draws them enabled instead of greyed out.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { codexPace, codexWeights, shortModel } from '../codex-pace.mjs';
import { codexRange, verdictShort, verdictText } from '../codex-range.mjs';
import { readCodex } from '../codex-sessions.mjs';
import { tokens } from '../colors.mjs';
import { fmtK } from '../price.mjs';
import { barsOf, clock24, fmtRate, range, spareAt } from '../range.mjs';
import { home, readJSON } from '../state.mjs';
import { claudePace } from './claude-read.mjs';
import { readMask, writePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
export const SPRITE_H = 36; // px @2x: 18 pt
const IDLE_MIN = 5;
const NAME_MAX = 32;
// the rate columns: `20-MIN AVG` and `NOW` wide, in a font every Mac has
const AVG_W = 10;
const NOW_W = 5;
const MONO = 'Menlo';

const T = tokens();
// on a dark menu bar. The brand has no on-dark danger token (the status line uses the
// terminal's own red there), so red is the prototype's #ff6b5e, as rendered 2026-11-13
export const COLOURS = {
  vendor: '#ffffff',
  muted: T['or-muted-on-dark'],
  accent: T['or-accent-on-dark'],
  danger: '#ff6b5e',
};
// menu rows: light,dark
const MUTED_ROW = `color=${T['or-ink-muted']},${T['or-muted-on-dark']}`;
// the verdict row by state; amber on dark is the prototype's #e0a640 (no on-dark token)
const VERDICT_ROW = {
  green: `color=${T['or-accent']},${T['or-accent-on-dark']}`,
  amber: `color=${T['or-warning']},#e0a640`,
  red: `color=${T['or-danger']},${COLOURS.danger}`,
  cold: MUTED_ROW,
};
const TIME_GAP = 10; // px between a tool's bars and its run-out time
const ON = 'refresh=true';

const sprites = {};
const sprite = (name) => {
  sprites[name] ||= readMask(readFileSync(path.join(here, 'sprites', `${name}.png`)));
  return sprites[name];
};

const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// bars come from the priced calls and the meter, so they show from the first call; only
// the verdict waits for 5 min of readings (a 3→10% Codex burst in its first 4 min read —
// on 2026-11-13)
const noBars = (t) => !t?.bars;

const redAt = (t) => (t?.bars && t.verdict?.state === 'red' && t.verdict.runOutAt) || null;

// the title's pieces, left to right: [sprite, colour, gap after, struck through]. With both
// tools red only the earlier run-out gets its time: both times (208 pt) hid the item beside
// the notch on 2026-11-13; the other time stays in the dropdown
export function titleParts(claude, codex) {
  const [a, b] = [redAt(claude), redAt(codex)];
  const timed = a && b ? (a <= b ? claude : codex) : a ? claude : b ? codex : null;
  const bars = (t) => {
    if (noBars(t)) return [['dash', COLOURS.muted, 0]];
    const fill = t.bars >= 4 ? COLOURS.danger : t.bars === 3 ? COLOURS.accent : COLOURS.muted;
    const out = [0, 1, 2, 3].map((i) =>
      i < t.bars ? ['full', fill, 0] : ['empty', COLOURS.muted, 0],
    );
    if (t === timed) {
      out.push(['gap', null, TIME_GAP]);
      for (const ch of clock24(t.verdict.runOutAt))
        out.push([ch === ':' ? 'colon' : `d${ch}`, COLOURS.danger, 0, true]);
    }
    return out;
  };
  return [
    ['anthropic', COLOURS.vendor, 8],
    ...bars(claude),
    ['gap', null, 20],
    ['openai', COLOURS.vendor, 8],
    ...bars(codex),
  ];
}

// the title as a PNG, each sprite centred vertically; a run of struck parts gets one
// STRIKE px line through the middle row, in its colour
const STRIKE = 2;
export function titlePng(claude, codex) {
  const parts = titleParts(claude, codex);
  const width = parts.reduce(
    (w, [name, , gap]) => w + (name === 'gap' ? 0 : sprite(name).width) + gap,
    0,
  );
  const rgba = new Uint8Array(width * SPRITE_H * 4);
  let x = 0;
  const strikes = []; // [x0, x1, hex]
  for (const [name, hex, gap, struck] of parts) {
    if (name !== 'gap') {
      const s = sprite(name);
      const [r, g, b] = rgb(hex);
      if (struck) {
        const last = strikes.at(-1);
        if (last && last[1] === x) last[1] = x + s.width;
        else strikes.push([x, x + s.width, hex]);
      }
      const top = Math.round((SPRITE_H - s.height) / 2);
      for (let y = 0; y < s.height; y++)
        for (let i = 0; i < s.width; i++) {
          const a = s.alpha[y * s.width + i];
          if (!a) continue;
          const o = ((top + y) * width + x + i) * 4;
          rgba[o] = r;
          rgba[o + 1] = g;
          rgba[o + 2] = b;
          rgba[o + 3] = Math.max(rgba[o + 3], a);
        }
      x += s.width;
    }
    x += gap;
  }
  for (const [x0, x1, hex] of strikes) {
    const [r, g, b] = rgb(hex);
    for (let y = SPRITE_H / 2 - STRIKE / 2; y < SPRITE_H / 2 + STRIKE / 2; y++)
      for (let i = x0; i < x1; i++) rgba.set([r, g, b, 255], (y * width + i) * 4);
  }
  return { png: writePng(width, SPRITE_H, rgba), width };
}

// a vendor mark as a template image: black, the mark's coverage as alpha
function templatePng(name) {
  const s = sprite(name);
  const rgba = new Uint8Array(s.width * s.height * 4);
  for (let i = 0; i < s.alpha.length; i++) rgba[i * 4 + 3] = s.alpha[i];
  return writePng(s.width, s.height, rgba).toString('base64');
}

// SwiftBar reads `|` as the start of the parameters and leading dashes as submenu depth
const clean = (s) => {
  const t = String(s)
    .replace(/\|/g, '¦')
    .replace(/^-+\s*/, '')
    .trim();
  return t.length > NAME_MAX ? `${t.slice(0, NAME_MAX - 1)}…` : t;
};
// a chat's name; when another chat in the list has the same name, its id's last 4
// characters are added (Codex ids start with a timestamp, so their heads are alike)
const chatName = (c, tool, chats = []) => {
  const name = clean(c.name || `${tool} chat ${String(c.id).slice(0, 8)}`);
  const twin = c.name && chats.some((x) => x.id !== c.id && x.name === c.name);
  return twin ? `${name} · ${String(c.id).slice(-4)}` : name;
};

// `Top drain: <chat>, <part> NN%/h`: the part's share of the tool's 20-min spend times the
// tool's %/h; null on green, cold or with nothing to name
export function drainRow(t, tool) {
  const d = t?.drain;
  if (!d || !['amber', 'red'].includes(t.verdict?.state)) return null;
  const pct = fmtRate(d.share * (t.perHour || 0)) || '<1%/h';
  if (d.outside) return `Top drain: outside ${tool} ${pct}`;
  const c = t.chats.find((x) => x.id === d.chat) || { id: d.chat };
  return `Top drain: ${chatName(c, tool, t.chats)}${d.label ? `, ${d.label}` : ''} ${pct}`;
}
const ago = (t, now) => {
  const m = Math.round((now - t) / MIN);
  return m < 1 ? 'under a min ago' : `${m} min ago`;
};
const barText = (n) => '▮'.repeat(n) + '▯'.repeat(4 - n);

// one tool's section, as lines. t: codexPace() / claudePace() or null
export function section(tool, mark, t, now, helperRow) {
  const out = [
    `**${tool}** | md=true size=14 templateImage=${templatePng(mark)} width=16 height=16 ${ON}`,
  ];
  if (!t) {
    out.push(`— nothing spent in the last 20 min | ${MUTED_ROW} ${ON}`);
    return out;
  }
  out.push(paceLine(t));
  const v = t.verdict;
  if (v) {
    const sim = t.sim ? ' · sim' : '';
    out.push(`${verdictText(v)}${sim} | ${VERDICT_ROW[v.state] || MUTED_ROW} ${ON}`);
    const top = drainRow(t, tool);
    if (top) out.push(`${top} | ${VERDICT_ROW[v.state]} ${ON}`);
  }
  // rate columns in monospace, so the 20-min averages line up and can be added by eye; a
  // NOW column when the chats carry a prompt rate (Claude, claude-read.mjs). Codex logs no
  // prompts, so its section has the average only
  const nowCol = t.chats.some((c) => c.nowPerHour !== undefined);
  const labels = [
    ...t.chats.map((c) => chatName(c, tool, t.chats)),
    ...t.chats.flatMap((c) => c.helpers.map(helperRow)),
    t.outside ? `Outside ${tool}` : '',
  ];
  const w = Math.max(...labels.map((s) => s.length), 'CHATS'.length);
  const row = (label, avg, nowRate = '') =>
    `${label.padEnd(w)}  ${avg.padStart(AVG_W)}${nowCol ? `  ${nowRate.padStart(NOW_W)}` : ''}`.trimEnd();
  const mono = `font=${MONO} `;
  if (t.chats.length || t.outside)
    out.push(`${row('CHATS', '20-MIN AVG', 'NOW')} | ${MUTED_ROW} ${mono}size=12 ${ON}`);
  for (const c of t.chats) {
    const idle = c.lastT && now - c.lastT > IDLE_MIN * MIN;
    const name = chatName(c, tool, t.chats);
    const tail = idle ? ` · idle ${Math.round((now - c.lastT) / MIN)} min` : '';
    out.push(
      `${row(name, fmtRate(c.perHour), fmtRate(c.nowPerHour ?? null))}${tail} | ${idle ? `${MUTED_ROW} ` : ''}${mono}size=12 ${ON}`,
    );
    const info = [
      c.model,
      c.ctx ? fmtK(c.ctx) : null,
      c.lastT ? `last turn ${ago(c.lastT, now)}` : null,
    ];
    out.push(`--${info.filter(Boolean).join(' · ')} | ${ON}`);
    for (const m of c.fallback || [])
      out.push(`--${clean(m)} priced as ${codexWeights().default} | ${MUTED_ROW} ${ON}`);
    if (c.reload) out.push(`--resumed cold, cost ≈${Math.max(1, Math.round(c.reload))}% | ${ON}`);
    for (const h of c.helpers)
      out.push(`${row(helperRow(h), fmtRate(h.perHour))} | ${MUTED_ROW} ${mono}size=12 ${ON}`);
  }
  if (t.outside)
    out.push(`${row(`Outside ${tool}`, fmtRate(t.outside.perHour))} | ${MUTED_ROW} ${mono}${ON}`);
  return out;
}

// ▮▮▮▮ 48%/h · 5h 62% · out 14:30; cold: ▮▮▯▯ 22%/h · 5h 12% (no verdict yet)
export function paceLine(t) {
  const v = t.verdict;
  const meter = v?.meter != null ? `5h ${v.meter}%` : null;
  if (!t.bars) return `— ${fmtRate(t.perHour)} · no meter reading yet | ${MUTED_ROW} ${ON}`;
  const short = v?.state === 'cold' ? null : verdictShort(v);
  const parts = [`${barText(t.bars)} ${fmtRate(t.perHour)}`, meter, short];
  return `${parts.filter(Boolean).join(' · ')} | ${ON}`;
}

// simulate.mjs range: { claude: {state, until}, codex: {state, until} }
export const SIM_FILE = () => path.join(home(), 'menubar-range.sim.json');
// run-out minutes after the reset, as simulate.mjs range for the status line
export const SIM_MARGIN = { cold: null, green: 60, amber: 10, red: -40 };

// a tool's pace with a simulated verdict: the run-out a fixed margin from the live reset
// (or one SIM_RESET_MIN away when the tool has none), the bars and rate from the rate that
// run-out implies, so a red sim reads 4 red bars. A tool with no data gets an empty
// section with a 50% meter. The chats stay the real ones.
const SIM_RESET_MIN = 120;
export function simulated(t, state, now = Date.now()) {
  const resetsAt =
    t?.resetsAt > now ? t.resetsAt : Math.ceil((now + SIM_RESET_MIN * MIN) / MIN) * MIN;
  const meter = t?.verdict?.meter ?? (t?.meter != null ? Math.round(t.meter) : 50);
  const margin = SIM_MARGIN[state];
  const r = range(
    margin == null ? null : { limitAt: resetsAt + margin * MIN, resetsAt },
    now,
    resetsAt,
  );
  const verdict = { ...r, meter, spare: null };
  let bars = t?.bars ?? null;
  let perHour = t?.perHour ?? null;
  if (r.runOutAt) {
    const rate = (100 - meter) / Math.max(1, (r.runOutAt - now) / MIN); // %/min
    perHour = rate * 60;
    bars = barsOf(rate, (100 - meter) / ((resetsAt - now) / MIN));
    if (state !== 'red') verdict.spare = spareAt(r, meter, now);
  } else bars ??= 1;
  return { chats: [], ...t, resetsAt, meter, bars, perHour, verdict, sim: true };
}

// the overlay for one tool, while it lasts
export function simFor(tool, now = Date.now()) {
  const s = readJSON(SIM_FILE())?.[tool];
  return s && s.until > now && s.state in SIM_MARGIN ? s.state : null;
}

// a helper row starts with └, one per level (SwiftBar strips leading spaces, so no indent);
// Codex names it by its task (agent_path), else its nickname
const branch = (depth = 1) => '└'.repeat(Math.max(1, depth));
export const codexHelper = (h) =>
  `${branch(h.depth)} ${clean(h.task || h.nickname || 'unnamed')} · ${shortModel(h.model)}`;
// Claude names it by the name it was started with (ledger.mjs agentName), else `helpers`
export const claudeHelper = (h) => `${branch()} ${clean(h.name || 'helpers')} · ${h.model}`;

// the whole plugin output
export function render(claude, codex, now = Date.now()) {
  const { png, width } = titlePng(claude, codex);
  return [
    `| image=${png.toString('base64')} width=${Math.round(width / 2)} height=${SPRITE_H / 2}`,
    '---',
    ...section('Claude Code', 'anthropic', claude, now, claudeHelper),
    '---',
    ...section('Codex', 'openai', codex, now, codexHelper),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const now = Date.now();
  let claude = null;
  let codex = null;
  try {
    claude = claudePace(now);
  } catch {}
  try {
    const data = readCodex(now);
    codex = codexPace(data, now);
    if (codex) codex.verdict = codexRange(data, now);
  } catch {}
  const simC = simFor('claude', now);
  const simX = simFor('codex', now);
  if (simC) claude = simulated(claude, simC, now);
  if (simX) codex = simulated(codex, simX, now);
  process.stdout.write(`${render(claude, codex, now)}\n`);
}
