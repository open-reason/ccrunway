#!/usr/bin/env node
// Pretend a session's cache went cold, so scenario 5 (cold launch) can be tested without
// waiting an hour:
//   node simulate.mjs cold [session_id]     (default: the most recent session)
//   Writes sessions/<sid>.sim.json; for 10 minutes the status line (state.mjs applySim)
//   sees prompt_cache as warm:false with expires_at a minute ago. The status line keeps
//   rewriting the live snapshot, which is why this is an overlay and not an edit. On a
//   chat over 150k it shows `⚠ next send costs ≈N% (reloads chat) · …  · sim`. The next
//   UserPromptSubmit removes the overlay (or it ends after 10 min).
// Pretend a model switch is pending, so scenario 6 can be tested without switching:
//   node simulate.mjs switch <model-id> [session_id]
//   Writes sessions/<sid>.launch.json as hook.mjs does on PreModelSwitch, priced at
//   <model-id>'s cache-write weight × the session's chat size, for 2 minutes or until
//   the next UserPromptSubmit, tagged `· sim`.
// Or show a range state in every session's status line for 2 minutes, tagged "· sim",
// without touching pace.json (the real meter feed):
//   node simulate.mjs range cold|green|amber|red [bars 1-4]
//   green = runs out 60 min after the reset, amber = 10 min after, red = 40 min before;
//   bars adds this many pace bars (none in cold) with a rate that fits them (the live
//   safe rate × 0.3 / 0.7 / 1 / 1.5), e.g. `range green 3`
//   The sim forces the verdict only: under amber or red the top drain is the real one,
//   from the real ledgers and meter, so it can be tested without burning the window.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  MIN_POINTS,
  SWITCH_MIN_TOKENS,
  SWITCH_TTL_MS,
  launchPath,
  launchPoints,
} from './launch.mjs';
import { ctxTokens, fmtK } from './price.mjs';
import { rangeSimPath, readJSON, sessionsDir, simPath, snapPath, writeJSON } from './state.mjs';

const argv = process.argv.slice(2);
const [cmd] = argv;
// switch takes the model first
const model = cmd === 'switch' ? argv[1] : null;
const [sidArg, barsArg] = cmd === 'switch' ? argv.slice(2) : argv.slice(1);
const MARGIN = { cold: null, green: 60, amber: 10, red: -40 };
const bars = /^[1-4]$/.test(barsArg || '') ? Number(barsArg) : null;
if (cmd === 'range' && sidArg in MARGIN && (barsArg == null || bars)) {
  writeJSON(rangeSimPath(), {
    state: sidArg,
    margin: MARGIN[sidArg],
    bars,
    until: Date.now() + 120_000,
  });
  process.stdout.write(
    `range shows ${sidArg}${bars ? ` with ${bars} pace bars` : ''} for 2 minutes in every session\n`,
  );
  process.exit(0);
}
if (cmd !== 'cold' && !(cmd === 'switch' && model)) {
  process.stderr.write(
    'usage: node simulate.mjs cold [session_id] | switch <model-id> [session_id] | range cold|green|amber|red [1-4]\n',
  );
  process.exit(1);
}

let sid = sidArg;
if (!sid) {
  const dir = sessionsDir();
  let files = [];
  try {
    files = readdirSync(dir).filter(
      (f) => /^[A-Za-z0-9_-]+\.json$/.test(f) && !f.includes('.state') && !f.includes('.sim'),
    );
  } catch {}
  files.sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs);
  sid = files[0]?.replace(/\.json$/, '');
}
if (!sid) {
  process.stderr.write(
    'no session snapshot yet: open Claude Code with ccrunway installed first\n',
  );
  process.exit(1);
}

const now = Date.now();
if (cmd === 'switch') {
  const tokens = ctxTokens(readJSON(snapPath(sid)));
  const pct = launchPoints(model, tokens);
  writeJSON(launchPath(sid), {
    kind: 'switch',
    model,
    from: null,
    tokens,
    pct,
    at: now,
    until: now + SWITCH_TTL_MS,
    sim: true,
  });
  const why =
    tokens <= SWITCH_MIN_TOKENS
      ? ` (the hook would skip a chat of ${fmtK(SWITCH_MIN_TOKENS)} or less)`
      : pct < MIN_POINTS
        ? ` (under ${MIN_POINTS} points: the line will not show it)`
        : '';
  process.stdout.write(
    `session ${sid}: switch to ${model} pending for 2 minutes, ${fmtK(tokens)} ≈ ${pct.toFixed(1)} points${why}\n`,
  );
  process.exit(0);
}
writeJSON(simPath(sid), { expires_at: Math.floor(now / 1000) - 60, until: now + 10 * 60_000 });
process.stdout.write(`session ${sid}: cache marked cold for 10 minutes\n`);
