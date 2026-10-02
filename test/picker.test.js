import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatList, runPicker } from '../src/picker.js';
import { createStore } from '../src/store.js';
import { parkedRecord } from './fixtures.js';

test('formatList shows label, age, state and cwd', () => {
  const now = Date.parse('2026-10-02T13:00:00.000Z');
  const text = formatList([parkedRecord(), parkedRecord({ id: 'b', label: 'chat-api', state: 'resume_failed', parked_at: '2026-09-29T13:00:00.000Z' })], now);
  assert.match(text, / 1\. keygen  3h ago\n {4}\/work\/keygen/);
  assert.match(text, / 2\. chat-api  3d ago  \[resume_failed\]/);
  assert.equal(formatList([], now), 'No parked spaces.');
});

test('runPicker resumes the chosen record', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-pick-')));
  store.save(parkedRecord());
  const input = new PassThrough();
  const output = new PassThrough();
  const chosen = [];
  const done = runPicker({ client: {}, store, input, output, resumeFn: async ({ id }) => { chosen.push(id); return { status: 'resumed', warnings: [] }; } });
  input.write('1\n');
  assert.equal(await done, 0);
  assert.deepEqual(chosen, ['rec-1']);
});

test('runPicker does nothing on an empty answer', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-pick-')));
  store.save(parkedRecord());
  const input = new PassThrough();
  const done = runPicker({ client: {}, store, input, output: new PassThrough(), resumeFn: async () => assert.fail('must not resume') });
  input.write('\n');
  assert.equal(await done, 0);
});

test('runPicker lists cleanup_failed records too, so they can be retried', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-pick-')));
  store.save(parkedRecord({ state: 'cleanup_failed' }));
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const done = runPicker({ client: {}, store, input, output, resumeFn: async () => ({ status: 'resumed', warnings: [] }) });
  input.write('\n');
  await done;
  assert.match(text, /keygen .*\[cleanup_failed\]/);
});
