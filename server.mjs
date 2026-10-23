import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, timingSafeEqual } from 'node:crypto';
import { Monitor } from './monitor.mjs';
import { Tailscale, slackSender, telegramSender } from './tailscale.mjs';
import { Integrations } from './integrations.mjs';
import { demoSource, seedDemo } from './demo.mjs';
import { currentVersion, updateConfig, fetchTags, latestVersion, isNewer } from './updates.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']]
]);
const digest = text => createHash('sha256').update(text).digest();

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 65_536) throw new Error('요청이 너무 큽니다.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('JSON 요청 형식을 확인하세요.'); }
}

export async function startServer({ env = process.env, dbPath, source, notifiers, demo = false } = {}) {
  const bind = env.MONITOR_BIND || '127.0.0.1';
  const port = Number(env.MONITOR_PORT ?? 8787);
  const password = env.MONITOR_PASSWORD || '';
  const username = env.MONITOR_USER || 'admin';
  if (!/^[^:\s]{1,64}$/.test(username)) throw new Error('MONITOR_USER는 공백과 콜론 없이 1~64자로 설정하세요.');
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('MONITOR_PORT를 확인하세요.');
  if ((password && password.length < 8) || (!['127.0.0.1', 'localhost', '::1'].includes(bind) && !password)) throw new Error('외부 인터페이스 사용 시 MONITOR_PASSWORD를 8자 이상 설정하세요.');
  const allowedHosts = new Set(['localhost', '127.0.0.1', '[::1]', ...(env.MONITOR_ALLOWED_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean)]);
  const interval = Number(env.POLL_INTERVAL_SEC || 60);
  if (!Number.isInteger(interval) || interval < 15 || interval > 3600) throw new Error('POLL_INTERVAL_SEC는 15~3600초로 설정하세요.');
  const monitorUrl = env.MONITOR_PUBLIC_URL || `http://127.0.0.1:${port || 8787}`;
  if (!/^https?:\/\/[^\s]+$/.test(monitorUrl)) throw new Error('MONITOR_PUBLIC_URL은 http(s) 주소로 설정하세요.');
  const links = { console: 'https://login.tailscale.com/admin/machines', monitor: monitorUrl };
  const updates = demo ? null : updateConfig(env);
  const updaterUrl = env.UPDATER_URL || '';
  const updateCheckSec = Number(env.UPDATE_CHECK_SEC || 600);
  if (!Number.isInteger(updateCheckSec) || updateCheckSec < 60) throw new Error('UPDATE_CHECK_SEC는 60초 이상으로 설정하세요.');
  const update = { current: currentVersion, latest: null, checkedAt: null, error: null, updater: null, enabled: Boolean(updates && updaterUrl) };
  const callUpdater = async (path, value) => {
    const response = await fetch(`${updaterUrl}${path}`, { method: value ? 'POST' : 'GET', signal: AbortSignal.timeout(5000),
      headers: { Authorization: `Bearer ${env.UPDATER_TOKEN || ''}`, 'Content-Type': 'application/json' }, body: value && JSON.stringify(value) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `업데이터 응답 HTTP ${response.status}`);
    return result;
  };
  const storage = dbPath || (demo ? ':memory:' : resolve(env.DATA_DIR || resolve(root, '.data'), 'monitor.sqlite'));
  const monitor = new Monitor({ dbPath: storage, source: { configured: false } });
  let integrations;
  const applyIntegrations = (values, initial = false) => {
    monitor.source = initial && source ? source : demo ? demoSource : new Tailscale(values);
    monitor.notifiers = demo ? {} : initial && notifiers ? notifiers : {
      slack: slackSender(values.SLACK_WEBHOOK_URL, links), telegram: telegramSender(values.TELEGRAM_BOT_TOKEN, values.TELEGRAM_CHAT_ID, links) };
  };
  try { integrations = new Integrations(monitor, env, storage); applyIntegrations(integrations.values(), true); }
  catch (error) { monitor.close(); throw error; }
  if (demo) await seedDemo(monitor);
  const checkUpdates = async () => {
    try {
      const latest = latestVersion(await fetchTags(updates));
      Object.assign(update, { latest: isNewer(latest, currentVersion) ? latest : null, checkedAt: new Date().toISOString(), error: null });
      if (update.latest && monitor.meta('updateAnnounced') !== update.latest) {
        monitor.queueReport(`Tailscale 모니터링 새 버전 ${update.latest}`, [{ label: '업데이트 가능', more: 0, items: [{ target: `${currentVersion} → ${update.latest}`, address: '',
          detail: update.enabled ? '모니터링 화면 상단의 업데이트 버튼으로 적용합니다.' : '서버에서 이미지를 받아 다시 실행하세요.' }] }]);
        monitor.setMeta('updateAnnounced', update.latest);
      }
    } catch (error) { Object.assign(update, { checkedAt: new Date().toISOString(), error: error.message }); }
  };
  let currentPoll = null;
  let savingIntegrations = false;
  const runPoll = () => {
    if (currentPoll) return currentPoll;
    currentPoll = monitor.poll().catch(() => { console.error('수집 중 내부 오류가 발생했습니다. 서버 상태를 확인하세요.'); }).finally(() => { currentPoll = null; });
    return currentPoll;
  };
  const server = http.createServer(async (req, res) => {
    const send = (status, value) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(value));
    };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (!allowedHosts.has(url.hostname)) return send(403, { error: 'MONITOR_ALLOWED_HOSTS에 허용된 주소로 접속하세요.' });
      if (url.pathname === '/healthz' && req.method === 'GET') return send(200, { running: true });
      if (password && !timingSafeEqual(digest(req.headers.authorization || ''), digest(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`))) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Tailscale Monitor", charset="UTF-8"');
        return send(401, { error: '로그인이 필요합니다.' });
      }
      if (req.method === 'GET') {
        if (url.pathname === '/api/state') {
          if (update.updater?.state === 'updating') update.updater = await callUpdater('/status').catch(error => ({ state: 'failed', error: error.message }));
          return send(200, { ...monitor.state(), update, integrations: integrations.status(), demo, pollIntervalSec: interval, serverTime: new Date().toISOString() });
        }
        const asset = assets.get(url.pathname);
        if (!asset) return send(404, { error: '페이지를 찾을 수 없습니다.' });
        const content = await readFile(resolve(root, 'public', asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1] });
        return res.end(content);
      }
      if (req.method !== 'POST') return send(405, { error: '지원하지 않는 요청입니다.' });
      if (req.headers['x-monitor-request'] !== '1' || !req.headers['content-type']?.startsWith('application/json')
        || req.headers['sec-fetch-site'] === 'cross-site'
        || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)) return send(403, { error: '같은 모니터링 사이트에서 요청하세요.' });
      const input = await body(req);
      if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { error: '요청 내용을 확인하세요.' });
      switch (url.pathname) {
        case '/api/poll': void runPoll(); return send(202, { ok: true });
        case '/api/settings': monitor.saveSettings(input); break;
        case '/api/groups': monitor.saveViewGroups(input); break;
        case '/api/update': {
          if (!update.enabled) return send(400, { error: '이 설치에서는 웹 업데이트를 사용할 수 없습니다. UPDATE_IMAGE와 UPDATER_URL을 확인하세요.' });
          if (!update.latest) return send(400, { error: '적용할 새 버전이 없습니다.' });
          update.updater = await callUpdater('/update', { version: update.latest });
          return send(202, { ok: true, update });
        }
        case '/api/integrations/reveal': return send(200, { value: integrations.reveal(input.key) });
        case '/api/integrations': {
          if (savingIntegrations) return send(409, { error: '다른 연동 정보를 저장 중입니다. 잠시 후 다시 시도하세요.' });
          savingIntegrations = true;
          try {
            if (currentPoll) await currentPoll;
            const previous = integrations.values();
            const values = integrations.save(input);
            applyIntegrations(values);
            // A new tailnet is backfilled from scratch; its history must not be alerted as fresh changes.
            if (previous.TAILSCALE_TAILNET !== values.TAILSCALE_TAILNET) { monitor.setMeta('auditCursor', null); monitor.setMeta('changeAlertsSince', null); }
            const changed = [];
            if (previous.SLACK_WEBHOOK_URL !== values.SLACK_WEBHOOK_URL) { monitor.setMeta('notification:slack', {}); changed.push('slack'); }
            if (previous.TELEGRAM_BOT_TOKEN !== values.TELEGRAM_BOT_TOKEN || previous.TELEGRAM_CHAT_ID !== values.TELEGRAM_CHAT_ID) { monitor.setMeta('notification:telegram', {}); changed.push('telegram'); }
            monitor.announceOpenFindings(changed);
            if (!demo) await runPoll();
          } finally { savingIntegrations = false; }
          return send(200, { ok: true, integrations: integrations.status() });
        }
        default: return send(404, { error: '요청 경로를 찾을 수 없습니다.' });
      }
      send(200, { ok: true });
    } catch (error) {
      if (error.code === 'ENOENT') return send(503, { error: '화면 파일이 준비되지 않았습니다.' });
      send(400, { error: error.code ? '요청을 처리하지 못했습니다.' : error.message });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.maxHeadersCount = 50;
  try { await new Promise((done, reject) => { server.once('error', reject); server.listen(port, bind, done); }); }
  catch (error) { monitor.close(); throw error; }
  const timer = setInterval(runPoll, interval * 1000);
  timer.unref();
  if (!demo) void runPoll();
  const updateTimer = updates ? setInterval(checkUpdates, updateCheckSec * 1000) : null;
  updateTimer?.unref();
  if (updates) void checkUpdates();
  return { server, monitor, async close() {
    clearInterval(timer);
    clearInterval(updateTimer);
    if (currentPoll) await currentPoll;
    await new Promise(done => server.close(done));
    monitor.close();
  } };
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const app = await startServer({ demo });
  console.log(`Tailscale Monitor${demo ? ' · 예시 모드' : ''}: http://${process.env.MONITOR_BIND || '127.0.0.1'}:${app.server.address().port}`);
  console.log(demo ? '예시 데이터만 사용합니다. 실제 연동은 일반 모드에서 설정하세요.' : '규칙·알림 → 연동 설정에서 연결 정보를 저장하세요. 종료하려면 Ctrl+C를 누르세요.');
  const shutdown = async () => { await app.close(); process.exit(0); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
