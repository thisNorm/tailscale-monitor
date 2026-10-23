import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Monitor } from '../monitor.mjs';

const board = { nodeId: 'node-board', id: '123', hostname: 'jetson-example-cough01',
  name: 'jetson-example-cough01.example.ts.net', addresses: ['100.100.1.10'],
  tags: ['tag:pig'], os: 'linux', user: 'example@example.com', authorized: true };

function setup(t) {
  let devices = [structuredClone(board)];
  let logs = [];
  let failDevices = false;
  let clock = new Date('2026-10-16T10:00:00Z');
  const delivered = [];
  const source = { configured: true,
    async devices() { if (failDevices) throw new Error('devices HTTP 403'); return devices; },
    async logs() { return logs; } };
  const monitor = new Monitor({ dbPath: ':memory:', source,
    notifiers: { slack: async text => delivered.push(text) }, clock: () => clock });
  t.after(() => monitor.close());
  return { monitor, delivered, source,
    devices: value => { devices = value; }, logs: value => { logs = value; },
    fail: value => { failDevices = value; },
    advance: () => { clock = new Date(clock.getTime() + 60_000); } };
}

test('conforming new devices need no approval and only convention violations trigger non-repeating alerts', async t => {
  const f = setup(t);
  await f.monitor.poll();
  assert.equal(f.monitor.state().findings.filter(x => !x.resolvedAt).length, 0);
  assert.equal(f.delivered.length, 0);
  f.devices([{ ...board, name: 'badname.example.ts.net', tags: [] }]);
  f.advance(); await f.monitor.poll();
  assert.equal(f.monitor.state().findings.filter(x => !x.resolvedAt).length, 2);
  const count = f.delivered.length;
  assert.ok(count > 0);
  f.advance(); await f.monitor.poll();
  assert.equal(f.delivered.length, count);
  f.devices([{ ...board, nodeId: 'different-node', id: '456' }]);
  f.advance(); await f.monitor.poll();
  assert.equal(f.monitor.state().findings.filter(x => !x.resolvedAt).length, 0);
  assert.equal(f.delivered.length, count);
});

test('hostname prefix rule flags unexpected office tags without per-device registration', async t => {
  const f = setup(t); await f.monitor.poll();
  f.monitor.saveSettings({ ...f.monitor.state().settings, tagRules: [{ prefix: 'jetson-example-', tags: ['tag:pig'] }] });
  f.devices([{ ...board, tags: ['tag:pig', 'tag:team-hardware'] }]);
  f.advance(); await f.monitor.poll();
  const codes = f.monitor.state().findings.filter(x => !x.resolvedAt).map(x => x.code);
  assert.ok(codes.includes('tag-rule:jetson-example-'));
});

test('failed device API cannot become a device deletion or discard previous state', async t => {
  const f = setup(t); await f.monitor.poll();
  f.fail(true); f.advance(); await f.monitor.poll();
  assert.equal(f.monitor.state().devices[0].present, true);
  assert.ok(f.monitor.state().collectors.devices.error);
  assert.equal(f.monitor.state().events.filter(x => x.kind === 'device-removed').length, 0);
  f.fail(false); f.devices([]); f.advance(); await f.monitor.poll();
  assert.equal(f.monitor.state().devices[0].present, false);
  assert.equal(f.monitor.state().collectors.devices.error, null);
});

test('audit logs sharing eventGroupID retain distinct changes and deduplicate overlapping windows', async t => {
  const f = setup(t);
  const common = { eventTime: '2026-10-16T09:59:00.123456789Z', eventGroupID: 'group-1',
    origin: 'ADMIN_CONSOLE', actor: { loginName: 'admin@example.com', type: 'USER' } };
  f.logs([
    { ...common, action: 'CREATE', target: { type: 'NODE', id: '123', name: board.hostname } },
    { ...common, action: 'DELETE', target: { type: 'NODE', id: '456', name: 'removed-board' } },
    { ...common, action: 'CREATE', target: { type: 'USER', id: 'user', name: 'not-a-device' } }
  ]);
  await f.monitor.poll(); f.advance(); await f.monitor.poll();
  const events = f.monitor.state().events.filter(x => x.source === 'tailscale');
  assert.equal(events.length, 3, 'device and user changes are all kept');
  assert.ok(events.some(e => e.kind === 'changed' && e.label === '사용자 생성'));
  assert.equal(events[0].actor, 'admin@example.com');
  assert.equal(events[0].origin, 'ADMIN_CONSOLE');
  assert.ok(events.some(e => e.kind === 'registered'));
  assert.ok(events.some(e => e.kind === 'deleted'));
});

test('name checks use the Tailscale device name, not an old OS hostname', async t => {
  const f = setup(t); await f.monitor.poll();
  f.devices([{ ...board, hostname: 'bad-os-name', name: 'jetson-correct-cough01.example.ts.net' }]);
  f.advance(); await f.monitor.poll();
  assert.equal(f.monitor.state().findings.filter(x => !x.resolvedAt).length, 0);
});

test('reused device names do not attach a different node IP to historical registration logs', async t => {
  const f = setup(t);
  f.logs([{ eventTime: '2026-10-16T09:00:00Z', eventGroupID: 'old-node', action: 'CREATE', origin: 'NODE',
    actor: { type: 'USER', loginName: 'old@example.com' }, target: { type: 'NODE', id: 'old-node-id', name: board.name } }]);
  await f.monitor.poll();
  const event = f.monitor.state().events[0];
  assert.equal(event.actor, 'old@example.com');
  assert.deepEqual(event.addresses, []);
});

test('failed Slack delivery is retained and retried without creating duplicate queued notifications', async t => {
  const f = setup(t);
  f.devices([{ ...board, tags: [] }]);
  f.monitor.notifiers.slack = async () => { throw new Error('Slack HTTP 503'); };
  await f.monitor.poll();
  const pending = f.monitor.state().notifications.pending;
  assert.ok(pending > 0);
  assert.ok(f.monitor.state().notifications.error);
  f.monitor.notifiers.slack = async text => f.delivered.push(text);
  f.advance(); await f.monitor.poll();
  assert.equal(f.monitor.state().notifications.pending, 0);
  assert.equal(f.delivered.length, pending);
});

test('channel switches isolate Telegram delivery and one failing channel cannot block the other', async t => {
  const f = setup(t);
  f.devices([{ ...board, tags: [] }]);
  const telegram = [];
  f.monitor.notifiers.telegram = async text => telegram.push(text);
  f.monitor.notifiers.slack = async () => { throw new Error('Slack unavailable'); };
  await f.monitor.poll();
  assert.ok(telegram.length > 0);
  assert.ok(f.monitor.state().notifications.channels.slack.pending > 0);
  assert.equal(f.monitor.state().notifications.channels.telegram.pending, 0);
  const count = telegram.length;
  f.monitor.saveSettings({ ...f.monitor.state().settings, telegramEnabled: false });
  f.devices([{ ...board, nodeId: 'second-node', tags: [] }]);
  f.advance(); await f.monitor.poll();
  assert.equal(telegram.length, count);
  f.monitor.saveSettings({ ...f.monitor.state().settings, notificationsEnabled: false });
  let sent = 0;
  f.monitor.notifiers.slack = async () => { sent++; };
  f.advance(); await f.monitor.poll();
  assert.equal(sent, 0);
  f.monitor.saveSettings({ ...f.monitor.state().settings, notificationsEnabled: true });
  f.advance(); await f.monitor.poll();
  assert.ok(sent > 0);
});

test('audit-log changes after start are recorded and alerted with who did them; backfill and logins are not alerted', async t => {
  const f = setup(t);
  const at = minutes => new Date(Date.parse('2026-10-16T10:00:00Z') + minutes * 60_000).toISOString();
  const actor = { loginName: 'admin@example.com', type: 'USER' };
  f.logs([{ eventTime: at(-60), action: 'UPDATE', actor, target: { type: 'NODE', id: 'node-board', name: 'old-change.ts.net', property: 'MACHINE_NAME' }, old: 'a', new: 'b' }]);
  await f.monitor.poll();
  const before = f.delivered.length;
  f.devices([{ ...board, tags: ['tag:pig', 'tag:team-hardware'] }]);
  f.logs([
    { eventTime: at(1), action: 'UPDATE', actor, target: { type: 'NODE', id: 'node-board', name: 'jetson-example-cough01.ts.net', property: 'ACL_TAGS' }, new: ['tag:team-hardware', 'tag:pig'] },
    { eventTime: at(1), action: 'UPDATE', actor, target: { type: 'TAILNET', name: 'example.com', property: 'ACL' }, old: 'a\nb', new: 'a\nc\nd' },
    { eventTime: at(1), action: 'LOGIN', actor, target: { type: 'ADMIN_CONSOLE', name: 'Admin console' } },
    { eventTime: at(1), action: 'CREATE', actor, target: { type: 'OAUTH_ACCESS_TOKEN', name: 'token' } }]);
  f.advance(); await f.monitor.poll();
  const tagged = f.monitor.state().events.find(e => e.kind === 'tagged');
  assert.deepEqual([tagged.target, tagged.oldTags, tagged.newTags, tagged.actor], ['jetson-example-cough01', ['tag:pig'], ['tag:pig', 'tag:team-hardware'], 'admin@example.com']);
  assert.ok(f.monitor.state().events.some(e => e.kind === 'renamed'), 'backfill still goes to history');
  const reports = f.delivered.slice(before).map(text => JSON.parse(text));
  const change = reports.find(r => r.title.includes('변경'));
  assert.deepEqual(change.sections.map(s => [s.label, s.items.map(i => i.detail)]), [
    ['태그 변경', ['tag:pig → tag:pig, tag:team-hardware · admin@example.com']], ['정책 변경', ['+2줄 / -1줄 · admin@example.com']]]);
});

test('default name convention covers barn, poultry and office devices; empty tag list allows new tags', async t => {
  const f = setup(t);
  const named = (name, tags) => ({ ...board, nodeId: name, id: name, hostname: name, name: `${name}.example.ts.net`, tags });
  f.devices([named('jetson-hadong-cough01', ['tag:pig']), named('chonnam-uni-001', ['tag:new-layer']),
    named('kisook-laptop', ['tag:brand-new']), named('jetson-hadong-cought1', ['tag:pig'])]);
  await f.monitor.poll();
  const open = f.monitor.state().findings.filter(x => !x.resolvedAt);
  assert.deepEqual(open.map(x => `${x.target}:${x.code}`), ['jetson-hadong-cought1:name-convention']);
});

test('turning a channel on sends violations that were found while it was off', async t => {
  const f = setup(t);
  const settings = () => f.monitor.state().settings;
  f.monitor.saveSettings({ ...settings(), slackEnabled: false });
  f.devices([{ ...board, tags: [] }]);
  await f.monitor.poll();
  assert.equal(f.delivered.length, 0);
  f.monitor.saveSettings({ ...settings(), slackEnabled: true });
  f.advance(); await f.monitor.poll();
  assert.equal(f.delivered.length, 1);
  const report = JSON.parse(f.delivered[0]);
  assert.match(report.title, /현재 열린 컨벤션 위반 2건/);
  assert.equal(report.sections[0].items[0].detail, '태그 없음');
});

test('summary replaces older undelivered alerts on the same channel', async t => {
  const f = setup(t);
  f.monitor.notifiers.slack = async () => { throw new Error('down'); };
  f.devices([{ ...board, tags: [] }]);
  await f.monitor.poll();
  assert.equal(f.monitor.state().notifications.channels.slack.pending, 1);
  f.monitor.announceOpenFindings(['slack']);
  assert.equal(f.monitor.state().notifications.channels.slack.pending, 1);
});

test('alerts are split into name and tag sections, and excluded devices are not checked', async t => {
  const f = setup(t);
  f.devices([{ ...board, name: 'badname.example.ts.net', tags: [] }]);
  await f.monitor.poll();
  assert.deepEqual(JSON.parse(f.delivered[0]).sections.map(s => [s.label, s.items.map(i => i.target)]),
    [['이름 규칙 위반', ['badname']], ['태그 지정 위반', ['badname']]]);
  f.devices([{ ...board, name: 'jetson-office-onano.example.ts.net', tags: ['tag:team-hardware'] }]);
  f.monitor.saveSettings({ ...f.monitor.state().settings, excludedDevices: [board.nodeId] });
  f.advance(); await f.monitor.poll();
  assert.equal(f.monitor.state().findings.filter(x => !x.resolvedAt).length, 0);
  assert.equal(f.delivered.length, 1);
});

test('regex tag rules: region "office" needs tag:office, any other region needs tag:field', async t => {
  const f = setup(t);
  const named = (name, tags) => ({ ...board, nodeId: name, id: name, hostname: name, name: `${name}.example.ts.net`, tags });
  f.monitor.saveSettings({ ...f.monitor.state().settings, namePattern: '^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+(?:-[a-z0-9]+)*$',
    tagRules: [{ prefix: '^[a-z0-9]+-office-', tags: ['tag:office'] }, { prefix: '^[a-z0-9]+-(?!office-)[a-z0-9]+-', tags: ['tag:field'] }] });
  f.devices([named('desktop-office-kisook', ['tag:office']), named('jetson-jeju-etri', ['tag:field']),
    named('jetson-office-onano', ['tag:field']), named('jetson-hadong-cough01', ['tag:office', 'tag:field']), named('nas-office', ['tag:office'])]);
  await f.monitor.poll();
  assert.deepEqual(f.monitor.state().findings.filter(x => !x.resolvedAt).map(x => `${x.target}:${x.code}`).sort(), [
    'jetson-hadong-cough01:tag-rule:^[a-z0-9]+-(?!office-)[a-z0-9]+-', 'jetson-office-onano:tag-rule:^[a-z0-9]+-office-', 'nas-office:name-convention']);
  assert.throws(() => f.monitor.saveSettings({ ...f.monitor.state().settings, tagRules: [{ prefix: '^(', tags: ['tag:office'] }] }), /규칙/);
});

test('view groups: two levels max, members must point at a group, saved for everyone', t => {
  const f = setup(t);
  const groups = [{ id: 'hw', name: 'team-hardware', parent: null }, { id: 'kisook', name: 'kisook', parent: 'hw' }];
  f.monitor.saveViewGroups({ groups, members: { 'node-board': 'kisook' } });
  assert.deepEqual(f.monitor.state().viewGroups, { groups, members: { 'node-board': 'kisook' } });
  assert.throws(() => f.monitor.saveViewGroups({ groups: [...groups, { id: 'deep', name: 'x', parent: 'kisook' }], members: {} }), /2단계/);
  assert.throws(() => f.monitor.saveViewGroups({ groups, members: { 'node-board': 'missing' } }), /그룹 지정/);
  assert.throws(() => f.monitor.saveViewGroups({ groups: [{ id: 'A!', name: 'x', parent: null }], members: {} }), /그룹 이름/);
});

test('alert lines say only what kind of mismatch it is, never the rule regex', async t => {
  const f = setup(t);
  f.monitor.saveSettings({ ...f.monitor.state().settings, tagRules: [{ prefix: '^[a-z0-9]+-(?!office-)[a-z0-9]+-', tags: ['tag:field'] }] });
  await f.monitor.poll();
  const items = JSON.parse(f.delivered.at(-1)).sections.flatMap(s => s.items);
  assert.deepEqual(items.map(i => i.detail), ['태그 규칙 불일치']);
});

test('rule note is saved as plain text up to 2000 characters', t => {
  const f = setup(t);
  f.monitor.saveSettings({ ...f.monitor.state().settings, ruleNote: '장비 이름은 장비-지역-닉네임' });
  assert.equal(f.monitor.state().settings.ruleNote, '장비 이름은 장비-지역-닉네임');
  assert.throws(() => f.monitor.saveSettings({ ...f.monitor.state().settings, ruleNote: 'x'.repeat(2001) }), /2000자/);
});

test('settings saved by an older version get new keys filled with defaults on start', t => {
  const dir = mkdtempSync(join(tmpdir(), 'tsm-'));
  const dbPath = join(dir, 'm.sqlite');
  const first = new Monitor({ dbPath, source: { configured: false } });
  const old = first.meta('settings'); delete old.changeAlertsEnabled; first.setMeta('settings', { ...old, requireTags: false });
  first.event('tagged', 'x', {}, { source: 'devices' });
  first.setMeta('auditCursor', '2026-10-16T00:00:00.000Z');
  first.setMeta('historySchema', 1);
  first.close();
  const second = new Monitor({ dbPath, source: { configured: false } });
  assert.equal(second.meta('settings').changeAlertsEnabled, true);
  assert.equal(second.meta('settings').requireTags, false, 'existing values are kept');
  assert.equal(second.meta('auditCursor'), null, 'audit history is re-read once');
  assert.equal(second.state().events.length, 0, 'poll-based tag events are replaced by audit ones');
  second.setMeta('auditCursor', 'kept');
  second.close();
  const third = new Monitor({ dbPath, source: { configured: false } });
  assert.equal(third.meta('auditCursor'), 'kept', 'migration runs only once');
  third.close();
});

test('backfilled tag changes chain old tags from the previous change, not from current tags', async t => {
  const f = setup(t);
  await f.monitor.poll();
  const actor = { loginName: 'a@example.com', type: 'USER' };
  const tagLog = (minutes, tags) => ({ eventTime: new Date(Date.parse('2026-10-16T09:00:00Z') + minutes * 60_000).toISOString(), action: 'UPDATE', actor,
    target: { type: 'NODE', id: 'node-board', name: 'jetson-example-cough01.ts.net', property: 'ACL_TAGS' }, new: tags });
  f.logs([tagLog(2, ['tag:pig']), tagLog(1, ['tag:field'])]);
  f.advance(); await f.monitor.poll();
  const tagged = f.monitor.state().events.filter(e => e.kind === 'tagged').map(e => e.detail);
  assert.deepEqual(tagged, ['tag:field → tag:pig', '(이전 미확인) → tag:field']);
});
