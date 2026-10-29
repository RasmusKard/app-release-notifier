import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadStateStore } from '../src/state.ts';

void test('state store: memory by default, custom module (README example), bad module rejected', async () => {
  const mem = await loadStateStore(undefined);
  assert.equal(await mem.get('play-state'), undefined);
  await mem.set('play-state', '{"a":1}');
  assert.equal(await mem.get('play-state'), '{"a":1}');

  const dir = mkdtempSync(join(tmpdir(), 'ews-state-'));
  // The file-store example from README.md, verbatim, pointed at a temp dir via STATE_DIR.
  const example = readFileSync('README.md', 'utf8').match(/```js\n(\/\/ state-store\.mjs: a file on disk[\s\S]*?)```/)![1];
  process.env.STATE_DIR = dir;
  writeFileSync(join(dir, 'store.mjs'), example);
  const file = await loadStateStore(join(dir, 'store.mjs'));
  assert.equal(await file.get('play-state'), undefined);
  await file.set('play-state', '{"b":2}');
  assert.equal(await file.get('play-state'), '{"b":2}');

  writeFileSync(join(dir, 'default.mjs'), 'const m = new Map(); export default { get: async (k) => m.get(k), set: async (k, v) => { m.set(k, v) } };');
  await (await loadStateStore(join(dir, 'default.mjs'))).set('k', 'v');

  // A synchronous store: its plain return value and its throw must still come back as promises.
  writeFileSync(join(dir, 'sync.mjs'), "export const get = () => 'v'; export const set = () => { throw new Error('boom'); };");
  const sync = await loadStateStore(join(dir, 'sync.mjs'));
  assert.ok(sync.get('k') instanceof Promise);
  assert.equal(await sync.get('k'), 'v');
  await assert.rejects(sync.set('k', 'v'), /boom/);

  writeFileSync(join(dir, 'bad.mjs'), 'export const get = () => {};');
  await assert.rejects(loadStateStore(join(dir, 'bad.mjs')), /must export get\(key\) and set\(key, value\)/);
});
