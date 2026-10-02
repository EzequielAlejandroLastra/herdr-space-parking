import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withLock } from '../src/lock.js';
import { parsePs } from '../src/proctree.js';

const T = 'Thu Oct 1 17:55:08 2026';
const lockPath = () => join(mkdtempSync(join(tmpdir(), 'hsp-lock-')), 'resume.lock');
const table = (lines) => async () => parsePs(lines.join('\n'));

test('withLock runs the function and releases the lock', async () => {
  const path = lockPath();
  const result = await withLock(path, async () => { assert.ok(existsSync(path)); return 42; }, { readTable: table([`  ${process.pid} 1 ${T} node`]) });
  assert.equal(result, 42);
  assert.equal(existsSync(path), false);
});

test('withLock releases the lock when the function throws', async () => {
  const path = lockPath();
  await assert.rejects(withLock(path, async () => { throw new Error('boom'); }, { readTable: table([`  ${process.pid} 1 ${T} node`]) }), /boom/);
  assert.equal(existsSync(path), false);
});

test('a lock whose owner is alive is never stolen, however old it is', async () => {
  const path = lockPath();
  writeFileSync(path, JSON.stringify({ pid: 4242, start: T }));
  const old = new Date(Date.now() - 10 * 60 * 1000);
  utimesSync(path, old, old);
  await assert.rejects(
    withLock(path, async () => assert.fail('must not run'), { readTable: table([`  4242 1 ${T} node cli.js picker`, `  ${process.pid} 1 ${T} node`]) }),
    /another resume is in progress \(pid 4242\)/,
  );
  assert.ok(existsSync(path));
});

test('a lock whose owner is gone (or whose pid was reused) is reclaimed', async () => {
  for (const lines of [[`  ${process.pid} 1 ${T} node`], [`  4242 1 Fri Oct 2 09:00:00 2026 other`, `  ${process.pid} 1 ${T} node`]]) {
    const path = lockPath();
    writeFileSync(path, JSON.stringify({ pid: 4242, start: T }));
    assert.equal(await withLock(path, async () => 'ran', { readTable: table(lines) }), 'ran');
    assert.equal(existsSync(path), false);
  }
});
