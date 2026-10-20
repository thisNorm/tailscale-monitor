import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { slackSender, telegramSender } from './tailscale.mjs';

export const integrationKeys = ['TAILSCALE_TAILNET', 'TAILSCALE_CLIENT_ID', 'TAILSCALE_CLIENT_SECRET',
  'SLACK_WEBHOOK_URL', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'];

export class Integrations {
  constructor(monitor, env, dbPath) {
    this.monitor = monitor;
    this.env = Object.fromEntries(integrationKeys.map(key => [key, env[key] || '']));
    this.keyPath = dbPath === ':memory:' ? null : resolve(dirname(dbPath), 'credentials.key');
    this.key = null;
    this.saved = {};
    const stored = monitor.meta('integrations');
    if (stored) {
      try {
        this.key = readFileSync(this.keyPath);
        const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(stored.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
        this.saved = JSON.parse(Buffer.concat([decipher.update(Buffer.from(stored.data, 'base64')), decipher.final()]).toString('utf8'));
      } catch { throw new Error('저장된 연동 정보를 읽지 못했습니다. 데이터 폴더와 credentials.key를 함께 복원하세요.'); }
    }
  }

  values() { return { ...this.env, ...this.saved }; }
  status() { return Object.fromEntries(Object.entries(this.values()).map(([key, value]) => [key, Boolean(value)])); }
  reveal(key) {
    if (!integrationKeys.includes(key)) throw new Error('조회할 연동 항목을 확인하세요.');
    return this.values()[key];
  }

  save(input) {
    if (Object.keys(input).some(key => !integrationKeys.includes(key))) throw new Error('연동 설정 항목을 확인하세요.');
    const patch = {};
    for (const [key, value] of Object.entries(input)) {
      if (typeof value !== 'string' || value.length > 4096 || /[\r\n\x00-\x1f\x7f]/.test(value) || value.includes('•')) throw new Error('연동 정보의 입력 형식을 확인하세요.');
      patch[key] = value.trim();
    }
    const values = { ...this.values(), ...patch };
    const tailscale = integrationKeys.slice(0, 3).map(key => values[key]);
    if (tailscale.some(Boolean) && !tailscale.every(Boolean)) throw new Error('Tailscale의 Tailnet, Client ID, Client Secret을 모두 입력하세요.');
    if (values.TAILSCALE_TAILNET && !/^[a-zA-Z0-9._@-]+$/.test(values.TAILSCALE_TAILNET)) throw new Error('Tailnet 이름을 확인하세요. URL 대신 이름만 입력하세요.');
    try { slackSender(values.SLACK_WEBHOOK_URL); }
    catch { throw new Error('Slack Incoming Webhook의 HTTPS 주소를 입력하세요.'); }
    telegramSender(values.TELEGRAM_BOT_TOKEN, values.TELEGRAM_CHAT_ID);
    if (!this.key) {
      let key = randomBytes(32);
      if (this.keyPath) {
        try { writeFileSync(this.keyPath, key, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; key = readFileSync(this.keyPath); }
      }
      this.key = key;
    }
    const saved = { ...this.saved, ...patch };
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(saved), 'utf8'), cipher.final()]);
    this.monitor.setMeta('integrations', { iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') });
    this.saved = saved;
    return values;
  }
}
