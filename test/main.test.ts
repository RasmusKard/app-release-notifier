// End to end: start the real server with a config pointing a Slack target at a local fake, then post signed webhooks.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const freePort = () => new Promise<number>((resolve) => {
  const s = createNetServer().listen(0, () => {
    const { port } = s.address() as { port: number };
    s.close(() => resolve(port));
  });
});

void test('server: health check, signed webhooks are delivered, bad signatures rejected', async (t) => {
  const posts: { text: string }[] = [];
  const slack = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    posts.push(JSON.parse(body) as { text: string });
    res.end('ok');
  });
  await new Promise<void>((r) => slack.listen(0, r));
  t.after(() => slack.close());

  const dir = mkdtempSync(join(tmpdir(), 'ews-'));
  const port = await freePort();
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
  const post = (path: string, body: string, headers: Record<string, string>) =>
    fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body, headers }).then((r) => r.status);

  // A malformed request-target used to crash the process.
  await new Promise<void>((done) => {
    const sock = connect(port, '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'));
    sock.on('data', () => {}).on('close', () => done()).on('error', () => done());
  });
  assert.equal((await fetch(`http://127.0.0.1:${port}/health_check`)).status, 200);

  const eas = JSON.stringify({ id: 'b1', buildDetailsPageUrl: 'https://expo.dev/b1', platform: 'ios', status: 'finished', metadata: { appVersion: '1.0.0' } });
  assert.equal(await post('/eas/myapp', eas, { 'expo-signature': 'sha1=bad' }), 401);
  assert.equal(await post('/eas/myapp', eas, { 'expo-signature': 'sha1=' + createHmac('sha1', 'sixteen-chars-secret').update(eas).digest('hex') }), 200);
  assert.match(posts[0].text, /iOS build succeeded: My App 1\.0\.0/);

  // App Store Connect "Test" button: body undocumented, so assume the bare minimum and expect a quiet 200.
  const ping = JSON.stringify({ data: { type: 'webhookPingCreated', id: 'p1' } });
  assert.equal(await post('/asc/myapp', ping, { 'x-apple-signature': 'hmacsha256=' + createHmac('sha256', 'asc-secret').update(ping).digest('hex') }), 200);
  assert.equal(posts.length, 1);

  // The post-event.mjs example from README.md, verbatim. Async: a sync spawn would block the fake Slack above.
  const example = readFileSync('README.md', 'utf8').match(/```js\n(\/\/ post-event\.mjs:[\s\S]*?)```/)![1];
  writeFileSync(join(dir, 'post-event.mjs'), example);
  const update = JSON.stringify({ type: 'update.published', title: 'OTA update published' });
  await promisify(execFile)(process.execPath, [join(dir, 'post-event.mjs'), update], {
    env: { ...process.env, INGEST_URL: `http://127.0.0.1:${port}/ingest`, INGEST_SECRET: `whsec_${ingestKey.toString('base64')}` },
  });
  assert.match(posts[1].text, /OTA update published/);
});
