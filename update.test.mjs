// node --test update.test.mjs
// `ccrunway update` against a local registry (node:http on 127.0.0.1, CCRUNWAY_REGISTRY).
// npx is never run: --check reports only, CCRUNWAY_UPDATE_DRY=1 reports the command that
// would run. Temp CCRUNWAY_HOME; nothing real is touched.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { newer } from './update.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
let server;
let base;
const seen = [];
before(async () => {
  server = createServer((req, res) => {
    seen.push({ url: req.url, accept: req.headers.accept });
    if (req.url !== '/ccrunway/latest') return res.writeHead(404).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ name: 'ccrunway', version: '9.9.9' }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

function env(extra = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ccrunway update-'));
  return {
    dir,
    home: path.join(dir, 'data'),
    env: {
      ...process.env,
      CCRUNWAY_HOME: path.join(dir, 'data'),
      CCRUNWAY_SB_ROOT: path.join(dir, 'root'),
      CCRUNWAY_REGISTRY: base,
      NO_COLOR: '1',
      ...extra,
    },
  };
}
// async: the registry answers from this process, so spawnSync would deadlock
const run = (e, ...argv) =>
  new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(here, 'cli.mjs'), ...argv], { env: e.env });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d) => (stdout += d));
    c.stderr.on('data', (d) => (stderr += d));
    c.stdin.end();
    c.on('close', (status) => resolve({ status, stdout, stderr }));
  });
const installedAt = (e, version) => {
  mkdirSync(e.home, { recursive: true });
  writeFileSync(path.join(e.home, 'install.json'), JSON.stringify({ version }));
};

test('newer: numeric x.y.z, prereleases ignored', () => {
  assert.ok(newer('0.10.0', '0.9.9'));
  assert.ok(newer('1.0.0', '0.99.99'));
  assert.ok(!newer('0.4.1', '0.4.1'));
  assert.ok(!newer('0.4.1-beta.1', '0.4.1'));
  assert.ok(!newer('0.4.0', '0.4.1'));
  assert.ok(newer('0.4.1', null), 'nothing installed counts as older');
  assert.ok(!newer('junk', '0.1.0'));
});

test('update --check --json: installed copy older → update_available, the command, nothing run', async () => {
  const e = env();
  installedAt(e, '0.1.0');
  const r = await run(e, 'update', '--check', '--json');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.schema, 1);
  assert.equal(j.ok, true);
  assert.equal(j.installed, '0.1.0');
  assert.match(j.running, /^\d+\.\d+\.\d+/);
  assert.equal(j.latest, '9.9.9');
  assert.equal(j.update_available, true);
  assert.equal(j.updated, false);
  assert.equal(j.command, 'npx -y ccrunway@9.9.9 install --json');
  assert.ok(seen.some((s) => s.url === '/ccrunway/latest' && s.accept === 'application/json'));
  const t = await run(e, 'update', '--check');
  assert.match(t.stdout, /^installed: 0\.1\.0 · running: .* · latest: 9\.9\.9$/m);
  assert.match(t.stdout, /`npx ccrunway update` installs it/);
});

test('update: already the latest → updated false, "is the latest"', async () => {
  const e = env();
  installedAt(e, '9.9.9');
  const j = JSON.parse((await run(e, 'update', '--json')).stdout);
  assert.equal(j.update_available, false);
  assert.equal(j.updated, false);
  assert.equal(j.message, 'ccrunway 9.9.9 is the latest');
  assert.equal(j.command, undefined);
});

test('update without --check runs npx ccrunway@<latest> install, flags passed on (CCRUNWAY_UPDATE_DRY)', async () => {
  const e = env({ CCRUNWAY_UPDATE_DRY: '1' });
  installedAt(e, '0.1.0');
  const r = await run(e, 'update', '--json', '--settings', '/tmp/x y/settings.json', '--node', '/opt/n/node', '--no-menubar');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const j = JSON.parse(r.stdout);
  assert.equal(j.dry_run, true);
  assert.equal(j.command, 'npx -y ccrunway@9.9.9 install --settings /tmp/x y/settings.json --node /opt/n/node --no-menubar --json');
  // not installed: still reports, and installs
  const n = env({ CCRUNWAY_UPDATE_DRY: '1' });
  const jn = JSON.parse((await run(n, 'update', '--json')).stdout);
  assert.equal(jn.installed, null);
  assert.equal(jn.command, 'npx -y ccrunway@9.9.9 install --json');
  const t = await run(n, 'update');
  assert.equal(t.stdout, 'would run: npx -y ccrunway@9.9.9 install\n');
});

test('registry unreachable or wrong: exit 1, UPDATE_CHECK_FAILED', async () => {
  for (const reg of ['http://127.0.0.1:9', `${base}/nope`]) {
    const e = env({ CCRUNWAY_REGISTRY: reg });
    const r = await run(e, 'update', '--check', '--json');
    assert.equal(r.status, 1, reg);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.error.code, 'UPDATE_CHECK_FAILED');
    assert.equal(j.error.fix, 'npx ccrunway@latest install');
    const t = await run(e, 'update', '--check');
    assert.equal(t.status, 1);
    assert.match(t.stderr, /could not get the latest version/);
  }
});
