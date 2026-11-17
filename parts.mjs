// Parts of a turn (range plan S3): what a turn's points were spent on, for the top drain.
//   helpers   exact: the helpers' own calls (ledger.mjs reads their files)
//   answers   exact: output tokens × the output weight, per call          "long answers"
//   browser   estimate: PostToolUse sizes (tools.mjs) × the turn model's cache-write weight
//   images    estimate, same
//   reads     estimate, same: every other tool result                      "big reads"
//   reload    estimate: the cache writes of calls that wrote more than they read and
//             at least RELOAD_MIN tokens (a cold resume, a model switch, an edited
//             history: the chat is written again instead of read from the cache), less
//             what the tool results already claim                          "chat reload"
//   fable     the rest of the cache writes when the turn's model is Fable (the prompt,
//             earlier replies written back, estimate error): not explained by anything
//             above, and 3.4× what Opus charges for the same tokens        "Fable"
//   other     the same rest on any other model
// The estimates are capped at the turn's cache-write points, so the parts always sum to
// the turn's pct. Tool tokens that did not fit (Stop can run before the call that writes
// the last result reaches the transcript) are returned as `left` and offered to the
// catch-up booking of the same turn.

import { isFable, w } from './price.mjs';

export const RELOAD_MIN = 50_000; // tokens; under this it is a new chat's first load
export const KINDS = ['browser', 'images', 'reads'];
const r4 = (x) => Math.round(x * 1e4) / 1e4;

// calls: [{model, outTokens, writeTokens, readTokens}] (the main chat's, unseen ones only)
// model: the turn's main model key; helperPct: points; tools: {browser, images, reads} tokens
export function split(calls, model, helperPct = 0, tools = {}) {
  let answers = 0;
  let writes = 0;
  let cold = 0;
  for (const c of calls) {
    const { w_out, w_write } = w(c.model);
    answers += (w_out * (c.outTokens || 0)) / 1e6;
    const p = (w_write * (c.writeTokens || 0)) / 1e6;
    writes += p;
    if ((c.writeTokens || 0) >= RELOAD_MIN && (c.readTokens || 0) < c.writeTokens) cold += p;
  }
  const ww = model ? w(model).w_write : 0;
  const want = KINDS.map((k) => (ww * (tools[k] || 0)) / 1e6);
  const wanted = want.reduce((a, b) => a + b, 0);
  const fit = wanted > writes ? (wanted > 0 ? writes / wanted : 0) : 1;
  const parts = { helpers: helperPct, answers };
  const left = {};
  KINDS.forEach((k, i) => {
    parts[k] = want[i] * fit;
    const rest = Math.round((tools[k] || 0) * (1 - fit));
    if (rest > 0) left[k] = rest;
  });
  const reload = Math.min(cold, Math.max(0, writes - wanted * fit));
  parts.reload = reload;
  const rest = Math.max(0, writes - wanted * fit - reload);
  parts[model && isFable(model) ? 'fable' : 'other'] = rest;
  const out = {};
  for (const [k, v] of Object.entries(parts)) if (r4(v) > 0) out[k] = r4(v);
  return { parts: out, left: Object.keys(left).length ? left : null };
}

// a ledger line's parts; a line from before S3 has none: its helper cost and the rest
export function partsOf(t) {
  if (t.parts && typeof t.parts === 'object') return t.parts;
  const helpers = Math.min(t.helper || 0, t.pct || 0);
  return { helpers, other: Math.max(0, (t.pct || 0) - helpers) };
}
