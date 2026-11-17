#!/usr/bin/env node
// ccrunway status line. Runs the status line that was there before install
// (install.json prevStatusLine) with the same stdin first and prints its output
// unchanged, then:
//   - writes the session snapshot (sessions/<sid>.json)
//   - feeds pace.json with this session's 5-hour meter reading (every session does)
//   - feeds price.mjs's seat_scale calibration (off unless CCRUNWAY_CALIBRATE=1)
//   - prints one line: this session's pace bar first, then the gauges (model · chat
//     size · 5h used), then the verdict on the 5-hour limit (range.mjs):
//       ccrunway · pace ▮▮▯▯  12%/h · Opus 5.5 · 40k · 5h 1% · checking… · resets 2:35pm   verdict grey
//       ccrunway · pace ▮▮▯▯  18%/h · Opus 5.5 · 120k · 5h 45% · ✓ on track · ~15% spare at 2:35pm green
//       ccrunway · pace ▮▮▮▯  21%/h · Opus 5.5 · 140k · 5h 55% · ⚠ tight · ~3% spare at 2:35pm     amber
//       ccrunway · pace ▮▮▮▮  30%/h · Fable 5.2 · 180k · 5h 62% · ✗ runs out 1:55pm, 40 min early  red
//     colours (colors.mjs): accent = green, warning = amber, danger = red; gauges muted,
//     the chat amber over 150k
//   - the rate under the verdict adds every session's priced turns since the last 1%
//     rise (sessions/*.turns.jsonl, written by hook.mjs on Stop), so the run-out time
//     does not jump at each tick (pace.mjs, model fill)
//   - this session's spend since its last booking (ledger.mjs pendingSpend, read only):
//     its own calls while a turn runs and its background helpers after a Stop, priced and
//     split into parts as the next Stop will book them, join those turns as an open turn
//     on this chat, from the last booking to now, so the rate, the run-out, the pace bar
//     and the top drain see a turn or helper still running; a transcript or helper file
//     written in the last minute counts as a turn open for the `outside Claude Code` rule
//   - the pace bar, right after the label: · pace ▮▮▮▯ 12%/h (range.mjs chatRate: the
//     greater of the per-prompt rate over the last 20 min and the spend over this chat's
//     own active minutes, the open turn included; the menu bar's chat row shows the same
//     number. Bars 1–2 muted, 3 accent, 4 danger, unfilled ▯ muted). The number is the
//     session's rate in % of the 5-hour limit per hour, in the bars' colour, padded to
//     RATE_W so what follows stays in one column. It is always there, also while the
//     verdict is checking; with no rate (nothing spent in 20 min, or no meter) it is
//     · pace ▯▯▯▯   –%/h, muted
//   - amber or red only, a second line with the top drain (drain.mjs), across every
//     session's ledger:
//                · top drain: this chat, browser 7%/h
//                · top drain: "Ledger.mjs turn flow", Fable helpers 12%/h
//                · top drain: outside Claude Code
//     label muted, the rest in the verdict's colour
//   - any colour but grey, for one turn: · big result: Read 50k (muted): the last turn of
//     this session had one tool result over 10k tokens (ledger.json `big`, set at Stop)
//   - a launch pending in this session (launch.mjs) replaces the verdict, amber,
//     with no big result; the pace bar stays:
//       ccrunway · pace ▮▯▯▯   5%/h · Fable 5.2 · 680k · 5h 40% · ⚠ next send costs ≈14% (reloads chat) · would run out 1:50pm
//       ccrunway · pace ▮▮▮▮  30%/h · Opus 5.5 · 400k · 5h 40% · ⚠ model switch costs ≈8% (resends chat) · still on track
//     cold = the prompt cache expired on a chat over 150k (decided here, from this stdin,
//     with simulate.mjs's cold overlay applied); switch = written by hook.mjs on
//     PreModelSwitch. A pending launch counts as amber for the top drain's second line
//   - muted (`ccrunway mute 2h`): only `ccrunway · muted until 3:05pm`; the data keeps updating
//   - CCRUNWAY_DEBUG_SECONDS=1 or `ccrunway debug on`: the reset with seconds and how long ago this session's own
//     rate_limits.five_hour last changed (resets_at moves by fractions of a second on
//     every fresh response), e.g. … ✓ on track · ~15% spare at 2:35:07pm · meter 42s old
// The earlier command gets 4 s; if it fails or times out, only the runway line prints.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { palette } from './colors.mjs';
import { breakdown } from './codex-pace.mjs';
import { drain, drainText } from './drain.mjs';
import {
  anyOpenTurn,
  pendingBusy,
  pendingSpend,
  pendingTurn,
  readAllTurns,
  readLedger,
  readTurns,
} from './ledger.mjs';
import { P, fillScale, observe as observePace, pace as paceNow } from './pace.mjs';
import { CALIBRATE, ctxTokens, fmtK, ms, observe } from './price.mjs';
import { chatRate, clock, fmtRate, range, simRate, spareAt } from './range.mjs';
import {
  applySim,
  home,
  mutedUntil,
  rangeSimPath,
  readConfig,
  readJSON,
  snapPath,
  writeSnapshot,
} from './state.mjs';

let config = {};
try {
  config = readConfig();
} catch {}
const SECONDS = process.env.CCRUNWAY_DEBUG_SECONDS === '1' || config.debug === true;
const C = palette();

const raw = readFileSync(0, 'utf8');

// the status line install found, run as Claude Code would run it (a shell command)
let passthrough = '';
try {
  const prev = readJSON(path.join(home(), 'install.json'))?.prevStatusLine?.command;
  if (prev && typeof prev === 'string')
    passthrough = execFileSync('/bin/sh', ['-c', prev], {
      input: raw,
      encoding: 'utf8',
      timeout: 4000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
} catch {}

const SEP = C.muted(' · ');
const RATE_W = 6; // the pace rate's width: 144%/h
// the label says which tool printed the line under someone else's
const LABEL = C.muted('ccrunway');
// the second line's dot sits under the first. Claude Code trims leading whitespace
// from a status line, so the indent is U+2800 (a blank braille cell), which it keeps
const INDENT = '\u2800'.repeat('ccrunway '.length);
let line = `${LABEL}${bar(null)}${C.muted(' · checking…')}`;
let second = ''; // the top drain, on its own line (scenarios 4 and 8)

// 40 min, 1h 10m
const span = (m) => {
  const n = Math.max(1, Math.round(m));
  return n < 60 ? `${n} min` : `${Math.floor(n / 60)}h${n % 60 ? ` ${n % 60}m` : ''}`;
};

// the gauges, before the verdict: model · chat size · 5h used. Muted; the chat turns
// amber over BIG_CHAT tokens.
const BIG_CHAT = 150_000;
function gauges(live) {
  const out = [];
  const model = live.model?.display_name;
  if (model) out.push(C.muted(model));
  const ctx = ctxTokens(live);
  if (ctx) out.push((ctx > BIG_CHAT ? C.warning : C.muted)(fmtK(ctx)));
  const five = live.rate_limits?.five_hour?.used_percentage;
  if (five != null) out.push(C.muted(`5h ${Math.round(five)}%`));
  return out.length ? `${out.join(SEP)}${SEP}` : '';
}

// the verdict on the 5-hour limit and one labelled number (plan: scenario table); the
// `5h NN%` gauge just before it is its subject. Green and amber show the spare: the
// share of the limit left at the reset at this pace, like an EV's arrival charge.
// meter: the 5-hour % now.
function message(r, meter, now) {
  const reset = r.resetsAt ? clock(r.resetsAt, SECONDS) : null;
  if (r.state === 'cold') return C.muted(`checking…${reset ? ` · resets ${reset}` : ''}`);
  if (r.state === 'red') {
    const early = span((r.resetsAt - r.runOutAt) / 60_000);
    return C.danger(`✗ runs out ${clock(r.runOutAt)}, ${early} early`);
  }
  // the same rate as the run-out time: all of what is left is used by runOutAt
  const at = reset ? ` · ~${spareAt(r, meter, now)}% spare at ${reset}` : '';
  return r.state === 'amber' ? C.warning(`⚠ tight${at}`) : C.accent(`✓ on track${at}`);
}

// · pace ▮▮▮▯  12%/h; n null: · pace ▯▯▯▯   –%/h. The rate is right-aligned in RATE_W
// (144%/h), so the gauges after it do not move as it changes
function bar(n, perHour) {
  if (!n) return `${SEP}${C.muted(`pace ▯▯▯▯ ${'–%/h'.padStart(RATE_W)}`)}`;
  const fill = n >= 4 ? C.danger : n === 3 ? C.accent : C.muted;
  const rest = n < 4 ? C.muted('▯'.repeat(4 - n)) : '';
  const unit = ` ${fill((fmtRate(perHour) || '–%/h').padStart(RATE_W))}`;
  return `${SEP}${C.muted('pace ')}${fill('▮'.repeat(n))}${rest}${unit}`;
}
try {
  const live = JSON.parse(raw);
  const sid = live.session_id;
  // when this session's meter reading last changed, for the debug age
  const meterKey = JSON.stringify(live.rate_limits?.five_hour ?? null);
  const prev = sid ? readJSON(snapPath(sid)) : null;
  const meterAt = prev?._meterKey === meterKey && prev._meterAt ? prev._meterAt : Date.now();
  if (sid) writeSnapshot(sid, { ...live, _meterKey: meterKey, _meterAt: meterAt });
  try {
    if (CALIBRATE) observe(live);
  } catch {}
  const now = Date.now();
  let p = null;
  try {
    p = observePace(live, now);
  } catch {}
  const resetsAt = ms(live.rate_limits?.five_hour?.resets_at) || null;
  let turns = [];
  try {
    turns = readAllTurns(now - 2 * P.KEEP_MIN * 60_000);
  } catch {}
  // this chat's unbooked spend (ledger.mjs pendingSpend): a running turn's own calls and
  // background helpers since the last booking, as an open turn from it to now: pace,
  // run-out and top drain include them
  let pending = null;
  let open = null;
  if (sid) {
    try {
      pending = pendingSpend(sid);
      open = pendingTurn(sid, pending, now);
      if (open) turns.push(open);
    } catch {}
  }
  const pc = paceNow(p, now, turns);
  let r = range(pc, now, resetsAt);
  const meter = pc?.cur ?? live.rate_limits?.five_hour?.used_percentage;
  let bars = null; // { bars, perHour }
  // the bar shows while the verdict is still checking (as in the menu
  // bar): it needs turns and the reset, not 5 min of meter readings
  if (sid) {
    try {
      // the scale as the menu bar takes it, so its chat row reads the same %/h
      bars = chatRate(
        readTurns(sid),
        meter,
        r.resetsAt ?? resetsAt,
        now,
        pc?.fillScale ?? fillScale(p?.readings, turns),
        open,
      );
    } catch {}
  }
  // simulate.mjs range: a fixed margin against the live reset, for the user test
  const sim = readJSON(rangeSimPath());
  const simOn = sim && sim.until > now;
  if (simOn && resetsAt) {
    r = range(
      sim.margin == null ? null : { limitAt: resetsAt + sim.margin * 60_000, resetsAt },
      now,
      resetsAt,
    );
    bars =
      r.state === 'cold' || !sim.bars
        ? null
        : { bars: sim.bars, perHour: simRate(sim.bars, meter, resetsAt, now) };
  }
  // a launch pending in this session; launch.mjs loads here so a broken
  // module cannot take the line down
  let launch = null;
  let verdict = null;
  if (sid) {
    try {
      const L = await import('./launch.mjs');
      launch = L.pendingLaunch(sid, applySim(sid, live, now), now, pc?.fillScale ?? 1);
      if (launch) {
        const after = L.afterLaunch({
          cur: meter,
          runOutAt: r.runOutAt,
          resetsAt: r.resetsAt,
          cost: launch.pct,
          now,
        });
        const reset = r.resetsAt ? clock(r.resetsAt, SECONDS) : null;
        verdict = C.warning(L.launchText(launch, after, (t) => clock(t), reset));
      }
    } catch {
      launch = null;
    }
  }
  line = `${LABEL}${bar(bars?.bars, bars?.perHour)}${SEP}${gauges(live)}${verdict ?? message(r, meter, now)}`;
  // the top drain: the real ledgers, also under a simulated verdict; a launch is amber
  if (r.state === 'amber' || r.state === 'red' || launch) {
    try {
      const text = drainText(
        drain(
          turns,
          p?.readings,
          now,
          pc?.fillScale ?? 1,
          () => anyOpenTurn(now) || pendingBusy([pending], now),
        ),
        sid,
        // every chat's %/h over the window, as the menu bar's pace line
        breakdown(
          turns.map((x) => ({ t: x.t, start: x.start, pct: x.pct, chat: x.sid })),
          meter,
          r.resetsAt ?? resetsAt,
          now,
          pc?.fillScale ?? 1,
        )?.perHour ?? null,
      );
      const tint = r.state === 'red' ? C.danger : C.warning;
      if (text) second = `${INDENT}${C.muted('· top drain: ')}${tint(text)}`;
    } catch {}
  }
  if (r.state !== 'cold' && sid && !launch) {
    try {
      const big = readLedger(sid).big;
      if (big?.tokens) line += `${SEP}${C.muted(`big result: ${big.tool} ${fmtK(big.tokens)}`)}`;
    } catch {}
  }
  if (simOn || launch?.sim) line += C.muted(' · sim');
  if (SECONDS)
    line += `${SEP}${C.muted(`meter ${Math.max(0, Math.round((now - meterAt) / 1000))}s old`)}`;
} catch {}

try {
  const until = mutedUntil();
  if (until) {
    line = `${LABEL}${C.muted(` · muted until ${clock(until)}`)}`;
    second = '';
  }
} catch {}

process.stdout.write(
  `${passthrough ? passthrough.replace(/\n?$/, '\n') : ''}${line}\n${second ? `${second}\n` : ''}`,
);
