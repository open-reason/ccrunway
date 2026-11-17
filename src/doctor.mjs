// `ccrunway doctor`: is ccrunway set up and working, check by check, for a person (text)
// or an agent (--json). Reads only; the one write is a temp file in CCRUNWAY_HOME to see
// it is writable, removed at once. Each check is { id, ok, required, detail, fix }:
//   ok        true, false, or null when it does not apply here (detail says why)
//   required  a false here makes doctor's ok false and its exit 1; the others (meter,
//             turns, five_hour_meter, menubar_running) tell "warming up" or "closed"
//             from "broken" and never fail it
//   fix       a command or what to do, or null
// Not installed is a result, not an error: the install checks fail with fix
// `npx ccrunway install` (doctor is what you run when unsure).

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readAllTurns } from './ledger.mjs';
import { readPace } from './pace.mjs';
import { span } from './range.mjs';
import {
  EVENTS,
  MIN_NODE,
  appDir,
  binMajor,
  cmdNode,
  here,
  isOurHook,
  isOurStatus,
  nodeMajor,
  pkgFile,
  platform,
  settingsPath,
} from './settings.mjs';
import { home, readJSON, sessionsDir } from './state.mjs';
import { menubarState, recordPath } from './swiftbar.mjs';

const MIN = 60_000;
const INSTALL = 'npx ccrunway install';
const STALE_MIN = 15; // a meter reading older than this: Claude Code has not sent one lately
const TURN_MIN = 60;
const WRAP_MS = 4000; // statusline.mjs gives the wrapped command the same
export const VERSION = readJSON(pkgFile(), {})?.version ?? '?';

const check = (id, required, ok, detail, fix = null) => ({ id, ok, required, detail, fix });
const ago = (t, now) => span(Math.max(1, Math.round((now - t) / MIN)));

// what every check reads, once
function context(opt, now) {
  const file = settingsPath(opt);
  let settings = null;
  let parseError = null;
  if (existsSync(file))
    try {
      settings = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      parseError = e.message;
    }
  return { now, file, settings, parseError, meta: readJSON(path.join(home(), 'install.json'), null) };
}

function platformCheck() {
  const p = platform();
  return p === 'darwin'
    ? check('platform', true, true, 'macOS')
    : check('platform', true, false, `${p}: ccrunway supports macOS only; --force installs anyway, untested`);
}

function nodeCheck({ meta }) {
  const fix = `npx ccrunway install --node <path to node ${MIN_NODE}+>`;
  const mine = nodeMajor();
  if ((mine ?? 0) < MIN_NODE)
    return check('node', true, false, `this node is ${process.version}; ccrunway needs ${MIN_NODE}+`, fix);
  if (!meta?.node) return check('node', true, true, `${process.version}; no install.json, so no hook node yet`);
  if (!existsSync(meta.node)) return check('node', true, false, `the hooks' node ${meta.node} is gone`, fix);
  const v = binMajor(meta.node);
  if (v == null) return check('node', true, false, `the hooks' node ${meta.node} does not run`, fix);
  if (v < MIN_NODE) return check('node', true, false, `the hooks' node ${meta.node} is node ${v}`, fix);
  return check('node', true, true, `${process.version}; hooks run ${meta.node} (node ${v})`);
}

function settingsCheck({ file, settings, parseError }) {
  if (parseError)
    return check('settings', true, false, `${file} is not valid JSON: ${parseError}`, `fix the JSON in ${file} by hand`);
  if (!settings) return check('settings', true, false, `no ${file}`, INSTALL);
  return check('settings', true, true, file);
}

function statusLineCheck({ settings }) {
  const s = settings?.statusLine;
  if (!isOurStatus(s))
    return check('status_line', true, false, s?.command ? `statusLine is someone else's: ${s.command}` : 'no ccrunway statusLine', INSTALL);
  const node = cmdNode(s.command);
  if (node && !existsSync(node)) return check('status_line', true, false, `its node ${node} is gone`, INSTALL);
  return check('status_line', true, true, s.command);
}

// run as statusline.mjs runs it: /bin/sh -c, 4 s, on the stdin Claude Code last sent a
// status line here (the newest snapshot, less ccrunway's own _ keys). Many status lines
// read fields such as .model.id, so `{}` would fail ones that work; with no session yet
// there is nothing real to test with, so it is skipped.
function wrappedCheck({ meta }) {
  const cmd = meta?.prevStatusLine?.command;
  if (!cmd || typeof cmd !== 'string') return check('wrapped', false, null, 'no earlier status line to wrap');
  const last = snapshots()
    .map((s) => readJSON(s.file, null))
    .find((j) => j && typeof j === 'object');
  if (!last) return check('wrapped', false, null, 'no Claude Code session yet to test it with');
  const input = JSON.stringify(Object.fromEntries(Object.entries(last).filter(([k]) => !k.startsWith('_'))));
  const t0 = Date.now();
  const r = spawnSync('/bin/sh', ['-c', cmd], {
    input,
    encoding: 'utf8',
    timeout: WRAP_MS,
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const msTaken = Date.now() - t0;
  const fix = `fix \`${cmd}\` so it prints within 4 s, or reinstall (${INSTALL}) after changing statusLine`;
  const used = "with the last session's input";
  if (r.error?.code === 'ETIMEDOUT' || r.signal)
    return check('wrapped', true, false, `\`${cmd}\` took over ${WRAP_MS / 1000} s ${used}; only the runway line prints`, fix);
  if (r.status !== 0)
    return check('wrapped', true, false, `\`${cmd}\` exited ${r.status ?? r.error?.code} ${used}, ${msTaken} ms`, fix);
  return check('wrapped', true, true, `\`${cmd}\` ${used}, ${msTaken} ms`);
}

function hooksCheck({ settings }) {
  const missing = [];
  const gone = new Set();
  for (const ev of EVENTS) {
    const ours = (settings?.hooks?.[ev] || []).flatMap((g) => (g?.hooks || []).filter(isOurHook));
    if (!ours.length) missing.push(ev);
    for (const h of ours) {
      const n = cmdNode(h.command);
      if (n && !existsSync(n)) gone.add(n);
    }
  }
  if (missing.length === EVENTS.length) return check('hooks', true, false, 'no ccrunway hooks', INSTALL);
  if (missing.length || gone.size)
    return check(
      'hooks',
      true,
      false,
      [missing.length && `missing on ${missing.join(', ')}`, gone.size && `node gone: ${[...gone].join(', ')}`]
        .filter(Boolean)
        .join('; '),
      INSTALL,
    );
  return check('hooks', true, true, EVENTS.join(', '));
}

function appCheck() {
  const app = appDir();
  const self = path.resolve(here) === path.resolve(app) ? ' (this CLI is that copy)' : '';
  const lacks = ['statusline.mjs', 'hook.mjs'].filter((f) => !existsSync(path.join(app, f)));
  if (lacks.length)
    return check('app', true, false, existsSync(app) ? `${app} lacks ${lacks.join(', ')}` : `no ${app}`, INSTALL);
  const v = readJSON(path.join(app, 'package.json'), {})?.version ?? '?';
  if (v !== VERSION)
    return check('app', true, false, `${app} is ${v}, this CLI is ${VERSION}`, `${INSTALL} (copies ${VERSION} there)`);
  return check('app', true, true, `${app} ${v}${self}`);
}

function dataDirCheck() {
  const dir = home();
  if (!existsSync(dir)) return check('data_dir', true, false, `no ${dir}`, INSTALL);
  const probe = path.join(dir, `.doctor.${process.pid}.tmp`);
  try {
    writeFileSync(probe, '');
    unlinkSync(probe);
    return check('data_dir', true, true, `${dir} is writable`);
  } catch (e) {
    return check('data_dir', true, false, `can't write in ${dir}: ${e.code ?? e.message}`, `make ${dir} writable by you`);
  }
}

// status-line snapshots (sessions/<sid>.json), newest first
function snapshots() {
  const dir = sessionsDir();
  let names = [];
  try {
    names = readdirSync(dir).filter((f) => /^[A-Za-z0-9_-]+\.json$/.test(f));
  } catch {}
  return names
    .map((f) => {
      const file = path.join(dir, f);
      try {
        return { file, mtime: statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

// pace.json keeps only rises, so a flat meter has no new reading; a snapshot with the
// 5-hour meter written lately says the status line still sees it
function meterCheck({ now }) {
  const last = readPace()?.readings?.at(-1);
  const seen = snapshots().find((s) => readJSON(s.file, null)?.rate_limits?.five_hour);
  const fresh = seen && now - seen.mtime < STALE_MIN * MIN;
  if (!last && !fresh)
    return check('meter', false, false, 'no 5-hour reading yet — open Claude Code and send a message');
  if (last && now - last.t < STALE_MIN * MIN)
    return check('meter', false, true, `${last.pct}%, last rise ${ago(last.t, now)} ago`);
  if (fresh)
    return check(
      'meter',
      false,
      true,
      `seen ${ago(seen.mtime, now)} ago${last ? `; flat at ${last.pct}% since ${ago(last.t, now)} ago` : ''}`,
    );
  return check('meter', false, false, `last reading ${ago(last.t, now)} ago (${last.pct}%): no Claude Code session lately`);
}

function turnsCheck({ now }) {
  let turns = [];
  try {
    turns = readAllTurns(0);
  } catch {}
  const last = turns.at(-1);
  if (!last) return check('turns', false, false, 'no turn booked yet — send a message in a new Claude Code session');
  const recent = turns.filter((t) => t.t > now - TURN_MIN * MIN).length;
  if (!recent) return check('turns', false, false, `no turn booked in the last hour; the last ${ago(last.t, now)} ago`);
  return check('turns', false, true, `${recent} in the last hour, the last ${ago(last.t, now)} ago`);
}

function fiveHourCheck() {
  const snaps = snapshots();
  if (!snaps.length) return check('five_hour_meter', false, null, 'no status-line snapshot yet');
  if (snaps.some((s) => readJSON(s.file, null)?.rate_limits?.five_hour))
    return check('five_hour_meter', false, true, 'Claude Code sends rate_limits.five_hour');
  return check(
    'five_hour_meter',
    false,
    false,
    'no 5-hour limit seen: an API-key session or a plan without one; ccrunway has nothing to forecast',
  );
}

// required once `ccrunway menubar on` ran (menubar.json), else skipped. Two ids, so each
// keeps one `required`: menubar (the link, SwiftBar installed, reading our folder) fails
// doctor; menubar_running (SwiftBar open) only warns, since quitting it is a choice
function menubarCheck() {
  if (!existsSync(recordPath())) return check('menubar', false, null, 'off');
  const m = menubarState();
  const fix = 'npx ccrunway menubar on';
  if (!m.on) return check('menubar', true, false, `the link ${m.link ?? '?'} is gone`, fix);
  if (!m.swiftbar) return check('menubar', true, false, 'SwiftBar is not installed', fix);
  if (m.hidden) return check('menubar', true, false, 'SwiftBar reads another plugin folder', fix);
  return check('menubar', true, true, m.link);
}

function menubarRunningCheck() {
  if (!existsSync(recordPath())) return check('menubar_running', false, null, 'menu bar off');
  const m = menubarState();
  if (!m.swiftbar) return check('menubar_running', false, null, 'SwiftBar is not installed');
  if (!m.swiftbar_running)
    return check('menubar_running', false, false, 'SwiftBar is not running, so the item does not show', 'open -a SwiftBar');
  return check('menubar_running', false, true, 'SwiftBar running');
}

export function doctor(opt = {}, now = Date.now()) {
  const c = context(opt, now);
  const checks = [
    platformCheck(c),
    nodeCheck(c),
    settingsCheck(c),
    statusLineCheck(c),
    wrappedCheck(c),
    hooksCheck(c),
    appCheck(c),
    dataDirCheck(c),
    meterCheck(c),
    turnsCheck(c),
    fiveHourCheck(c),
    menubarCheck(c),
    menubarRunningCheck(c),
  ];
  return { ok: checks.every((k) => !k.required || k.ok === true), checks };
}

export function doctorText({ ok, checks }) {
  const w = Math.max(...checks.map((k) => k.id.length)) + 2;
  const lines = checks.map((k) =>
    k.ok === null
      ? `– ${k.id.padEnd(w)}skipped: ${k.detail}`
      : k.ok
        ? `✓ ${k.id.padEnd(w)}${k.detail}`
        : `✗ ${k.id.padEnd(w)}${k.detail}${k.fix ? ` — fix: ${k.fix}` : ''}`,
  );
  const bad = checks.filter((k) => k.required && k.ok !== true).map((k) => k.id);
  const soft = checks.filter((k) => !k.required && k.ok === false).map((k) => k.id);
  lines.push(
    ok
      ? `ok: every required check passes${soft.length ? ` (not yet: ${soft.join(', ')})` : ''}`
      : `not ok: ${bad.join(', ')} failed`,
  );
  return lines.join('\n');
}
