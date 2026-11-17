// ccrunway state on disk. Everything lives under ~/.ccrunway (override with
// CCRUNWAY_HOME; tests always do):
//   app/                           the installed copy of the code (install.mjs)
//   install.json                   what install changed: settings path, backup, the wrapped statusLine
//   config.json                    { mutedUntil, debug }  (written by cli.mjs)
//   calibration.json               seat_scale and its samples (price.mjs)
//   sessions/<sid>.json            latest status-line stdin + _at (written by statusline.mjs)
//   sessions/<sid>.sim.json        simulate.mjs overlay: pretend the cache went cold
//   sessions/<sid>.launch.json     a pending model-switch launch (launch.mjs)
//   sessions/<sid>.turns.jsonl     the turn ledger (ledger.mjs, written by hook.mjs on Stop)
//   pace.json                      the seat's 5-hour meter readings (pace.mjs)
// Writes are atomic (tmp + rename) so a status-line refresh never reads half a file.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const home = () => process.env.CCRUNWAY_HOME || path.join(os.homedir(), '.ccrunway');
export const sessionsDir = () => path.join(home(), 'sessions');

export function readJSON(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(file, obj, mode) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, mode ? { mode } : undefined);
  renameSync(tmp, file);
}

// session ids come from Claude Code; keep them filename-safe anyway
const safe = (sid) => String(sid || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
const snapPath = (sid) => path.join(sessionsDir(), `${safe(sid)}.json`);
const simPath = (sid) => path.join(sessionsDir(), `${safe(sid)}.sim.json`);
export { simPath, snapPath };
// simulate.mjs range: one overlay for every session's range line
export const rangeSimPath = () => path.join(home(), 'range.sim.json');

export const writeSnapshot = (sid, snap) => writeJSON(snapPath(sid), { ...snap, _at: Date.now() });

// the overlay alone, on a snapshot in hand (the status line's own stdin); returns a copy
// only when the overlay is active
export function applySim(sid, snap, now = Date.now()) {
  const sim = readJSON(simPath(sid));
  if (!sim || !(sim.until > now)) return snap;
  return {
    ...snap,
    prompt_cache: { ...(snap.prompt_cache || {}), warm: false, expires_at: sim.expires_at },
    _simulated: true,
  };
}

// config.json: { mutedUntil (ms), debug }, written by cli.mjs
export const configPath = () => path.join(home(), 'config.json');
export const readConfig = () => readJSON(configPath(), {}) || {};
export const writeConfig = (patch) => writeJSON(configPath(), { ...readConfig(), ...patch }, 0o600);
export const mutedUntil = () => {
  const t = readConfig().mutedUntil;
  return t && t > Date.now() ? t : 0;
};
