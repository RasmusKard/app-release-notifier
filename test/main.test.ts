// End to end: start the real server with a config pointing a Slack target at a local fake, then post signed webhooks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

void test('server: verifies, delivers, replies 503 while the target fails and 200 once it recovers', async (t) => {
  let slackStatus = 500;
  const posts: { text: string }[] = [];
  const slack = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    posts.push(JSON.parse(body) as { text: string });
    res.writeHead(slackStatus, { 'retry-after': '0' }).end(slackStatus === 200 ? 'ok' : 'err');
  });
  await new Promise<void>((r) => slack.listen(0, r));
  t.after(() => slack.close());

  const dir = mkdtempSync(join(tmpdir(), 'ews-'));
  const port = 18000 + Math.floor(Math.random() * 1000);
  const ingestKey = randomBytes(32);
  writeFileSync(join(dir, 'config.yaml'), `
port: ${port}
apps:
  myapp:
    name: My App
    eas: { secret: "\${EAS_SECRET}" }
    asc: { secret: asc-secret }
ingest: { secret: "whsec_${ingestKey.toString('base64')}" }
targets:
  - { id: releases, type: slack, url: "http://127.0.0.1:${(slack.address() as any).port}/hook" }
routes:
  - { types: ["build.*", "update.published"], targets: [releases] }
`);
  const proc = spawn(process.execPath, ['src/main.ts', join(dir, 'config.yaml')], { env: { ...process.env, EAS_SECRET: 'sixteen-chars-secret' } });
  t.after(() => proc.kill());
  await new Promise<void>((resolve, reject) => {
    proc.stdout.on('data', (d) => String(d).includes('listening') && resolve());
    let err = '';
    proc.stderr.on('data', (d) => (err += d));
    proc.on('exit', (code) => reject(new Error(`server exited ${code}: ${err}`)));
  });

  const body = JSON.stringify({ id: 'b1', buildDetailsPageUrl: 'https://expo.dev/b1', platform: 'ios', status: 'finished', metadata: { appVersion: '1.0.0' } });
  const send = (sig = 'sha1=' + createHmac('sha1', 'sixteen-chars-secret').update(body).digest('hex'), path = '/eas/myapp') =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body, headers: { 'expo-signature': sig } }).then((r) => r.status);

  // A malformed request-target used to crash the process.
  const { connect } = await import('node:net');
  await new Promise<void>((done) => {
    const sock = connect(port, '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    sock.on('data', () => {}).on('close', () => done()).on('error', () => done());
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health_check`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 404);

  assert.equal(await send('sha1=bad'), 401);
  assert.equal(await send(undefined, '/eas/other'), 404);
  assert.equal(await send(), 503); // Slack failing: ask Expo to resend
  assert.equal(posts.length, 2); // first try + one in-request retry
  slackStatus = 200;
  assert.equal(await send(), 200);
  assert.equal(posts.length, 3);
  assert.match(posts[2].text, /iOS build succeeded: My App 1\.0\.0/);

  // App Store Connect "Test" button: body undocumented, so assume the bare minimum and expect a quiet 200.
  const ping = JSON.stringify({ data: { type: 'webhookPingCreated', id: 'p1' } });
  const asc = await fetch(`http://127.0.0.1:${port}/asc/myapp`, {
    method: 'POST', body: ping, headers: { 'x-apple-signature': 'hmacsha256=' + createHmac('sha256', 'asc-secret').update(ping).digest('hex') },
  });
  assert.equal(asc.status, 200);
  assert.equal(posts.length, 3);

  // OTA update from CI, signed like README.md's post-event.mjs example (Standard Webhooks).
  const update = JSON.stringify({ type: 'update.published', title: 'OTA update published', labels: { app: 'myapp' } });
  const ts = String(Math.floor(Date.now() / 1000));
  const ingest = (sig = createHmac('sha256', ingestKey).update(`msg_1.${ts}.${update}`).digest('base64')) =>
    fetch(`http://127.0.0.1:${port}/ingest`, { method: 'POST', body: update, headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': ts, 'webhook-signature': `v1,${sig}` } }).then((r) => r.status);
  assert.equal(await ingest('bad'), 401);
  assert.equal(await ingest(), 200);
  assert.equal(posts.length, 4);
  assert.match(posts[3].text, /OTA update published/);
});
