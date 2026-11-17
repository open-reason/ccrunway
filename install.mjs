#!/usr/bin/env node
// Adds ccrunway to Claude Code.
//   ccrunway install [--settings <path>] [--dry-run]
// - copies the runtime files to CCRUNWAY_HOME/app (default ~/.ccrunway/app), so clearing
//   the npx cache breaks nothing
// - backs up settings.json to CCRUNWAY_HOME/settings.<timestamp>.json
// - saves the current statusLine in CCRUNWAY_HOME/install.json; statusline.mjs runs it
//   first and prints its output above the runway line
// - sets statusLine to ours and adds hook.mjs on UserPromptSubmit, Stop, PostToolUse and
//   PreModelSwitch, each in its own group, 5 s timeout, with the absolute node path;
//   everyone else's hooks stay
// - writes the `ccrunway` skill next to the settings file (skills/ccrunway/SKILL.md)
// - re-running is idempotent: our old entries are removed before the new ones go in, and
//   uninstall keeps pointing at the first backup and the first saved statusLine
// --dry-run prints the resulting settings JSON and writes nothing. --node <absolute path>
// picks the node the hooks run with (default: this one, by its PATH name).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  addRunway,
  args,
  copyApp,
  here,
  isOurStatus,
  serialize,
  settingsPath,
  stableNode,
  stripHooks,
} from './settings.mjs';
import { home, readJSON, writeJSON } from './state.mjs';

const opt = args(process.argv.slice(2));
const file = settingsPath(opt);
const existed = existsSync(file);
const text = existed ? readFileSync(file, 'utf8') : '{}\n';
const settings = JSON.parse(text);
const meta = readJSON(path.join(home(), 'install.json'), null);
const again = isOurStatus(settings.statusLine) && meta?.settingsPath === file;

// the statusLine we wrap and uninstall puts back
let prevStatusLine = settings.statusLine ?? null;
if (isOurStatus(prevStatusLine)) prevStatusLine = again ? (meta.prevStatusLine ?? null) : null;

const node = typeof opt.node === 'string' && path.isAbsolute(opt.node) ? opt.node : stableNode();
const next = addRunway(stripHooks(structuredClone(settings)), node);

if (opt['dry-run']) {
  process.stdout.write(serialize(next));
  process.exit(0);
}

const lines = [];
mkdirSync(home(), { recursive: true });

// the code, copied next to the data
const app = copyApp();


const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = path.join(home(), `settings.${stamp}.json`);
writeFileSync(backup, text);
mkdirSync(path.dirname(file), { recursive: true });
writeFileSync(file, serialize(next));
writeJSON(path.join(home(), 'install.json'), {
  settingsPath: file,
  // a re-install keeps pointing uninstall at the pre-install backup
  backup: again && meta.backup ? meta.backup : backup,
  existed: again && meta.existed != null ? meta.existed : existed,
  prevStatusLine,
  node,
  app,
  version: readJSON(path.join(here, 'package.json'), {})?.version ?? null,
  at: new Date().toISOString(),
});

// the skill, so Claude Code can run the CLI when you ask it to ("mute ccrunway for 2h")
const skillDir = path.join(path.dirname(file), 'skills', 'ccrunway');
const skillFile = path.join(skillDir, 'SKILL.md');
let skillNote = `skill: ${skillFile}`;
try {
  const prev = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null;
  if (existsSync(skillDir) && !/^name: ccrunway$/m.test(prev || '')) {
    skillNote = `skill: ${skillDir} exists and is not ccrunway's; left alone`;
  } else {
    const body = readFileSync(path.join(here, 'skill', 'SKILL.md'), 'utf8').replaceAll(
      '{{CLI}}',
      `"${node}" "${path.join(app, 'cli.mjs')}"`,
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, body);
  }
} catch {
  skillNote = 'skill: could not write it; Claude Code will not know the ccrunway commands';
}

const wrapped = prevStatusLine?.command;
process.stdout.write(
  [
    ...lines,
    `ccrunway installed in ${file}`,
    `backup: ${backup}`,
    wrapped ? `your status line stays on top: ${wrapped}` : 'no earlier status line to wrap',
    skillNote,
    'open a new Claude Code session to see the runway line',
    '',
  ].join('\n'),
);
