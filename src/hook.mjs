#!/usr/bin/env node
// ccrunway hook: keeps the turn ledger (ledger.mjs) and says nothing.
//   UserPromptSubmit   opens a turn: its start time and the transcript's byte size
//   PostToolUse        appends {t, tool, kind, tokens} for the result to
//                      sessions/<sid>.tools.jsonl (tools.mjs); append-only, no reads
//   Stop               prices the turn's API calls (and its helpers') from the
//                      transcript and appends {t, start, model, pct, helper, hmodel, parts}
//                      to sessions/<sid>.turns.jsonl
//   PreModelSwitch     writes a pending switch launch (launch.mjs, S4) for the status
//                      line; prints nothing, so the switch goes ahead unasked
//   UserPromptSubmit   also clears a pending switch launch and simulate's cold overlay
// Local files only, no output. Never breaks Claude Code: any error → exit 0, no output.
// Modules load inside the try, per event, so a broken one cannot fail the hook and
// PostToolUse loads only what it needs.

import { readFileSync } from 'node:fs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const sid = input.session_id;
  const tp = input.transcript_path;
  const ev = input.hook_event_name;
  if (sid && ev === 'PostToolUse') (await import('./tools.mjs')).noteTool(sid, input);
  else if (sid && ev === 'PreModelSwitch') (await import('./launch.mjs')).noteSwitch(sid, input);
  else if (sid && ev === 'UserPromptSubmit') {
    try {
      (await import('./launch.mjs')).clearLaunch(sid);
    } catch {}
    if (tp) (await import('./ledger.mjs')).openTurn(sid, tp);
  } else if (sid && tp && ev === 'Stop') (await import('./ledger.mjs')).closeTurn(sid, tp);
} catch {}
process.exitCode = 0;
