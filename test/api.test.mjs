import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Tailscale, slackSender, telegramSender, slackMessage, telegramMessage } from '../tailscale.mjs';

// Test credentials are generated per run; nothing here is a real secret.
const fake = () => randomBytes(12).toString('hex');
const botToken = `12345:${fake()}`;
const clientSecret = fake();

test('OAuth token is shared by concurrent read requests and only the two necessary read scopes are requested', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push(String(url));
    if (String(url).endsWith('/oauth/token')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('scope'), 'devices:core:read logs:configuration:read');
      assert.equal(options.body.get('grant_type'), 'client_credentials');
      return Response.json({ access_token: 'fixture-access-token', expires_in: 3600 });
    }
    assert.equal(options.headers.Authorization, 'Bearer fixture-access-token');
    assert.equal(options.method, undefined);
    assert.equal(options.redirect, 'error');
    if (String(url).endsWith('/devices')) return Response.json({ devices: [] });
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/api/v2/tailnet/example.com/logging/configuration');
    assert.equal(parsed.searchParams.get('start'), '2026-10-15T00:00:00Z');
    assert.equal(parsed.searchParams.get('end'), '2026-10-16T00:00:00Z');
    return Response.json({ logs: [] });
  };
  const source = new Tailscale({ TAILSCALE_TAILNET: 'example.com', TAILSCALE_CLIENT_ID: 'fixture-id', TAILSCALE_CLIENT_SECRET: clientSecret });
  const [devices, logs] = await Promise.all([source.devices(), source.logs('2026-10-15T00:00:00Z', '2026-10-16T00:00:00Z')]);
  assert.deepEqual(devices, []); assert.deepEqual(logs, []);
  assert.equal(requests.length, 3);
});

test('large audit ranges use contiguous bounded requests and retain the complete time range', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const windows = [];
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    const parsed = new URL(url);
    const start = parsed.searchParams.get('start');
    const end = parsed.searchParams.get('end');
    assert.ok(Date.parse(end) - Date.parse(start) <= 7 * 86400_000, 'large audit queries must be split before requesting');
    windows.push({ start, end });
    return Response.json({ logs: [{ eventTime: end, marker: windows.length }] });
  };
  const source = new Tailscale({ TAILSCALE_TAILNET: 'example.com', TAILSCALE_CLIENT_ID: 'fixture-id', TAILSCALE_CLIENT_SECRET: clientSecret });
  const logs = await source.logs('2026-10-01T00:00:00Z', '2026-10-16T09:19:17.123Z');
  assert.equal(windows.length, 3);
  assert.equal(windows[0].start, '2026-10-01T00:00:00Z');
  assert.equal(windows.at(-1).end, '2026-10-16T09:19:17.123Z');
  for (let i = 1; i < windows.length; i++) assert.equal(windows[i].start, windows[i - 1].end, 'inclusive boundaries must not leave gaps');
  assert.deepEqual(logs.map(log => log.marker), [1, 2, 3]);
});

test('an audit chunk failure rejects the whole collection instead of accepting partial history', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let requests = 0;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
    requests++;
    if (requests === 2) return Response.json({ message: 'fixture failure' }, { status: 503 });
    return Response.json({ logs: [{ eventTime: '2026-10-01T00:00:00Z' }] });
  };
  const source = new Tailscale({ TAILSCALE_TAILNET: 'example.com', TAILSCALE_CLIENT_ID: 'fixture-id', TAILSCALE_CLIENT_SECRET: clientSecret });
  await assert.rejects(source.logs('2026-10-01T00:00:00Z', '2026-10-16T00:00:00Z'), /HTTP 503/);
  assert.equal(requests, 2);
});

test('notification adapters send plain text and honor Telegram rate-limit delay without exposing the bot token', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const bodies = [];
  globalThis.fetch = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    assert.equal(options.method, 'POST');
    if (String(url).includes('hooks.slack.com')) {
      assert.ok(!options.body.includes('<!channel>'));
      return new Response('ok', { status: 200 });
    }
    assert.equal(body.chat_id, '-1001234');
    assert.equal(body.parse_mode, undefined);
    return Response.json({ ok: false, parameters: { retry_after: 45 } }, { status: 429 });
  };
  await slackSender('https://hooks.slack.com/services/fixture/fixture/fixture')('new-device <!channel>');
  await assert.rejects(telegramSender(botToken, '-1001234')('new-device'), error => {
    assert.equal(error.retryAfter, 45);
    assert.ok(!error.message.includes(botToken.split(':')[1]));
    return true;
  });
  assert.equal(bodies.length, 2);
  assert.throws(() => slackSender('http://localhost/secret'), /HTTPS/);
});

test('empty audit windows accept null while malformed responses remain errors', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let response = { logs: null };
  globalThis.fetch = async url => String(url).endsWith('/oauth/token')
    ? Response.json({ access_token: 'fixture-token', expires_in: 3600 }) : Response.json(response);
  const source = new Tailscale({ TAILSCALE_TAILNET: 'example.com', TAILSCALE_CLIENT_ID: 'fixture-id', TAILSCALE_CLIENT_SECRET: clientSecret });
  const range = ['2026-10-19T00:00:00Z', '2026-10-19T00:10:00Z'];
  assert.deepEqual(await source.logs(...range), []);
  response = { logs: [] };
  assert.deepEqual(await source.logs(...range), []);
  response = { logs: {} };
  await assert.rejects(source.logs(...range), /logs 응답 형식/);
  response = {};
  await assert.rejects(source.logs(...range), /logs 응답 형식/);
});

test('empty chunks do not discard events from other audit chunks', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const event = { eventTime: '2026-10-09T00:00:00Z', action: 'CREATE', target: { type: 'NODE', id: 'fixture-device' } };
  let chunk = 0;
  globalThis.fetch = async url => String(url).endsWith('/oauth/token')
    ? Response.json({ access_token: 'fixture-token', expires_in: 3600 })
    : Response.json({ logs: ++chunk === 2 ? [event] : null });
  const source = new Tailscale({ TAILSCALE_TAILNET: 'example.com', TAILSCALE_CLIENT_ID: 'fixture-id', TAILSCALE_CLIENT_SECRET: clientSecret });
  assert.deepEqual(await source.logs('2026-10-01T00:00:00Z', '2026-10-16T00:00:00Z'), [event]);
  assert.equal(chunk, 3);
});

test('reports render as Slack blocks and Telegram HTML with escaped device names', () => {
  const text = JSON.stringify({ title: 'Tailscale 새 컨벤션 위반 2건', time: '2026-10-19T04:07:58.033Z', sections: [
    { label: '이름 규칙 위반', items: [{ target: 'ubuntu<!channel>', address: '100.64.10.1', detail: '이름 규칙 불일치' }], more: 0 },
    { label: '태그 지정 위반', items: [{ target: 'minipc-01', address: '100.64.10.2', detail: '태그 없음' }], more: 3 }] });
  const slack = slackMessage(text);
  assert.deepEqual(slack.blocks.map(b => b.type), ['header', 'context', 'divider', 'section', 'divider', 'section']);
  assert.match(slack.blocks[1].elements[0].text, /^2026-10-19 13:07 KST · 이름 규칙 위반 1건 · 태그 지정 위반 4건$/);
  assert.ok(!JSON.stringify(slack).includes('<!channel>'));
  assert.match(slack.blocks[5].text.text, /외 3건/);
  const telegram = telegramMessage(text);
  assert.equal(telegram.parse_mode, 'HTML');
  assert.ok(telegram.text.includes('<b>ubuntu&lt;!channel&gt;</b>  <code>100.64.10.1</code>\n    이름 규칙 불일치'));
});

test('reports end with Tailscale and monitoring buttons; Telegram skips a local monitoring URL', () => {
  const text = JSON.stringify({ title: 't', time: '2026-10-19T04:07:58.033Z', sections: [{ label: 'x', items: [], more: 1 }] });
  const links = { console: 'https://login.tailscale.com/admin/machines', monitor: 'http://127.0.0.1:8787' };
  assert.deepEqual(slackMessage(text, links).blocks.at(-1).elements.map(e => e.url), [links.console, links.monitor]);
  assert.deepEqual(telegramMessage(text, links).reply_markup.inline_keyboard[0].map(b => b.text), ['Tailscale 콘솔']);
  assert.equal(telegramMessage(text, { ...links, monitor: 'http://100.64.0.5:8787' }).reply_markup.inline_keyboard[0].length, 2);
});

test('transient connection failures are retried; HTTP errors are not', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let calls = 0, status = 200;
  globalThis.fetch = async url => {
    if (String(url).endsWith('/oauth/token')) return Response.json({ access_token: 'x', expires_in: 3600 });
    calls++;
    if (calls <= 2) throw new TypeError('fetch failed');
    return status === 200 ? Response.json({ devices: [] }) : new Response('', { status });
  };
  const source = new Tailscale({ TAILSCALE_TAILNET: 'example.com', TAILSCALE_CLIENT_ID: 'id', TAILSCALE_CLIENT_SECRET: clientSecret });
  source.retryDelayMs = 1;
  assert.deepEqual(await source.devices(), []);
  assert.equal(calls, 3);
  calls = 2; status = 403;
  await assert.rejects(source.devices(), /HTTP 403/);
  assert.equal(calls, 3, 'HTTP errors are not retried');
  calls = -10;
  await assert.rejects(source.devices(), /연결할 수 없습니다\(3회 시도\)/);
});
