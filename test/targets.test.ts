import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '../src/message.ts';
import { discord } from '../src/targets/discord.ts';
import { postJson, truncate } from '../src/targets/shared.ts';
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

void test('truncate never splits a surrogate pair', () => {
  assert.equal(truncate('ab🚀', 3), 'ab…');
  assert.equal(truncate('abc', 3), 'abc');
});

void test('slack: within block limits, no injected mentions or links', () => {
  const p = slack.render(worst, slack.parseConfig({ url: 'https://hooks.slack.com/services/x' }), plain) as any;
  const [body, fields, actions, context] = p.attachments[0].blocks;
  assert.ok(body.text.text.length <= 3000);
  assert.ok(fields.fields.length <= 10 && fields.fields.every((f: any) => f.text.length <= 2000));
  assert.ok(actions.elements.length <= 25);
  assert.ok(context.elements[0].text.length <= 3000);
  assert.ok(!json(p).includes('<!channel>') && !json(p).includes('<https://evil'));
});

void test('discord: 6000-char embed total, silent flag, no pings', () => {
  const cfg = discord.parseConfig({ url: 'https://discord.com/api/webhooks/1/abc' });
  assert.equal(cfg.url, 'https://discord.com/api/v10/webhooks/1/abc?wait=true&with_components=true');
  const p = discord.render(worst, cfg, { mention: false, silent: true }) as any;
  const e = p.embeds[0];
  const total = [e.title, e.description, e.author.name, e.footer.text, ...e.fields.flatMap((f: any) => [f.name, f.value])].join('').length;
  assert.ok(total <= 6000, `embed total ${total}`);
  assert.ok(e.title.length <= 256 && e.fields.length <= 25 && e.fields.every((f: any) => f.value.length <= 1024));
  assert.equal(p.flags, 4096);
  assert.deepEqual(p.allowed_mentions.parse, []);
});

void test('teams: under 28 KB, mention wired up, untrusted text never in a markdown TextBlock', () => {
  const cfg = teams.parseConfig({ url: 'https://x.environment.api.powerplatform.com/y', mention: { id: 'a@b.c', name: 'Release crew' } });
  const p = teams.render(worst, cfg, { mention: true, silent: false }) as any;
  assert.ok(Buffer.byteLength(json(p)) <= 28_000, `${Buffer.byteLength(json(p))} bytes`);
  const card = p.attachments[0].content;
  assert.equal(card.msteams.entities[0].text, '<at>Release crew</at>');
  assert.ok(json(card.body).includes('{{DATE(2026-10-08T12:34:56Z,SHORT)}}'));
  assert.ok(card.actions.length <= 6);
  const textBlocks = (n: any): string[] =>
    Array.isArray(n) ? n.flatMap(textBlocks)
    : n && typeof n === 'object' ? [...(n.type === 'TextBlock' ? [n.text] : []), ...Object.values(n).flatMap(textBlocks)]
    : [];
  assert.ok(textBlocks(card).every((t) => !t.includes('evil')));
  assert.throws(() => teams.parseConfig({ url: 'https://acme.webhook.office.com/webhookb2/x' }));
});

void test('links: URLs survive escaping, oversized ones are dropped, Slack link syntax stays intact', () => {
  const m: Message = { ...worst, title: 'T', body: 'log: https://expo.dev/my_team/build_1 *done*', fields: [],
    links: [{ label: 'Build', url: 'https://expo.dev/a|b' }, { label: 'Huge', url: `https://expo.dev/${'x'.repeat(600)}` }] };
  const dp = discord.render(m, discord.parseConfig({ url: 'https://discord.com/api/webhooks/1/abc' }), plain) as any;
  assert.equal(dp.embeds[0].description, 'log: https://expo.dev/my_team/build_1 \\*done\\*');
  assert.equal(dp.components[0].components.length, 1); // the 600-char URL is over Discord's 512 limit
  const sp = slack.render(m, slack.parseConfig({ url: 'https://hooks.slack.com/services/x' }), plain) as any;
  assert.ok(sp.text.includes('<https://expo.dev/a%7Cb|T>'));
});

void test('postJson: retries 5xx honouring Retry-After: 0, fails fast on 404 with status', async () => {
  const { createServer } = await import('node:http');
  const statuses = [503, 200, 404];
  let calls = 0;
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(statuses[calls++], { 'retry-after': '0' }).end('nope');
  });
  await new Promise<void>((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const started = Date.now();
    await postJson(url, {});
    assert.equal(calls, 2);
    assert.ok(Date.now() - started < 500, 'Retry-After: 0 should not wait'); // used to wait 1 s
    await assert.rejects(postJson(url, {}), (e: any) => e.status === 404);
    assert.equal(calls, 3);
  } finally {
    server.close();
  }
});

void test('slack: an invalid webhook URL is rejected without echoing it', () => {
  assert.throws(() => slack.parseConfig({ url: 'hooks.slack.com/services/T/B/SECRET' }), (e: Error) => !e.message.includes('SECRET'));
});

void test('teams: retired webhook hosts are rejected, whatever the case or port', () => {
  assert.throws(() => teams.parseConfig({ url: 'https://prod-27.westus.LOGIC.azure.com:443/workflows/x' }), /retired/);
});

void test('teams: 3-byte UTF-8 text in every slot and 2 KB links stay under 28 KB', () => {
  const cjk = '漢'.repeat(4000);
  const big: Message = { ...worst, title: cjk, body: cjk, source: cjk, actor: cjk,
    fields: Array.from({ length: 20 }, (_, i) => ({ label: `F${i}`, value: cjk })),
    links: Array.from({ length: 10 }, (_, i) => ({ label: `L${i}`, url: `https://x.example/${i}?sig=${'a'.repeat(2000)}` })) };
  const card = teams.render(big, teams.parseConfig({ url: 'https://x.environment.api.powerplatform.com/y' }), plain);
  assert.ok(Buffer.byteLength(json(card)) <= 28_000, `${Buffer.byteLength(json(card))} bytes`);
});

void test('discord: numbered-list markers are escaped, version numbers are not', () => {
  const dp = discord.render({ ...worst, body: '1.4.2 released\n1. Fix crash', fields: [] }, discord.parseConfig({ url: 'https://discord.com/api/webhooks/1/abc' }), plain) as any;
  assert.equal(dp.embeds[0].description, '1.4.2 released\n1\\. Fix crash');
});

void test('postJson: status survives a broken response body', async () => {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    req.resume();
    res.writeHead(404, { 'content-length': '100' });
    res.write('par');
    setTimeout(() => res.destroy(), 20);
  });
  await new Promise<void>((r) => server.listen(0, r));
  try {
    await assert.rejects(postJson(`http://127.0.0.1:${(server.address() as any).port}`, {}), (e: any) => e.status === 404);
  } finally {
    server.close();
  }
});
