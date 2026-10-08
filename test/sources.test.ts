import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AppConfig } from '../src/config.ts';
import { ascToMessages, verifyAsc } from '../src/sources/asc.ts';
import { easToMessages } from '../src/sources/eas.ts';
import { ingestToMessage, verifyIngest } from '../src/sources/ingest.ts';
import { playDiff } from '../src/sources/play.ts';

const app: AppConfig = { id: 'myapp', name: 'My App' };

void test('signatures: Apple and Standard Webhooks test vectors', () => {
  // https://developer.apple.com/documentation/appstoreconnectapi/configuring-webhook-notifications
  const apple = 'hmacsha256=7f062172b01cb00b53ca068614674a3d982a34062a0f5d37687d5e3377e54657';
  assert.ok(verifyAsc(Buffer.from('Hello, World!'), apple, 'This is my secret'));
  // standard-webhooks python test suite
  const h = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=' };
  assert.ok(verifyIngest(Buffer.from('{"test": 2432232314}'), h, 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw', 1614265330));
});

void test('EAS: failed build and successful submission map to messages', () => {
  const [b] = easToMessages({
    id: 'b1', buildDetailsPageUrl: 'https://expo.dev/b1', platform: 'android', status: 'errored',
    metadata: { appVersion: '1.4.2', appBuildVersion: '57' }, error: { message: 'Gradle build failed', errorCode: 'X' },
  }, app);
  assert.deepEqual([b.type, b.title], ['build.failed', 'Android build failed: My App 1.4.2 (57)']);
  const [s] = easToMessages({ id: 's1', submissionDetailsPageUrl: 'https://expo.dev/s1', platform: 'ios', status: 'finished' }, app);
  assert.deepEqual([s.type, s.title], ['submit.succeeded', 'iOS submission to App Store Connect succeeded: My App']);
});

void test("ASC: Apple's example payload maps to a rejection", () => {
  const event = {
    data: {
      type: 'appStoreVersionAppVersionStateUpdated', id: '7c813492', version: 1,
      attributes: { newValue: 'REJECTED', oldValue: 'IN_REVIEW', timestamp: '2025-04-16T05:00:52.745Z' },
      relationships: { instance: { data: { type: 'appStoreVersions', id: 'ad7e6298' } } },
    },
  };
  const [m] = ascToMessages(event, app, { version: '1.4.2', platform: 'IOS', appleAppId: '123' });
  assert.deepEqual([m.type, m.title], ['appreview.rejected', 'iOS rejected: My App 1.4.2']);
});

void test('ASC: version state changes map to review and release events', () => {
  const types = (oldValue: string, newValue: string) =>
    ascToMessages({ data: { type: 'appStoreVersionAppVersionStateUpdated', id: 'v1', attributes: { oldValue, newValue } } }, app).map((m) => m.type);
  assert.deepEqual(types('PREPARE_FOR_SUBMISSION', 'WAITING_FOR_REVIEW'), ['appreview.submitted']);
  assert.deepEqual(types('IN_REVIEW', 'PENDING_DEVELOPER_RELEASE'), ['appreview.approved']);
  assert.deepEqual(types('IN_REVIEW', 'READY_FOR_DISTRIBUTION'), ['appreview.approved', 'release.live']);
  assert.deepEqual(types('PENDING_DEVELOPER_RELEASE', 'READY_FOR_DISTRIBUTION'), ['release.live']);
  assert.deepEqual(types('WAITING_FOR_REVIEW', 'DEVELOPER_REJECTED'), ['appreview.withdrawn']);
  assert.deepEqual(types('PREPARE_FOR_SUBMISSION', 'READY_FOR_REVIEW'), []);
});

void test('Play: first poll is a baseline, then a state change notifies', () => {
  const rel = (state: string) => [{ releaseName: '57 (1.4.2)', releaseLifecycleState: `RELEASE_LIFECYCLE_STATE_${state}`, activeArtifacts: [{ versionCode: '57' }] }];
  const play = { ...app, play: { packageName: 'com.acme.myapp', tracks: ['production'] } };
  const first = playDiff(undefined, rel('IN_REVIEW'), play, 'production');
  assert.equal(first.messages.length, 0);
  const second = playDiff(first.next, rel('PUBLISHED'), play, 'production');
  assert.deepEqual(second.messages.map((m) => [m.type, m.title]), [['release.live', 'Android live on Google Play: My App 57 (1.4.2)']]);
});

void test('ingest: a valid event becomes a message, a javascript: link is rejected', () => {
  const m = ingestToMessage('msg_1', { type: 'update.published', title: 'OTA update published' });
  assert.deepEqual(typeof m === 'object' && [m.type, m.title], ['update.published', 'OTA update published']);
  assert.match(ingestToMessage('x', { type: 'a.b', title: 't', links: [{ label: 'x', url: 'javascript:alert(1)' }] }) as string, /links/);
});
