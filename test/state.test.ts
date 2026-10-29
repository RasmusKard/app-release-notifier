import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadStateStore } from '../src/state.ts';

void test('state store: memory by default, the README file store, a synchronous store', async () => {
  const mem = await loadStateStore(undefined);
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

  // Its throw must come back as a rejection, not crash the poller.
  writeFileSync(join(dir, 'sync.mjs'), "export const get = () => 'v'; export const set = () => { throw new Error('boom'); };");
  const sync = await loadStateStore(join(dir, 'sync.mjs'));
  assert.equal(await sync.get('k'), 'v');
  await assert.rejects(sync.set('k', 'v'), /boom/);
});
