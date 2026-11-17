// Status line colours: three semantic colours, accent (fine), warning (careful),
// danger (wrong). Everything else stays the terminal's own ink; colour is a
// signal, not decoration.
//
// Light themes get the tokens below as 24-bit colour. Dark themes get the
// on-dark tokens where there are any (accent, muted); warning and danger
// have no on-dark token, so they fall back to the terminal's own yellow
// and red, which every dark theme tunes for contrast.
// NO_COLOR=1 turns colour off.

import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TOKENS = {
  'or-accent': '#0b7a58',
  'or-ink-muted': '#6b665c',
  'or-warning': '#8a5a12',
  'or-danger': '#a5271d',
  'or-accent-on-dark': '#4ecfa1',
  'or-muted-on-dark': '#a8a294',
};

// the tokens as hex, {'or-accent': '#0b7a58', …}; the menu bar draws with these too
export const tokens = () => ({ ...TOKENS });

function dark() {
  if (process.env.CCRUNWAY_THEME) return /dark/i.test(process.env.CCRUNWAY_THEME);
  try {
    const s = JSON.parse(readFileSync(path.join(os.homedir(), '.claude', 'settings.json'), 'utf8'));
    return /dark/i.test(s.theme || 'dark'); // Claude Code's default theme is dark
  } catch {
    return true;
  }
}

const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `38;2;${(n >> 16) & 255};${(n >> 8) & 255};${n & 255}`;
};
const wrap = (code) => (s) => `\x1b[${code}m${s}\x1b[0m`;
const plain = (s) => s;

export function palette() {
  if (process.env.NO_COLOR) {
    return { accent: plain, muted: plain, warning: plain, danger: plain, bold: plain };
  }
  const t = tokens();
  const d = dark();
  return {
    accent: wrap(rgb(d ? t['or-accent-on-dark'] : t['or-accent'])),
    muted: wrap(rgb(d ? t['or-muted-on-dark'] : t['or-ink-muted'])),
    warning: wrap(d ? '33' : rgb(t['or-warning'])),
    danger: wrap(d ? '31' : rgb(t['or-danger'])),
    bold: wrap('1'),
  };
}
