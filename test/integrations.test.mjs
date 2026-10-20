import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server.mjs';

// Test credentials are generated per run; nothing here is a real secret.
const fake = () => randomBytes(12).toString('hex');

const fixture = {
  TAILSCALE_TAILNET: 'fixture.example.com',
  TAILSCALE_CLIENT_ID: 'fixture-client-id',
  TAILSCALE_CLIENT_SECRET: fake(),
  SLACK_WEBHOOK_URL: `https://hooks.slack.com/services/${fake()}/${fake()}/${fake()}`,
  TELEGRAM_BOT_TOKEN: `123456:${fake()}`,
  TELEGRAM_CHAT_ID: '-100123456789'
};
const headers = { 'Content-Type': 'application/json', 'X-Monitor-Request': '1' };

test('web credentials persist, stay out of state responses, and replace live OAuth credentials without a restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'monitor-integrations-'));
  const originalFetch = globalThis.fetch;
  const clients = [];
  let app;
  t.after(async () => {
    if (app) await app.close();
    globalThis.fetch = originalFetch;
    await rm(directory, { recursive: true, force: true });
  });
  globalThis.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return originalFetch(url, options);
    if (String(url).endsWith('/oauth/token')) {
      clients.push(options.body.get('client_id'));
      return Response.json({ access_token: `fixture-token-${clients.length}`, expires_in: 3600 });
    }
    if (String(url).endsWith('/devices')) return Response.json({ devices: [] });
    if (String(url).includes('/logging/configuration?')) return Response.json({ logs: [] });
    throw new Error('Unexpected external request in fixture');
  };
  const dbPath = join(directory, 'monitor.sqlite');
  app = await startServer({ env: { MONITOR_PORT: '0' }, dbPath });
  let url = `http://127.0.0.1:${app.server.address().port}`;
  const keyPath = join(directory, 'credentials.key');
  await mkdir(keyPath);
  const failedSave = await fetch(`${url}/api/integrations`, { method: 'POST', headers,
    body: JSON.stringify({ TELEGRAM_BOT_TOKEN: fixture.TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID: fixture.TELEGRAM_CHAT_ID }) });
  assert.equal(failedSave.status, 400);
  await rmdir(keyPath);
  const saved = await fetch(`${url}/api/integrations`, { method: 'POST', headers, body: JSON.stringify(fixture) });
  assert.equal(saved.status, 200);
  const stateText = await (await fetch(`${url}/api/state`)).text();
  for (const value of Object.values(fixture)) assert.ok(!stateText.includes(value), 'state must not contain credential values');
  const state = JSON.parse(stateText);
  assert.equal(state.configured, true);
  assert.equal(state.integrations.TELEGRAM_BOT_TOKEN, true);
  assert.equal(state.notifications.channels.slack.configured, true);
  assert.deepEqual(clients, ['fixture-client-id']);
  const updated = await fetch(`${url}/api/integrations`, { method: 'POST', headers,
    body: JSON.stringify({ TAILSCALE_CLIENT_ID: 'fixture-new-client-id' }) });
  assert.equal(updated.status, 200);
  const revealed = await fetch(`${url}/api/integrations/reveal`, { method: 'POST', headers,
    body: JSON.stringify({ key: 'TAILSCALE_CLIENT_SECRET' }) });
  assert.deepEqual(await revealed.json(), { value: fixture.TAILSCALE_CLIENT_SECRET });
  assert.deepEqual(clients, ['fixture-client-id', 'fixture-new-client-id']);
  await app.close();
  app = null;
  const stored = await readFile(dbPath);
  assert.ok(!stored.includes(Buffer.from(fixture.TAILSCALE_CLIENT_SECRET)), 'stored credentials must be encrypted');
  assert.ok(!stored.includes(Buffer.from(fixture.TELEGRAM_BOT_TOKEN)), 'stored credentials must be encrypted');
  app = await startServer({ env: { MONITOR_PORT: '0' }, dbPath });
  url = `http://127.0.0.1:${app.server.address().port}`;
  const restored = await fetch(`${url}/api/integrations/reveal`, { method: 'POST', headers,
    body: JSON.stringify({ key: 'TAILSCALE_CLIENT_ID' }) });
  assert.deepEqual(await restored.json(), { value: 'fixture-new-client-id' });
  assert.equal((await (await fetch(`${url}/api/state`)).json()).integrations.SLACK_WEBHOOK_URL, true);
});

test('credential saving and revealing require authentication and same-origin POST, and invalid edits preserve saved values', async t => {
  const password = fake();
  const app = await startServer({ env: { MONITOR_PORT: '0', MONITOR_PASSWORD: password }, dbPath: ':memory:', demo: true });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const authorized = { ...headers, Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` };
  const post = (path, values, requestHeaders = authorized) => fetch(`${url}${path}`, { method: 'POST', headers: requestHeaders, body: JSON.stringify(values) });
  assert.equal((await post('/api/integrations', fixture)).status, 200);
  assert.equal((await post('/api/integrations/reveal', { key: 'TELEGRAM_BOT_TOKEN' }, headers)).status, 401);
  assert.equal((await post('/api/integrations/reveal', { key: 'TELEGRAM_BOT_TOKEN' }, { ...authorized, Origin: 'https://other.example.com' })).status, 403);
  assert.equal((await post('/api/integrations', { SLACK_WEBHOOK_URL: 'http://127.0.0.1/internal' })).status, 400);
  assert.equal((await post('/api/integrations', { TELEGRAM_BOT_TOKEN: '••••••••' })).status, 400);
  assert.equal((await post('/api/integrations', { MONITOR_PASSWORD: fake() })).status, 400);
  assert.equal((await post('/api/integrations/reveal', { key: 'MONITOR_PASSWORD' })).status, 400);
  assert.equal((await post('/api/integrations', { TELEGRAM_CHAT_ID: '' })).status, 400);
  assert.deepEqual(await (await post('/api/integrations/reveal', { key: 'TELEGRAM_BOT_TOKEN' })).json(), { value: fixture.TELEGRAM_BOT_TOKEN });
  assert.equal((await post('/api/integrations', { SLACK_WEBHOOK_URL: '' })).status, 200);
  assert.deepEqual(await (await post('/api/integrations/reveal', { key: 'SLACK_WEBHOOK_URL' })).json(), { value: '' });
  const state = await (await fetch(`${url}/api/state`, { headers: authorized })).json();
  assert.equal(state.notifications.channels.telegram.configured, false, 'demo must not enable real senders');
});

test('environment values remain available when untouched web fields are omitted', async t => {
  const app = await startServer({ env: { MONITOR_PORT: '0', TELEGRAM_BOT_TOKEN: fixture.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: fixture.TELEGRAM_CHAT_ID }, dbPath: ':memory:' });
  t.after(() => app.close());
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const saved = await fetch(`${url}/api/integrations`, { method: 'POST', headers,
    body: JSON.stringify({ SLACK_WEBHOOK_URL: fixture.SLACK_WEBHOOK_URL }) });
  assert.equal(saved.status, 200);
  const state = await (await fetch(`${url}/api/state`)).json();
  assert.equal(state.integrations.TELEGRAM_BOT_TOKEN, true);
  assert.equal(state.notifications.channels.telegram.configured, true);
  const revealed = await fetch(`${url}/api/integrations/reveal`, { method: 'POST', headers,
    body: JSON.stringify({ key: 'TELEGRAM_CHAT_ID' }) });
  assert.deepEqual(await revealed.json(), { value: fixture.TELEGRAM_CHAT_ID });
});
