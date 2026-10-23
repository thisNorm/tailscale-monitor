const now = '2026-10-16T08:40:00.000Z';
const board = (nodeId, hostname, tags, address) => ({ nodeId, id: nodeId, hostname,
  name: `${hostname}.example.ts.net`, tags, addresses: [address], os: 'linux',
  clientVersion: '예시', authorized: true, connectedToControl: true, created: now, user: 'demo@example.com' });

export const demoSource = {
  configured: true,
  async devices() { return [
    board('demo-manager', 'server-office-manager01', ['tag:team-hardware'], '100.100.0.10'),
    board('demo-board1', 'jetson-farm-cough01', ['tag:pig'], '100.100.0.21'),
    board('demo-board2', 'jetson-farm-cough02', ['tag:pig', 'tag:team-hardware'], '100.100.0.22'),
    board('demo-unknown', 'new-device', [], '100.100.0.99')
  ]; },
  async logs() { return [{ eventTime: now, eventGroupID: 'demo-event', action: 'CREATE', origin: 'NODE',
    actor: { type: 'USER', loginName: '예시 관리자' },
    target: { type: 'NODE', id: 'demo-board2', name: 'jetson-farm-cough02', isEphemeral: false } },
    { eventTime: '2026-10-16T07:40:00.000Z', eventGroupID: 'demo-delete', action: 'DELETE', origin: 'ADMIN_CONSOLE',
      actor: { type: 'USER', loginName: '예시 관리자' }, target: { type: 'NODE', id: 'demo-removed', name: 'jetson-farm-cough09' } },
    { eventTime: '2026-10-16T08:10:00.000Z', action: 'UPDATE', origin: 'ADMIN_CONSOLE', actor: { type: 'USER', loginName: '예시 관리자' },
      target: { type: 'NODE', id: 'demo-board2', name: 'jetson-farm-cough02', property: 'ACL_TAGS' }, new: ['tag:pig', 'tag:team-hardware'] },
    { eventTime: '2026-10-16T08:20:00.000Z', action: 'UPDATE', origin: 'ADMIN_CONSOLE', actor: { type: 'USER', loginName: '예시 관리자' },
      target: { type: 'NODE', id: 'demo-board1', name: 'jetson-farm-cough01', property: 'MACHINE_NAME' }, old: 'jetson-test', new: 'jetson-farm-cough01' },
    { eventTime: '2026-10-16T08:30:00.000Z', action: 'UPDATE', origin: 'ADMIN_CONSOLE', actor: { type: 'USER', loginName: '예시 관리자' },
      target: { type: 'TAILNET', name: 'example.com', property: 'ACL' }, old: '{\n"grants": []\n}', new: '{\n"grants": [\n{"src": ["tag:office"], "dst": ["*"], "ip": ["*"]}\n]\n}' }]; }
};

export async function seedDemo(monitor) {
  await monitor.poll();
  if (monitor.meta('demoSeeded')) return;
  monitor.saveSettings({ ...monitor.state().settings, tagRules: [{ prefix: 'jetson-farm-', tags: ['tag:pig'] }] });
  monitor.setMeta('demoSeeded', true);
}
