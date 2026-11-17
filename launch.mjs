// Launch previews (range plan S4): a send that will cost a lot in one go, shown on the
// status line before it happens, with the run-out time after the jump.
//   cold   = this session's prompt cache has expired (the status line's prompt_cache:
//            warm false or expires_at passed, price.mjs cacheCold) and the chat is over
//            COLD_MIN_TOKENS: the next send writes the whole chat again. The status line
//            gets prompt_cache on every refresh, so it decides this alone (no SessionStart
//            hook); the launch clears itself when the cache is warm again.
//   switch = PreModelSwitch (hook.mjs, before the switch) on a chat over SWITCH_MIN_TOKENS:
//            the first call on the new model writes the whole chat to its cache. Written to
//            sessions/<sid>.launch.json {kind, model, from, tokens, pct, at, until}; shown
//            until the next UserPromptSubmit (clearLaunch) or SWITCH_TTL_MS.
//            Claude Code 2.1.311's PreModelSwitch input carries from_model, to_model and
//            context_tokens (the tokens the next request re-sends).
// cost   = tokens × the model's cache-write weight (price.mjs, seat_scale 1): model points.
//          The status line puts them in meter points with pace()'s fillScale when it is
//          below 1 (as drain.mjs does: the model reads ~1.3× the meter, and a scale above
//          1 is spend the ledgers do not have). A launch under MIN_POINTS meter points is
//          not shown.
// After the jump (afterLaunch): the meter is cur + cost now, at the same rate as the
// current verdict, so run-out = now + (runOutAt − now) × (100 − cur − cost) ÷ (100 − cur).
// simulate.mjs: `cold` sets the sessions/<sid>.sim.json overlay (state.mjs applySim);
// `switch <model>` writes a launch.json with sim: true. UserPromptSubmit removes both.

import { unlinkSync } from 'node:fs';
import path from 'node:path';
import { cacheCold, ctxTokens, price } from './price.mjs';
import { readJSON, sessionsDir, snapPath, writeJSON } from './state.mjs';

export const COLD_MIN_TOKENS = 150_000;
export const SWITCH_MIN_TOKENS = 100_000;
export const MIN_POINTS = 2; // meter points; the meter moves in whole percents
export const SWITCH_TTL_MS = 2 * 60_000;

const safe = (sid) => String(sid || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
export const launchPath = (sid) => path.join(sessionsDir(), `${safe(sid)}.launch.json`);

// model points to write `tokens` to `model`'s cache (seat_scale 1)
export const launchPoints = (model, tokens) => price({ model, writeTokens: tokens || 0 }, 1);

// the cold launch from a status-line snapshot (simulate overlay already applied), or null
export function coldLaunch(snap, now = Date.now()) {
  const tokens = ctxTokens(snap);
  if (!cacheCold(snap, now) || tokens <= COLD_MIN_TOKENS) return null;
  // what Claude Code says it would write again; the context size if it does not say
  const write = snap?.prompt_cache?.recache_tokens_if_cold || tokens;
  const model = snap?.model?.id;
  return { kind: 'cold', model, tokens: write, pct: launchPoints(model, write) };
}

// the switch launch from a PreModelSwitch input (+ the snapshot for the chat size), or null
export function switchLaunch(input, snap, now = Date.now()) {
  const model = input?.to_model;
  if (!model) return null;
  const tokens = input.context_tokens || ctxTokens(snap);
  if (tokens <= SWITCH_MIN_TOKENS) return null;
  return {
    kind: 'switch',
    model,
    from: input.from_model ?? snap?.model?.id ?? null,
    tokens,
    pct: launchPoints(model, tokens),
    at: now,
    until: now + SWITCH_TTL_MS,
  };
}

// hook.mjs PreModelSwitch: write the pending launch (or drop an older one)
export function noteSwitch(sid, input, now = Date.now()) {
  const l = switchLaunch(input, readJSON(snapPath(sid)), now);
  if (l) writeJSON(launchPath(sid), l);
  else rm(launchPath(sid));
  return l;
}

// hook.mjs UserPromptSubmit: the send happened; drop a pending switch and simulate's
// cold overlay
export function clearLaunch(sid) {
  rm(launchPath(sid));
  rm(path.join(sessionsDir(), `${safe(sid)}.sim.json`));
}

function rm(file) {
  try {
    unlinkSync(file);
  } catch {}
}

// what the status line shows: a pending switch first (it is the newer event), else a
// cold launch; pct in meter points (scale = pace()'s fillScale, used only below 1).
// null under MIN_POINTS. { kind, model, tokens, pct, sim }
export function pendingLaunch(sid, snap, now = Date.now(), scale = 1) {
  const k = Math.min(1, scale > 0 ? scale : 1);
  const sw = sid ? readJSON(launchPath(sid)) : null;
  const pick =
    sw?.kind === 'switch' && sw.until > now
      ? { ...sw, sim: !!sw.sim }
      : (() => {
          const c = coldLaunch(snap, now);
          return c && { ...c, sim: !!snap?._simulated };
        })();
  if (!pick) return null;
  const pct = pick.pct * k;
  return pct >= MIN_POINTS ? { ...pick, pct } : null;
}

// the run-out time if the meter jumped by `cost` points now, at the same rate.
// null when there is no rate (cold verdict). before: it runs out before the reset.
export function afterLaunch({ cur, runOutAt, resetsAt, cost, now = Date.now() }) {
  if (runOutAt == null || cur == null) return null;
  const left = 100 - cur;
  if (!(left > 0) || runOutAt <= now) return { runOutAt: now, before: resetsAt != null };
  const after = Math.max(0, left - cost);
  const t = now + ((runOutAt - now) * after) / left;
  return { runOutAt: t, before: resetsAt != null && t < resetsAt };
}

// the verdict segment, plain text (the status line colours it amber):
//   ⚠ next send costs ≈14% (reloads chat) · would run out 1:50pm
//   ⚠ model switch costs ≈8% (resends chat) · still on track
//   ⚠ next send costs ≈14% (reloads chat) · resets 2:35pm        (no rate yet)
// clock: (ms) → '1:50pm'; reset: the reset already formatted, or null
export function launchText(l, after, clock, reset) {
  const n = Math.max(1, Math.round(l.pct));
  const head =
    l.kind === 'switch'
      ? `⚠ model switch costs ≈${n}% (resends chat)`
      : `⚠ next send costs ≈${n}% (reloads chat)`;
  if (after)
    return `${head} · ${after.before ? `would run out ${clock(after.runOutAt)}` : 'still on track'}`;
  return reset ? `${head} · resets ${reset}` : head;
}
