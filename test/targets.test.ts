import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import type { Message } from '../src/message.ts';
import { discord } from '../src/targets/discord.ts';
import { postJson } from '../src/targets/shared.ts';
import { slack } from '../src/targets/slack.ts';
import { teams } from '../src/targets/teams.ts';

// Worst case: every slot oversized and full of markup, mention syntax and astral chars.
const nasty = '<!channel> @everyone *b* [x](https://evil.example) & 🚀 '.repeat(200);
const worst: Message = {
  id: '1',
  type: 'build.failed',
  source: 'EAS',
  severity: 'error',
  time: '2026-10-08T12:34:56.789Z',
  title: nasty,
  body: nasty,
  actor: nasty,
  fields: Array.from({ length: 30 }, (_, i) => ({ label: `Field ${i}`, value: nasty })),
  links: Array.from({ length: 10 }, (_, i) => ({ label: `Link ${i}`, url: `https://expo.dev/${i}` })),
  labels: {},
};
const plain = { mention: false, silent: false };
const json = (p: unknown) => JSON.stringify(p);

void test('slack: renders within block limits, no injected mentions', () => {
  const p = slack.render(worst, slack.parseConfig({ url: 'https://hooks.slack.com/services/x' }), plain) as any;
  assert.ok(p.text.includes('<https://expo.dev/0|'));
  assert.ok(p.attachments[0].blocks[0].text.text.length <= 3000);
  assert.ok(!json(p).includes('<!channel>'));
});

void test('discord: renders within the 6000-char embed total, no pings', () => {
  const cfg = discord.parseConfig({ url: 'https://discord.com/api/webhooks/1/abc' });
  assert.equal(cfg.url, 'https://discord.com/api/v10/webhooks/1/abc?wait=true&with_components=true');
  const e = (discord.render(worst, cfg, plain) as any).embeds[0];
  const total = [e.title, e.description, e.author.name, e.footer.text, ...e.fields.flatMap((f: any) => [f.name, f.value])].join('').length;
  assert.ok(total <= 6000, `embed total ${total}`);
  assert.deepEqual((discord.render(worst, cfg, plain) as any).allowed_mentions.parse, []);
});

void test('teams: renders an Adaptive Card under 28 KB with the mention', () => {
  const cfg = teams.parseConfig({ url: 'https://x.environment.api.powerplatform.com/y', mention: { id: 'a@b.c', name: 'Release crew' } });
  const p = teams.render(worst, cfg, { mention: true, silent: false }) as any;
  assert.ok(Buffer.byteLength(json(p)) <= 28_000, `${Buffer.byteLength(json(p))} bytes`);
  assert.equal(p.attachments[0].content.type, 'AdaptiveCard');
  assert.equal(p.attachments[0].content.msteams.entities[0].text, '<at>Release crew</at>');
});

void test('postJson: retries a 5xx', async () => {
  const statuses = [503, 200];
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(statuses[calls++], { 'retry-after': '0' }).end();
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await postJson(`http://127.0.0.1:${(server.address() as any).port}`, {});
    assert.equal(calls, 2);
  } finally {
    server.close();
  }
});
