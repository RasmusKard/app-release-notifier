import assert from 'node:assert/strict';
import { test } from 'node:test';
import { interpolate, parseConfig, type TargetInstance } from '../src/config.ts';
import type { Message } from '../src/message.ts';
import { createRouter, plan } from '../src/router.ts';
import type { Target } from '../src/targets/shared.ts';

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

void test('config: env interpolation, unknown keys and dangling target ids are errors', () => {
  assert.deepEqual(interpolate({ a: ['${X}:${X}'], n: 1 }, { X: 'v#1' }), { a: ['v#1:v#1'], n: 1 });
  assert.throws(() => interpolate('${MISSING}', {}), /MISSING/);
  assert.throws(() => parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['a'], minseverity: 'error' }] }), /minseverity/);
  assert.throws(() => parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['nope'] }] }), /nope/);
  assert.throws(() => parseConfig({ ...baseConfig, routes: [{ types: ['build.*.x'], targets: ['a'] }] }), /only allowed at the end/);
  assert.throws(() => parseConfig({ ...baseConfig, targets: [{ id: 'ops', type: 'slack', url: 'nope' }] }), (e: Error) => /targets\.ops/.test(e.message) && e.message.includes('"url" must be an http(s) URL'));
});

void test('plan: all matching routes fire; mention if any, silent only if all', () => {
  const { routes } = parseConfig(baseConfig);
  assert.deepEqual([...plan(msg(), routes)], [['a', { mention: true, silent: false }], ['b', { mention: false, silent: true }]]);
  assert.deepEqual([...plan(msg({ severity: 'success', type: 'build.succeeded' }), routes)], [['a', { mention: true, silent: false }]]);
  assert.deepEqual([...plan(msg({ labels: { platform: 'android' } }), routes)], [['a', { mention: true, silent: false }]]);
  assert.equal(plan(msg({ type: 'release.live', severity: 'success' }), routes).size, 0);
});

void test('router: resend only when no target got it, never for permanent failures', async () => {
  const calls: string[] = [];
  let bFails: number | undefined = 503;
  const fake = (id: string): TargetInstance => ({
    cfg: {},
    target: {
      keys: [],
      parseConfig: () => ({}),
      render: () => ({}),
      send: async () => {
        calls.push(id);
        if (id === 'b' && bFails !== undefined) throw Object.assign(new Error('x'), { status: bFails });
      },
    } satisfies Target<{}>,
  });
  const { routes } = parseConfig(baseConfig);
  const router = createRouter({ routes, targets: new Map([['a', fake('a')], ['b', fake('b')]]) });

  assert.equal(await router.deliver([msg()]), 'ok'); // b: 503, but a got it: no resend (logged at error level)
  assert.deepEqual(calls, ['a', 'b']);
  calls.length = 0;
  const onlyB = createRouter({ routes: parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['b'] }] }).routes, targets: new Map([['b', fake('b')]]) });
  assert.equal(await onlyB.deliver([msg()]), 'retry'); // nobody got it: ask the sender to resend
  bFails = undefined;
  assert.equal(await onlyB.deliver([msg()]), 'ok');
  assert.deepEqual(calls, ['b', 'b']);

  calls.length = 0;
  bFails = 404;
  assert.equal(await onlyB.deliver([msg({ id: 'm2' })]), 'ok'); // permanent: no resend, just an error log
  assert.deepEqual(calls, ['b']);

});

void test('config: a target with an unknown key or type is an error', () => {
  assert.throws(() => parseConfig({ ...baseConfig, targets: [{ id: 'a', type: 'discord', url: 'https://discord.com/api/webhooks/1/x', threadID: '1' }] }), /unknown key.*threadID/);
  assert.throws(() => parseConfig({ ...baseConfig, targets: [{ id: 'a', type: 'constructor', url: 'https://x' }] }), /type must be one of/);
});

void test('config: port and booleans are coerced from env strings, other strings are errors', () => {
  const routes = [{ types: ['*'], targets: ['a'], mention: 'true', silent: 'false' }];
  const c = parseConfig({ ...baseConfig, port: '3000', routes });
  assert.deepEqual([c.port, c.routes[0].mention, c.routes[0].silent], [3000, true, false]);
  assert.throws(() => parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['a'], mention: 'yes' }] }), /mention must be true or false/);
  assert.throws(() => parseConfig({ ...baseConfig, port: 'abc' }), /port/);
});

void test('config: ingest secret must be 24+ base64 bytes', () => {
  for (const secret of ['whsec_', 'my!secret!', 'whsec_' + Buffer.from('short').toString('base64')])
    assert.throws(() => parseConfig({ ...baseConfig, ingest: { secret } }), /ingest.secret/);
  assert.ok(parseConfig({ ...baseConfig, ingest: { secret: 'whsec_' + Buffer.alloc(32, 7).toString('base64') } }).ingest);
});

void test('config: errors never echo secrets', () => {
  const key = 'eyJ0eXBlIjoic2VydmljZV9hY2NvdW50IiwicHJpdmF0ZV9rZXkiOiJTRUNSRVQifQ';
  assert.throws(() => parseConfig({ ...baseConfig, playApi: { serviceAccount: key } }), (e: Error) => !e.message.includes(key) && /serviceAccount/.test(e.message));
});

void test('plan: minSeverity drops lower severities', () => {
  const { routes: r2 } = parseConfig({ ...baseConfig, routes: [{ types: ['*'], targets: ['a'], minSeverity: 'success' }] });
  assert.equal(plan(msg({ severity: 'info' }), r2).size, 0);
  assert.equal(plan(msg({ severity: 'success' }), r2).size, 1);
});
