import { readFileSync } from 'node:fs';

export const currentVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const parts = tag => /^(\d+)\.(\d+)\.(\d+)$/.exec(tag)?.slice(1).map(Number);
export const isVersion = tag => Boolean(parts(tag));
export const isNewer = (a, b) => {
  const [x, y] = [parts(a), parts(b)];
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
export const latestVersion = tags => tags.filter(isVersion).reduce((best, tag) => !best || isNewer(tag, best) ? tag : best, null);

// UPDATE_IMAGE is "<registry host>/<repository>"; UPDATE_REGISTRY_URL overrides the API base (e.g. a local test registry).
export function updateConfig(env) {
  const image = env.UPDATE_IMAGE || '';
  if (!image) return null;
  const [host, ...path] = image.split('/');
  if (!host || !path.length || !/^[a-z0-9._/-]+$/.test(path.join('/'))) throw new Error('UPDATE_IMAGE는 레지스트리주소/저장소 형식으로 설정하세요.');
  const base = env.UPDATE_REGISTRY_URL || `https://${host}`;
  if (!/^https?:\/\/[^\s/]+$/.test(base)) throw new Error('UPDATE_REGISTRY_URL을 확인하세요.');
  const user = env.REGISTRY_USER || '', password = env.REGISTRY_PASSWORD || '';
  return { image, host, repository: path.join('/'), base, user, password,
    authorization: user ? `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}` : dockerConfigAuth(env.REGISTRY_AUTH_FILE, host) };
}

// Reuses an existing `docker login` (config.json "auth" is already base64 user:password), so no password is copied into .env.
function dockerConfigAuth(file, host) {
  if (!file) return '';
  try {
    const auth = JSON.parse(readFileSync(file, 'utf8')).auths?.[host]?.auth;
    return typeof auth === 'string' && auth ? `Basic ${auth}` : '';
  } catch { return ''; }
}

export async function fetchTags(config) {
  let response;
  try {
    response = await fetch(`${config.base}/v2/${config.repository}/tags/list?n=1000`, { redirect: 'error', signal: AbortSignal.timeout(20_000),
      headers: config.authorization ? { Authorization: config.authorization } : {} });
  } catch { throw new Error('이미지 레지스트리에 연결할 수 없습니다.'); }
  if (!response.ok) throw new Error(`이미지 레지스트리 응답 HTTP ${response.status}. REGISTRY_USER·REGISTRY_PASSWORD를 확인하세요.`);
  const body = await response.json();
  return Array.isArray(body.tags) ? body.tags.filter(tag => typeof tag === 'string') : [];
}
