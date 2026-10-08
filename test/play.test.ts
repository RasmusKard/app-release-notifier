// The Google Play poll loop, against a stubbed Play API, a fake router and a fake state store.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.ts';
import { startPlayPoller } from '../src/sources/play.ts';

const app: AppConfig = { id: 'myapp', name: 'My App', play: { packageName: 'com.acme.myapp', tracks: ['internal', 'production'] } };
// A real RSA key: the poller signs its token request with it.
const private_key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const cfg = { playApi: { serviceAccount: { client_email: 'poller@acme.iam', private_key }, intervalMinutes: 1 }, apps: new Map([[app.id, app]]) };
// Stored: 56 is live on internal, 57 is on production in the given state.
const stored = (production: string) => JSON.stringify({
  'com.acme.myapp/internal': { '56|56': 'RELEASE_LIFECYCLE_STATE_PUBLISHED' },
  'com.acme.myapp/production': { '57|57': `RELEASE_LIFECYCLE_STATE_${production}` },
});
// Play now: the internal track fails to load, 57 is published on production.
const play = async (url: string) => {
  if (url.includes('/tracks/internal/')) throw new TypeError('fetch failed');
  return Response.json(url.includes('oauth2') ? { access_token: 't', expires_in: 3600 }
    : { releases: [{ releaseName: '57', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: '57' }] }] });
};

void test('poller: state advances only for tracks that were fetched and delivered; the rest keep their old state', async (t) => {
  t.mock.method(globalThis, 'fetch', play);
  const sent: string[] = [];
  const stop = new AbortController();
  // One poller per delivery outcome. Each saves once at the end of its pass.
  const saved = await Promise.all((['ok', 'retry'] as const).map((outcome) => new Promise<string>((resolve) =>
    startPlayPoller(cfg, { deliver: async (msgs) => (sent.push(...msgs.map((m) => m.type)), outcome) },
      { get: async () => stored('IN_REVIEW'), set: async (_, v) => resolve(v) }, stop.signal))));
  stop.abort();
  assert.deepEqual(sent, ['release.live', 'release.live']);
  assert.deepEqual(saved, [stored('PUBLISHED'), stored('IN_REVIEW')]); // on retry nothing advances, so the next poll sends it again
});

void test('poller: when the state fails to load, the poll is skipped and nothing is saved', async (t) => {
  t.mock.method(globalThis, 'fetch', play);
  const log = t.mock.method(console, 'log', () => {});
  const set = t.mock.fn(async () => {});
  const stop = new AbortController();
  startPlayPoller(cfg, { deliver: async () => 'ok' }, { get: async () => { throw new Error('store down'); }, set }, stop.signal);
  await new Promise((r) => setTimeout(r, 50)); // room for a pass that wrongly went on to fetch (stubbed) and save
  stop.abort();
  assert.match(String(log.mock.calls[0].arguments[0]), /could not load Play state/);
  assert.equal(set.mock.callCount(), 0); // a save here would overwrite the good stored state with a fresh baseline
});
