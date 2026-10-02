import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hsp-store-'));
const rec = (id, parked_at = '2026-10-01T00:00:00.000Z', extra = {}) => ({ v: 1, id, state: 'parked', tabs: [], parked_at, ...extra });

test('save then get round-trips and stamps updated_at', () => {
  const store = createStore(tmp());
  store.save(rec('a-1', undefined, { label: 'x' }));
  const got = store.get('a-1');
  assert.equal(got.label, 'x');
  assert.match(got.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(readdirSync(store.dir), ['a-1.json']);
});

test('get returns null for a missing record', () => {
  assert.equal(createStore(tmp()).get('nope'), null);
});

test('list is newest first and skips corrupt files without deleting them', () => {
  const store = createStore(tmp());
  store.save(rec('old', '2026-10-01T00:00:00.000Z'));
  store.save(rec('new', '2026-10-02T00:00:00.000Z'));
  writeFileSync(join(store.dir, 'broken.json'), '{not json');
  writeFileSync(join(store.dir, 'notes.txt'), 'hello');
  assert.deepEqual(store.list().map((r) => r.id), ['new', 'old']);
  assert.ok(readdirSync(store.dir).includes('broken.json'));
});

test('well-formed foreign JSON is ignored and left untouched', () => {
  const store = createStore(tmp());
  const foreign = JSON.stringify({ id: 'x', parked_at: '2026-10-03T00:00:00.000Z', scope: 'workspace' });
  writeFileSync(join(store.dir, 'x.json'), foreign);
  writeFileSync(join(store.dir, 'other.json'), JSON.stringify(rec('mismatch')));
  writeFileSync(join(store.dir, 'weird.json'), JSON.stringify(rec('weird', undefined, { state: 'hidden' })));
  assert.deepEqual(store.list(), []);
  assert.equal(store.get('x'), null);
  assert.equal(store.get('weird'), null);
  assert.equal(readFileSync(join(store.dir, 'x.json'), 'utf8'), foreign);
});

test('remove deletes the record', () => {
  const store = createStore(tmp());
  store.save(rec('gone'));
  store.remove('gone');
  assert.equal(store.get('gone'), null);
});

test('invalid ids are rejected', () => {
  const store = createStore(tmp());
  assert.throws(() => store.get('../etc/passwd'), /invalid record id/);
  assert.throws(() => store.save({ id: 'a/b' }), /invalid record id/);
});

test('missing state dir names the env var', () => {
  assert.throws(() => createStore(undefined), /HERDR_PLUGIN_STATE_DIR/);
});
