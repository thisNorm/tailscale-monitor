// End-to-end: the real HTTP server, driven the way the team uses it, with a fake Tailscale API and fake Slack/Telegram receivers.
import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { startServer } from '../server.mjs';
import { slackMessage, telegramMessage } from '../tailscale.mjs';

// Test credentials are generated per run; nothing here is a real secret.
const fake = () => randomBytes(12).toString('hex');
const password = fake();
const updaterToken = fake();
const registryAuth = [fake(), fake()];

const device = (name, tags, ip) => ({ nodeId: `n-${name}`, id: name, hostname: name, name: `${name}.tail.ts.net`, tags, addresses: [ip],
  os: 'linux', connectedToControl: true, lastSeen: new Date().toISOString() });
const log = (action, name, minutesAgo) => ({ eventTime: new Date(Date.now() - minutesAgo * 60_000).toISOString(), action, origin: 'NODE',
  actor: { type: 'USER', loginName: 'ops@example.com' }, target: { type: 'NODE', id: `n-${name}`, name } });

async function setup(t) {
  const tailnet = { devices: [device('jetson-hadong-cough01', ['tag:pig'], '100.64.0.1'), device('ubuntu', [], '100.64.0.2')], logs: [] };
  const sent = { slack: [], telegram: [] };
  const app = await startServer({ dbPath: ':memory:',
    env: { MONITOR_PORT: '0', MONITOR_USER: 'invako', MONITOR_PASSWORD: password, POLL_INTERVAL_SEC: '3600' },
    source: { configured: true, devices: async () => structuredClone(tailnet.devices), logs: async () => structuredClone(tailnet.logs) },
    notifiers: { slack: async text => { sent.slack.push(text); }, telegram: async text => { sent.telegram.push(text); } } });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from(`invako:${password}`).toString('base64')}` };
  const state = async () => (await fetch(`${base}/api/state`, { headers: auth })).json();
  const post = (path, body, headers = {}) => fetch(`${base}${path}`, { method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json', 'X-Monitor-Request': '1', ...headers }, body: JSON.stringify(body) });
  const poll = async () => {
    const before = (await state()).lastPoll;
    assert.equal((await post('/api/poll', {})).status, 202);
    for (let i = 0; i < 100; i++) {
      const now = await state();
      if (now.lastPoll !== before && !now.busy) return now;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('poll did not finish');
  };
  const reports = channel => sent[channel].map(text => JSON.parse(text));
  const open = s => s.findings.filter(f => !f.resolvedAt).map(f => `${f.target}:${f.code}`).sort();
  return { tailnet, sent, base, auth, state, post, poll, reports, open };
}

test('UC0 access: login, host check and same-site write guard', async t => {
  const e = await setup(t);
  assert.equal((await fetch(`${e.base}/api/state`)).status, 401);
  assert.equal((await fetch(`${e.base}/api/state`, { headers: { Authorization: `Basic ${Buffer.from(`admin:${password}`).toString('base64')}` } })).status, 401);
  assert.equal((await fetch(`${e.base}/`, { headers: e.auth })).status, 200);
  assert.equal((await fetch(`${e.base}/healthz`)).status, 200);
  // fetch drops a custom Host header, so send the forged host with node:http.
  const forged = await new Promise((done, fail) => http.get(`${e.base}/api/state`, { headers: { ...e.auth, Host: 'evil.example' } }, res => { res.resume(); done(res.statusCode); }).on('error', fail));
  assert.equal(forged, 403);
  assert.equal((await e.post('/api/poll', {}, { 'X-Monitor-Request': '' })).status, 403);
  assert.equal((await e.post('/api/poll', {}, { Origin: 'http://evil.example' })).status, 403);
});

test('UC1 first collection alerts existing violations once, split by kind', async t => {
  const e = await setup(t);
  const s = await e.poll();
  assert.deepEqual(e.open(s), ['ubuntu:missing-tags', 'ubuntu:name-convention']);
  const [report] = e.reports('telegram');
  assert.deepEqual(report.sections.map(x => [x.label, x.items.map(i => `${i.target} ${i.address} ${i.detail}`)]), [
    ['이름 규칙 위반', ['ubuntu 100.64.0.2 이름 규칙 불일치']], ['태그 지정 위반', ['ubuntu 100.64.0.2 태그 없음']]]);
  assert.equal(e.sent.slack.length, 1);
  await e.poll();
  assert.equal(e.sent.telegram.length, 1, 'same violation must not repeat');
  const slack = slackMessage(e.sent.slack[0], { console: 'https://login.tailscale.com/admin/machines', monitor: 'http://m:8787' });
  assert.equal(slack.blocks.at(-1).type, 'actions');
  assert.equal(telegramMessage(e.sent.telegram[0]).parse_mode, 'HTML');
});

test('UC2 a field board registered with an extra team tag is logged and alerted with who registered it', async t => {
  const e = await setup(t);
  await e.poll();
  e.tailnet.devices.push(device('jetson-jinju-cough02', ['tag:pig', 'tag:team-hardware'], '100.64.0.3'));
  e.tailnet.logs.push(log('CREATE', 'jetson-jinju-cough02', 1));
  const s = await e.poll();
  const created = s.events.find(x => x.kind === 'registered' && x.target === 'jetson-jinju-cough02');
  assert.equal(created.actor, 'ops@example.com');
  assert.deepEqual(created.addresses, ['100.64.0.3']);
  assert.ok(e.open(s).includes('jetson-jinju-cough02:tag-rule:jetson-'));
  const latest = e.reports('slack').at(-1);
  assert.deepEqual(latest.sections.flatMap(x => x.items.map(i => i.target)), ['jetson-jinju-cough02'], 'only the new device is alerted');
});

test('UC3 fixing the tag in Tailscale logs who changed it, alerts the change and resolves the violation', async t => {
  const e = await setup(t);
  e.tailnet.devices.push(device('jetson-jinju-cough02', ['tag:pig', 'tag:team-hardware'], '100.64.0.3'));
  await e.poll();
  const alerts = e.sent.slack.length;
  e.tailnet.devices.at(-1).tags = ['tag:pig'];
  e.tailnet.logs.push({ ...log('UPDATE', 'jetson-jinju-cough02', 0), target: { type: 'NODE', id: 'n-jetson-jinju-cough02', name: 'jetson-jinju-cough02.tail.ts.net', property: 'ACL_TAGS' }, new: ['tag:pig'] });
  const s = await e.poll();
  const tagged = s.events.find(x => x.kind === 'tagged');
  assert.deepEqual([tagged.target, tagged.oldTags, tagged.newTags, tagged.actor], ['jetson-jinju-cough02', ['tag:pig', 'tag:team-hardware'], ['tag:pig'], 'ops@example.com']);
  assert.ok(!e.open(s).some(x => x.startsWith('jetson-jinju')));
  assert.equal(e.sent.slack.length, alerts + 1, 'one change alert, no violation alert');
  assert.match(e.reports('slack').at(-1).title, /변경 1건/);
});

test('UC4 marking an office device as an exception removes it from checks and alerts; releasing re-checks it', async t => {
  const e = await setup(t);
  e.tailnet.devices.push(device('jetson-office-onano', ['tag:team-hardware'], '100.64.0.4'));
  let s = await e.poll();
  assert.ok(e.open(s).includes('jetson-office-onano:tag-rule:jetson-'));
  assert.equal((await e.post('/api/settings', { ...s.settings, excludedDevices: ['n-jetson-office-onano'] })).status, 200);
  s = await e.poll();
  assert.ok(!e.open(s).some(x => x.startsWith('jetson-office-onano')));
  const alerts = e.sent.slack.length;
  await e.poll();
  assert.equal(e.sent.slack.length, alerts);
  assert.equal((await e.post('/api/settings', { ...s.settings, excludedDevices: [] })).status, 200);
  assert.ok(e.open(await e.state()).some(x => x.startsWith('jetson-office-onano')));
});

test('UC5 a device deleted in Tailscale is kept as "gone" and the deletion is logged', async t => {
  const e = await setup(t);
  await e.poll();
  e.tailnet.devices = e.tailnet.devices.filter(d => d.hostname !== 'ubuntu');
  e.tailnet.logs.push(log('DELETE', 'ubuntu', 1));
  const s = await e.poll();
  assert.equal(s.devices.find(d => d.hostname === 'ubuntu').present, false);
  assert.ok(s.events.some(x => x.kind === 'deleted' && x.target === 'ubuntu'));
  assert.ok(!e.open(s).some(x => x.startsWith('ubuntu')), 'gone devices are not violations');
});

test('UC6 rule editing: bad input is rejected with a message, a valid rule re-checks devices at once', async t => {
  const e = await setup(t);
  let s = await e.poll();
  const bad = await e.post('/api/settings', { ...s.settings, namePattern: '(' });
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /정규식/);
  assert.equal((await e.post('/api/settings', { ...s.settings, tagRules: [{ prefix: 'jetson-', tags: ['pig'] }] })).status, 400);
  assert.equal((await e.post('/api/settings', { ...s.settings, namePattern: '^.+$', requireTags: false })).status, 200);
  assert.deepEqual(e.open(await e.state()), []);
});

test('UC7 personal Telegram test first, then team Slack: turning a channel on sends the current summary to it only', async t => {
  const e = await setup(t);
  let s = await e.poll();
  assert.deepEqual([e.sent.slack.length, e.sent.telegram.length], [1, 1]);
  await e.post('/api/settings', { ...s.settings, slackEnabled: false });
  e.tailnet.devices.push(device('laptop', ['tag:team-ai'], '100.64.0.8'));
  await e.poll();
  assert.deepEqual([e.sent.slack.length, e.sent.telegram.length], [1, 2], 'only telegram gets the new violation while slack is off');
  s = await e.state();
  await e.post('/api/settings', { ...s.settings, slackEnabled: true });
  await e.poll();
  assert.match(e.reports('slack').at(-1).title, /현재 열린 컨벤션 위반 3건/);
  assert.equal(e.sent.telegram.length, 2, 'telegram is not re-sent');
  s = await e.state();
  await e.post('/api/settings', { ...s.settings, notificationsEnabled: false });
  e.tailnet.devices.push(device('server', [], '100.64.0.9'));
  await e.poll();
  assert.deepEqual([e.sent.slack.length, e.sent.telegram.length], [2, 2], 'master switch off sends nothing');
});

test('UC8 new image version: detected, announced once, applied through the updater with its token', async t => {
  const listen = handler => new Promise(done => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => done(s)); });
  const registry = await listen((req, res) => {
    const ok = req.headers.authorization === `Basic ${Buffer.from(registryAuth.join(':')).toString('base64')}` && req.url.startsWith('/v2/x/tsm/tags/list');
    res.writeHead(ok ? 200 : 401, { 'Content-Type': 'application/json' }).end(JSON.stringify(ok ? { tags: ['1.0.0', '9.0.0', 'latest'] } : {}));
  });
  const calls = [];
  const updater = await listen(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    calls.push([req.method, req.url, req.headers.authorization, body]);
    res.writeHead(req.url === '/update' ? 202 : 200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ state: 'updating', version: '9.0.0' }));
  });
  t.after(() => { registry.close(); updater.close(); });
  const sent = [];
  const app = await startServer({ dbPath: ':memory:', source: { configured: false }, notifiers: { telegram: async text => { sent.push(text); } },
    env: { MONITOR_PORT: '0', UPDATE_IMAGE: 'hub.example/x/tsm', UPDATE_REGISTRY_URL: `http://127.0.0.1:${registry.address().port}`,
      REGISTRY_USER: registryAuth[0], REGISTRY_PASSWORD: registryAuth[1], UPDATER_URL: `http://127.0.0.1:${updater.address().port}`, UPDATER_TOKEN: updaterToken } });
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let s;
  for (let i = 0; i < 50 && !s?.update.checkedAt; i++) { await new Promise(r => setTimeout(r, 20)); s = await (await fetch(`${base}/api/state`)).json(); }
  assert.deepEqual([s.update.latest, s.update.enabled, s.update.error], ['9.0.0', true, null]);
  await app.monitor.flushNotifications();
  assert.match(JSON.parse(sent[0]).title, /새 버전 9\.0\.0/);
  const res = await fetch(`${base}/api/update`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Monitor-Request': '1' }, body: '{}' });
  assert.equal(res.status, 202);
  assert.deepEqual(calls[0], ['POST', '/update', `Bearer ${updaterToken}`, '{"version":"9.0.0"}']);
  await fetch(`${base}/api/state`);
  assert.equal(calls[1][1], '/status', 'state polls the updater while updating');
});
