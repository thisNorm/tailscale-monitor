import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server.mjs';

// Test credentials are generated per run; nothing here is a real secret.
const fake = () => randomBytes(12).toString('hex');

test('local HTTP serves the dashboard, prevents cross-origin writes and rejects invalid settings', async t => {
  const app = await startServer({ env: { MONITOR_PORT: '0' }, dbPath: ':memory:' });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Tailscale/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.configured, false);
  assert.equal(state.devices.length, 0);
  const rejected = await fetch(`${url}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state.settings) });
  assert.equal(rejected.status, 403);
  const invalid = await fetch(`${url}/api/settings`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Monitor-Request': '1' },
    body: JSON.stringify({ ...state.settings, namePattern: '[' }) });
  assert.equal(invalid.status, 400);
  const saved = await fetch(`${url}/api/settings`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Monitor-Request': '1' },
    body: JSON.stringify({ ...state.settings, notificationsEnabled: false }) });
  assert.equal(saved.status, 200);
  assert.equal((await (await fetch(`${url}/api/state`)).json()).settings.notificationsEnabled, false);
  assert.equal((await fetch(`${url}/.env`)).status, 404);
});

test('configured password protects both the dashboard and API', async t => {
  const password = fake();
  const app = await startServer({ env: { MONITOR_PORT: '0', MONITOR_PASSWORD: password }, dbPath: ':memory:' });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(`${url}/api/state`)).status, 401);
  const headers = { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` };
  assert.equal((await fetch(`${url}/api/state`, { headers })).status, 200);
  await assert.rejects(startServer({ env: { MONITOR_BIND: '0.0.0.0', MONITOR_PORT: '0' }, dbPath: ':memory:' }), /MONITOR_PASSWORD/);
});
