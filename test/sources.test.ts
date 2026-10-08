import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.ts';
import { safeEq } from '../src/sources/shared.ts';
import { ascToMessages, verifyAsc, versionEvents } from '../src/sources/asc.ts';
import { easToMessages, isEasPayload, verifyEas } from '../src/sources/eas.ts';
import { ingestToMessage, verifyIngest } from '../src/sources/ingest.ts';
import { playDiff } from '../src/sources/play.ts';

const app: AppConfig = { id: 'myapp', name: 'My App', play: { packageName: 'com.acme.myapp', tracks: ['internal', 'production'] } };
const rel = (state: string) => [{ releaseName: '57 (1.4.2)', releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`, activeArtifacts: [{ versionCode: '57' }] }];
const build = { id: 'b', buildDetailsPageUrl: 'https://e', platform: 'ios', status: 'errored' };

void test('signatures: EAS, Apple test vector, Standard Webhooks test vector', () => {
  const body = Buffer.from('{"id":"x"}');
  assert.ok(verifyEas(body, 'sha1=' + createHmac('sha1', 'sixteen-chars-secret').update(body).digest('hex'), 'sixteen-chars-secret'));
  assert.ok(!verifyEas(body, 'sha1=00', 'sixteen-chars-secret'));
  assert.ok(!verifyEas(body, undefined, 'sixteen-chars-secret'));
  // https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications
  const apple = 'hmacsha256=7f062172b01cb00b53ca068614674a3d982a34062a0f5d37687d5e3377e54657';
  assert.ok(verifyAsc(Buffer.from('Hello, World!'), apple, 'This is my secret'));
  assert.ok(!verifyAsc(Buffer.from('Hello, World?'), apple, 'This is my secret'));
  // standard-webhooks python test suite
  const h = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' };
  const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
  assert.ok(verifyIngest(Buffer.from('{"test": 2432232314}'), h, secret, 1614265330));
  assert.ok(!verifyIngest(Buffer.from('{"test": 2432232314}'), h, secret, 1614265330 + 301)); // replay window
});

void test('EAS: failed build and submission map to messages', () => {
  const [b] = easToMessages({
    id: 'b1', buildDetailsPageUrl: 'https://expo.dev/b1', platform: 'android', status: 'errored',
    metadata: { appVersion: '1.4.2', appBuildVersion: '57', buildProfile: 'production', gitCommitHash: 'a1b2c3d4e5', gitCommitMessage: 'fix: login\n\nlong body', username: 'rasmus' },
    error: { message: 'Gradle build failed', errorCode: 'EAS_BUILD_UNKNOWN_GRADLE_ERROR' },
  }, app);
  assert.equal(b.type, 'build.failed');
  assert.equal(b.title, 'Android build failed: My App 1.4.2 (57)');
  assert.deepEqual(b.labels, { app: 'myapp', platform: 'android', profile: 'production' });
  assert.deepEqual(b.fields?.[1], { label: 'Commit', value: 'a1b2c3d fix: login' });
  const [s] = easToMessages({ id: 's1', submissionDetailsPageUrl: 'https://expo.dev/s1', platform: 'ios', status: 'finished' }, app);
  assert.equal(s.type, 'submit.succeeded');
  assert.equal(s.title, 'iOS submission to App Store Connect succeeded: My App');
});

void test('ASC: review states map to abstract events, for every release type', () => {
  const types = (o: string | undefined, n: string) => versionEvents(o, n).map((e) => e.type);
  assert.deepEqual(types('READY_FOR_REVIEW', 'WAITING_FOR_REVIEW'), ['appreview.submitted']);
  assert.deepEqual(types('IN_REVIEW', 'REJECTED'), ['appreview.rejected']);
  assert.deepEqual(types('IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'), ['appreview.approved']); // manual release
  assert.deepEqual(types('IN_REVIEW', 'READY_FOR_DISTRIBUTION'), ['appreview.approved', 'release.live']); // automatic release
  assert.deepEqual(types('PENDING_DEVELOPER_RELEASE', 'READY_FOR_DISTRIBUTION'), ['release.live']);
  assert.deepEqual(types('PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW'), []);

  // Apple's documented example payload
  const event = {
    data: {
      type: 'appStoreVersionAppVersionStateUpdated', id: '7c813492', version: 1,
      attributes: { newValue: 'REJECTED', oldValue: 'IN_REVIEW', timestamp: '2025-04-16T05:00:52.745Z' },
      relationships: { instance: { data: { type: 'appStoreVersions', id: 'ad7e6298' } } },
    },
  };
  const [m] = ascToMessages(event, app, { version: '1.4.2', platform: 'IOS', appleAppId: '123' });
  assert.equal(m.title, 'iOS rejected: My App 1.4.2');
  assert.equal(m.labels.platform, 'ios');
  assert.equal(m.links?.[0].url, 'https://appstoreconnect.apple.com/apps/123/distribution');
});

void test('Play: first poll is a baseline, then state changes notify', () => {
  const first = playDiff(undefined, rel('IN_REVIEW'), app, 'production');
  assert.equal(first.messages.length, 0);
  const second = playDiff(first.next, rel('PUBLISHED'), app, 'production');
  assert.deepEqual(second.messages.map((m) => [m.type, m.title]), [['release.live', 'Android live on Google Play: My App 57 (1.4.2)']]);
  assert.equal(playDiff(second.next, rel('PUBLISHED'), app, 'production').messages.length, 0);
  const internal = playDiff({}, rel('PUBLISHED'), app, 'internal'); // new release on an already-tracked track
  assert.equal(internal.messages[0].type, 'testing.build.available');
});

void test('ingest: strict validation at the trust boundary', () => {
  const ok = ingestToMessage('msg_1', { type: 'update.published', title: 'OTA update published', severity: 'success', links: [{ label: 'View', url: 'https://expo.dev/u' }] });
  assert.equal(typeof ok, 'object');
  assert.match(ingestToMessage('x', { type: 'Update Published', title: 't' }) as string, /type/);
  assert.match(ingestToMessage('x', { type: 'a.b', title: 't', severity: 'fatal' }) as string, /severity/);
  assert.match(ingestToMessage('x', { type: 'a.b', title: 't', links: [{ label: 'x', url: 'javascript:alert(1)' }] }) as string, /links/);
  for (const url of ['https://', 'https://exa mple.com/x']) assert.match(ingestToMessage('x', { type: 'a.b', title: 't', links: [{ label: 'x', url }] }) as string, /links/);
});

void test('signJwt: ES256 with ieee-p1363 verifies as a JWS (raw r||s signature)', async () => {
  const { generateKeyPairSync, webcrypto } = await import('node:crypto');
  const { signJwt } = await import('../src/sources/shared.ts');
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const [h, c, s] = signJwt({ alg: 'ES256', typ: 'JWT' }, { aud: 'appstoreconnect-v1' }, { key: privateKey, dsaEncoding: 'ieee-p1363' }).split('.');
  const pub = await webcrypto.subtle.importKey('jwk', publicKey.export({ format: 'jwk' }), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.ok(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, Buffer.from(s, 'base64url'), Buffer.from(`${h}.${c}`)));
});

void test('ASC: a ping with null attributes maps to no messages', () => {
  assert.deepEqual(ascToMessages({ data: { type: 'webhookPingCreated', id: 'p', attributes: null } }, app), []);
});

void test('ASC: without the Apple app id the link is the generic apps page', () => {
  const [m] = ascToMessages({ data: { type: 'appStoreVersionAppVersionStateUpdated', id: 'e', attributes: { oldValue: 'WAITING_FOR_REVIEW', newValue: 'IN_REVIEW' } } }, app);
  assert.equal(m.links?.[0].url, 'https://appstoreconnect.apple.com/apps'); // no app id: generic link, not /apps/distribution
});

void test('EAS: only a build or submission with a known status and a platform passes the payload check', () => {
  assert.ok(isEasPayload(build));
  for (const bad of [null, [], 42, {}, { id: 'x', status: 'errored' }]) assert.equal(isEasPayload(bad), false);
  for (const bad of [
    { ...build, status: 'constructor' },
    { id: 's', submissionDetailsPageUrl: 'https://e', status: 'finished' }, // no platform
  ]) assert.equal(isEasPayload(bad), false, JSON.stringify(bad));
});

void test('EAS: a build with submissionDetailsPageUrl: null is still a build', () => {
  assert.equal(easToMessages({ ...build, submissionDetailsPageUrl: null } as any, app)[0].type, 'build.failed');
});

void test('safeEq: byte-length mismatch is false, not a throw', () => {
  assert.equal(safeEq('sha1=' + 'a'.repeat(39) + '\u00e9', 'sha1=' + 'a'.repeat(40)), false); // threw RangeError before
});

void test('Play: a repeated transition is posted again', () => {
  let state = playDiff(undefined, rel('IN_REVIEW'), app, 'production').next;
  const types: string[] = [];
  for (const s of ['NOT_APPROVED', 'IN_REVIEW', 'NOT_APPROVED']) {
    const d = playDiff(state, rel(s), app, 'production');
    types.push(...d.messages.map((m) => m.type));
    state = d.next;
  }
  assert.deepEqual(types, ['appreview.rejected', 'appreview.in_review', 'appreview.rejected']); // the second rejection is posted too
});
