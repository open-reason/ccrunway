#!/usr/bin/env node
// Removes ccrunway from Claude Code.
//   ccrunway uninstall [--settings <path>] [--dry-run]
// Removes only ccrunway's entries (its four hooks and its status line) and puts back the
// statusLine that was there before install (install.json). When the result equals the
// pre-install backup, the backup's exact bytes are written, so the file is byte-identical
// to it; a settings file install created is removed again. Removes the skill install
// wrote, and the menu bar item (`ccrunway menubar off`) if it is on. The data in CCRUNWAY_HOME stays (delete the folder to remove it).
// --json prints one object instead of the text (cli.mjs has the contract).

import { existsSync, readFileSync, readdirSync, rmSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { args, isOurHook, isOurStatus, serialize, settingsPath, stripHooks } from './settings.mjs';
import { home, readJSON } from './state.mjs';

const opt = args(process.argv.slice(2));
const json = opt.json === true;
const emit = (obj) => process.stdout.write(`${JSON.stringify({ schema: 1, ok: true, ...obj })}\n`);
const file = settingsPath(opt);
if (!existsSync(file)) {
  if (json)
    emit({ ok: false, error: { code: 'NO_SETTINGS', message: `no settings at ${file}`, fix: null } });
  else process.stderr.write(`no settings at ${file}\n`);
  process.exit(1);
}
let parsed;
try {
  parsed = JSON.parse(readFileSync(file, 'utf8'));
} catch (e) {
  const message = `can't read ${file} as JSON: ${e.message}`;
  if (json)
    emit({ ok: false, error: { code: 'SETTINGS_UNREADABLE', message, fix: `fix the JSON in ${file}` } });
  else process.stderr.write(`${message}\n`);
  process.exit(1);
}
const before = JSON.stringify(parsed);
const was =
  isOurStatus(parsed.statusLine) ||
  Object.values(parsed.hooks || {})
    .flat()
    .some((g) => (g?.hooks || []).some(isOurHook));
const settings = stripHooks(parsed, isOurHook);
const meta = readJSON(path.join(home(), 'install.json'), null);
const mine = meta && path.resolve(meta.settingsPath) === file;

if (isOurStatus(settings.statusLine)) {
  const prev = mine ? meta.prevStatusLine : null;
  settings.statusLine = prev || undefined;
}

let out = serialize(settings);
let restored = false;
if (mine && meta.backup && existsSync(meta.backup)) {
  const bytes = readFileSync(meta.backup, 'utf8');
  try {
    if (JSON.stringify(JSON.parse(bytes)) === JSON.stringify(settings)) {
      out = bytes;
      restored = true;
    }
  } catch {}
}
// install created the file and nothing else is in it
const remove = mine && meta.existed === false && JSON.stringify(settings) === '{}';

if (opt['dry-run']) {
  if (json) emit({ dry_run: true, settings: file, settings_after: remove ? null : JSON.parse(out) });
  else process.stdout.write(remove ? '' : out);
  process.exit(0);
}
if (remove) unlinkSync(file);
else writeFileSync(file, out);

// the skill install wrote
const skillDir = path.join(path.dirname(file), 'skills', 'ccrunway');
let skillRemoved = false;
try {
  if (/^name: ccrunway$/m.test(readFileSync(path.join(skillDir, 'SKILL.md'), 'utf8'))) {
    rmSync(skillDir, { recursive: true, force: true });
    skillRemoved = true;
  }
  const skills = path.dirname(skillDir);
  if (!readdirSync(skills).length) rmdirSync(skills);
} catch {}

// the menu bar item, if `ccrunway menubar on` set one up
const log = [];
let menubarOff = false;
if (existsSync(path.join(home(), 'menubar.json'))) {
  try {
    (await import('./swiftbar.mjs')).menubarOff({
      out: (l) => (json ? log.push(l) : process.stdout.write(`${l}\n`)),
    });
    menubarOff = true;
  } catch {}
}

if (json) {
  emit({
    settings: file,
    was_installed: was,
    changed: remove || before !== JSON.stringify(settings),
    // deleting the file install created wins, as in the text
    restored_from_backup: restored && !remove,
    deleted_settings: remove,
    skill_removed: skillRemoved,
    menubar_off: menubarOff,
    data_kept: home(),
    log,
  });
  process.exit(0);
}

process.stdout.write(
  `ccrunway removed from ${file}${remove ? ' (deleted it: install had created it)' : restored ? ' (restored the backup bytes)' : ''}\n` +
    `your data stays in ${home()}; delete that folder to remove it too\n`,
);
