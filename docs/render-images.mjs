// The README's menu bar images, from ccrunway's own menu bar code (render(), titlePng(),
// simulated()) with example chats, never your data: the title on a dark menu bar, and the
// dropdown laid out as a light macOS menu (HTML → headless Chrome screenshot).
//   node docs/render-images.mjs        writes docs/images/menubar-*.png
// Needs Google Chrome in /Applications.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, 'images');
const tmp = mkdtempSync(path.join(os.tmpdir(), 'ccrunway-images-'));
process.env.CCRUNWAY_HOME = tmp; // nothing is read from or written to the real data folder
mkdirSync(out, { recursive: true });
const mb = await import(pathToFileURL(path.join(here, '..', 'src', 'menubar', 'menubar.mjs')).href);
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MIN = 60_000;
const now = Date.now();

const claudeBase = () => ({
  meter: 58,
  resetsAt: Math.ceil((now + 75 * MIN) / (5 * MIN)) * 5 * MIN,
  chats: [
    { id: 'a1', name: 'fix-login-flow', perHour: 14, nowPerHour: 19, share: 0.55, model: 'Opus 5.5', ctx: 182_000, lastT: now - MIN,
      helpers: [{ name: 'write tests', model: 'Sonnet', perHour: 5 }] },
    { id: 'a2', name: 'docs-update', perHour: 6, nowPerHour: 0, share: 0.25, model: 'Sonnet 5.5', ctx: 64_000, lastT: now - 3 * MIN, helpers: [] },
    { id: 'a3', name: 'refactor-api', perHour: 3, nowPerHour: 0, share: 0.12, model: 'Opus 5.5', ctx: 41_000, lastT: now - 9 * MIN, helpers: [] },
  ],
  drain: { chat: 'a1', label: 'long chat', share: 0.42 },
});
const codexBase = () => ({
  meter: 31,
  resetsAt: Math.ceil((now + 140 * MIN) / (5 * MIN)) * 5 * MIN,
  chats: [
    { id: 'c1', name: 'code-review', perHour: 9, share: 1, model: 'gpt-5.6-sol', ctx: 96_000, lastT: now - 2 * MIN,
      helpers: [{ task: 'scan dependencies', model: 'gpt-6-astra', perHour: 3, depth: 1 }] },
  ],
});
// the simulated tool rate, split over the example chats in their proportions, so the rows
// add up to the tool line as they do in the real menu
const sim = (t, state) => {
  const s = { ...mb.simulated(t, state, now), sim: false };
  const rows = s.chats.flatMap((c) => [c, ...c.helpers]);
  const sum = s.chats.reduce((n, c) => n + c.perHour, 0);
  const k = s.perHour / sum;
  for (const r of rows) {
    r.perHour = Math.round(r.perHour * k);
    if (r.nowPerHour) r.nowPerHour = Math.round(r.nowPerHour * k);
  }
  return s;
};

const shot = (name, html, w, h) => {
  const file = path.join(tmp, `${name}.html`);
  writeFileSync(file, html);
  execFileSync(CHROME, ['--headless=new', '--hide-scrollbars', '--force-device-scale-factor=2',
    `--window-size=${w},${h}`, `--screenshot=${path.join(out, `${name}.png`)}`, pathToFileURL(file).href],
    { stdio: 'ignore' });
};

// the title: the PNG ccrunway hands SwiftBar, on a dark menu bar
const titleHtml = (png, width) => `<!doctype html><html><body style="margin:0;background:#2b2b2d">
<div style="height:42px;display:flex;align-items:center;padding:0 14px">
<img src="data:image/png;base64,${png.toString('base64')}" style="width:${width / 2}px;height:18px"></div></body></html>`;
for (const [name, c, x] of [
  ['title-green', 'green', 'green'],
  ['title-amber', 'amber', 'green'],
  ['title-red', 'red', 'amber'],
]) {
  const { png, width } = mb.titlePng(sim(claudeBase(), c), sim(codexBase(), x));
  shot(`menubar-${name}`, titleHtml(png, width), Math.round(width / 2) + 28, 42);
}

// the dropdown: SwiftBar's rows as a light menu (light colours of `color=light,dark`)
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function dropdown(text) {
  const lines = text.split('\n').slice(2); // title row and its separator
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === '---') { rows.push('<hr>'); continue; }
    if (l.startsWith('--')) continue; // submenu
    const [label, params = ''] = l.split(' | ');
    const p = Object.fromEntries(params.split(' ').map((kv) => kv.split('=')));
    const colour = p.color ? p.color.split(',')[0] : '#1d1d1f';
    const mono = p.font === 'Menlo';
    const sub = lines[i + 1]?.startsWith('--') && !lines[i + 1].startsWith('---');
    let body = esc(label);
    if (p.md === 'true') body = body.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    const icon = p.templateImage
      ? `<img src="data:image/png;base64,${p.templateImage}" style="width:16px;height:16px;margin-right:7px;vertical-align:-2px">`
      : '';
    rows.push(`<div class="row${mono ? ' mono' : ''}" style="color:${colour};font-size:${p.size || 13}px">${icon}<span>${body}</span>${sub ? '<i>›</i>' : ''}</div>`);
  }
  return rows;
}
const menuHtml = (rows) => `<!doctype html><html><head><style>
body{margin:0;background:#fff;font:13px -apple-system,BlinkMacSystemFont,"Helvetica Neue",sans-serif}
.menu{margin:10px;width:444px;padding:5px 0;background:#f3f3f3;border:1px solid #d4d4d4;border-radius:9px;box-shadow:0 6px 18px rgba(0,0,0,.14);display:inline-block}
.row{display:flex;align-items:center;height:22px;padding:0 14px;white-space:pre}
.row span{flex:1}.row i{font-style:normal;margin-left:18px;color:#555}
.mono span{font-family:Menlo,monospace}
hr{border:0;border-top:1px solid #dcdcdc;margin:5px 10px}
</style></head><body><div class="menu">${rows.join('\n')}</div></body></html>`;
for (const [name, c, x] of [
  ['dropdown-green', 'green', 'green'],
  ['dropdown-red', 'red', 'amber'],
]) {
  const rows = dropdown(mb.render(sim(claudeBase(), c), sim(codexBase(), x), now));
  const h = 20 + 10 + rows.reduce((s, r) => s + (r === '<hr>' ? 11 : 22), 0) + 2;
  shot(`menubar-${name}`, menuHtml(rows), 466, h);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${out}/menubar-*.png`);
