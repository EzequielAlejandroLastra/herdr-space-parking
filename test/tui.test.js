import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { filterItems, renderFrame, runTui, stripAnsi, toItem } from '../src/tui.js';
import { parkedRecord } from './fixtures.js';

const NOW = Date.parse('2026-10-02T13:00:00.000Z');

function record(overrides = {}) {
  const r = parkedRecord(overrides);
  r.git = { branch: 'develop', dirty_files: 2 };
  r.tabs[0].root.title = 'Pull request 387 review and merge';
  r.tabs[1].root.first.title = 'Revisa PR #351';
  return r;
}

const many = (n) => Array.from({ length: n }, (_, i) => record({ id: `rec-${i}`, label: `space-${String(i).padStart(3, '0')}`, parked_at: new Date(NOW - i * 3600000).toISOString() }));

test('toItem summarises agents and builds a detail with titles, git state and running commands', () => {
  const item = toItem(record(), NOW);
  assert.deepEqual(item.agents, ['claude', 'codex']);
  assert.equal(item.age, '3h ago');
  const detail = item.detail.map((line) => line.text).join('\n');
  assert.match(detail, /develop · 2 uncommitted files/);
  assert.match(detail, /Tab "main"\n {2}● claude {2}"Pull request 387 review and merge"/);
  assert.match(detail, /◆ codex {2}"Revisa PR #351"/);
  assert.match(detail, /\$ shell · was running: npm run dev/);
  assert.match(detail, /parked .* · 3h ago/);
});

test('toItem flags spaces that need attention', () => {
  const detail = toItem(record({ state: 'resume_failed', error: 'invalid_layout' }), NOW).detail.map((l) => l.text).join('\n');
  assert.match(detail, /⚠ resume failed: invalid_layout/);
});

test('search matches every word in name, folder, branch, tabs or conversation titles', () => {
  const items = [toItem(record(), NOW), toItem(record({ id: 'rec-2', label: 'sizer', cwd: '/work/sizer' }), NOW)];
  items[1].search = items[1].search.replace('pull request 387', 'other');
  assert.deepEqual(filterItems(items, 'request 387').map((i) => i.id), ['rec-1']);
  assert.deepEqual(filterItems(items, 'SIZER').map((i) => i.id), ['rec-2']);
  assert.deepEqual(filterItems(items, 'develop').map((i) => i.id), ['rec-1', 'rec-2']);
  assert.deepEqual(filterItems(items, '').length, 2);
  assert.deepEqual(filterItems(items, 'nothing like this'), []);
});

test('wide terminals show the list and the selected space detail side by side', () => {
  const items = [toItem(record(), NOW), toItem(record({ id: 'rec-2', label: 'sizer' }), NOW)];
  const frame = stripAnsi(renderFrame({ items, total: 2, selected: 1, query: '', searching: false }, { columns: 120, rows: 20 })).split('\n');
  assert.match(frame[0], /Parked spaces \(2\)/);
  assert.ok(frame.some((line) => /^▸ sizer /.test(line)), frame.join('\n'));
  assert.match(frame[2], /│ sizer +$/);
  assert.ok(frame.some((line) => /│ +Tab "main"/.test(line)));
  assert.match(frame.at(-1), /↑↓ move · Enter resume · \/ search · d delete · q close/);
  assert.ok(frame.every((line) => [...line].length <= 120));
  assert.equal(frame.length, 20);
});

test('the list scrolls to keep the selection visible among 100 spaces', () => {
  const items = many(100).map((r) => toItem(r, NOW));
  const frame = stripAnsi(renderFrame({ items, total: 100, selected: 97, query: '', searching: false }, { columns: 120, rows: 15 }));
  assert.match(frame, /▸ space-097/);
  assert.doesNotMatch(frame, /space-000/);
  assert.match(frame, /98\/100/);
});

test('narrow terminals stack the detail under the list', () => {
  const items = [toItem(record(), NOW)];
  const frame = stripAnsi(renderFrame({ items, total: 1, selected: 0, query: '', searching: false }, { columns: 60, rows: 24 })).split('\n');
  assert.ok(frame.every((line) => [...line].length <= 60));
  assert.ok(frame.some((line) => /^ *Tab "main"/.test(line)));
});

test('search mode, confirmations and messages replace the help line', () => {
  const items = [toItem(record(), NOW)];
  const size = { columns: 100, rows: 12 };
  assert.match(stripAnsi(renderFrame({ items, total: 1, selected: 0, query: 'key', searching: true }, size)).split('\n')[0], /\/ key█/);
  assert.match(stripAnsi(renderFrame({ items, total: 1, selected: 0, query: '', confirm: 'keygen' }, size)).split('\n').at(-1), /Delete 'keygen'\? .*y\/N/);
  assert.match(stripAnsi(renderFrame({ items: [], total: 1, selected: 0, query: 'zzz', searching: false }, size)), /No parked space matches "zzz"/);
});

function harness(records, { idleMs = 0 } = {}) {
  let list = records;
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const calls = [];
  const actions = {
    resume: async (id) => { calls.push(['resume', id]); return id === 'bad' ? { status: 'failed', error: 'directory no longer exists' } : { status: 'resumed' }; },
    remove: async (id) => { calls.push(['remove', id]); list = list.filter((r) => r.id !== id); return { status: 'deleted' }; },
  };
  const done = runTui({ load: () => list, input, output, actions, size: () => ({ columns: 100, rows: 20 }), idleMs, now: () => NOW });
  const keys = async (...sequence) => {
    for (const key of sequence) {
      input.write(key);
      await new Promise((resolve) => setImmediate(resolve));
    }
  };
  return { done, keys, calls, output };
}

const DOWN = '\x1b[B';

test('arrow down + Enter resumes the selected space and closes', async () => {
  const h = harness([record(), record({ id: 'rec-2', label: 'sizer' })]);
  await h.keys(DOWN, '\r');
  assert.equal(await h.done, 'resumed');
  assert.deepEqual(h.calls, [['resume', 'rec-2']]);
});

test('typing a search narrows the list and Enter resumes the match', async () => {
  const h = harness([record(), record({ id: 'rec-2', label: 'sizer' })]);
  await h.keys('/', 's', 'i', 'z', '\r', '\r');
  assert.equal(await h.done, 'resumed');
  assert.deepEqual(h.calls, [['resume', 'rec-2']]);
});

test('d asks for confirmation, y deletes and the list reloads', async () => {
  const h = harness([record(), record({ id: 'rec-2', label: 'sizer' })]);
  await h.keys('d', 'n', 'd', 'y', 'q');
  assert.equal(await h.done, 'closed');
  assert.deepEqual(h.calls, [['remove', 'rec-1']]);
});

test('a failed resume shows the error and keeps the board open', async () => {
  const h = harness([record({ id: 'bad', label: 'broken' })]);
  let screen = '';
  h.output.on('data', (chunk) => { screen += chunk; });
  await h.keys('\r');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(stripAnsi(screen), /directory no longer exists/);
  await h.keys('q');
  assert.equal(await h.done, 'closed');
});

test('the board gives the terminal back after a while without keys', async () => {
  const h = harness([record()], { idleMs: 50 });
  assert.equal(await h.done, 'idle');
});

import { runSelect } from '../src/tui.js';

const candidate = (id, label, age = 'idle') => ({ id, label, age, agents: ['claude'], state: 'parked', blockers: age === 'idle' ? [] : ['busy'], detail: [{ text: label }], search: label });

function selectHarness(items) {
  const input = new PassThrough();
  const output = new PassThrough();
  let screen = '';
  output.on('data', (chunk) => { screen += chunk; });
  const parked = [];
  const done = runSelect({
    load: async () => items,
    input,
    output,
    size: () => ({ columns: 100, rows: 20 }),
    park: async (targets, onProgress) => {
      parked.push(...targets.map((t) => t.id));
      targets.forEach((t, i) => onProgress(i + 1, targets.length, t.label));
      return targets.map((t) => ({ id: t.id, label: t.label, status: t.id === 'w2' ? 'refused' : 'parked', reason: t.id === 'w2' ? 'claude is working' : null }));
    },
  });
  const keys = async (...sequence) => {
    for (const key of sequence) {
      input.write(key);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  return { done, keys, parked, screen: () => stripAnsi(screen) };
}

test('select: space marks spaces, Enter parks the marked ones and shows a summary', async () => {
  const h = selectHarness([candidate('w1', 'api'), candidate('w2', 'sizer', '⚠ blocked'), candidate('w3', 'infra')]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.keys(' ', DOWN, ' ', DOWN, ' ', '\r');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.parked, ['w1', 'w2', 'w3']);
  assert.match(h.screen(), /\[x\] api/);
  assert.match(h.screen(), /2 parked · 1 not parked/);
  assert.match(h.screen(), /sizer +not parked/);
  await h.keys('x');
  const results = await h.done;
  assert.equal(results.length, 3);
});

test('select: a marks every idle space, Enter with nothing marked parks the current one', async () => {
  const h = selectHarness([candidate('w1', 'api'), candidate('w2', 'sizer', '⚠ blocked'), candidate('w3', 'infra')]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.keys('a', '\r');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.parked, ['w1', 'w3']);
  await h.keys('q');
  await h.done;

  const single = selectHarness([candidate('w1', 'api'), candidate('w3', 'infra')]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await single.keys(DOWN, '\r');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(single.parked, ['w3']);
  await single.keys('q');
  await single.done;
});

test('select: q closes without parking anything', async () => {
  const h = selectHarness([candidate('w1', 'api')]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.keys(' ', 'q');
  assert.deepEqual(await h.done, []);
  assert.deepEqual(h.parked, []);
});

test('select: a only marks idle spaces that match the current search', async () => {
  const h = selectHarness([candidate('w1', 'api'), candidate('w2', 'hsp-one'), candidate('w3', 'hsp-two')]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await h.keys('/', 'h', 's', 'p', '\r', 'a', '\r');
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(h.parked, ['w2', 'w3']);
  await h.keys('q');
  await h.done;
});
