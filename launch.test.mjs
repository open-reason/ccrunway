// node --test launch.test.mjs
// Launch previews (range plan S4): the cost, the run-out time after the jump, when a
// launch shows and when it clears, through the real hook and status line processes.
// Temp CCRUNWAY_HOME; placeholder fixtures only.

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.CCRUNWAY_HOME = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-launch-'));
const L = await import('./launch.mjs');
const { w } = await import('./price.mjs');
const { clock } = await import('./range.mjs');

const here = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const SAMPLE = JSON.parse(
  readFileSync(path.join(here, 'fixtures', 'statusline-opus-259k.json'), 'utf8'),
);

// a status-line snapshot with a chosen model, size, cache state and meter
// reset: epoch seconds (the same one goes into pace.json, or observe() starts a new window)
const resetS = (min) => Math.floor((Date.now() + min * MIN) / 1000);
function snapshot(sid, { model, name = model, ctx, cold = false, meter = 40, reset = resetS(90) }) {
  const s = structuredClone(SAMPLE);
  s.session_id = sid;
  s.transcript_path = '/nonexistent';
  s.model = { id: model, display_name: name };
  s.context_window.current_usage = {
    input_tokens: 2,
    output_tokens: 300,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: ctx - 2,
  };
  s.prompt_cache.recache_tokens_if_cold = ctx;
  s.prompt_cache.warm = !cold;
  s.prompt_cache.expires_at = Math.floor(Date.now() / 1000) + (cold ? -600 : 3000);
  s.rate_limits.five_hour = { used_percentage: meter, resets_at: reset };
  return s;
}

function home() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-launch-e2e-'));
  mkdirSync(path.join(dir, 'sessions'));
  const env = { ...process.env, CCRUNWAY_HOME: dir, NO_COLOR: '1' };
  const run = (script, stdin, argv = []) =>
    spawnSync(process.execPath, [path.join(here, script), ...argv], {
      input: typeof stdin === 'string' ? stdin : JSON.stringify(stdin ?? {}),
      env,
      encoding: 'utf8',
    });
  // a steady pace: 1% every 2 min for the last 40 min up to `meter`; reset in epoch seconds
  const pace = (meter, reset) => {
    const now = Date.now();
    const readings = [];
    for (let i = 0; i <= 20; i++)
      readings.push({ t: now - (40 - 2 * i) * MIN, pct: meter - 20 + i });
    writeFileSync(
      path.join(dir, 'pace.json'),
      JSON.stringify({
        resetsAt: reset * 1000,
        readings,
        askedAt: null,
        noted: false,
      }),
    );
  };
  return { dir, run, pace };
}

test('launch cost: chat size × the model cache-write weight, seat_scale 1', () => {
  const fable = w('claude-fable-5-2').w_write;
  assert.equal(L.launchPoints('claude-fable-5-2', 680_000), (680_000 * fable) / 1e6);
  const c = L.coldLaunch(snapshot('a', { model: 'claude-fable-5-2', ctx: 680_000, cold: true }));
  assert.equal(c.kind, 'cold');
  assert.equal(c.tokens, 680_000);
  assert.ok(Math.abs(c.pct - (680_000 * fable) / 1e6) < 1e-9);
  // a switch is priced at the TARGET model's weight
  const s = L.switchLaunch(
    { to_model: 'claude-fable-5-2', from_model: 'claude-opus-5-5', context_tokens: 200_000 },
    null,
    0,
  );
  assert.equal(s.model, 'claude-fable-5-2');
  assert.ok(Math.abs(s.pct - (200_000 * fable) / 1e6) < 1e-9);
  assert.equal(s.until, L.SWITCH_TTL_MS);
  // no context_tokens: the snapshot's chat size
  const s2 = L.switchLaunch(
    { to_model: 'claude-opus-5-5' },
    snapshot('a', { model: 'claude-fable-5-2', ctx: 400_000 }),
  );
  assert.equal(s2.tokens, 400_000);
});

test('cold launch only when cold, over 150k, and ≥ 2 points', () => {
  const now = Date.now();
  const big = { model: 'claude-fable-5-2', ctx: 680_000 };
  assert.equal(L.coldLaunch(snapshot('a', big), now), null, 'warm');
  assert.equal(
    L.coldLaunch(snapshot('a', { ...big, ctx: 150_000, cold: true }), now),
    null,
    '150k is not over 150k',
  );
  assert.ok(L.coldLaunch(snapshot('a', { ...big, cold: true }), now));
  // Opus 259k cold: 1.5 points, a launch but under the 2-point floor
  const opus = snapshot('opus', { model: 'claude-opus-5-5', ctx: 259_000, cold: true });
  assert.ok(L.coldLaunch(opus, now).pct < L.MIN_POINTS);
  assert.equal(L.pendingLaunch('opus', opus, now), null);
  const fable = snapshot('fab', { ...big, cold: true });
  assert.equal(L.pendingLaunch('fab', fable, now).kind, 'cold');
  // a fillScale below 1 scales it down; above 1 is ignored
  const p = L.pendingLaunch('fab', fable, now, 1).pct;
  assert.ok(Math.abs(L.pendingLaunch('fab', fable, now, 0.5).pct - p / 2) < 1e-9);
  assert.equal(L.pendingLaunch('fab', fable, now, 3).pct, p);
  // 120k Fable at 20/Mtok = 2.4 points but under the size floor
  assert.equal(L.coldLaunch(snapshot('a', { ...big, ctx: 120_000, cold: true }), now), null);
});

test('after the jump: same rate, meter + cost; would run out vs still on track', () => {
  const now = new Date(2026, 10, 12, 12, 0).getTime();
  const reset = new Date(2026, 10, 12, 14, 35).getTime();
  // 40% used, runs out 60 min after the reset at this rate: 215 min for 60 points
  const runOutAt = reset + 60 * MIN;
  const a = L.afterLaunch({ cur: 40, runOutAt, resetsAt: reset, cost: 14, now });
  // 46 points left at 60/215 per min → 164.8 min: 2:44:50pm, still after the reset
  assert.ok(Math.abs((a.runOutAt - now) / MIN - (215 * 46) / 60) < 1e-6);
  assert.equal(a.before, false);
  const b = L.afterLaunch({ cur: 40, runOutAt, resetsAt: reset, cost: 20, now });
  assert.equal(b.before, true);
  assert.equal(Math.round((b.runOutAt - now) / MIN), Math.round((215 * 40) / 60));
  // a cost bigger than what is left: it runs out on the send
  assert.equal(L.afterLaunch({ cur: 90, runOutAt, resetsAt: reset, cost: 14, now }).runOutAt, now);
  // no rate yet
  assert.equal(L.afterLaunch({ cur: 40, runOutAt: null, resetsAt: reset, cost: 14, now }), null);

  const cold = { kind: 'cold', pct: 13.6 };
  assert.equal(
    L.launchText(cold, b, clock),
    `⚠ next send costs ≈14% (reloads chat) · would run out ${clock(b.runOutAt)}`,
  );
  assert.equal(
    L.launchText({ kind: 'switch', pct: 8.4 }, a, clock),
    '⚠ model switch costs ≈8% (resends chat) · still on track',
  );
  assert.equal(
    L.launchText(cold, null, clock, '2:35pm'),
    '⚠ next send costs ≈14% (reloads chat) · resets 2:35pm',
  );
});

test('status line: cold launch replaces the verdict, no pace bar, clears when warm', () => {
  const h = home();
  const reset = resetS(100);
  h.pace(40, reset); // 0.5%/min, 60 left → 120 min: 20 min after the reset (green)
  const sid = 'cold-1';
  // 3 turns, so the pace bar would show without the launch
  const t = Date.now();
  writeFileSync(
    path.join(h.dir, 'sessions', `${sid}.turns.jsonl`),
    [0, 1, 2]
      .map(
        (i) =>
          `${JSON.stringify({ t: t - (6 - 2 * i) * MIN + 30_000, start: t - (6 - 2 * i) * MIN, model: 'opus-5-5', pct: 0.5, helper: 0 })}\n`,
      )
      .join(''),
  );
  const warm = snapshot(sid, { model: 'claude-fable-5-2', name: 'Fable 5.2', ctx: 680_000, reset });
  const green = h.run('statusline.mjs', warm).stdout;
  assert.match(green, /^ccrunway · pace ▮.* · ✓ on track /);
  const cold = { ...warm, prompt_cache: { ...warm.prompt_cache, warm: false } };
  const line = h.run('statusline.mjs', cold).stdout;
  // 13.6 points; 46.4 left at 0.5/min → ~93 min: before the 100-min reset
  assert.match(
    line,
    /^ccrunway · pace ▮+▯* +\d+%\/h · Fable 5\.2 · 680k · 5h 40% · ⚠ next send costs ≈14% \(reloads chat\) · would run out \d+:\d\d[ap]m\n/,
  );
  assert.doesNotMatch(line, /sim/);
  // a smaller chat: 200k × 20 = 4 points → 56 left → 112 min, still after the reset
  const small = snapshot(sid, {
    model: 'claude-fable-5-2',
    name: 'Fable 5.2',
    ctx: 200_000,
    cold: true,
    reset,
  });
  assert.match(
    h.run('statusline.mjs', small).stdout,
    /⚠ next send costs ≈4% \(reloads chat\) · still on track\n/,
  );
  // warm again: the launch is gone
  assert.match(h.run('statusline.mjs', warm).stdout, /✓ on track/);
});

test('status line: a launch with no rate yet shows the cost and the reset', () => {
  const h = home(); // no pace.json: cold verdict
  const s = snapshot('nr', {
    model: 'claude-fable-5-2',
    name: 'Fable 5.2',
    ctx: 680_000,
    cold: true,
  });
  const line = h.run('statusline.mjs', s).stdout;
  assert.match(line, /· ⚠ next send costs ≈14% \(reloads chat\) · resets \d+:\d\d[ap]m\n$/);
});

test('PreModelSwitch writes a switch launch; UserPromptSubmit and the timeout clear it', () => {
  const h = home();
  const reset = resetS(90);
  h.pace(40, reset);
  const sid = 'sw-1';
  const snap = snapshot(sid, { model: 'claude-opus-5-5', name: 'Opus 5.5', ctx: 400_000, reset });
  h.run('statusline.mjs', snap);
  const ev = {
    hook_event_name: 'PreModelSwitch',
    session_id: sid,
    transcript_path: '/nonexistent',
    from_model: 'claude-opus-5-5',
    to_model: 'claude-fable-5-2',
    requested_model: 'fable',
    source: 'command',
    context_tokens: 400_000,
    prompt_cache_warm: true,
  };
  const r = h.run('hook.mjs', ev);
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '', 'the switch is not asked about');
  const file = path.join(h.dir, 'sessions', `${sid}.launch.json`);
  const l = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(l.kind, 'switch');
  assert.equal(l.tokens, 400_000);
  // 400k × 20 = 8 points; 52 left at 0.5/min → 104 min, after the 90-min reset
  const line = h.run('statusline.mjs', snap).stdout;
  assert.match(
    line,
    /^ccrunway · pace ▯▯▯▯ +–%\/h · Opus 5\.5 · 400k · 5h 40% · ⚠ model switch costs ≈8% \(resends chat\) · still on track\n/,
  );
  assert.doesNotMatch(line, /pace ▮/);
  // the send clears it
  h.run('hook.mjs', {
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: '/nonexistent',
    prompt: '[placeholder]',
  });
  assert.equal(existsSync(file), false);
  assert.match(h.run('statusline.mjs', snap).stdout, /✓ on track/);
  // a small chat writes nothing
  h.run('hook.mjs', { ...ev, context_tokens: 90_000 });
  assert.equal(existsSync(file), false);
  // the timeout: an old launch is not shown
  h.run('hook.mjs', ev);
  const old = JSON.parse(readFileSync(file, 'utf8'));
  writeFileSync(file, JSON.stringify({ ...old, until: Date.now() - 1 }));
  assert.doesNotMatch(h.run('statusline.mjs', snap).stdout, /model switch/);
});

test('a switch launch on a red line keeps the drain second line', () => {
  const h = home();
  const reset = resetS(120);
  h.pace(60, reset); // 0.5%/min, 40 left → 80 min, 40 min before the reset: red
  const sid = 'sw-red';
  const t = Date.now();
  writeFileSync(
    path.join(h.dir, 'sessions', `${sid}.turns.jsonl`),
    `${JSON.stringify({ t: t - 2 * MIN, start: t - 4 * MIN, model: 'opus-5-5', pct: 3, helper: 0 })}\n`,
  );
  const snap = snapshot(sid, {
    model: 'claude-opus-5-5',
    name: 'Opus 5.5',
    ctx: 400_000,
    meter: 60,
    reset,
  });
  h.run('statusline.mjs', snap);
  h.run('hook.mjs', {
    hook_event_name: 'PreModelSwitch',
    session_id: sid,
    to_model: 'claude-fable-5-2',
    context_tokens: 400_000,
  });
  const out = h.run('statusline.mjs', snap).stdout;
  assert.match(
    out,
    /⚠ model switch costs ≈8% \(resends chat\) · would run out \S+\n⠀+· top drain: /,
  );
});

test('simulate.mjs cold and switch drive the status line end to end, tagged sim', () => {
  const h = home();
  const reset = resetS(100);
  h.pace(40, reset);
  const sid = 'sim-1';
  const snap = snapshot(sid, { model: 'claude-fable-5-2', name: 'Fable 5.2', ctx: 680_000, reset });
  h.run('statusline.mjs', snap);
  const c = h.run('simulate.mjs', '', ['cold', sid]);
  assert.equal(c.status, 0);
  const cold = h.run('statusline.mjs', snap).stdout;
  assert.match(cold, /· ⚠ next send costs ≈14% \(reloads chat\) · would run out \S+ · sim\n/);
  // the live snapshot on disk stays warm: the overlay is beside it
  const disk = JSON.parse(readFileSync(path.join(h.dir, 'sessions', `${sid}.json`), 'utf8'));
  assert.equal(disk.prompt_cache.warm, true);
  // the send clears the overlay
  h.run('hook.mjs', {
    hook_event_name: 'UserPromptSubmit',
    session_id: sid,
    transcript_path: '/nonexistent',
    prompt: '[placeholder]',
  });
  assert.match(h.run('statusline.mjs', snap).stdout, /✓ on track/);

  const s = h.run('simulate.mjs', '', ['switch', 'claude-opus-5-5', sid]);
  assert.equal(s.status, 0);
  assert.match(s.stdout, /switch to claude-opus-5-5/);
  // 680k × Opus 5.9 = 4 points
  assert.match(
    h.run('statusline.mjs', snap).stdout,
    /· ⚠ model switch costs ≈4% \(resends chat\) · still on track · sim\n/,
  );
  assert.equal(h.run('simulate.mjs', '', ['switch']).status, 1, 'a model id is required');
});
