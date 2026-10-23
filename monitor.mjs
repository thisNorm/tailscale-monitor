import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b, 'en'))) : item);
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const parse = value => value ? JSON.parse(value) : null;
const iso = value => new Date(value).toISOString();
const sorted = values => [...new Set(values)].sort();
const defaults = {
  // jetson-지역-cough01 (축사) | chonnam-uni-001 (양계장) | 닉네임-장비 (사무실, jetson-/chonnam- 접두어 제외)
  namePattern: '^(?:jetson-[a-z]+-cough[0-9]+|chonnam-uni-[0-9]{3}|(?!jetson-|chonnam-)[a-z0-9]+(?:-[a-z0-9]+)+)$',
  tagRules: [{ prefix: 'jetson-', tags: ['tag:pig'] }],
  requireTags: true,
  // Plain-language rule summary the team reads on the devices page; not used for checks.
  ruleNote: '',
  // Node IDs the team accepted as exceptions (e.g. office jetson boards); they are not checked or alerted.
  excludedDevices: [],
  notificationsEnabled: true,
  changeAlertsEnabled: true,
  slackEnabled: true,
  telegramEnabled: true
};

// A rule key is a name prefix, or a regex when it starts with "^" (e.g. "^[a-z0-9]+-office-" checks the region segment).
const isPatternRule = key => key.startsWith('^') && key.length <= 200 && (() => { try { new RegExp(key); return true; } catch { return false; } })();
const ruleMatches = (key, name) => key.startsWith('^') ? new RegExp(key).test(name) : name.startsWith(key);

const typeLabels = { NODE: '장비', TAILNET: '테일넷', USER: '사용자', API_KEY: 'API 키', OAUTH_CLIENT: 'OAuth 클라이언트', WEBHOOK: '웹훅', INVITE: '초대' };
const actionLabels = { CREATE: '생성', DELETE: '삭제', UPDATE: '변경' };
const lines = text => new Set(String(text ?? '').split('\n').map(line => line.trim()).filter(Boolean));

// Turns one configuration audit log entry into a history/alert record, or null for non-changes (logins, our own OAuth tokens).
export function describeChange(log, before) {
  const target = log.target || {}, property = target.property || '';
  if (log.action === 'LOGIN' || target.type === 'OAUTH_ACCESS_TOKEN') return null;
  const name = target.type === 'NODE' ? String(target.name || target.id || '').split('.')[0] : target.name || target.id || '';
  if (target.type === 'NODE' && log.action === 'CREATE') return { kind: 'registered', label: '장비 등록', target: name };
  if (target.type === 'NODE' && log.action === 'DELETE') return { kind: 'deleted', label: '장비 삭제', target: name };
  if (target.type === 'NODE' && property === 'ACL_TAGS') {
    const newTags = sorted(Array.isArray(log.new) ? log.new : []);
    const oldTags = before?.tags ?? null;
    return { kind: 'tagged', label: '태그 변경', target: name, oldTags, newTags, detail: `${oldTags ? oldTags.join(', ') || '(없음)' : '(이전 미확인)'} → ${newTags.join(', ') || '(없음)'}` };
  }
  if (target.type === 'NODE' && property === 'MACHINE_NAME') return { kind: 'renamed', label: '이름 변경', target: name, detail: `${log.old || '(없음)'} → ${log.new || '(없음)'}` };
  if (target.type === 'NODE' && property === 'KEY_EXPIRY_TIME') {
    const until = String(log.new || '');
    return { kind: 'changed', label: '키 만료 변경', target: name, detail: !until || until.startsWith('0001-') ? '만료 없음' : `${until.slice(0, 10)}까지` };
  }
  if (target.type === 'TAILNET' && property === 'ACL') {
    const [oldLines, newLines] = [lines(log.old), lines(log.new)];
    const add = [...newLines].filter(line => !oldLines.has(line)).length, remove = [...oldLines].filter(line => !newLines.has(line)).length;
    return { kind: 'policy', label: '정책 변경', target: '정책 파일(ACL)', detail: `+${add}줄 / -${remove}줄` };
  }
  return { kind: 'changed', label: `${typeLabels[target.type] || target.type || '설정'} ${actionLabels[log.action] || log.action}`, target: name, detail: property };
}

export function validateSettings(value) {
  if (!value || typeof value.namePattern !== 'string' || !value.namePattern.trim() || value.namePattern.length > 256) throw new Error('이름 규칙은 1~256자로 입력하세요.');
  try { new RegExp(value.namePattern); } catch { throw new Error('이름 정규식이 올바르지 않습니다.'); }
  if (!Array.isArray(value.tagRules) || value.tagRules.length > 100 || value.tagRules.some(rule =>
    !rule || typeof rule.prefix !== 'string' || !(/^[a-z0-9][a-z0-9-]{0,99}$/.test(rule.prefix) || isPatternRule(rule.prefix))
    || !Array.isArray(rule.tags) || !rule.tags.length || rule.tags.some(tag => typeof tag !== 'string' || !/^tag:[a-z][a-z0-9-]{0,62}$/.test(tag)))) {
    throw new Error('장비명별 규칙은 접두어 = tag:이름 형식으로 입력하세요.');
  }
  value = { ...value, excludedDevices: value.excludedDevices ?? [], ruleNote: value.ruleNote ?? '', changeAlertsEnabled: value.changeAlertsEnabled ?? true };
  if (typeof value.ruleNote !== 'string' || value.ruleNote.length > 2000) throw new Error('규칙 설명은 2000자 이내로 입력하세요.');
  if (!Array.isArray(value.excludedDevices) || value.excludedDevices.length > 500 || value.excludedDevices.some(id => typeof id !== 'string' || !id || id.length > 255)) throw new Error('예외 장비 목록을 확인하세요.');
  if (['requireTags', 'notificationsEnabled', 'changeAlertsEnabled', 'slackEnabled', 'telegramEnabled'].some(key => typeof value[key] !== 'boolean')) throw new Error('검사·알림 설정을 확인하세요.');
  return Object.fromEntries(Object.keys(defaults).map(key => [key, Array.isArray(value[key]) ? sorted(value[key]) : value[key]]));
}

export class Monitor {
  constructor({ dbPath, source, notifiers = {}, clock = () => new Date() }) {
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, body TEXT NOT NULL, present INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS findings (key TEXT PRIMARY KEY, scope TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, time TEXT NOT NULL, source TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (id INTEGER PRIMARY KEY, channel TEXT NOT NULL, text TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, due INTEGER NOT NULL DEFAULT 0, delivered_at TEXT);
      CREATE INDEX IF NOT EXISTS event_time ON events(time DESC);`);
    this.source = source;
    this.notifiers = notifiers;
    this.clock = clock;
    this.busy = false;
    // Settings saved by an older version lack newer keys (e.g. changeAlertsEnabled); fill them with defaults.
    this.setMeta('settings', { ...defaults, ...this.meta('settings') });
    // One-time: re-read 89 days of audit logs so tag/name/policy changes from before 1.1.5 reach history
    // (not alerted: they are older than changeAlertsSince), and drop the poll-based tag events they replace.
    // Schema 3 also re-derives tag events, whose "before" tags were wrong in the first backfill.
    if (this.meta('historySchema') !== 3) {
      this.db.prepare("DELETE FROM events WHERE source='devices' OR json_extract(body, '$.kind')='tagged'").run();
      this.setMeta('auditCursor', null);
      this.setMeta('historySchema', 3);
    }
  }

  close() { this.db.close(); }
  meta(key) { return parse(this.db.prepare('SELECT value FROM meta WHERE key=?').get(key)?.value); }
  setMeta(key, value) { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?, ?)').run(key, JSON.stringify(value)); }
  rows(table) { return this.db.prepare(`SELECT * FROM ${table}`).all(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  event(kind, target, body, { source = 'monitor', actor = '모니터링 서버', time = iso(this.clock()), id } = {}) {
    const item = { kind, target, actor, time, source, ...body };
    const eventId = id || hash(item);
    const result = this.db.prepare('INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?)').run(eventId, iso(time), source, JSON.stringify({ id: eventId, ...item }));
    return Boolean(result.changes);
  }

  // Outbox rows hold a JSON report; each sender renders it in its own format (Slack Block Kit, Telegram HTML).
  queue(items, channels = ['slack', 'telegram'], title = '새 컨벤션 위반') {
    const settings = this.meta('settings');
    if (!items.length || !settings.notificationsEnabled) return;
    const section = (label, list) => ({ label, items: list.slice(0, 10).map(item => this.findingEntry(item)), more: Math.max(0, list.length - 10) });
    this.queueReport(`Tailscale ${title} ${items.length}건`, [
      section('이름 규칙 위반', items.filter(item => item.code === 'name-convention')),
      section('태그 지정 위반', items.filter(item => item.code !== 'name-convention'))].filter(item => item.items.length), channels);
  }

  queueReport(title, sections, channels = ['slack', 'telegram']) {
    const settings = this.meta('settings');
    if (!settings.notificationsEnabled) return;
    const text = JSON.stringify({ title, time: iso(this.clock()), sections });
    for (const channel of channels) {
      if (this.notifiers[channel] && settings[`${channel}Enabled`]) this.db.prepare('INSERT INTO outbox (channel, text) VALUES (?, ?)').run(channel, text);
    }
  }

  queueChanges(changes) {
    const sections = new Map();
    for (const change of changes) {
      if (!sections.has(change.label)) sections.set(change.label, []);
      sections.get(change.label).push({ target: change.target, address: '', detail: [change.detail, change.actor].filter(Boolean).join(' · ') });
    }
    this.queueReport(`Tailscale 변경 ${changes.length}건`, [...sections].map(([label, items]) => ({ label, items: items.slice(0, 10), more: Math.max(0, items.length - 10) })));
  }

  findingEntry(item) {
    const device = parse(this.db.prepare('SELECT body FROM devices WHERE id=?').get(item.deviceId)?.body);
    return { target: item.target, address: device?.addresses?.find(a => !a.includes(':')) || device?.addresses?.[0] || '주소 미확인',
      // Alerts stay short; the full reason (rule, current tags) is on the monitoring page.
      detail: item.code === 'name-convention' ? '이름 규칙 불일치' : item.code === 'missing-tags' ? '태그 없음' : '태그 규칙 불일치' };
  }

  // Violations found while a channel was off or unconfigured are otherwise never sent to it.
  announceOpenFindings(channels) {
    const open = this.rows('findings').map(row => parse(row.body)).filter(item => !item.resolvedAt);
    const active = channels.filter(channel => this.notifiers[channel] && this.meta('settings').notificationsEnabled && this.meta('settings')[`${channel}Enabled`]);
    // The summary covers every open violation, so older undelivered alerts on that channel are superseded.
    // Change and update notices are not covered by the summary, so only violation reports are replaced.
    for (const channel of active) this.db.prepare("DELETE FROM outbox WHERE channel=? AND delivered_at IS NULL AND text LIKE '%컨벤션 위반%'").run(channel);
    this.queue(open, channels, '현재 열린 컨벤션 위반');
  }

  reconcile(scope, expected) {
    const now = iso(this.clock());
    const previous = new Map(this.db.prepare('SELECT body FROM findings WHERE scope=?').all(scope).map(row => {
      const item = parse(row.body); return [item.key, item];
    }));
    const changes = [];
    for (const item of expected) {
      const old = previous.get(item.key);
      previous.delete(item.key);
      const signature = hash({ code: item.code, detail: item.detail, severity: item.severity });
      if (old && !old.resolvedAt && old.signature === signature) continue;
      const next = { ...item, signature, openedAt: old && !old.resolvedAt ? old.openedAt : now,
        updatedAt: now, resolvedAt: null };
      this.db.prepare('INSERT OR REPLACE INTO findings VALUES (?, ?, ?)').run(item.key, scope, JSON.stringify(next));
      changes.push(item);
    }
    for (const item of previous.values()) {
      if (item.resolvedAt) continue;
      item.resolvedAt = now;
      this.db.prepare('UPDATE findings SET body=? WHERE key=?').run(JSON.stringify(item), item.key);
    }
    this.queue(changes);
  }

  evaluateDevices() {
    const settings = this.meta('settings');
    const findings = [];
    for (const row of this.rows('devices')) {
      if (!row.present || settings.excludedDevices?.includes(row.id)) continue;
      const d = parse(row.body);
      const add = (code, detail) => findings.push({ key: `device:${row.id}:${code}`, code, target: d.displayName, deviceId: row.id, detail, severity: 'warning' });
      if (!new RegExp(settings.namePattern).test(d.displayName)) add('name-convention', `이름 규칙 불일치: ${d.displayName}`);
      if (settings.requireTags && !d.tags.length) add('missing-tags', '태그가 지정되지 않았습니다.');
      for (const rule of settings.tagRules.filter(r => ruleMatches(r.prefix, d.displayName))) {
        if (hash(sorted(rule.tags)) !== hash(sorted(d.tags))) add(`tag-rule:${rule.prefix}`, `${rule.prefix.startsWith('^') ? `규칙 ${rule.prefix}에 해당하는` : rule.prefix} 장비의 태그는 ${rule.tags.join(', ')}여야 합니다. 현재: ${d.tags.join(', ') || '(없음)'}`);
      }
    }
    this.reconcile('devices', findings);
  }

  collectDevices(items) {
    if (!Array.isArray(items) || items.some(d => !d || typeof (d.nodeId || d.id) !== 'string' || typeof d.hostname !== 'string' || d.hostname.length > 255
      || !Array.isArray(d.addresses) || d.addresses.some(a => typeof a !== 'string')
      || (d.tags !== undefined && (!Array.isArray(d.tags) || d.tags.some(t => typeof t !== 'string'))))) {
      throw new Error('devices 응답 형식을 확인할 수 없습니다. 기존 장비 목록을 유지합니다.');
    }
    const ids = items.map(d => d.nodeId || d.id);
    if (new Set(ids).size !== ids.length) throw new Error('devices 응답에 중복 노드 ID가 있습니다.');
    const old = new Map(this.rows('devices').map(row => [row.id, row]));
    for (const item of items) {
      const id = item.nodeId || item.id;
      const d = { ...item, displayName: item.name?.split('.')[0] || item.hostname, tags: sorted(item.tags || []) };
      // Keep the last tag transition: the audit log for it can arrive a poll after the Devices API shows the new tags.
      const prev = old.has(id) ? parse(old.get(id).body) : null;
      if (prev) d.previousTags = hash(prev.tags) !== hash(d.tags) ? prev.tags : prev.previousTags;
      old.delete(id);
      this.db.prepare('INSERT OR REPLACE INTO devices VALUES (?, ?, 1)').run(id, JSON.stringify(d));
    }
    for (const [id, row] of old) {
      if (!row.present) continue;
      this.db.prepare('UPDATE devices SET present=0 WHERE id=?').run(id);
    }
    this.evaluateDevices();
  }

  async poll() {
    if (this.busy || !this.source.configured) return;
    this.busy = true;
    try {
      const end = new Date(this.clock().getTime() - 30_000);
      const cutoff = this.clock().getTime() - 89 * 86400_000;
      const cursor = this.meta('auditCursor');
      const start = new Date(Math.max(cutoff, cursor ? Date.parse(cursor) - 600_000 : cutoff));
      if (cursor && Date.parse(cursor) < cutoff) this.setMeta('auditGap', '서버 중단 기간이 원본 보관 범위를 초과했습니다. 일부 과거 변경은 조회할 수 없습니다.');
      if (!this.meta('changeAlertsSince')) this.setMeta('changeAlertsSince', iso(this.clock()));
      const previousDevices = this.rows('devices').map(row => ({ ...parse(row.body), savedId: row.id }));
      const previousPoll = Date.parse(this.meta('lastPoll') || 0);
      const results = await Promise.allSettled([this.source.devices(), this.source.logs(iso(start), iso(end))]);
      for (const [index, key] of ['devices', 'logs'].entries()) {
        try {
          const result = results[index];
          if (result.status === 'rejected') throw result.reason;
          this.transaction(() => {
            if (key === 'devices') this.collectDevices(result.value);
            if (key === 'logs') {
              if (!Array.isArray(result.value) || result.value.some(log => !log || typeof log.eventTime !== 'string' || Number.isNaN(Date.parse(log.eventTime)))) throw new Error('logs 응답 형식을 확인할 수 없습니다.');
              const since = Date.parse(this.meta('changeAlertsSince'));
              const fresh = [];
              // Oldest first, so a tag change's "before" is the previous tag change of the same device.
              for (const log of [...result.value].sort((a, b) => Date.parse(a.eventTime) - Date.parse(b.eventTime))) {
                const before = previousDevices.find(device => [device.savedId, device.id, device.nodeId].includes(log.target?.id));
                const prior = log.target?.property === 'ACL_TAGS' && this.db.prepare("SELECT body FROM events WHERE json_extract(body, '$.kind')='tagged' AND json_extract(body, '$.deviceId')=? AND time < ? ORDER BY time DESC LIMIT 1").get(log.target.id, iso(log.eventTime));
                // Without an earlier tag event: a change since the last poll uses the pre-poll snapshot; one that lagged a poll uses its last transition.
                const newTags = sorted(Array.isArray(log.new) ? log.new : []);
                const oldTags = prior ? parse(prior.body).newTags
                  : Date.parse(log.eventTime) > previousPoll ? before?.tags
                  : before?.previousTags && hash(before.tags) === hash(newTags) ? before.previousTags : null;
                const change = describeChange(log, oldTags ? { tags: oldTags } : null);
                if (!change) continue;
                const actor = log.actor?.loginName || log.actor?.displayName || log.actor?.type || '기록 없음';
                const snapshot = before || this.rows('devices').map(row => ({ ...parse(row.body), savedId: row.id }))
                  .find(device => [device.savedId, device.id, device.nodeId].includes(log.target?.id));
                const added = this.event(change.kind, change.target, { ...change, old: log.old, new: log.new, raw: log,
                  deviceId: log.target?.id, origin: log.origin, addresses: snapshot?.addresses || [], failed: Boolean(log.error), ephemeral: Boolean(log.target?.isEphemeral) },
                  { source: 'tailscale', actor, time: log.eventTime, id: hash(log) });
                // Only changes after this feature started are alerted; the 89-day backfill goes to history only.
                if (added && Date.parse(log.eventTime) >= since && !log.error) fresh.push({ ...change, actor });
              }
              if (fresh.length && this.meta('settings').changeAlertsEnabled) this.queueChanges(fresh);
              this.setMeta('auditCursor', iso(end));
            }
            this.setMeta(`collector:${key}`, { lastSuccess: iso(this.clock()), error: null });
          });
        } catch (error) {
          const message = error.message || 'API 수집 실패';
          const previous = this.meta(`collector:${key}`) || {};
          this.setMeta(`collector:${key}`, { ...previous, lastAttempt: iso(this.clock()), error: message });
        }
      }
      this.setMeta('lastPoll', iso(this.clock()));
      await this.flushNotifications();
    } finally { this.busy = false; }
  }

  async flushNotifications() {
    const settings = this.meta('settings');
    if (!settings.notificationsEnabled) return;
    for (const channel of ['slack', 'telegram']) {
      if (!this.notifiers[channel] || !settings[`${channel}Enabled`]) continue;
      const rows = this.db.prepare('SELECT * FROM outbox WHERE channel=? AND delivered_at IS NULL AND due<=? ORDER BY id LIMIT 10').all(channel, this.clock().getTime());
      for (const row of rows) {
        try {
          await this.notifiers[channel](row.text);
          this.db.prepare('UPDATE outbox SET delivered_at=? WHERE id=?').run(iso(this.clock()), row.id);
          this.setMeta(`notification:${channel}`, { lastSuccess: iso(this.clock()), error: null });
        } catch (error) {
          const delay = Math.max(Number(error.retryAfter) || 0, Math.min(3600, 30 * 2 ** Math.min(row.attempts, 7)));
          this.db.prepare('UPDATE outbox SET attempts=attempts+1, due=? WHERE id=?').run(this.clock().getTime() + delay * 1000, row.id);
          this.setMeta(`notification:${channel}`, { ...(this.meta(`notification:${channel}`) || {}), error: error.message || '알림 전송 실패' });
          break;
        }
      }
    }
  }


  saveSettings(value) {
    const settings = validateSettings(value);
    const previous = this.meta('settings');
    if (hash(previous) === hash(settings)) return;
    const active = (value, channel) => value.notificationsEnabled && value[`${channel}Enabled`];
    this.transaction(() => {
      this.setMeta('settings', settings);
      this.evaluateDevices();
      this.announceOpenFindings(['slack', 'telegram'].filter(channel => !active(previous, channel) && active(settings, channel)));
    });
  }

  // View-only device groups shared by everyone on this server; they never touch Tailscale tags or rule checks.
  // shortcut: whole-object last-write-wins, fine for a few admins; upgrade to per-change ops if edits start colliding.
  saveViewGroups(value) {
    const groups = value?.groups, members = value?.members;
    if (!Array.isArray(groups) || groups.length > 200 || !members || typeof members !== 'object' || Array.isArray(members)) throw new Error('그룹 형식을 확인하세요.');
    const byId = new Map();
    for (const group of groups) {
      if (!group || !/^[a-z0-9]{1,24}$/.test(group.id) || byId.has(group.id) || typeof group.name !== 'string' || !group.name.trim() || group.name.trim().length > 40) throw new Error('그룹 이름은 1~40자로 입력하세요.');
      byId.set(group.id, { id: group.id, name: group.name.trim(), parent: group.parent ?? null });
    }
    for (const group of byId.values()) {
      if (group.parent !== null && byId.get(group.parent)?.parent !== null) throw new Error('그룹은 2단계까지만 만들 수 있습니다.');
    }
    const entries = Object.entries(members);
    if (entries.length > 5000 || entries.some(([id, groupId]) => typeof id !== 'string' || id.length > 255 || !byId.has(groupId))) throw new Error('장비 그룹 지정을 확인하세요.');
    this.setMeta('viewGroups', { groups: [...byId.values()], members: Object.fromEntries(entries) });
  }

  state() {
    const devices = this.rows('devices').map(row => {
      const device = parse(row.body);
      return { ...device, id: row.id, present: Boolean(row.present) };
    });
    const findings = this.rows('findings').map(row => parse(row.body)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    const channels = Object.fromEntries(['slack', 'telegram'].map(channel => [channel, {
      configured: Boolean(this.notifiers[channel]), enabled: this.meta('settings')[`${channel}Enabled`],
      ...(this.meta(`notification:${channel}`) || {}),
      pending: this.db.prepare('SELECT count(*) AS n FROM outbox WHERE channel=? AND delivered_at IS NULL').get(channel).n
    }]));
    return { configured: this.source.configured, busy: this.busy, lastPoll: this.meta('lastPoll'), auditGap: this.meta('auditGap'),
      settings: this.meta('settings'), viewGroups: this.meta('viewGroups') || { groups: [], members: {} }, collectors: Object.fromEntries(['devices', 'logs'].map(key => [key, this.meta(`collector:${key}`) || {}])),
      devices, findings, // Full before/after values (a whole policy file per ACL change) stay in the DB; the page only needs the summary.
      events: this.db.prepare("SELECT body FROM events WHERE source IN ('tailscale', 'devices') ORDER BY time DESC, rowid DESC LIMIT 500").all().map(row => {
        const { old: _old, new: _new, raw, ...event } = parse(row.body);
        return { ...event, raw: raw && { actor: raw.actor, error: raw.error } };
      }),
      notifications: { channels, error: channels.slack.error || channels.telegram.error || null,
        pending: channels.slack.pending + channels.telegram.pending }
    };
  }
}
