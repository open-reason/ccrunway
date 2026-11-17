// Turn ledger: what each prompt cost in 5-hour points, one line per turn.
//
//   sessions/<sid>.turns.jsonl   {t, start, model, pct, helper, hmodel, agents, parts}
//                                appended by hook.mjs on Stop; lines from before S3 have
//                                no hmodel / parts and still read (parts.mjs partsOf);
//                                agents [{name, model, pct}] is `helper` by helper, named
//                                from its agent-*.meta.json (lines before 14 Nov 2026: none)
//   sessions/<sid>.ledger.json   {start, offset, sub: {file: offset}, seen: [requestId],
//                                 toolsOff, carry, big, open}   where the next Stop starts reading
//
// A turn's cost comes from the transcript, not the status line: every assistant entry
// after the turn's start, deduped by requestId (one API call is written as several
// entries, one per content block, and output_tokens can grow between them, so the
// largest value per request wins; a resumed chat repeats old entries, which the byte
// offset and the seen list skip). points = price.mjs, seat_scale 1.
//
// Helpers (Agent/Task): their calls are NOT in the parent transcript. A foreground
// helper's tool result carries `usage`, but only for its last call; a background one
// carries nothing. Every call is in <transcript dir>/<sid>/subagents/agent-*.jsonl, so
// Stop reads those too, from the offset where it last stopped, and books the cost to
// the turn that sees it (`helper`). A background helper still running at Stop is
// booked, as far as it got, at the next Stop. Until then pendingSpend() prices what it
// has written since, read only, and the status line and the menu bar add that as an open
// turn on its chat (so it is not idle, and its spend is not called outside Claude Code).
// The same goes for the chat's own calls while a turn runs: they are booked at its Stop,
// and pendingSpend() prices them from the main transcript in the meantime.
//
// Parts: `parts` splits pct by what it was spent on (parts.mjs). The tool results
// come from sessions/<sid>.tools.jsonl (tools.mjs, PostToolUse), read from `toolsOff`;
// tokens that did not fit under this booking's cache writes wait in `carry` for the
// catch-up booking of the same turn. `big` is the turn's one result over 10k tokens
// ({tool, tokens}), set at Stop and replaced at the next Stop: the status line names it
// for one turn.

import {
  appendFileSync,
  closeSync,
  openSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { KINDS, partsOf, split } from './parts.mjs';
import { modelKey, price } from './price.mjs';
import { readJSON, sessionsDir, writeJSON } from './state.mjs';
import { bigResult, parseTools, toolsPath } from './tools.mjs';

const safe = (sid) => String(sid || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
export const turnsPath = (sid) => path.join(sessionsDir(), `${safe(sid)}.turns.jsonl`);
export const ledgerPath = (sid) => path.join(sessionsDir(), `${safe(sid)}.ledger.json`);
export const readLedger = (sid) => readJSON(ledgerPath(sid), null) || { sub: {}, seen: [] };
export const writeLedger = (sid, l) => writeJSON(ledgerPath(sid), l);

const SEEN_KEEP = 300;
const TAIL_BYTES = 32_768; // ~300 turns: more than any window the status line looks at

// bytes [from, end) of a file as text
function readFrom(file, from) {
  let fd;
  try {
    const size = statSync(file).size;
    if (size <= from) return { text: '', end: size };
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    return { text: buf.toString('utf8'), end: size };
  } catch {
    return { text: '', end: from };
  } finally {
    if (fd != null) closeSync(fd);
  }
}

export const fileSize = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

// assistant calls in a chunk of transcript, one per requestId, at or after `since` (ms).
// A torn last line (still being written) is skipped and read again next time.
export function calls(text, since = 0, out = new Map()) {
  for (const line of text.split('\n')) {
    if (!line.includes('"assistant"') || !line.includes('"usage"')) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const u = e?.message?.usage;
    const model = e?.message?.model;
    if (e.type !== 'assistant' || !u || !model || model === '<synthetic>') continue;
    if (since && Date.parse(e.timestamp) < since) continue;
    const id = e.requestId || e.message.id || e.uuid;
    const prev = out.get(id);
    const outTokens = Math.max(prev?.outTokens || 0, u.output_tokens || 0);
    const writeTokens = Math.max(prev?.writeTokens || 0, u.cache_creation_input_tokens || 0);
    const readTokens = Math.max(prev?.readTokens || 0, u.cache_read_input_tokens || 0);
    out.set(id, { model, outTokens, writeTokens, readTokens });
  }
  return out;
}

// the points in a set of calls, the model with the biggest share, and the calls counted
export function cost(callMap, seen = new Set()) {
  let pct = 0;
  const byModel = {};
  const fresh = [];
  for (const [id, c] of callMap) {
    if (seen.has(id)) continue;
    fresh.push(c);
    const p = price(c, 1);
    pct += p;
    const k = modelKey(c.model);
    byModel[k] = (byModel[k] || 0) + p;
  }
  const model = Object.entries(byModel).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { pct, model, n: callMap.size, fresh };
}

// UserPromptSubmit: a turn starts now. Claude Code can run Stop before the turn's last
// entries reach the transcript, so first book whatever came in after the last Stop to
// the previous turn (same start; readTurns merges the lines).
export function openTurn(sid, transcriptPath, now = Date.now()) {
  const l = readLedger(sid);
  if (l.transcript === transcriptPath && l.lastStart != null && l.offset != null)
    book(sid, transcriptPath, l, l.lastStart, now);
  else l.offset = fileSize(transcriptPath);
  // the new turn's tool results start from an empty file
  try {
    if (fileSize(toolsPath(sid)) > 0) writeFileSync(toolsPath(sid), '');
  } catch {}
  l.toolsOff = 0;
  l.carry = null;
  l.open = now; // a turn is running: its cost is in no ledger until Stop
  l.start = now;
  l.transcript = transcriptPath;
  writeLedger(sid, l);
}

// Stop: price everything since the turn opened and append one ledger line.
// Returns the line, or null when nothing new was written yet (or a local command).
export function closeTurn(sid, transcriptPath, now = Date.now()) {
  const l = readLedger(sid);
  // no UserPromptSubmit seen (installed mid-turn): nothing to anchor on, start here
  if (l.start == null || l.transcript !== transcriptPath) {
    l.start = now;
    l.offset = fileSize(transcriptPath);
    l.transcript = transcriptPath;
    writeLedger(sid, l);
    return null;
  }
  const line = book(sid, transcriptPath, l, l.start, now, true);
  l.open = null;
  l.lastStart = l.start;
  l.start = now; // a Stop without a UserPromptSubmit before it still has a start
  writeLedger(sid, l);
  return line;
}

// price the transcript (and helper files) from the ledger's offsets to their ends,
// book it to the turn that started at `start`, and move the offsets on.
// atStop: also note the turn's big result (the catch-up booking leaves it alone)
function book(sid, transcriptPath, l, start, now, atStop = false) {
  l.sub ||= {};
  const r = measure(sid, transcriptPath, l, start);
  l.toolsOff = r.toolsOff;
  if (atStop) l.big = bigResult(r.toolItems);
  l.offset = r.offset;
  Object.assign(l.sub, r.ends);
  const seen = new Set(l.seen || []);
  const { line, fresh, left } = priced(r, seen, start, now);
  for (const id of fresh) seen.add(id);
  l.seen = [...seen].slice(-SEEN_KEEP);
  l.carry = left ? { start, left } : null;
  if (line) appendFileSync(turnsPath(sid), `${JSON.stringify(line)}\n`);
  return line;
}

// a chunk of text up to its last newline: the whole lines (a torn last line waits)
const whole = (text) => text.slice(0, text.lastIndexOf('\n') + 1);

// what a booking to the turn that started at `start` would read, read only: the tool
// results since `toolsOff` (plus what the last booking of the same turn left over), the
// main transcript's calls after `offset`, the helpers' after `sub`, and where each read
// ends. book() passes no `opt` and moves the offsets on; pendingSpend() passes
// { after, maxUnread } (readHelpers) and the main transcript is held to the same two
// limits: not opened when last written before `after`, skipped (named in `skipped`) with
// more than maxUnread unread bytes.
//   → { mainCalls, helperCalls, tools, toolItems, toolsOff, offset, ends, lastWrite, skipped }
function measure(sid, transcriptPath, l, start, opt = {}) {
  const tools = {};
  if (l.carry?.start === start) for (const k of KINDS) tools[k] = l.carry.left?.[k] || 0;
  let toolsFrom = l.toolsOff || 0;
  if (fileSize(toolsPath(sid)) < toolsFrom) toolsFrom = 0;
  const toolText = whole(readFrom(toolsPath(sid), toolsFrom).text);
  const toolItems = parseTools(toolText);
  for (const r of toolItems)
    if (KINDS.includes(r.kind)) tools[r.kind] = (tools[r.kind] || 0) + r.tokens;

  const since = start - 2000;
  let st = null;
  try {
    st = statSync(transcriptPath);
  } catch {}
  const size = st?.size ?? 0;
  let from = l.offset || 0;
  if (size < from) from = 0; // rewritten: the timestamp filter guards
  let mainCalls = new Map();
  let offset = from;
  let lastWrite = 0;
  const skipped = [];
  const limited = opt.after != null || opt.maxUnread != null;
  const open = !limited || (st && st.mtimeMs >= (opt.after ?? 0));
  if (limited && open) lastWrite = st.mtimeMs;
  if (open && size > from) {
    if (opt.maxUnread != null && size - from > opt.maxUnread)
      skipped.push(path.basename(transcriptPath));
    else {
      const main = whole(readFrom(transcriptPath, from).text);
      mainCalls = calls(main, since);
      offset = from + Buffer.byteLength(main);
    }
  }

  const h = readHelpers(transcriptPath, l.sub || {}, since, opt);
  return {
    mainCalls,
    helperCalls: h.helperCalls,
    helperFiles: h.helperFiles,
    agentNames: h.agentNames,
    tools,
    toolItems,
    toolsOff: toolsFrom + Buffer.byteLength(toolText),
    offset,
    ends: h.ends,
    lastWrite: Math.max(lastWrite, h.lastWrite),
    skipped: [...skipped, ...h.skipped],
  };
}

// a measure() priced as a ledger line for the turn that started at `start`: the calls not
// in `seen`, the main ones split into parts (parts.mjs) and the helpers' as `helpers`.
//   → { line (null when no call is new), fresh: [requestId], left: tool tokens to carry }
function priced(r, seen, start, now) {
  const m = cost(r.mainCalls, seen);
  const h = cost(r.helperCalls, seen);
  const fresh = [...r.mainCalls.keys(), ...r.helperCalls.keys()].filter((id) => !seen.has(id));
  if (!fresh.length) {
    const left = Object.values(r.tools).some((n) => n > 0) ? r.tools : null;
    return { line: null, fresh, left };
  }
  const pct = Math.round((m.pct + h.pct) * 1e4) / 1e4;
  const helper = Math.round(h.pct * 1e4) / 1e4;
  const line = { t: now, start, model: m.model || h.model, pct, helper };
  const agents = agentsOf(r.helperFiles, r.agentNames, seen);
  if (agents.length) line.agents = agents;
  let left = null;
  try {
    const s = split(m.fresh, m.model, helper, r.tools);
    if (h.model && helper > 0) line.hmodel = h.model;
    line.parts = s.parts;
    left = s.left;
  } catch {}
  return { line, fresh, left };
}

// helpers: <transcript without .jsonl>/subagents/agent-*.jsonl
export const subagentsDir = (transcriptPath) =>
  path.join(String(transcriptPath).replace(/\.jsonl$/, ''), 'subagents');

// a helper's name, from the agent-*.meta.json Claude Code writes beside its transcript:
// the name it was started with, else its description, else its agent type; null without
// the file (Claude Code before it wrote one)
export function agentName(subDir, file) {
  const m = readJSON(path.join(subDir, file.replace(/\.jsonl$/, '.meta.json')), null);
  const name = [m?.name, m?.description, m?.agentType].find(
    (v) => typeof v === 'string' && v.trim(),
  );
  return name ? name.trim() : null;
}

// the turn's helper points by helper: [{ name, model, pct }], one per name and model, the
// biggest first. A helper with no name gets name null, so they still sum to `helper`.
function agentsOf(helperFiles, names, seen) {
  const by = new Map();
  for (const [file, callMap] of helperFiles || []) {
    const c = cost(callMap, seen);
    if (!(c.pct > 0)) continue;
    const name = names?.[file] ?? null;
    const k = `${name}\t${c.model}`;
    const a = by.get(k) || { name, model: c.model, pct: 0 };
    a.pct += c.pct;
    by.set(k, a);
  }
  return [...by.values()]
    .map((a) => ({ ...a, pct: Math.round(a.pct * 1e4) / 1e4 }))
    .filter((a) => a.pct > 0)
    .sort((a, b) => b.pct - a.pct);
}

// two lists of agents as one, the same name and model summed (a turn booked in two parts,
// or a pending turn added to the last one)
export function mergeAgents(a = [], b = []) {
  const by = new Map();
  for (const x of [...a, ...b]) {
    const k = `${x.name}\t${x.model}`;
    const prev = by.get(k);
    by.set(k, prev ? { ...prev, pct: prev.pct + x.pct } : { ...x });
  }
  return [...by.values()].sort((p, q) => q.pct - p.pct);
}

// the helper calls written after the offsets in `sub` ({file: offset}), and where each
// file's whole lines end: { helperCalls, ends, lastWrite, skipped }. A file never seen
// before is read whole, but only calls at or after `since` count. Stop passes no `opt`;
// pendingSpend() passes { after, maxUnread }: files last written before `after` (ms)
// are not opened, and a file with more than maxUnread unread bytes is skipped (named in
// `skipped`) so one runaway helper cannot slow the status line.
function readHelpers(transcriptPath, sub, since, opt = {}) {
  const subDir = subagentsDir(transcriptPath);
  const helperCalls = new Map();
  const helperFiles = new Map();
  const agentNames = {};
  const ends = {};
  const skipped = [];
  let lastWrite = 0;
  let names = [];
  try {
    names = readdirSync(subDir).filter((f) => f.endsWith('.jsonl'));
  } catch {}
  for (const name of names) {
    const f = path.join(subDir, name);
    const off = sub[name] ?? 0;
    if (opt.after != null || opt.maxUnread != null) {
      let st;
      try {
        st = statSync(f);
      } catch {
        continue;
      }
      if (st.mtimeMs < (opt.after ?? 0)) continue;
      lastWrite = Math.max(lastWrite, st.mtimeMs);
      if (st.size <= off) continue;
      if (opt.maxUnread != null && st.size - off > opt.maxUnread) {
        skipped.push(name);
        continue;
      }
    }
    const chunk = readFrom(f, off);
    if (!chunk.text) continue;
    const mine = calls(chunk.text, sub[name] == null ? since : 0);
    for (const [id, c] of mine) helperCalls.set(id, c);
    if (mine.size) {
      helperFiles.set(name, mine);
      agentNames[name] = agentName(subDir, name);
    }
    ends[name] = off + Buffer.byteLength(chunk.text.slice(0, chunk.text.lastIndexOf('\n') + 1));
  }
  return { helperCalls, helperFiles, agentNames, ends, lastWrite, skipped };
}

// Pending spend: what a chat has spent since its last booking, before the next Stop (or
// the catch-up at the next prompt) books it: its own calls while a turn runs (the main
// transcript is booked only at Stop) and a background helper's after it. Read only:
// book()'s own measure() and priced() over the same files, offsets, seen list, tool
// results and carry, and nothing is written, so it cannot race the hook; once the hook
// books these calls it moves the offsets and this drops back to what is still unbooked.
// The transcript path is the one the hook stored in the ledger (`transcript`).
//   anchor = the ledger's `start`: the last Stop's time when idle, the prompt's while a
//            turn is open. Files not written since anchor − 2 s are not opened.
//   since  = the turn the next booking books to, which also filters a never-seen file:
//            the open turn's start, or, idle, the last turn's start (the catch-up)
// → null (no ledger, or no file written since the anchor), or
//   { pct, model, helper, hmodel, parts, lastWrite, start, open, skipped }
// with parts as the booking would split them (parts.mjs). pct 0 with a recent lastWrite
// is a turn or helper that is running but has no priced call yet.
export const PENDING_MAX_UNREAD = 4 * 1024 * 1024; // bytes per file per read
export function pendingSpend(sid, maxUnread = PENDING_MAX_UNREAD) {
  const l = readJSON(ledgerPath(sid), null);
  if (!l?.transcript || l.start == null) return null;
  const open = l.open != null;
  const start = open ? l.start : (l.lastStart ?? l.start);
  const r = measure(sid, l.transcript, l, start, { after: l.start - 2000, maxUnread });
  if (!r.lastWrite) return null;
  const { line } = priced(r, new Set(l.seen || []), start, Date.now());
  return {
    pct: line?.pct ?? 0,
    model: line?.model ?? null,
    helper: line?.helper ?? 0,
    hmodel: line?.hmodel ?? null,
    agents: line?.agents ?? [],
    parts: line?.parts ?? {},
    lastWrite: r.lastWrite,
    start: l.start,
    open,
    skipped: r.skipped,
  };
}

// pendingSpend() as a ledger line ({sid, t, start, pct, helper, hmodel, parts}), the open
// turn the readers add for that chat; null with nothing priced yet. t: now while a prompt
// runs; idle, when its files were last written. Most Stops run before the turn's last
// entry is written, so nearly every idle chat has a small unbooked tail: ending it at now
// would make the chat look active and spread the tail into the window.
export function pendingTurn(sid, p, now = Date.now()) {
  if (!(p?.pct > 0)) return null;
  const start = Math.min(p.start, now);
  return {
    sid,
    t: p.open || !p.lastWrite ? now : Math.max(start, Math.min(now, p.lastWrite)),
    start,
    model: p.model,
    pct: p.pct,
    helper: p.helper || 0,
    hmodel: p.hmodel ?? null,
    agents: p.agents || [],
    parts: p.parts || {},
    pending: true,
    inTurn: !!p.open, // a prompt is running: its Stop books this as that turn
  };
}

// one session's turns for the per-turn pace bar (range.mjs paceRate), with the pending
// turn where the hook will book it: while a prompt runs, the Stop makes it that turn's;
// idle, the catch-up at the next prompt adds it to the last turn (same start). Counting
// an idle lump as a turn of its own would add a start that is no send and halve the
// median gap.
export function withPending(turns, open) {
  if (!open) return turns;
  const last = turns.at(-1);
  if (open.inTurn || !last) return [...turns, open];
  const parts = { ...partsOf(last) };
  for (const [k, v] of Object.entries(open.parts || {})) parts[k] = (parts[k] || 0) + v;
  const merged = {
    ...last,
    pct: last.pct + open.pct,
    helper: (last.helper || 0) + (open.helper || 0),
    hmodel: last.hmodel ?? open.hmodel,
    agents: mergeAgents(last.agents, open.agents),
    t: Math.max(last.t, open.t),
    parts,
  };
  return [...turns.slice(0, -1), merged];
}

// pendingSpend() for every session whose ledger the hook wrote after `after` (ms): the
// menu bar's recent chats. → [{ sid, ...pendingSpend }]
export function pendingAll(after = 0, maxUnread = PENDING_MAX_UNREAD) {
  let names = [];
  try {
    names = readdirSync(sessionsDir()).filter((f) => f.endsWith('.ledger.json'));
  } catch {}
  const out = [];
  for (const name of names) {
    try {
      if (statSync(path.join(sessionsDir(), name)).mtimeMs < after) continue;
    } catch {
      continue;
    }
    const sid = name.slice(0, -'.ledger.json'.length);
    const p = pendingSpend(sid, maxUnread);
    if (p) out.push({ sid, ...p });
  }
  return out;
}

// a chat transcript or helper file written in the last PENDING_BUSY_MS counts as an open
// turn for the outside-spend rule (drain.mjs busy): its newest call may not be in the file
// yet. (A running turn is also open through the ledger's `open`: anyOpenTurn.)
export const PENDING_BUSY_MS = 60_000;
export const pendingBusy = (pending, now = Date.now()) =>
  (pending || []).some((p) => p && now - p.lastWrite < PENDING_BUSY_MS);

// one session's turns, oldest first (the tail of the file only)
export function readTurns(sid) {
  return parseTurns(readTail(turnsPath(sid)), sid);
}

// every session's turns that ended after `after` (ms), oldest first
export function readAllTurns(after = 0) {
  const dir = sessionsDir();
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.turns.jsonl'));
  } catch {}
  const out = [];
  for (const name of names) {
    const f = path.join(dir, name);
    try {
      if (statSync(f).mtimeMs < after) continue;
    } catch {
      continue;
    }
    const sid = name.slice(0, -'.turns.jsonl'.length);
    for (const t of parseTurns(readTail(f), sid)) if (t.t > after) out.push(t);
  }
  return out.sort((a, b) => a.t - b.t);
}

// is any session inside a turn that opened in the last `withinMs`? Its spend so far is
// unpriced, so the meter can be ahead of the ledgers without anything being untracked.
// (A turn stopped with Esc never gets its Stop; the time limit lets that one go.)
export function anyOpenTurn(now = Date.now(), withinMs = 60 * 60_000) {
  let names = [];
  try {
    names = readdirSync(sessionsDir()).filter((f) => f.endsWith('.ledger.json'));
  } catch {}
  for (const name of names) {
    const open = readJSON(path.join(sessionsDir(), name), null)?.open;
    if (open && open <= now && now - open < withinMs) return true;
  }
  return false;
}

function readTail(file) {
  const size = fileSize(file);
  const { text } = readFrom(file, Math.max(0, size - TAIL_BYTES));
  return size > TAIL_BYTES ? text.slice(text.indexOf('\n') + 1) : text;
}

// one entry per turn: a turn booked in two parts (Stop, then the catch-up at the next
// UserPromptSubmit) shares its start, so lines with the same start are summed
function parseTurns(text, sid) {
  const byStart = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const t = JSON.parse(line);
      if (!Number.isFinite(t.t) || !Number.isFinite(t.pct)) continue;
      const k = t.start ?? t.t;
      const prev = byStart.get(k);
      if (!prev) byStart.set(k, { ...t, sid });
      else {
        // parts: a line without them (before S3) counts as helpers + other
        const a = partsOf(prev);
        const b = partsOf(t);
        prev.parts = { ...a };
        for (const k in b) prev.parts[k] = (prev.parts[k] || 0) + b[k];
        if ((t.helper || 0) > (prev.helper || 0) || !prev.hmodel)
          prev.hmodel = t.hmodel ?? prev.hmodel;
        if (prev.agents || t.agents) prev.agents = mergeAgents(prev.agents, t.agents);
        prev.pct += t.pct;
        prev.helper = (prev.helper || 0) + (t.helper || 0);
        prev.t = Math.max(prev.t, t.t);
        if (!prev.model) prev.model = t.model;
      }
    } catch {}
  }
  return [...byStart.values()].sort((a, b) => a.t - b.t);
}
