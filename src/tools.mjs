// Tool results per turn (range plan S3): what each tool call put into the chat.
//   sessions/<sid>.tools.jsonl   {t, tool, kind, tokens}   appended by hook.mjs on PostToolUse,
//                                emptied when the next turn opens (ledger.mjs openTurn)
// kind: 'browser' (isBrowserTool), 'images' (the result carries an image, or a
// Read of an image file), else 'reads'. ledger.mjs prices them at Stop (parts.mjs).
//
// tokens is an estimate from the hook's tool_response, sized as the model sees it:
//   text    chars ÷ CHARS_PER_TOKEN. Measured 2026-11-12 on 40 transcripts of this repo
//           (5,300 calls that followed only tool results): the next call's cache write,
//           less the previous call's output and ~180 tokens of per-call overhead, came to
//           2.4–2.9 chars per token for results of 500–20k chars. chars ÷ 4 read ~0.6× low.
//   image   IMAGE_TOKENS each: the median over 480 calls with screenshots was ~1,240
//           (quartiles 710–1,680)
//   Edit / Write / NotebookEdit   a short confirmation (EDIT_CHARS); tool_response holds
//           the whole file, which the model does not get back
//   saved to a file   Claude Code keeps a long result out of the chat and sends a ~2k
//           preview: Bash with persistedOutputPath, and any built-in tool but Read over
//           PERSIST_CHARS (seen on WebFetch: 52–65k chars raw, 2.1k in the chat).
//           [assumption] the same cap holds for the other built-in tools; MCP results
//           are left as they are
//   keys that are not sent to the model (the helper's prompt, diffs, base64) are skipped
// This file imports nothing heavy: PostToolUse runs after every tool call.

import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
// browser tools by name
const BROWSER = /^mcp__.*browser|^mcp__claude-in-chrome__|chrome-devtools/i;
export const isBrowserTool = (name) => BROWSER.test(name || '');
import { sessionsDir } from './state.mjs';

export const CHARS_PER_TOKEN = 3;
export const IMAGE_TOKENS = 1250;
export const BIG_RESULT_TOKENS = 10_000; // rules.mjs row 11's threshold
const EDIT_CHARS = 200;
const PREVIEW_CHARS = 2200;
const PERSIST_CHARS = 50_000;
const MAX_DEPTH = 6;
const EDITS = /^(Edit|Write|MultiEdit|NotebookEdit)$/;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i;
const SKIP = new Set([
  'originalFile',
  'structuredPatch',
  'bashEditDiff',
  'gitOperation',
  'oldString',
  'newString',
  'prompt',
  'data',
  'filePath',
  'type',
]);

const safe = (sid) => String(sid || 'unknown').replace(/[^A-Za-z0-9_-]/g, '_');
export const toolsPath = (sid) => path.join(sessionsDir(), `${safe(sid)}.tools.jsonl`);

// { chars, images } of one tool_response
export function resultSize(tool, resp, input) {
  if (EDITS.test(tool || '')) return { chars: EDIT_CHARS, images: 0 };
  if (resp?.persistedOutputPath) return { chars: PREVIEW_CHARS, images: 0 };
  let chars = 0;
  let images = 0;
  const walk = (v, depth) => {
    if (typeof v === 'string') chars += v.length;
    else if (Array.isArray(v)) {
      if (depth < MAX_DEPTH) for (const x of v) walk(x, depth + 1);
    } else if (v && typeof v === 'object') {
      if (v.type === 'image' || v.isImage === true) {
        images++;
        return;
      }
      if (depth < MAX_DEPTH) for (const k in v) if (!SKIP.has(k)) walk(v[k], depth + 1);
    }
  };
  walk(resp, 0);
  // Read returns the file with a line-number prefix on every line
  if (tool === 'Read' && Number.isFinite(resp?.file?.numLines)) chars += 7 * resp.file.numLines;
  if (!images && tool === 'Read' && IMAGE_FILE.test(input?.file_path || '')) images = 1;
  if (chars > PERSIST_CHARS && tool !== 'Read' && !/^mcp__/.test(tool || '')) chars = PREVIEW_CHARS;
  return { chars, images };
}

// mcp__claude-in-chrome__get_page_text → get_page_text; Read → Read
export const shortTool = (name) =>
  String(name || 'tool')
    .replace(/^mcp__.*__/, '')
    .slice(0, 24);

// PostToolUse: one line for this call. A call made inside a helper is skipped: its cost
// is in the helper's own transcript ([assumption] hook input carries agent_id there).
export function noteTool(sid, input, now = Date.now()) {
  if (input.agent_id) return null;
  const tool = input.tool_name;
  if (!tool) return null;
  const { chars, images } = resultSize(tool, input.tool_response, input.tool_input);
  const tokens = Math.round(chars / CHARS_PER_TOKEN + images * IMAGE_TOKENS);
  const kind = isBrowserTool(tool) ? 'browser' : images ? 'images' : 'reads';
  const rec = { t: now, tool: shortTool(tool), kind, tokens };
  const line = `${JSON.stringify(rec)}\n`;
  try {
    appendFileSync(toolsPath(sid), line);
  } catch {
    mkdirSync(sessionsDir(), { recursive: true });
    appendFileSync(toolsPath(sid), line);
  }
  return rec;
}

// the lines of a chunk of the tools file
export function parseTools(text) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (Number.isFinite(r.tokens) && r.tokens >= 0) out.push(r);
    } catch {}
  }
  return out;
}

// the one result over BIG_RESULT_TOKENS, the largest if several; null if none
export function bigResult(items) {
  let top = null;
  for (const r of items || [])
    if (r.tokens > BIG_RESULT_TOKENS && r.tokens > (top?.tokens ?? 0)) top = r;
  return top ? { tool: top.kind === 'browser' ? 'browser' : top.tool, tokens: top.tokens } : null;
}
