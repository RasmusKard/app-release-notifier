import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';
import { interpolate, loadConfig, parseConfig, type TargetInstance } from '../src/config.ts';
import type { Message } from '../src/message.ts';
import { createRouter, plan } from '../src/router.ts';

const msg = (over: Partial<Message> = {}): Message => ({
  id: 'm1', type: 'build.failed', source: 'EAS', severity: 'error', time: '2026-10-08T12:00:00Z', title: 'T', labels: { platform: 'ios' }, ...over,
});

const baseConfig = {
  apps: { myapp: { name: 'My App', eas: { secret: 'x' } } },
  targets: [
    { id: 'a', type: 'slack', url: 'https://hooks.slack.com/services/a' },
    { id: 'b', type: 'discord', url: 'https://discord.com/api/webhooks/1/b' },
  ],
  routes: [
    { types: ['build.*'], targets: ['a'], mention: true },
    { types: ['*'], minSeverity: 'warning', labels: { platform: 'ios' }, targets: ['a', 'b'], silent: true },
  ],
};

void test('config: config.example.yaml parses', () => {
  const raw = parse(readFileSync('config.example.yaml', 'utf8'));
  delete raw.ascApi; // their key files aren't in the repo
  delete raw.playApi;
  const env = {
    EAS_WEBHOOK_SECRET: 'sixteen-chars-secret',
    ASC_WEBHOOK_SECRET: 'asc-secret',
    INGEST_SECRET: 'whsec_' + Buffer.alloc(32, 7).toString('base64'),
    SLACK_RELEASES_WEBHOOK: 'https://hooks.slack.com/services/x',
    DISCORD_WEBHOOK: 'https://discord.com/api/webhooks/1/x',
    TEAMS_WORKFLOW_URL: 'https://x.environment.api.powerplatform.com/y',
  };
  assert.equal(parseConfig(interpolate(raw, env)).routes.length, 4);
});

void test('config: STOREHERALD_CONFIG is used instead of the file', () => {
  const yaml = 'apps: {}\ntargets: [{ id: a, type: slack, url: "${SLACK}" }]\nroutes: [{ types: ["*"], targets: [a] }]\n';
  const cfg = loadConfig('missing.yaml', { STOREHERALD_CONFIG: yaml, SLACK: 'https://hooks.slack.com/services/x' });
  assert.deepEqual([...cfg.targets.keys()], ['a']);
});

void test('config: errors never echo secrets', () => {
  const key = 'eyJ0eXBlIjoic2VydmljZV9hY2NvdW50IiwicHJpdmF0ZV9rZXkiOiJTRUNSRVQifQ';
  assert.throws(() => parseConfig({ ...baseConfig, playApi: { serviceAccount: key } }), (e: Error) => !e.message.includes(key));
  const url = 'hooks.slack.com/services/T/B/SECRET';
  assert.throws(() => parseConfig({ ...baseConfig, targets: [{ id: 'a', type: 'slack', url }] }), (e: Error) => !e.message.includes('SECRET'));
});

void test('plan: all matching routes fire; mention if any, silent only if all', () => {
  const { routes } = parseConfig(baseConfig);
  assert.deepEqual([...plan(msg(), routes)], [['a', { mention: true, silent: false }], ['b', { mention: false, silent: true }]]);
  assert.deepEqual([...plan(msg({ severity: 'success', type: 'build.succeeded' }), routes)], [['a', { mention: true, silent: false }]]);
});

void test('router: asks for a resend when no target got the message', async () => {
  let status: number | undefined = 503;
  const target: TargetInstance = {
    render: () => ({}),
    send: async () => {
      if (status) throw Object.assign(new Error('x'), { status });
    },
  };
  const { routes } = parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['a'] }] });
  const router = createRouter({ routes, targets: new Map([['a', target]]) });
  assert.equal(await router.deliver([msg()]), 'retry');
  status = undefined;
  assert.equal(await router.deliver([msg()]), 'ok');
});
