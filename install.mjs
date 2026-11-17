#!/usr/bin/env node
// Adds ccrunway to Claude Code.
//   ccrunway install [--settings <path>] [--dry-run] [--node <abs path>] [--force] [--json]
// - copies the runtime files to CCRUNWAY_HOME/app (default ~/.ccrunway/app), so clearing
//   the npx cache breaks nothing
// - backs up settings.json to CCRUNWAY_HOME/settings.<timestamp>.json
// - saves the current statusLine in CCRUNWAY_HOME/install.json; statusline.mjs runs it
//   first and prints its output above the runway line
// - sets statusLine to ours and adds hook.mjs on UserPromptSubmit, Stop, PostToolUse and
//   PreModelSwitch, each in its own group, 5 s timeout, with the absolute node path;
//   everyone else's hooks stay. A CCRUNWAY_HOME set now goes into each command, and into
//   the skill's (CCRUNWAY_HOME="…" "<node>" "…/hook.mjs"), so they reach that folder
//   however Claude Code was started
// - writes the `ccrunway` skill next to the settings file (skills/ccrunway/SKILL.md)
// - re-running is idempotent: our old entries are removed before the new ones go in, and
//   uninstall keeps pointing at the first backup and the first saved statusLine
// --dry-run prints the resulting settings JSON and writes nothing. --node <absolute path>
// picks the node the hooks run with (default: this one, by its PATH name). --json prints
// one object instead of the text (cli.mjs has the contract); --dry-run --json puts the
// settings under settings_after.
// Preflight, before any write (the data folder included) and on --dry-run too: macOS
// (UNSUPPORTED_OS; --force installs anyway, untested), node 20+ here (NODE_TOO_OLD) and
// at --node (BAD_NODE), settings.json readable as JSON (SETTINGS_UNREADABLE).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  MIN_NODE,
  addRunway,
  args,
  binMajor,
  cliCmd,
  copyApp,
  here,
  isOurStatus,
  nodeMajor,
  platform,
  serialize,
  settingsPath,
  stableNode,
  stripHooks,
} from './settings.mjs';
import { home, readJSON, writeJSON } from './state.mjs';

const opt = args(process.argv.slice(2));
const json = opt.json === true;
const emit = (obj) => process.stdout.write(`${JSON.stringify({ schema: 1, ok: true, ...obj })}\n`);
function fail(code, message, fix) {
  if (json) emit({ ok: false, error: { code, message, fix } });
  else process.stderr.write(`${message}${fix ? `\n  fix: ${fix}` : ''}\n`);
  process.exit(1);
}
const file = settingsPath(opt);

if (platform() !== 'darwin' && opt.force !== true)
  fail(
    'UNSUPPORTED_OS',
    `ccrunway supports macOS only, and this is ${platform()}`,
    'npx ccrunway install --force (untested)',
  );
if ((nodeMajor() ?? 0) < MIN_NODE)
  fail(
    'NODE_TOO_OLD',
    `ccrunway needs node ${MIN_NODE} or newer; this is ${process.version}`,
    `run it with node ${MIN_NODE}+, or npx ccrunway install --node <path to node ${MIN_NODE}+>`,
  );
if (opt.node != null) {
  const n = opt.node;
  const v = typeof n === 'string' && path.isAbsolute(n) && existsSync(n) ? binMajor(n) : null;
  if (v == null || v < MIN_NODE)
    fail(
      'BAD_NODE',
      typeof n !== 'string' || !path.isAbsolute(n)
        ? `--node takes an absolute path, not "${n}"`
        : !existsSync(n)
          ? `--node ${n}: no such file`
          : v == null
            ? `--node ${n}: \`${n} --version\` did not run`
            : `--node ${n} is node ${v}; ccrunway needs ${MIN_NODE}+`,
      `npx ccrunway install --node <absolute path to node ${MIN_NODE}+>`,
    );
}

const existed = existsSync(file);
const text = existed ? readFileSync(file, 'utf8') : '{}\n';
let settings;
try {
  settings = JSON.parse(text);
} catch (e) {
  fail(
    'SETTINGS_UNREADABLE',
    `can't read ${file} as JSON: ${e.message}`,
    `fix the JSON in ${file} by hand, or point --settings at another file`,
  );
}
const meta = readJSON(path.join(home(), 'install.json'), null);
const again = isOurStatus(settings.statusLine) && meta?.settingsPath === file;

// the statusLine we wrap and uninstall puts back
let prevStatusLine = settings.statusLine ?? null;
if (isOurStatus(prevStatusLine)) prevStatusLine = again ? (meta.prevStatusLine ?? null) : null;

const node = opt.node ?? stableNode();
const next = addRunway(stripHooks(structuredClone(settings)), node);

if (opt['dry-run']) {
  if (json) emit({ dry_run: true, settings: file, settings_after: next });
  else process.stdout.write(serialize(next));
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
let skillAt = skillFile;
try {
  const prev = existsSync(skillFile) ? readFileSync(skillFile, 'utf8') : null;
  if (existsSync(skillDir) && !/^name: ccrunway$/m.test(prev || '')) {
    skillNote = `skill: ${skillDir} exists and is not ccrunway's; left alone`;
    skillAt = null;
  } else {
    const body = readFileSync(path.join(here, 'skill', 'SKILL.md'), 'utf8').replaceAll('{{CLI}}', cliCmd(node));
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(skillFile, body);
  }
} catch {
  skillNote = 'skill: could not write it; Claude Code will not know the ccrunway commands';
  skillAt = null;
}

// the menu bar item, when SwiftBar is already on this Mac: nothing is downloaded here
// (`menubar on` asks before installing SwiftBar). With a plugin folder our link goes in
// beside the user's plugins; with none, SwiftBar gets ccrunway's own folder, so no one
// else's setup changes. --no-menubar skips it; `menubar off` removes it.
let menubar = { on: false, detail: null, hint: 'npx ccrunway menubar on' };
if (opt['no-menubar']) menubar.detail = 'skipped (--no-menubar)';
else {
  const sb = await import('./swiftbar.mjs');
  if (!sb.swiftbarApp()) menubar.detail = 'SwiftBar is not installed; `npx ccrunway menubar on` installs it after asking';
  else {
    const said = [];
    const info = {};
    const code = sb.menubarOn({ yes: false, prompt: false, out: (l) => said.push(l), info });
    menubar =
      code === 0
        ? { on: true, detail: said[0]?.replace(/^menu bar: /, '') ?? null, hint: 'npx ccrunway menubar off' }
        : { on: false, detail: said.join('; ') || info.code || 'not set up', hint: 'npx ccrunway menubar on' };
  }
}

const wrapped = prevStatusLine?.command;
if (json) {
  emit({
    settings: file,
    backup,
    wraps: wrapped ?? null,
    skill: skillAt,
    ...(skillAt ? {} : { skill_note: skillNote.replace(/^skill: /, '') }),
    app,
    node,
    version: readJSON(path.join(here, 'package.json'), {})?.version ?? null,
    menubar,
    next_step: 'open a new Claude Code session',
    next_steps: ['open a new Claude Code session', 'npx ccrunway doctor'],
  });
  process.exit(0);
}
process.stdout.write(
  [
    ...lines,
    `ccrunway installed in ${file}`,
    `backup: ${backup}`,
    wrapped ? `your status line stays on top: ${wrapped}` : 'no earlier status line to wrap',
    skillNote,
    menubar.on
      ? `menu bar: on (${menubar.detail}); \`npx ccrunway menubar off\` removes it`
      : `menu bar: off (${menubar.detail}); \`npx ccrunway menubar on\` adds it`,
    'open a new Claude Code session to see the runway line',
    'check it: npx ccrunway doctor',
    '',
  ].join('\n'),
);
