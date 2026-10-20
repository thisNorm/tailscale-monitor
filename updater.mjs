// Runs in its own container with the Docker socket. It has no published port; only the monitor container calls it.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash, timingSafeEqual } from 'node:crypto';
import { updateConfig, isVersion } from './updates.mjs';

const env = process.env;
const config = updateConfig(env);
const projectDir = env.PROJECT_DIR;
const token = env.UPDATER_TOKEN || '';
const digest = text => createHash('sha256').update(text).digest();
let status = { state: 'idle', version: null, error: null, at: null };

const run = (command, args, input) => new Promise((done, fail) => {
  // Minimal env: compose prefers process env over .env, so the container's old MONITOR_TAG must not leak in.
  const child = execFile(command, args, { cwd: projectDir, env: { PATH: env.PATH, HOME: env.HOME || '/root', PWD: projectDir }, timeout: 10 * 60_000, maxBuffer: 4 << 20 },
    (error, stdout, stderr) => error ? fail(new Error(`${args.slice(0, 2).join(' ')} 실패: ${(stderr || error.message).trim().split('\n').at(-1)}`)) : done(stdout));
  if (input !== undefined) child.stdin.end(input);
});

export async function setTag(file, version) {
  const text = await readFile(file, 'utf8').catch(() => '');
  const next = /^MONITOR_TAG=.*$/m.test(text) ? text.replace(/^MONITOR_TAG=.*$/m, `MONITOR_TAG=${version}`) : `${text.replace(/\n?$/, '\n')}MONITOR_TAG=${version}\n`;
  await writeFile(file, next);
}

async function update(version) {
  status = { state: 'updating', version, error: null, at: new Date().toISOString() };
  try {
    if (config.user) await run('docker', ['login', config.host, '-u', config.user, '--password-stdin'], config.password);
    await run('docker', ['pull', `${config.image}:${version}`]);
    await setTag(resolve(projectDir, '.env'), version);
    await run('docker', ['compose', 'up', '-d', '--no-deps', 'monitor']);
    status = { state: 'done', version, error: null, at: new Date().toISOString() };
  } catch (error) {
    status = { state: 'failed', version, error: error.message, at: new Date().toISOString() };
  }
}

if (process.argv[1]?.endsWith('updater.mjs')) {
  if (!config || !projectDir || token.length < 16) throw new Error('UPDATE_IMAGE, PROJECT_DIR, UPDATER_TOKEN(16자 이상)을 설정하세요.');
  http.createServer(async (req, res) => {
    const send = (code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${token}`))) return send(401, { error: 'unauthorized' });
    if (req.method === 'GET' && req.url === '/status') return send(200, status);
    if (req.method !== 'POST' || req.url !== '/update') return send(404, { error: 'not found' });
    let raw = '';
    for await (const chunk of req) { raw += chunk; if (raw.length > 1024) return send(413, { error: 'too large' }); }
    const version = (() => { try { return JSON.parse(raw).version; } catch { return null; } })();
    if (!isVersion(version)) return send(400, { error: '버전 형식이 올바르지 않습니다.' });
    if (status.state === 'updating') return send(409, { error: '이미 업데이트 중입니다.' });
    void update(version);
    send(202, status);
  }).listen(9000, '0.0.0.0', () => console.log('updater listening on :9000'));
}
