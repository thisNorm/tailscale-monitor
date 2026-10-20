import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isNewer, latestVersion, updateConfig } from '../updates.mjs';
import { setTag } from '../updater.mjs';

test('picks the highest semver tag and ignores non-version tags', () => {
  assert.equal(latestVersion(['1.0.0', 'latest', '1.10.0', '1.9.3', 'v2.0.0']), '1.10.0');
  assert.ok(isNewer('1.10.0', '1.9.9'));
  assert.ok(!isNewer('1.0.0', '1.0.0'));
  assert.ok(!isNewer(null, '1.0.0'));
});

test('update config splits registry host and repository', () => {
  const config = updateConfig({ UPDATE_IMAGE: 'registry.example.com/this_norm/tailscale-monitoring/tailscale-monitor' });
  assert.equal(config.base, 'https://registry.example.com');
  assert.equal(config.repository, 'this_norm/tailscale-monitoring/tailscale-monitor');
  assert.equal(updateConfig({}), null);
});

test('setTag replaces or appends MONITOR_TAG and keeps other lines', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tsm-')), '.env');
  writeFileSync(file, 'A=1\nMONITOR_TAG=1.0.0\nB=2\n');
  await setTag(file, '1.1.0');
  assert.equal(readFileSync(file, 'utf8'), 'A=1\nMONITOR_TAG=1.1.0\nB=2\n');
  writeFileSync(file, 'A=1');
  await setTag(file, '1.2.0');
  assert.equal(readFileSync(file, 'utf8'), 'A=1\nMONITOR_TAG=1.2.0\n');
});

test('registry auth falls back to an existing docker login file', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'tsm-')), 'config.json');
  writeFileSync(file, JSON.stringify({ auths: { 'hub.example': { auth: 'dTpw' } } }));
  assert.equal(updateConfig({ UPDATE_IMAGE: 'hub.example/x/tsm', REGISTRY_AUTH_FILE: file }).authorization, 'Basic dTpw');
  assert.equal(updateConfig({ UPDATE_IMAGE: 'other.example/x/tsm', REGISTRY_AUTH_FILE: file }).authorization, '');
});
