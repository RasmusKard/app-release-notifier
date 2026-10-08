// The Google Play poll loop, against a stubbed Play API, a fake router and a fake state store.
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.ts';
import { startPlayPoller } from '../src/sources/play.ts';

const app: AppConfig = { id: 'myapp', name: 'My App', play: { packageName: 'com.acme.myapp', tracks: ['production'] } };
// A real RSA key: the poller signs its token request with it.
const private_key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
const cfg = { playApi: { serviceAccount: { client_email: 'poller@acme.iam', private_key }, intervalMinutes: 1 }, apps: new Map([[app.id, app]]) };
const stored = (state: string) => JSON.stringify({ 'com.acme.myapp/production': { '57|57': `RELEASE_LIFECYCLE_STATE_${state}` } });
const play = async (url: string) =>
  Response.json(url.includes('oauth2') ? { access_token: 't', expires_in: 3600 }
    : { releases: [{ releaseName: '57', releaseLifecycleState: 'RELEASE_LIFECYCLE_STATE_PUBLISHED', activeArtifacts: [{ versionCode: '57' }] }] });

void test('poller: a state change is delivered and the new state saved', async (t) => {
  t.mock.method(globalThis, 'fetch', play);
  const sent: string[] = [];
  const stop = new AbortController();
  const saved = await new Promise<string>((resolve) =>
    startPlayPoller(cfg, { deliver: async (msgs) => (sent.push(...msgs.map((m) => m.type)), 'ok') },
      { get: async () => stored('IN_REVIEW'), set: async (_, v) => resolve(v) }, stop.signal));
  stop.abort();
  assert.deepEqual(sent, ['release.live']);
  assert.equal(saved, stored('PUBLISHED'));
});

void test('poller: when the state fails to load, nothing is saved', async (t) => {
  t.mock.method(globalThis, 'fetch', play);
  t.mock.method(console, 'log', () => {});
  const set = t.mock.fn(async () => {});
  const stop = new AbortController();
  startPlayPoller(cfg, { deliver: async () => 'ok' }, { get: async () => { throw new Error('store down'); }, set }, stop.signal);
  await new Promise((r) => setTimeout(r, 50));
  stop.abort();
  assert.equal(set.mock.callCount(), 0); // a save here would overwrite the good stored state with a fresh baseline
});

void test('poller: a change no target got is not saved, so the next poll sends it again', async (t) => {
  t.mock.method(globalThis, 'fetch', play);
  t.mock.method(console, 'log', () => {});
  const outcomes = ['retry', 'ok'] as const;
  const sent: string[] = [];
  const saves: string[] = [];
  const stop = new AbortController();
  await new Promise<void>((resolve) =>
    startPlayPoller({ ...cfg, playApi: { ...cfg.playApi, intervalMinutes: 0.001 } }, // 60 ms between polls
      { deliver: async (msgs) => (sent.push(...msgs.map((m) => m.type)), outcomes[saves.length]) },
      { get: async () => stored('IN_REVIEW'), set: async (_, v) => void (saves.push(v) === outcomes.length && resolve()) }, stop.signal));
  stop.abort();
  assert.deepEqual(sent, ['release.live', 'release.live']);
  assert.deepEqual(saves, [stored('IN_REVIEW'), stored('PUBLISHED')]);
});
