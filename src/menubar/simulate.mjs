#!/usr/bin/env node
// Show a verdict in the menu bar for 2 minutes, tagged `· sim` in the dropdown, without
// touching the real meter feeds, as simulate.mjs range does for the Claude
// status line.
//   node menubar/simulate.mjs range cold|green|amber|red [claude|codex]
//   node menubar/simulate.mjs range off
//   green = runs out 60 min after the reset, amber = 10 min after, red = 40 min before,
//   against the tool's live reset (or one 2 h away when it has none); the bars follow the
//   rate that run-out implies (menubar.mjs simulated). With no tool named, both tools.
//   The overlay is CCRUNWAY_HOME/menubar-range.sim.json; `off` removes it. SwiftBar picks it
//   up on its next 5 s refresh.
//   S3: amber or red shows the `Top drain:` row, from the real chats, parts and meter (as the
//   status line's simulation does); a tool with nothing spent in 20 min has none to show.
//   For a recorded Codex chat: codex-pace.mjs --replay <file> --at <time> --sim amber|red.

import { rmSync } from 'node:fs';
import { readJSON, writeJSON } from '../state.mjs';
import { SIM_FILE, SIM_MARGIN } from './menubar.mjs';

const TTL_MS = 120_000;
const TOOLS = ['claude', 'codex'];
const [cmd, state, tool] = process.argv.slice(2);

if (cmd === 'range' && state === 'off' && !tool) {
  rmSync(SIM_FILE(), { force: true });
  process.stdout.write('menu bar simulation off\n');
  process.exit(0);
}
if (cmd !== 'range' || !(state in SIM_MARGIN) || (tool && !TOOLS.includes(tool))) {
  process.stderr.write(
    'usage: node simulate.mjs range cold|green|amber|red [claude|codex] | range off\n',
  );
  process.exit(1);
}
const now = Date.now();
const sim = readJSON(SIM_FILE()) || {};
for (const t of tool ? [tool] : TOOLS) sim[t] = { state, until: now + TTL_MS };
writeJSON(SIM_FILE(), sim);
process.stdout.write(
  `menu bar shows ${state} for ${tool ? (tool === 'claude' ? 'Claude Code' : 'Codex') : 'both tools'} for 2 minutes\n`,
);
