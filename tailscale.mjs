const base = 'https://api.tailscale.com/api/v2';
const scopes = 'devices:core:read logs:configuration:read';

export class Tailscale {
  constructor(env = process.env) {
    this.tailnet = env.TAILSCALE_TAILNET;
    this.clientId = env.TAILSCALE_CLIENT_ID;
    this.clientSecret = env.TAILSCALE_CLIENT_SECRET;
    this.configured = Boolean(this.tailnet && this.clientId && this.clientSecret);
    this.token = null;
    this.tokenRequest = null;
  }

  async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value;
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = (async () => {
      const response = await fetch(`${base}/oauth/token`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret, scope: scopes }) });
      if (!response.ok) throw new Error(`OAuth 인증 실패 (HTTP ${response.status}). Client ID·Secret·읽기 권한을 확인하세요.`);
      const result = await response.json();
      if (typeof result.access_token !== 'string' || !Number.isFinite(result.expires_in)) throw new Error('OAuth 토큰 응답이 올바르지 않습니다.');
      this.token = { value: result.access_token, expires: Date.now() + result.expires_in * 1000 };
      return this.token.value;
    })();
    try { return await this.tokenRequest; } finally { this.tokenRequest = null; }
  }

  // Connects over a slow link sometimes stall past Node's 10 s connect limit; retry those, never HTTP errors.
  async get(path) {
    for (let attempt = 1; ; attempt++) {
      try { return await this.request(path); }
      catch (error) {
        if (!error.network || attempt === 3) throw error;
        await new Promise(done => setTimeout(done, this.retryDelayMs ?? 2000 * attempt));
      }
    }
  }

  async request(path) {
    try {
      const token = await this.accessToken();
      const response = await fetch(`${base}/tailnet/${encodeURIComponent(this.tailnet)}/${path}`, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.timeout(25_000)
      });
      if (!response.ok) {
        if (response.status === 401) this.token = null;
        throw new Error(`Tailscale ${path.split('?')[0]} HTTP ${response.status}. Tailnet·읽기 권한·인증정보를 확인하세요.`);
      }
      return await response.json();
    } catch (error) {
      if (error.name === 'TimeoutError') throw Object.assign(new Error('Tailscale API 응답 시간 초과(3회 시도). 다음 주기에 다시 수집합니다.'), { network: true });
      if (error.message === 'fetch failed') throw Object.assign(new Error('Tailscale API에 연결할 수 없습니다(3회 시도). 서버 네트워크를 확인하세요.'), { network: true });
      throw error;
    }
  }

  async devices() { const result = await this.get('devices'); return result.devices; }
  async logs(start, end) {
    const logs = [];
    let chunkStart = start;
    // Large initial history queries can exceed the per-request timeout.
    do {
      const next = Math.min(Date.parse(chunkStart) + 7 * 86400_000, Date.parse(end));
      const chunkEnd = next < Date.parse(end) ? new Date(next).toISOString() : end;
      const result = await this.get(`logging/configuration?${new URLSearchParams({ start: chunkStart, end: chunkEnd })}`);
      const chunkLogs = result.logs === null ? [] : result.logs;
      if (!Array.isArray(chunkLogs)) throw new Error('logs 응답 형식을 확인할 수 없습니다.');
      logs.push(...chunkLogs);
      chunkStart = chunkEnd;
    } while (Date.parse(chunkStart) < Date.parse(end));
    return logs;
  }
}

const escapeMarkup = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shortTime = value => new Date(value).toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).slice(5, 16).replace('-', '/');
// Reports queued by older versions use sections; they are flattened into the same one-line items.
const report = text => {
  try {
    const value = JSON.parse(text);
    if (Array.isArray(value?.items)) return { buttons: ['console', 'monitor'], more: 0, ...value };
    if (Array.isArray(value?.sections)) return { title: value.title, time: value.time, buttons: ['console', 'monitor'],
      items: value.sections.flatMap(s => s.items.map(i => ({ label: s.label, target: i.target, detail: i.detail }))), more: value.sections.reduce((n, s) => n + s.more, 0) };
  } catch {}
  return null;
};
// One line per item: • [label] target — detail · actor. Escaping blocks <!channel> injection from device names.
const itemLines = (r, bold) => [...r.items.map(i => `• ${i.label ? `[${escapeMarkup(i.label)}] ` : ''}${bold(escapeMarkup(i.target))}${i.detail ? ` — ${escapeMarkup(i.detail)}` : ''}${i.actor ? `  · ${escapeMarkup(i.actor)}` : ''}`),
  ...(r.more ? [`외 ${r.more}건 · 모니터링 화면에서 확인`] : [])];

// Telegram rejects inline-button URLs that point at a local address.
const publicUrl = url => Boolean(url) && !/^https?:\/\/(localhost|127\.|\[::1\])/.test(url);
const buttons = (r, links, telegram) => [
  ...(r.buttons.includes('console') && links.console ? [{ text: 'Tailscale 콘솔', url: links.console }] : []),
  ...(r.buttons.includes('monitor') && (telegram ? publicUrl(links.monitor) : links.monitor) ? [{ text: '모니터링 열기', url: links.monitor }] : [])];

export function slackMessage(text, links = {}) {
  const r = report(text);
  if (!r) return { text: escapeMarkup(text), blocks: [{ type: 'section', text: { type: 'mrkdwn', text: escapeMarkup(text).slice(0, 2900) } }] };
  const links_ = buttons(r, links, false);
  return { text: escapeMarkup(r.title), unfurl_links: false, unfurl_media: false, blocks: [
    { type: 'section', text: { type: 'mrkdwn', text: [`*${escapeMarkup(r.title)}*  ·  ${shortTime(r.time)}`, ...itemLines(r, t => `*${t}*`)].join('\n').slice(0, 2900) } },
    ...(links_.length ? [{ type: 'actions', elements: links_.map((b, i) => ({ type: 'button', text: { type: 'plain_text', text: b.text }, url: b.url, ...(i === links_.length - 1 && b.text === '모니터링 열기' ? { style: 'primary' } : {}) })) }] : [])] };
}

// shortcut: no HTML-aware truncation; 15 items per report keeps it far below Telegram's 4096-char limit.
export function telegramMessage(text, links = {}) {
  const r = report(text);
  if (!r) return { text: text.slice(0, 4000) };
  const links_ = buttons(r, links, true);
  return { parse_mode: 'HTML', text: [`<b>${escapeMarkup(r.title)}</b>  ·  ${shortTime(r.time)}`, ...itemLines(r, t => `<b>${t}</b>`)].join('\n'),
    ...(links_.length ? { reply_markup: { inline_keyboard: [links_] } } : {}) };
}

export function slackSender(url, links) {
  if (!url) return null;
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || !['hooks.slack.com', 'hooks.slack-gov.com'].includes(parsed.hostname) || !parsed.pathname.startsWith('/services/') || parsed.username || parsed.password || parsed.port) {
    throw new Error('SLACK_WEBHOOK_URL은 Slack Incoming Webhook의 HTTPS 주소를 사용하세요.');
  }
  return async text => {
    let response;
    try {
      response = await fetch(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackMessage(text, links)) });
    } catch { throw new Error('Slack 연결 실패. 알림은 대기열에 보관합니다.'); }
    if (!response.ok || (await response.text()).trim() !== 'ok') {
      const error = new Error(`Slack 전송 실패 (HTTP ${response.status}). Webhook 설정을 확인하세요.`);
      error.retryAfter = Number(response.headers.get('retry-after')) || 0;
      throw error;
    }
  };
}

export function telegramSender(token, chatId, links) {
  if (!token && !chatId) return null;
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '') || !/^(?:-?\d+|@[a-zA-Z0-9_]{5,32})$/.test(chatId || '')) {
    throw new Error('TELEGRAM_BOT_TOKEN과 TELEGRAM_CHAT_ID를 함께 확인하세요.');
  }
  return async text => {
    let response, result;
    try {
      response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, ...telegramMessage(text, links), link_preview_options: { is_disabled: true } })
      });
      result = await response.json();
    } catch { throw new Error('Telegram 연결 실패. 알림은 대기열에 보관합니다.'); }
    if (!response.ok || result.ok !== true) {
      const reason = typeof result?.description === 'string' ? ` · ${result.description.slice(0, 200)}` : '';
      const error = new Error(`Telegram 전송 실패 (HTTP ${response.status}${reason}). 봇·대화방 설정을 확인하세요.`);
      error.retryAfter = Number(result.parameters?.retry_after) || 0;
      throw error;
    }
  };
}
