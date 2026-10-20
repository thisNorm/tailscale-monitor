const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const split = value => value.split(/[,\n]/).map(s => s.trim()).filter(Boolean);
const date = value => value ? new Date(value).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '기록 없음';
const ago = value => {
  const diff = Date.now() - Date.parse(value), minutes = Math.abs(diff) / 60000;
  if (minutes < 1) return '방금';
  const [n, unit] = minutes < 60 ? [minutes, '분'] : minutes < 1440 ? [minutes / 60, '시간'] : [minutes / 1440, '일'];
  return `${Math.round(n)}${unit} ${diff >= 0 ? '전' : '후'}`;
};
function presence(d) {
  if (!d.present) return '';
  const online = d.connectedToControl === true;
  const days = d.expires && !d.keyExpiryDisabled ? (Date.parse(d.expires) - Date.now()) / 86400000 : Infinity;
  return `<small class="presence ${online ? 'online' : 'offline'}" title="${escapeHtml(d.lastSeen ? date(d.lastSeen) : '')}">${online ? '연결됨' : `마지막 접속 ${d.lastSeen ? escapeHtml(ago(d.lastSeen)) : '기록 없음'}`}</small>`
    + (days < 14 ? `<small class="expiry" title="${escapeHtml(date(d.expires))}">${days <= 0 ? '키 만료됨 · 재인증 필요' : `키 만료 ${escapeHtml(ago(d.expires))}`}</small>` : '');
}
const origins = { ADMIN_CONSOLE: '관리 콘솔', ADMIN_UI: '관리 콘솔', CONFIG_API: 'API', CONTROL: 'Tailscale 서비스', NODE: '장비에서 실행', POLL: '장비 수집 비교', IDENTITY_PROVIDER: '인증 제공자', SUPPORT_REQUEST: '지원 요청' };
const eventKinds = { registered: '등록', deleted: '삭제', tagged: '태그 변경' };
const pages = {
  devices: ['장비', '태그별로 장비를 확인하고 웹에서 표시 그룹을 정리합니다.'],
  history: ['등록 · 삭제 이력', '장비 등록·삭제와 태그 변경을 시간순으로 확인합니다.'],
  settings: ['규칙 · 알림', '검사할 컨벤션과 알림을 받을 채널을 설정합니다.']
};
const integrationGroups = [
  { id: 'tailscale', label: 'Tailscale', description: '장비와 등록·삭제 이력 수집', fields: [
    ['TAILSCALE_TAILNET', 'Tailnet', '예: example.com 또는 tailnet 이름'],
    ['TAILSCALE_CLIENT_ID', 'Client ID', 'OAuth Client ID'],
    ['TAILSCALE_CLIENT_SECRET', 'Client Secret', 'OAuth Client Secret']
  ] },
  { id: 'telegram', label: 'Telegram', description: '개인 테스트 알림', fields: [
    ['TELEGRAM_BOT_TOKEN', 'Bot Token', 'BotFather에서 발급한 토큰'],
    ['TELEGRAM_CHAT_ID', 'Chat ID', '숫자 또는 @채널명']
  ] },
  { id: 'slack', label: 'Slack', description: '팀 공용 알림', fields: [
    ['SLACK_WEBHOOK_URL', 'Webhook URL', 'https://hooks.slack.com/services/…']
  ] }
];
const credentialMask = '••••••••';
const deviceGroupingStorageKey = 'invako-monitor-unregistered-v1';
let unregisteredDevices = readDeviceGrouping();
const deviceGroupOrderStorageKey = 'invako-monitor-group-order-v1';
// Per-browser view preference: which tag groups this computer keeps folded.
const collapsedGroupsStorageKey = 'invako-monitor-collapsed-groups-v1';
const readCollapsedGroups = () => {
  try {
    const saved = JSON.parse(localStorage.getItem(collapsedGroupsStorageKey) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter(tag => typeof tag === 'string') : []);
  } catch { return new Set(); }
};
let collapsedGroups = readCollapsedGroups();
let deviceGroupOrder = readDeviceGroupOrder();
let deviceTagFilter = '*';
let state;
let page = 'devices';
let deviceFilter = 'all';
let historyFilter = 'all';
let deviceSearch = '';
let historySearch = '';
let loading = false;
let formDirty = false;
let toastTimer;
let loadedVersion;

const themeStorageKey = 'invako-monitor-theme';
function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  $('#theme').value = ['light', 'dark'].includes(theme) ? theme : 'system';
}
try { applyTheme(localStorage.getItem(themeStorageKey)); } catch { applyTheme('system'); }

function toast(text) {
  $('#toast').textContent = text;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3500);
}

async function post(path, value) {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Monitor-Request': '1' }, body: JSON.stringify(value) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '저장하지 못했습니다.');
  return data;
}

function openFindings(id) { return state.findings.filter(item => item.deviceId === id && !item.resolvedAt); }

function renderChrome() {
  const failed = Object.values(state.collectors).filter(item => item.error);
  const stale = state.lastPoll && Date.now() - Date.parse(state.lastPoll) > (state.pollIntervalSec * 2 + 60) * 1000;
  const connection = $('#connection');
  connection.textContent = state.demo ? '예시 데이터' : !state.configured ? '연동 전' : failed.length ? '수집 오류' : stale ? '수집 지연' : state.busy ? '수집 중' : '자동 수집 중';
  connection.className = `status-dot${failed.length || stale ? ' error' : !state.configured || state.demo ? ' warn' : ''}`;
  $('#poll-button').disabled = !state.configured || state.busy;
  $('#poll-label').textContent = state.busy ? '검사 중…' : '지금 검사';
  $('#poll-interval').textContent = `${state.pollIntervalSec}초 주기`;
  $('#last-sync').textContent = `${state.lastPoll ? `마지막 검사 ${date(state.lastPoll)} · ${state.pollIntervalSec}초 간격` : '인증정보 설정 후 자동 수집을 시작합니다.'}${state.update ? ` · v${state.update.current}` : ''}`;
  const banners = [];
  if (state.demo) banners.push('<div class="banner demo-banner"><span class="banner-label">예시 환경</span><p>가상 장비와 기록으로 구성한 화면입니다. 실제 Tailscale 수집과 알림 전송은 실행하지 않습니다.</p></div>');
  if (!state.configured) banners.push('<div class="banner warning"><p>Tailscale 연동 정보를 저장하면 장비와 등록·삭제 이력을 자동으로 가져옵니다. <a href="#settings">연동 설정 열기</a></p></div>');
  for (const [key, item] of Object.entries(state.collectors)) {
    if (item.error) banners.push(`<div class="banner error"><p><strong>${key === 'devices' ? '장비' : '감사 로그'} 수집 실패</strong> · ${escapeHtml(item.error)}<br>마지막 성공: ${escapeHtml(date(item.lastSuccess))}. 기존 기록은 유지됩니다.</p></div>`);
  }
  if (stale) banners.push('<div class="banner warning"><p>수집이 지연되고 있습니다. 서버와 네트워크 연결을 확인하세요.</p></div>');
  const update = state.update;
  if (update?.updater?.state === 'updating') banners.push(`<div class="banner update-banner"><p><strong>${escapeHtml(update.updater.version)}(으)로 업데이트 중</strong> · 새 이미지를 받고 다시 시작합니다. 끝나면 화면이 자동으로 새로고침됩니다.</p></div>`);
  else if (update?.latest) banners.push(`<div class="banner update-banner"><p><strong>새 버전 ${escapeHtml(update.latest)}</strong> · 현재 ${escapeHtml(update.current)}${update.updater?.state === 'failed' ? ` · 지난 업데이트 실패: ${escapeHtml(update.updater.error || '')}` : ''}</p>${update.enabled ? '<button type="button" class="primary" data-update>업데이트</button>' : '<small>서버에서 직접 업데이트하세요.</small>'}</div>`);
  if (state.auditGap) banners.push(`<div class="banner warning"><p>${escapeHtml(state.auditGap)}</p></div>`);
  if (state.notifications.error) banners.push(`<div class="banner warning"><p>알림 전송 대기 · ${escapeHtml(state.notifications.error)} <a href="#settings">알림 설정</a></p></div>`);
  $('#banners').innerHTML = banners.join('');
  renderIntegrationStatus();
}

function devicesView() {
  return `<div class="device-workbench"><section class="device-main" aria-label="장비 목록">
    <div class="device-toolbar"><div class="filters" aria-label="장비 필터">
      ${[['all', '전체'], ['unregistered', '미등록'], ['violations', '컨벤션 위반'], ['removed', '목록에서 사라짐']].map(([value, label]) => `<button type="button" class="filter ${deviceFilter === value ? 'active' : ''}" data-device-filter="${value}" aria-pressed="${deviceFilter === value}">${label}<span class="filter-count" data-count="${value}">${deviceCount(value)}</span></button>`).join('')}
    </div><label class="search"><span class="sr-only">장비 검색</span><input id="device-search" type="search" placeholder="장비명, Tailscale IP, 태그 검색" value="${escapeHtml(deviceSearch)}"></label></div>
    <div class="device-group-tools"><label class="tag-group-filter"><span>태그 그룹</span><select id="device-tag-filter" aria-label="태그 그룹">${deviceTagOptions()}</select></label></div>
    <div id="device-sections">${deviceGroups()}</div>
    <div class="table-note"><span>목록 이탈 ≠ 삭제 확정</span></div>
  </section><aside class="inspector" aria-label="규칙과 최근 이력">${settingsView(true)}${historyPreview()}</aside></div>`;
}

function readDeviceGrouping() {
  try {
    const saved = JSON.parse(localStorage.getItem(deviceGroupingStorageKey) || '[]');
    return new Set(Array.isArray(saved) ? saved.filter(id => typeof id === 'string') : []);
  } catch { return new Set(); }
}

function readDeviceGroupOrder() {
  try {
    const saved = JSON.parse(localStorage.getItem(deviceGroupOrderStorageKey) || '[]');
    return [...new Set(Array.isArray(saved) ? saved.filter(tag => typeof tag === 'string') : [])];
  } catch { return []; }
}

function orderedDeviceGroupKeys() {
  const keys = new Set(['']);
  for (const device of state.devices) {
    if (!isUnregistered(device)) for (const tag of device.tags) keys.add(tag);
  }
  return [...deviceGroupOrder.filter(tag => keys.has(tag)), ...[...keys].filter(tag => !deviceGroupOrder.includes(tag)).sort((a, b) => a.localeCompare(b))];
}

function deviceTagOptions() {
  const keys = orderedDeviceGroupKeys();
  if (deviceTagFilter !== '*' && !keys.includes(deviceTagFilter)) deviceTagFilter = '*';
  return `<option value="*"${deviceTagFilter === '*' ? ' selected' : ''}>전체 그룹</option>` + keys.map(tag => `<option value="${escapeHtml(tag)}"${deviceTagFilter === tag ? ' selected' : ''}>${escapeHtml(tag || '미등록 장비')}</option>`).join('');
}

function isUnregistered(device) { return !device.tags.length || unregisteredDevices.has(device.id); }

function matchesDeviceFilter(device, filter) {
  return filter === 'removed' ? !device.present : filter === 'violations' ? device.present && openFindings(device.id).length : filter === 'unregistered' ? isUnregistered(device) : true;
}

function deviceCount(filter) { return state.devices.filter(device => matchesDeviceFilter(device, filter)).length; }

function deviceGroups() {
  const query = deviceSearch.trim().toLowerCase();
  const devices = state.devices.filter(device => matchesDeviceFilter(device, deviceFilter))
    .filter(device => [device.displayName, device.hostname, ...device.addresses, ...device.tags].join(' ').toLowerCase().includes(query))
    .sort((a, b) => Boolean(b.present && openFindings(b.id).length) - Boolean(a.present && openFindings(a.id).length) || a.displayName.localeCompare(b.displayName));
  const groups = new Map([['', []]]);
  for (const device of devices) {
    for (const tag of isUnregistered(device) ? [''] : new Set(device.tags)) {
      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag).push(device);
    }
  }
  const visibleKeys = orderedDeviceGroupKeys().filter(tag => groups.has(tag) && (deviceTagFilter === '*' || deviceTagFilter === tag));
  if (!visibleKeys.length) return '<p class="empty">선택한 그룹에서 조건에 맞는 장비가 없습니다.</p>';
  return visibleKeys.map((tag, index) => {
    const items = groups.get(tag);
    const title = tag || '미등록 장비';
    const collapsed = collapsedGroups.has(tag);
    const violations = items.filter(d => d.present && openFindings(d.id).length).length;
    return `<section class="panel device-panel${tag ? '' : ' unregistered-panel'}${collapsed ? ' collapsed' : ''}" data-device-group="${escapeHtml(tag)}" aria-label="${escapeHtml(title)}">
      <div class="panel-header"><div class="section-title"><h2><button type="button" class="group-toggle" data-group-toggle="${escapeHtml(tag)}" aria-expanded="${!collapsed}" aria-controls="group-body-${index}"><span class="chevron" aria-hidden="true"></span>${escapeHtml(title)}</button></h2><span class="result-count">${items.length}</span>${violations ? `<span class="group-violations">위반 ${violations}</span>` : ''}</div><div class="device-group-heading-tools"><span class="section-mark">${tag ? '현재 태그 기준' : '태그 없음 · 웹에서 이동한 장비'}</span><div class="device-group-order" aria-label="${escapeHtml(title)} 순서 변경"><button type="button" data-group-order="up" data-group-order-tag="${escapeHtml(tag)}" aria-label="${escapeHtml(title)} 그룹 위로" title="위로 이동" ${index === 0 ? 'disabled' : ''}>↑</button><button type="button" data-group-order="down" data-group-order-tag="${escapeHtml(tag)}" aria-label="${escapeHtml(title)} 그룹 아래로" title="아래로 이동" ${index === visibleKeys.length - 1 ? 'disabled' : ''}>↓</button></div></div></div>
      <div class="table-wrap" id="group-body-${index}"><table class="device-table"><caption class="sr-only">${escapeHtml(title)} 장비 목록</caption><thead><tr><th scope="col">장비명</th><th scope="col">Tailscale IP</th><th scope="col">현재 태그</th><th scope="col">검사 결과</th></tr></thead><tbody>${deviceRows(items)}</tbody></table></div></section>`;
  }).join('');
}

function renderDeviceList() {
  const tagFilter = $('#device-tag-filter');
  if (tagFilter) tagFilter.innerHTML = deviceTagOptions();
  $('#device-sections').innerHTML = deviceGroups();
  document.querySelectorAll('[data-device-filter]').forEach(button => {
    const active = button.dataset.deviceFilter === deviceFilter;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active);
    button.querySelector('[data-count]').textContent = deviceCount(button.dataset.deviceFilter);
  });
}

function deviceRows(devices) {
  if (!devices.length) return `<tr><td colspan="4" class="empty">${!state.configured ? 'Tailscale 연동을 기다리고 있습니다.' : deviceSearch.trim() ? '검색 결과가 없습니다.' : '표시할 장비가 없습니다.'}</td></tr>`;
  return devices.map(d => {
    const findings = openFindings(d.id);
    const moved = unregisteredDevices.has(d.id);
    const groupAction = moved ? '태그 기준으로 복원' : '미등록으로 이동';
    const excluded = state.settings.excludedDevices?.includes(d.id);
    const excludeAction = excluded ? '예외 해제' : '알림 제외';
    const rules = state.settings.tagRules.filter(rule => findings.some(item => item.code === `tag-rule:${rule.prefix}`));
    const extraTags = d.present ? d.tags.filter(tag => rules.some(rule => !rule.tags.includes(tag))) : [];
    const reason = extraTags.length ? '초과 태그' : findings.some(item => item.code === 'missing-tags') ? '태그 미지정' : findings.some(item => item.code === 'name-convention') ? '이름 규칙 위반' : '태그 규칙 위반';
    return `<tr class="${!d.present ? 'row-missing' : findings.length ? 'row-violation' : ''}"><td class="device-cell"><div class="device-identity"><span class="device-symbol" aria-hidden="true"></span><div><strong>${escapeHtml(d.displayName)}</strong><small>${escapeHtml(d.os || '')}${d.os ? ' · ' : ''}<span class="mono">${escapeHtml(d.id)}</span></small>${d.hostname !== d.displayName ? `<small>OS 이름: ${escapeHtml(d.hostname)}</small>` : ''}${presence(d)}</div></div>${moved ? '<small class="device-group-label">웹에서 미등록으로 분류</small>' : ''}${d.tags.length || moved ? `<button type="button" class="device-group-action" data-device-group-id="${escapeHtml(d.id)}" data-device-group-action="${moved ? 'restore' : 'unregister'}" aria-label="${escapeHtml(d.displayName)} ${groupAction}">${groupAction}</button>` : ''}${d.present && (findings.length || excluded) ? `<button type="button" class="device-group-action" data-exclude-id="${escapeHtml(d.id)}" aria-label="${escapeHtml(d.displayName)} ${excludeAction}">${excludeAction}</button>` : ''}</td>
    <td class="ip-cell">${(ip => ip ? `<button type="button" class="ip-chip" data-copy="${escapeHtml(ip)}" title="클릭해서 복사${escapeHtml(d.addresses.filter(a => a !== ip).map(a => ` · ${a}`).join(''))}">${escapeHtml(ip)}</button>` : '')(d.addresses.find(a => !a.includes(':')) || d.addresses[0])}</td><td class="tags">${d.tags.length ? d.tags.map(tag => `<span class="tag${extraTags.includes(tag) ? ' tag-extra' : ''}">${extraTags.includes(tag) ? '<span aria-label="초과 태그">+</span> ' : ''}${escapeHtml(tag)}</span>`).join('') : '<span class="tag tag-empty">∅ 태그 없음</span>'}</td>
    <td>${excluded && d.present ? '<span class="excluded-label">예외 장비 · 검사·알림 제외</span><p class="result-detail">팀이 허용한 예외입니다. 해제하면 다시 검사합니다.</p>' : !d.present ? '<div class="missing-label">목록에서 사라짐</div><p class="violation muted">삭제 여부는 감사 로그에서 확인합니다.</p>' : findings.length ? `<div class="violation-label">${reason}</div>${findings.map(item => `<p class="violation">${escapeHtml(item.detail)}</p>`).join('')}${findings.some(item => item.code === 'name-convention') ? `<code class="expected-pattern">${escapeHtml(state.settings.namePattern)}</code>` : ''}` : '<span class="check-clear">위반 없음</span><p class="result-detail">설정한 이름·태그 규칙 준수</p>'}</td></tr>`;
  }).join('');
}

function historyPreview() {
  return `<section class="panel recent-panel" aria-label="최근 등록 삭제 이력"><div class="panel-header"><div class="section-title"><span class="section-number">02</span><h2>등록 · 삭제 이력</h2></div><a href="#history" class="section-link">전체 보기 ↗</a></div><div id="recent-events">${recentEvents()}</div></section>`;
}

function recentEvents() {
  return state.events.length ? `<ol class="audit-stream">${state.events.slice(0, 4).map(e => `<li><div class="audit-time"><time datetime="${escapeHtml(e.time)}" title="${escapeHtml(date(e.time))}">${escapeHtml(ago(e.time))}</time><span class="event-badge ${e.kind}">${eventKinds[e.kind]}${e.failed ? ' 요청 실패' : ''}</span></div><strong>${escapeHtml(e.target)}</strong>${e.kind === 'tagged' ? `<small class="mono">${escapeHtml(e.oldTags.join(', ') || '(없음)')} → ${escapeHtml(e.newTags.join(', ') || '(없음)')}</small>` : ''}<div class="audit-meta"><span>계정 <b>${escapeHtml(e.actor || '미확인')}</b></span><span>경로 <b>${escapeHtml(origins[e.origin] || e.origin || '미확인')}</b></span></div></li>`).join('')}</ol>` : '<p class="empty">확인된 등록·삭제 이력이 없습니다.</p>';
}

function historyView() {
  return `<section class="panel" aria-label="등록 삭제 이력"><div class="toolbar"><div class="filters" aria-label="이력 필터">
    ${[['all', '전체'], ['registered', '등록'], ['deleted', '삭제'], ['tagged', '태그 변경']].map(([value, label]) => `<button type="button" class="filter ${historyFilter === value ? 'active' : ''}" data-history-filter="${value}" aria-pressed="${historyFilter === value}">${label}</button>`).join('')}
    </div><label class="search"><span class="sr-only">이력 검색</span><input type="search" id="history-search" placeholder="장비명, 작업 계정 검색" value="${escapeHtml(historySearch)}"></label></div>
    <div class="table-wrap"><table class="history-table"><caption class="sr-only">장비 등록 삭제 감사 로그</caption><thead><tr><th scope="col">시각</th><th scope="col">작업</th><th scope="col">대상 장비</th><th scope="col">작업 계정</th><th scope="col">작업 경로</th></tr></thead><tbody id="history-rows">${historyRows()}</tbody></table></div>
    <div class="table-note">최근 200건을 표시합니다. 시각·계정·작업 경로는 Tailscale 감사 로그 기준이며, 삭제된 장비의 IP는 수집 이력이 있을 때 표시됩니다.</div></section>`;
}

function historyRows() {
  const query = historySearch.trim().toLowerCase();
  const events = state.events.filter(e => historyFilter === 'all' || e.kind === historyFilter)
    .filter(e => [e.target, e.actor, e.origin, ...e.addresses || []].join(' ').toLowerCase().includes(query));
  if (!events.length) return '<tr><td colspan="5" class="empty">표시할 등록·삭제 기록이 없습니다.</td></tr>';
  return events.map(e => `<tr><td class="mono"><time datetime="${escapeHtml(e.time)}" title="${escapeHtml(e.time)}">${escapeHtml(date(e.time))}</time><small>${escapeHtml(ago(e.time))}</small></td>
    <td><span class="event-badge ${e.kind}">${eventKinds[e.kind]}</span>${e.failed ? '<small class="red">실패한 요청</small>' : ''}${e.ephemeral ? '<small>임시 노드</small>' : ''}</td>
    <td class="device-cell"><strong>${escapeHtml(e.target)}</strong>${e.kind === 'tagged' ? `<small class="mono">${escapeHtml(e.oldTags.join(', ') || '(없음)')} → ${escapeHtml(e.newTags.join(', ') || '(없음)')}</small>` : ''}${e.addresses?.length ? `<small class="mono">${e.addresses.map(escapeHtml).join(' · ')}</small>` : ''}</td>
    <td>${escapeHtml(e.actor)}${e.raw && !e.raw.actor?.loginName ? `<small>${escapeHtml(e.raw?.actor?.type || '행위자 정보 없음')}</small>` : ''}</td>
    <td>${escapeHtml(origins[e.origin] || e.origin || '기록 없음')}${e.raw?.error ? `<small class="red">${escapeHtml(e.raw.error)}</small>` : ''}</td></tr>`).join('');
}

function channelStatus(channel) {
  if (state.demo) return '예시 모드 · 실제 전송 안 함';
  const item = state.notifications.channels[channel];
  if (!item.configured) return '인증정보 미설정';
  if (item.error) return `전송 실패 · 대기 ${item.pending}건`;
  return `${item.lastSuccess ? `최근 전송 ${date(item.lastSuccess)}` : '인증정보 설정됨 · 전송 이력 없음'}${item.pending ? ` · 대기 ${item.pending}건` : ''}`;
}

function toggle(name, label, description, extra = '') {
  return `<div class="switch-row"><div class="switch-description"><strong>${label}</strong><p>${description}</p>${extra}</div><span class="switch-state">${state.settings[name] ? 'ON' : 'OFF'}</span><label class="switch"><input type="checkbox" data-notification="${name}" ${state.settings[name] ? 'checked' : ''} aria-label="${label}"><span class="switch-track" aria-hidden="true"></span></label></div>`;
}

function notificationControls() {
  return `<div id="notification-controls"><div class="notification-heading"><h3>알림 채널</h3></div>
    ${toggle('notificationsEnabled', '전체 알림', '이름·태그 컨벤션 위반만 알림')}
    ${toggle('telegramEnabled', 'Telegram', '01 · 개인 테스트', `<div class="channel-status">${escapeHtml(channelStatus('telegram'))}</div>`)}
    ${toggle('slackEnabled', 'Slack', '02 · 팀 공용 운영', `<div class="channel-status">${escapeHtml(channelStatus('slack'))}</div>`)}</div>`;
}

function credentialLabel(key) {
  return integrationGroups.flatMap(group => group.fields).find(field => field[0] === key)[1];
}

function integrationStatus(group) {
  const ready = group.fields.every(([key]) => state.integrations?.[key]);
  if (!ready) return '미설정';
  if (state.demo) return '예시 저장 · 실제 연결 안 함';
  if (group.id === 'tailscale') {
    if (Object.values(state.collectors).some(item => item.error)) return '저장됨 · 연결 오류 확인';
    return state.busy ? '저장됨 · 연결 확인 중' : state.collectors.devices.lastSuccess ? '수집 중' : '저장됨 · 수집 대기';
  }
  return state.notifications.channels[group.id].error ? '저장됨 · 전송 오류 확인' : '저장됨';
}

function renderIntegrationStatus() {
  for (const group of integrationGroups) {
    const status = $(`#integration-status-${group.id}`);
    if (status) status.textContent = integrationStatus(group);
  }
  document.querySelectorAll('.channel-status').forEach(element => {
    const name = element.closest('.switch-row').querySelector('[data-notification]').dataset.notification.replace('Enabled', '');
    element.textContent = channelStatus(name);
  });
}

function integrationsView() {
  return `<section class="panel integration-panel" aria-label="연동 설정"><div class="panel-header"><h2>연동 설정</h2></div><div class="panel-body">
    <p class="help setup-intro">한 번 저장한 값은 재접속해도 유지됩니다. 기본은 마스킹이며 보기 버튼으로 확인할 수 있습니다.</p>
    ${state.demo ? '<p class="help red">현재 예시 모드입니다. 입력값은 임시 보관되며 실제 연결은 실행하지 않습니다.</p>' : ''}
    ${integrationGroups.map(group => `<form class="integration-form" data-integration="${group.id}" autocomplete="off"><div class="integration-heading"><div><h3>${group.label}</h3><p>${group.description}</p></div><span class="integration-status" id="integration-status-${group.id}">${escapeHtml(integrationStatus(group))}</span></div>
      ${group.fields.map(([key, label, placeholder]) => `<div class="credential-field"><label for="credential-${key}">${label}</label><div class="credential-control"><input id="credential-${key}" name="${key}" data-credential="${key}" data-saved="${Boolean(state.integrations?.[key])}" type="password" value="${state.integrations?.[key] ? credentialMask : ''}" placeholder="${escapeHtml(placeholder)}" maxlength="4096" autocomplete="off" spellcheck="false" autocapitalize="none"><button type="button" data-reveal="${key}" aria-label="${label} 마스킹 해제" aria-pressed="false">보기</button></div></div>`).join('')}
      <p class="integration-feedback" role="status"></p><div class="integration-actions"><small>수정한 항목만 저장합니다.</small><button type="submit">${group.label} 저장</button></div></form>`).join('')}
    <details class="setup-details"><summary>연동 정보 발급 방법</summary><p class="help"><strong>Tailscale</strong> · 관리 콘솔 → Settings → Trust credentials에서 OAuth를 발급하고 <code>devices:core:read</code>, <code>logs:configuration:read</code> 두 읽기 권한을 선택하세요. Tailnet은 Settings → General의 이름입니다.</p><p class="help"><strong>Telegram</strong> · BotFather에서 봇을 만들고 개인 대화에서는 먼저 봇에게 /start를 보내세요. 그룹에서는 봇을 추가하세요.</p><p class="help"><strong>Slack</strong> · 연결할 채널의 Incoming Webhook 주소를 입력하세요.</p></details>
    <p class="help">저장값은 서버 데이터 폴더에 암호화해 보관합니다. 알림 발송 여부는 위의 채널 스위치로 설정합니다.</p>
  </div></section>`;
}

function settingsView(compact = false) {
  const settings = state.settings;
  return `<div class="settings-layout${compact ? ' compact-settings' : ''}">${compact ? '' : '<div class="settings-column">'}<section class="panel rules-panel"><div class="panel-header"><div class="section-title">${compact ? '<span class="section-number">03</span>' : ''}<h2>${compact ? '규칙 · 알림 설정' : '컨벤션 규칙'}</h2></div></div><div class="panel-body"><form id="rules-form">
    <label class="field"><span class="field-title">이름 정규식</span><input name="namePattern" class="mono" aria-label="이름 정규식" value="${escapeHtml(settings.namePattern)}" maxlength="256" required>${!compact ? '<small>Tailscale 장비명을 검사합니다. 예: jetson-hadong-cough01, chonnam-uni-001, kisook-laptop</small>' : ''}</label>
    <label class="field"><span class="field-title">접두어 → 필수 태그 <small>지정한 태그만 허용</small></span><textarea name="tagRules" rows="3" class="mono" aria-label="장비명별 태그 규칙" placeholder="jetson-hadong- = tag:pig">${escapeHtml(settings.tagRules.map(rule => `${rule.prefix} = ${rule.tags.join(', ')}`).join('\n'))}</textarea>${!compact ? '<small>예: jetson-hadong- = tag:pig · 추가 태그도 위반으로 검사합니다.</small>' : ''}</label>
    <label class="checkbox-label"><input type="checkbox" name="requireTags" ${settings.requireTags ? 'checked' : ''}> 태그가 없는 장비도 위반으로 알림</label>
    ${settings.excludedDevices?.length ? `<p class="help">예외 장비 ${settings.excludedDevices.length}대 · ${escapeHtml(settings.excludedDevices.map(id => state.devices.find(d => d.id === id)?.displayName || id).join(', '))} <small>(장비 화면에서 해제)</small></p>` : ''}
    ${compact ? notificationControls() : ''}
    <p id="rules-error" class="form-error" role="alert"></p><div class="form-actions"><small id="dirty-note"></small><button type="submit" class="primary">규칙 저장</button></div></form>${compact ? '<a class="setup-link" href="#settings">연동 방법 · 자세한 설정 ↗</a>' : ''}</div></section>
    ${!compact ? `<section class="panel notification-panel"><div class="panel-header"><h2>개인 테스트 → 팀 운영</h2></div><div class="panel-body">${notificationControls()}<p class="help">채널을 켜거나 연동 정보를 저장하면 현재 열린 위반을 한 번 묶어서 보냅니다. 전송 실패로 보관된 알림은 ON으로 전환하면 재시도합니다.</p></div></section></div>
    ${integrationsView()}` : ''}</div>`;
}

function renderPage() {
  page = Object.hasOwn(pages, location.hash.slice(1)) ? location.hash.slice(1) : 'devices';
  const [title, description] = pages[page];
  $('#page-title').textContent = title;
  $('#page-description').textContent = description;
  $('.page-heading').classList.toggle('sr-only', page === 'devices');
  document.querySelectorAll('[data-page]').forEach(link => {
    if (link.dataset.page === page) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  if (!state) return;
  $('#content').innerHTML = page === 'devices' ? devicesView() : page === 'history' ? historyView() : settingsView();
}

async function refresh(passive = false) {
  if (loading) return;
  loading = true;
  try {
    const response = await fetch('/api/state');
    if (!response.ok) throw new Error(`서버 응답 오류 (HTTP ${response.status})`);
    const previous = state;
    const next = await response.clone().json();
    if (loadedVersion && next.update && next.update.current !== loadedVersion) { location.reload(); return; }
    loadedVersion ??= next.update?.current;
    state = await response.json();
    renderChrome();
    const changed = JSON.stringify([state.devices, state.findings, state.events]) !== JSON.stringify([previous?.devices, previous?.findings, previous?.events]);
    if (!passive || !previous) renderPage();
    else if (changed && page === 'devices') {
      renderDeviceList();
      $('#recent-events').innerHTML = recentEvents();
    } else if (page === 'history' && changed && !$('#content').contains(document.activeElement)) renderPage();
  } catch (error) {
    $('#connection').textContent = '서버 연결 끊김';
    $('#connection').className = 'status-dot error';
    $('#banners').innerHTML = `<div class="banner error"><p>${escapeHtml(error.message)} · 서버가 실행 중인지 확인하세요.</p></div>`;
  } finally { loading = false; }
}

document.addEventListener('click', async event => {
  const reveal = event.target.closest('[data-reveal]');
  if (reveal) {
    const input = $(`#credential-${reveal.dataset.reveal}`);
    if (!input) return;
    if (input.type === 'text') {
      input.type = 'password';
      reveal.textContent = '보기';
      reveal.setAttribute('aria-label', `${credentialLabel(input.name)} 마스킹 해제`);
      reveal.setAttribute('aria-pressed', 'false');
      if (!input.dataset.edited) { input.value = input.dataset.saved === 'true' ? credentialMask : ''; delete input.dataset.loaded; }
    } else {
      reveal.disabled = true;
      try {
        if (!input.dataset.edited && !input.dataset.loaded && input.dataset.saved === 'true') {
          const result = await post('/api/integrations/reveal', { key: input.name });
          if (!input.isConnected) return;
          if (!input.dataset.edited) {
            input.value = result.value;
            input.dataset.loaded = 'true';
          }
        }
        input.type = 'text';
        reveal.textContent = '숨기기';
        reveal.setAttribute('aria-label', `${credentialLabel(input.name)} 숨기기`);
        reveal.setAttribute('aria-pressed', 'true');
      } catch (error) { toast(error.message); }
      finally { reveal.disabled = false; }
    }
    return;
  }
  const orderButton = event.target.closest('[data-group-order]');
  if (orderButton) {
    const visibleKeys = [...document.querySelectorAll('[data-device-group]')].map(element => element.dataset.deviceGroup);
    const tag = orderButton.dataset.groupOrderTag;
    const position = visibleKeys.indexOf(tag);
    const neighbor = visibleKeys[position + (orderButton.dataset.groupOrder === 'up' ? -1 : 1)];
    if (position < 0 || neighbor === undefined) return;
    const next = [...deviceGroupOrder, ...orderedDeviceGroupKeys().filter(tag => !deviceGroupOrder.includes(tag))];
    const from = next.indexOf(tag), to = next.indexOf(neighbor);
    [next[from], next[to]] = [next[to], next[from]];
    try { localStorage.setItem(deviceGroupOrderStorageKey, JSON.stringify(next)); }
    catch { toast('그룹 순서를 저장하지 못했습니다. 브라우저 저장 공간을 확인하세요.'); return; }
    deviceGroupOrder = next;
    renderDeviceList();
    const buttons = [...document.querySelectorAll('[data-group-order]')].filter(button => button.dataset.groupOrderTag === tag);
    (buttons.find(button => button.dataset.groupOrder === orderButton.dataset.groupOrder && !button.disabled) || buttons.find(button => !button.disabled))?.focus();
    toast('그룹 순서를 저장했습니다.');
    return;
  }
  const groupButton = event.target.closest('[data-device-group-id]');
  if (groupButton) {
    const next = new Set(unregisteredDevices);
    const restore = groupButton.dataset.deviceGroupAction === 'restore';
    if (restore) next.delete(groupButton.dataset.deviceGroupId); else next.add(groupButton.dataset.deviceGroupId);
    try { localStorage.setItem(deviceGroupingStorageKey, JSON.stringify([...next])); }
    catch { toast('브라우저 분류를 저장하지 못했습니다. 브라우저 저장 공간을 확인하세요.'); return; }
    unregisteredDevices = next;
    renderDeviceList();
    toast(restore ? '태그 기준 표시로 복원했습니다.' : '미등록 장비로 옮겼습니다. 실제 태그는 유지됩니다.');
    return;
  }
  const updateButton = event.target.closest('[data-update]');
  if (updateButton) {
    if (!confirm(`모니터링을 ${state.update.latest}(으)로 업데이트하고 다시 시작합니다. 진행할까요?`)) return;
    updateButton.disabled = true;
    try { await post('/api/update', {}); await refresh(true); toast('업데이트를 시작했습니다.'); }
    catch (error) { toast(error.message); updateButton.disabled = false; }
    return;
  }
  const groupToggle = event.target.closest('[data-group-toggle]');
  if (groupToggle) {
    const tag = groupToggle.dataset.groupToggle;
    const next = new Set(collapsedGroups);
    if (next.has(tag)) next.delete(tag); else next.add(tag);
    collapsedGroups = next;
    groupToggle.closest('.device-panel').classList.toggle('collapsed', next.has(tag));
    groupToggle.setAttribute('aria-expanded', String(!next.has(tag)));
    try { localStorage.setItem(collapsedGroupsStorageKey, JSON.stringify([...next])); }
    catch { toast('접기 상태를 이 브라우저에 저장하지 못했습니다.'); }
    return;
  }
  const copyButton = event.target.closest('[data-copy]');
  if (copyButton) {
    const text = copyButton.dataset.copy;
    // navigator.clipboard is missing on plain-http tailnet URLs, so fall back to a selected textarea + execCommand.
    const legacyCopy = () => {
      const area = Object.assign(document.createElement('textarea'), { value: text, readOnly: true });
      area.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.append(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      copyButton.focus();
      if (!ok) throw new Error('copy failed');
    };
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text); else legacyCopy();
      toast(`${text} 복사했습니다.`);
    } catch {
      try { legacyCopy(); toast(`${text} 복사했습니다.`); } catch { toast('복사하지 못했습니다. 직접 선택해 복사하세요.'); }
    }
    return;
  }
  const excludeButton = event.target.closest('[data-exclude-id]');
  if (excludeButton) {
    const id = excludeButton.dataset.excludeId;
    const current = state.settings.excludedDevices || [];
    const excluded = current.includes(id);
    excludeButton.disabled = true;
    try {
      await post('/api/settings', { ...state.settings, excludedDevices: excluded ? current.filter(item => item !== id) : [...current, id] });
      await refresh();
      toast(excluded ? '예외를 해제했습니다. 다시 검사합니다.' : '예외 장비로 지정했습니다. 검사와 알림에서 제외됩니다.');
    } catch (error) { toast(error.message); excludeButton.disabled = false; }
    return;
  }
  const deviceButton = event.target.closest('[data-device-filter]');
  if (deviceButton) { deviceFilter = deviceButton.dataset.deviceFilter; renderDeviceList(); }
  const historyButton = event.target.closest('[data-history-filter]');
  if (historyButton) { historyFilter = historyButton.dataset.historyFilter; renderPage(); }
});

document.addEventListener('input', event => {
  if (event.target.dataset.credential) {
    event.target.dataset.edited = 'true';
    event.target.closest('form').querySelector('.integration-feedback').textContent = '저장하지 않은 변경이 있습니다.';
  }
  if (event.target.id === 'device-search') { deviceSearch = event.target.value; renderDeviceList(); }
  if (event.target.id === 'history-search') { historySearch = event.target.value; $('#history-rows').innerHTML = historyRows(); }
  if (event.target.closest('#rules-form') && !event.target.dataset.notification) { formDirty = true; $('#dirty-note').textContent = '저장하지 않은 변경이 있습니다.'; }
});

document.addEventListener('focusin', event => {
  const input = event.target;
  if (input.dataset.credential && !input.dataset.edited && !input.dataset.loaded && input.dataset.saved === 'true') input.value = '';
});
document.addEventListener('focusout', event => {
  const input = event.target;
  if (input.dataset.credential && !input.dataset.edited && !input.dataset.loaded && input.dataset.saved === 'true') input.value = credentialMask;
});

document.addEventListener('change', async event => {
  if (event.target.id === 'theme') {
    applyTheme(event.target.value);
    try { localStorage.setItem(themeStorageKey, event.target.value); } catch {}
    return;
  }
  if (event.target.id === 'device-tag-filter') {
    deviceTagFilter = event.target.value;
    renderDeviceList();
    return;
  }
  const name = event.target.dataset.notification;
  if (!name) return;
  const checkbox = event.target;
  checkbox.disabled = true;
  try {
    await post('/api/settings', { ...state.settings, [name]: checkbox.checked });
    await refresh(true);
    checkbox.closest('.switch-row').querySelector('.switch-state').textContent = checkbox.checked ? 'ON' : 'OFF';
    toast('알림 설정을 저장했습니다.');
  } catch (error) { checkbox.checked = !checkbox.checked; toast(error.message); }
  finally { checkbox.disabled = false; }
});

document.addEventListener('submit', async event => {
  if (event.target.dataset.integration) {
    event.preventDefault();
    const form = event.target;
    const button = form.querySelector('button[type=submit]');
    const feedback = form.querySelector('.integration-feedback');
    const inputs = [...form.querySelectorAll('[data-credential]')];
    const edited = inputs.filter(input => input.dataset.edited);
    if (!edited.length) { feedback.textContent = '저장된 값이 유지되고 있습니다.'; return; }
    button.disabled = true;
    inputs.forEach(input => { input.disabled = true; });
    feedback.textContent = '저장하고 연결을 적용하는 중입니다…';
    try {
      const saved = await post('/api/integrations', Object.fromEntries(edited.map(input => [input.name, input.value])));
      state.integrations = saved.integrations;
      await refresh(true);
      if (!form.isConnected) return;
      for (const input of inputs) {
        input.type = 'password';
        input.dataset.saved = String(Boolean(state.integrations[input.name]));
        input.value = state.integrations[input.name] ? credentialMask : '';
        delete input.dataset.edited;
        delete input.dataset.loaded;
        const reveal = form.querySelector(`[data-reveal="${input.name}"]`);
        reveal.textContent = '보기';
        reveal.setAttribute('aria-label', `${credentialLabel(input.name)} 마스킹 해제`);
        reveal.setAttribute('aria-pressed', 'false');
      }
      feedback.textContent = state.demo ? '예시 모드에 저장했습니다. 실제 요청은 보내지 않습니다.' : '저장하고 적용했습니다. 값은 마스킹 상태로 유지됩니다.';
    } catch (error) { feedback.textContent = error.message; }
    finally { button.disabled = false; inputs.forEach(input => { input.disabled = false; }); }
    return;
  }
  if (event.target.id !== 'rules-form') return;
  event.preventDefault();
  const form = event.target;
  const button = form.querySelector('button[type=submit]');
  button.disabled = true;
  try {
    const values = new FormData(form);
    const tagRules = String(values.get('tagRules')).split('\n').map(line => line.trim()).filter(Boolean).map(line => {
      const parts = line.split('=');
      if (parts.length !== 2) throw new Error('장비명별 규칙을 접두어 = tag:이름 형식으로 입력하세요.');
      return { prefix: parts[0].trim(), tags: split(parts[1]) };
    });
    await post('/api/settings', { ...state.settings, namePattern: values.get('namePattern'),
      tagRules, requireTags: form.elements.requireTags.checked });
    formDirty = false;
    await refresh();
    toast('규칙을 저장하고 현재 장비를 다시 검사했습니다.');
  } catch (error) { $('#rules-error').textContent = error.message; }
  finally { button.disabled = false; }
});

$('#poll-button').addEventListener('click', async () => {
  try { await post('/api/poll', {}); await refresh(); setTimeout(() => refresh(true), 1200); }
  catch (error) { toast(error.message); }
});
window.addEventListener('hashchange', () => { formDirty = false; renderPage(); });
window.addEventListener('storage', event => {
  if ([deviceGroupingStorageKey, deviceGroupOrderStorageKey, collapsedGroupsStorageKey, null].includes(event.key)) {
    unregisteredDevices = readDeviceGrouping();
    deviceGroupOrder = readDeviceGroupOrder();
    collapsedGroups = readCollapsedGroups();
    if (state && page === 'devices') renderDeviceList();
  }
});

void refresh();
setInterval(() => refresh(true), 10_000);
