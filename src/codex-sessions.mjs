// Codex session files: every model call of every Codex chat on this Mac, and the Codex
// 5-hour meter, read from ~/.codex (CODEX_HOME) without touching it.
//
//   sessions/YYYY/MM/DD/rollout-*.jsonl   one file per chat or helper, appended as it runs;
//                                         the folder is the day the chat started, so a chat
//                                         resumed days later is still written in its old one
//     line 1   session_meta   id; a helper has thread_source "subagent", parent_thread_id,
//                             agent_nickname, and session_id = the chat that spawned it
//     turn_context            model (the model of the calls after it)
//     event_msg token_count   info.last_token_usage = one model call (input_tokens includes
//                             cached_input_tokens; output_tokens includes reasoning);
//                             rate_limits.primary = the 5-hour meter {used_percent, resets_at}
//   session_index.jsonl                   {id, thread_name}: the chat's name; a rename appends
//                                         a line, so the last one wins
//
// What the files hold that the plan did not say (checked 2026-11-13 on 0.166–0.169):
//   - token_count is sometimes written twice for one call (same total_token_usage), so a
//     line whose total equals the file's previous one is skipped
//   - a helper's file starts with a copy of its parent's history (a second session_meta,
//     the parent's turn_context): lines before subagent_history_start_ordinal are skipped
//   - resets_at moves by a few seconds between calls: rounded to the minute here
//   - rate_limits with limit_id "premium" (credits) carry no primary; only "codex" counts
//
// What S3 reads besides (checked 2026-11-13 on 23 files, 0.166–0.169):
//   - response_item function_call_output / custom_tool_call_output: a tool result, written
//     BEFORE the token_count of the call that asked for it, so it is input to the call after
//     that one. `reads` on a call = the text characters (images left out) of the results
//     over BIG_READ_CHARS fed to it. 75 results ≥ 30k chars: the next call's new input was
//     chars ÷ 4.05 tokens (median; p10 2.99, p90 4.71), read uncached once (71 of 75 within
//     5%) and from the cache on every later call (68 of 75)
//   - event_msg task_started … task_complete / turn_aborted: a turn. `open` on a thread =
//     the start of a turn with no end yet: the outside-spend rule waits while one runs
//   - a cold resume: a call more than COLD_IDLE_H after the file's previous one, on a chat
//     over COLD_MIN tokens, reading under COLD_SHARE of it from the cache (`cold` on the
//     call). Calls over 100k after > 6 h idle read 4% from the cache (median, 6 calls)
//
// Files written in the last ACTIVE_MIN are read; each from the byte offset where the last
// run stopped (CCRUNWAY_HOME/codex-sessions.json), so a 5 s refresh reads only what is new.
// A file seen for the first time is read whole, keeping the calls of the last KEEP_MIN.
// readReplay() reads one recorded chat (and its helpers' files) as of a moment inside it,
// for `codex-pace.mjs --replay`, without the state file.

import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ms } from './price.mjs';
import { home, readJSON, writeJSON } from './state.mjs';

const MIN = 60_000;
export const ACTIVE_MIN = 20; // the breakdown's window, as pace.mjs WINDOW_MIN
export const KEEP_MIN = 120; // calls and meter readings kept: fillScale wants an hour of rises
const FORGET_MS = 24 * 60 * MIN; // a file untouched this long leaves the state
export const CHARS_PER_TOKEN = 3; // the plan's (Claude's) ratio; Codex measured ~4 (above)
export const BIG_READ_MIN = 10_000; // tokens: a tool result over this is a `big read`
export const BIG_READ_CHARS = BIG_READ_MIN * CHARS_PER_TOKEN;
export const COLD_IDLE_H = 6;
export const COLD_MIN = 100_000; // tokens of input
export const COLD_SHARE = 0.5; // read from the cache, of the input
export const OPEN_MAX_MIN = 60; // a turn open longer than this is taken as ended (a killed Codex)

// the text characters of a tool result; images (data URLs) and ids are left out
function textChars(x, key = null) {
  if (typeof x === 'string')
    return ['image_url', 'type', 'detail', 'id', 'call_id'].includes(key) ? 0 : x.length;
  if (Array.isArray(x)) return x.reduce((n, y) => n + textChars(y, key), 0);
  if (x && typeof x === 'object') {
    let n = 0;
    for (const k in x) n += textChars(x[k], k);
    return n;
  }
  return 0;
}

export const codexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
export const statePath = () => path.join(home(), 'codex-sessions.json');
const STATE_V = 2; // 2: helpers' task and depth

// bytes [from, end) as text, cut at the last whole line; next = the offset after it
function readFrom(file, from, size) {
  if (size <= from) return { text: '', next: from };
  let fd;
  try {
    fd = openSync(file, 'r');
    const buf = Buffer.alloc(size - from);
    readSync(fd, buf, 0, buf.length, from);
    const cut = buf.lastIndexOf(10); // '\n'; a torn last line is read again next time
    if (cut < 0) return { text: '', next: from };
    return { text: buf.subarray(0, cut + 1).toString('utf8'), next: from + cut + 1 };
  } catch {
    return { text: '', next: from };
  } finally {
    if (fd != null) closeSync(fd);
  }
}

const minute = (t) => (t == null ? null : Math.round(t / MIN) * MIN);

// One chunk of a rollout file. f: the file's entry in the state ({id, root, helper,
// nickname, model, last, from, lastT, open, pend, next}), updated in place; calls and meters
// are appended to `out`. Calls before `since` (ms) are dropped; lines after `until` are
// skipped (a replay of an old file at a moment inside it; live, nothing is after now).
export function parseRollout(text, f, out, since = 0, until = Number.POSITIVE_INFINITY) {
  for (const line of text.split('\n')) {
    if (!line) continue;
    const meta = line.includes('"session_meta"');
    // a tool result shorter than BIG_READ_CHARS as a whole line can't be a big read
    const result = line.length >= BIG_READ_CHARS && line.includes('_call_output"');
    const task = line.includes('"task_') || line.includes('"turn_aborted"');
    if (
      !meta &&
      !result &&
      !task &&
      !line.includes('"turn_context"') &&
      !line.includes('"token_count"')
    )
      continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const p = e.payload || {};
    const t = Date.parse(e.timestamp);
    if (t > until) continue;
    if (e.type === 'session_meta') {
      if (f.id) continue; // the parent's meta, copied into a helper's history
      const spawn = p.source?.subagent?.thread_spawn;
      f.id = p.id;
      f.helper = p.thread_source === 'subagent' || !!spawn;
      f.nickname = p.agent_nickname ?? spawn?.agent_nickname ?? null;
      // the task's name, as Codex shows it (`Started /root/or360_activity`); 0.169 on
      const task = p.agent_path ?? spawn?.agent_path ?? null;
      f.task = task ? task.split('/').filter(Boolean).at(-1) : null;
      f.depth = spawn?.depth ?? (f.helper ? 1 : 0);
      f.parent = p.parent_thread_id ?? spawn?.parent_thread_id ?? null;
      // the chat a helper belongs to: session_id is the top chat, also for a helper's helper
      f.root = f.helper ? p.session_id || f.parent || p.id : p.id;
      f.from = p.subagent_history_start_ordinal ?? 0;
      continue;
    }
    if (f.from && Number.isFinite(e.ordinal) && e.ordinal < f.from) continue;
    if (e.type === 'turn_context') {
      if (p.model) f.model = p.model;
      continue;
    }
    if (e.type === 'response_item') {
      if (p.type !== 'function_call_output' && p.type !== 'custom_tool_call_output') continue;
      const n = textChars(p.output);
      if (n >= BIG_READ_CHARS) f.pend = (f.pend || 0) + n;
      continue;
    }
    if (e.type !== 'event_msg') continue;
    if (p.type === 'task_started') f.open = t;
    else if (p.type === 'task_complete' || p.type === 'turn_aborted') f.open = null;
    if (p.type !== 'token_count') continue;
    const rl = p.rate_limits;
    const pr = rl?.primary;
    if (pr?.used_percent != null && (rl.limit_id == null || rl.limit_id === 'codex') && t >= since)
      out.meters.push({ t, pct: pr.used_percent, resetsAt: minute(ms(pr.resets_at)) });
    const info = p.info;
    const u = info?.last_token_usage;
    if (!u) continue;
    const total = info.total_token_usage?.total_tokens ?? null;
    if (total != null && total === f.last) continue; // the same call written twice
    f.last = total;
    // the results written before this token_count go to the next call
    const reads = f.next || 0;
    f.next = f.pend || 0;
    f.pend = 0;
    const input = u.input_tokens || 0;
    const cached = u.cached_input_tokens || 0;
    const cold =
      f.lastT != null &&
      t - f.lastT > COLD_IDLE_H * 60 * MIN &&
      input > COLD_MIN &&
      cached < COLD_SHARE * input;
    f.ctx = input; // the chat's size at its last call
    f.lastT = t;
    if (t < since) continue;
    const call = {
      t,
      thread: f.id,
      model: f.model ?? null,
      last_token_usage: {
        input_tokens: input,
        cached_input_tokens: cached,
        output_tokens: u.output_tokens || 0,
      },
    };
    if (reads) call.reads = reads;
    if (cold) call.cold = true;
    out.calls.push(call);
  }
}

// is a turn running in any chat or helper? (a start with no end, under OPEN_MAX_MIN old)
export const anyOpen = (threads, now = Date.now()) =>
  Object.values(threads || {}).some(
    (th) => th.open != null && th.open <= now && now - th.open < OPEN_MAX_MIN * MIN,
  );

// the state's file entries → readCodex()'s threads
function threadsOf(files, names) {
  const threads = {};
  for (const f of files) {
    if (!f.id) continue;
    threads[f.id] = {
      name: names[f.id] ?? null,
      root: f.root ?? f.id,
      helper: !!f.helper,
      nickname: f.nickname ?? null,
      task: f.task ?? null,
      parent: f.parent ?? null,
      depth: f.depth ?? 0,
      model: f.model ?? null,
      ctx: f.ctx ?? null,
      lastT: f.lastT ?? null,
      open: f.open ?? null,
    };
  }
  return threads;
}

// rollout files under sessions/, with their stat
export function rollouts(root) {
  const dir = path.join(root, 'sessions');
  let names = [];
  try {
    names = readdirSync(dir, { recursive: true });
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!/(^|\/)rollout-[^/]*\.jsonl$/.test(name)) continue;
    const file = path.join(dir, name);
    try {
      const s = statSync(file);
      out.push({ file, size: s.size, mtime: s.mtimeMs });
    } catch {}
  }
  return out;
}

// id → thread_name, the last line per id winning
export function readIndex(root = codexHome()) {
  const names = {};
  let text = '';
  try {
    text = readFileSync(path.join(root, 'session_index.jsonl'), 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.id && e.thread_name) names[e.id] = e.thread_name;
    } catch {}
  }
  return names;
}

// Everything the menu bar needs about Codex right now:
//   calls    [{t, thread, model, last_token_usage}] of the last KEEP_MIN, oldest first
//   meters   [{t, pct, resetsAt}] the same span, oldest first
//   threads  {id: {name, root, helper, nickname, model, ctx, lastT}}
// The offsets, calls and readings carry over in CCRUNWAY_HOME/codex-sessions.json.
export function readCodex(now = Date.now(), root = codexHome()) {
  // a state from an older reader lacks fields only the file's first line gives (task,
  // depth): start over, which re-reads the active files from the top
  let st = readJSON(statePath(), null) || {};
  if (st.v !== STATE_V) st = {};
  const files = st.files || {};
  const since = now - KEEP_MIN * MIN;
  const out = {
    calls: (st.calls || []).filter((c) => c.t >= since),
    meters: (st.meters || []).filter((m) => m.t >= since),
  };
  const seen = new Set();
  for (const r of rollouts(root)) {
    seen.add(r.file);
    let f = files[r.file];
    if (!f) {
      if (r.mtime < now - ACTIVE_MIN * MIN) continue;
      f = files[r.file] = { off: 0 };
    }
    if (r.size < f.off) Object.assign(f, { off: 0, last: null }); // rewritten
    f.mtime = r.mtime;
    if (r.size === f.off) continue;
    const { text, next } = readFrom(r.file, f.off, r.size);
    parseRollout(text, f, out, since, now);
    f.off = next;
  }
  for (const k of Object.keys(files))
    if (!seen.has(k) || files[k].mtime < now - FORGET_MS) delete files[k];
  out.calls.sort((a, b) => a.t - b.t);
  out.meters.sort((a, b) => a.t - b.t);
  try {
    writeJSON(statePath(), { v: STATE_V, files, calls: out.calls, meters: out.meters });
  } catch {}
  const threads = threadsOf(Object.values(files), readIndex(root));
  return { calls: out.calls, meters: out.meters, threads };
}

// the first line of a file (session_meta), at most 256 KB of it
function firstLine(file) {
  const { text } = readFrom(file, 0, Math.min(statSync(file).size, 262_144));
  return text.slice(0, text.indexOf('\n') + 1 || undefined);
}

// One recorded chat as of `at` (ms; default: its file's last event), as readCodex() returns
// it: the rollout file and its helpers' files (any rollout under the same sessions/ whose
// session_meta names the chat as its parent or session). The chat's name comes from the
// session_index.jsonl beside sessions/. → { now, calls, meters, threads }
export function readReplay(file, at = null) {
  const abs = path.resolve(file);
  const cut = abs.lastIndexOf(`${path.sep}sessions${path.sep}`);
  const root = cut < 0 ? path.dirname(abs) : abs.slice(0, cut);
  const text = readFileSync(abs, 'utf8');
  let now = at;
  if (now == null) {
    const lines = text.trimEnd().split('\n');
    for (let i = lines.length - 1; i >= 0 && now == null; i--) {
      const m = /"timestamp":"([^"]+)"/.exec(lines[i]);
      if (m) now = Date.parse(m[1]);
    }
  }
  if (!Number.isFinite(now)) throw new Error(`no timestamp in ${file}`);
  const since = now - KEEP_MIN * MIN;
  const out = { calls: [], meters: [] };
  const main = {};
  parseRollout(text, main, out, since, now);
  const files = [main];
  if (main.id)
    for (const r of rollouts(root)) {
      if (path.resolve(r.file) === abs) continue;
      let head = '';
      try {
        head = firstLine(r.file);
      } catch {
        continue;
      }
      if (
        !head.includes(`"parent_thread_id":"${main.id}"`) &&
        !head.includes(`"session_id":"${main.id}"`)
      )
        continue;
      const f = {};
      parseRollout(readFileSync(r.file, 'utf8'), f, out, since, now);
      if (f.helper) files.push(f);
    }
  out.calls.sort((a, b) => a.t - b.t);
  out.meters.sort((a, b) => a.t - b.t);
  return { now, calls: out.calls, meters: out.meters, threads: threadsOf(files, readIndex(root)) };
}
