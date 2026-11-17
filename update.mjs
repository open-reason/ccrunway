// `ccrunway update`'s version check: one GET to the npm registry (5 s), nothing sent but the
// request. CCRUNWAY_REGISTRY swaps the registry for tests.

export const registry = () => (process.env.CCRUNWAY_REGISTRY || 'https://registry.npmjs.org').replace(/\/$/, '');

// → the latest version string; throws with a short reason
export async function latestVersion() {
  const r = await fetch(`${registry()}/ccrunway/latest`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(5000),
  }).catch((e) => {
    throw new Error(e.name === 'TimeoutError' ? 'no answer within 5 s' : (e.cause?.code ?? e.message));
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const v = (await r.json().catch(() => null))?.version;
  if (typeof v !== 'string' || !parse(v)) throw new Error('no version in the answer');
  return v;
}

// x.y.z as numbers; a prerelease suffix is ignored
const parse = (v) => {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? ''));
  return m ? m.slice(1).map(Number) : null;
};

// a newer than b; an unreadable b counts as older
export function newer(a, b) {
  const x = parse(a);
  const y = parse(b);
  if (!x) return false;
  if (!y) return true;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
