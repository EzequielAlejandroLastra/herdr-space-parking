import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listCandidates, parkMany, runBatch } from '../src/bulk.js';
import { createStore } from '../src/store.js';
import { CODEX_REF, LAYOUTS, PROCESS_INFOS, fakeClient, makeSnapshot } from './fixtures.js';

const verified = () => ({ ref: CODEX_REF, method: 'verified' });

function setup({ snapshot = makeSnapshot(), board = null, processInfo } = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-bulk-')));
  if (board) writeFileSync(join(dirname(store.dir), 'board.json'), JSON.stringify(board));
  const client = fakeClient({
    'session.snapshot': () => ({ snapshot }),
    'layout.export': ({ tab_id }) => ({ layout: LAYOUTS[tab_id] ?? { tab_id, root: { type: 'pane', pane_id: tab_id.replace(':t', ':p'), cwd: '/tmp' } } }),
    'pane.process_info': ({ pane_id }) => {
      if (processInfo) return { process_info: processInfo(pane_id) };
      return { process_info: PROCESS_INFOS[pane_id] ?? { pane_id, shell_pid: 900, foreground_processes: [{ pid: 900, name: 'zsh' }] } };
    },
  });
  return { store, client };
}

test('lists every space with what would block parking it', async () => {
  const snapshot = makeSnapshot();
  snapshot.panes[0].agent_status = 'working';
  const { store, client } = setup({ snapshot });
  const items = await listCandidates({ client, store, codexResolver: verified });
  assert.deepEqual(items.map((i) => [i.id, i.label, i.age]), [['w4', 'keygen', '⚠ blocked'], ['w5', 'other', 'idle']]);
  assert.deepEqual(items[0].blockers, ['w4:p1: claude is working']);
  assert.deepEqual(items[0].agents, ['claude', 'codex']);
  const detail = items[0].detail.map((l) => l.text).join('\n');
  assert.match(detail, /⚠ w4:p1: claude is working/);
  assert.match(detail, /Tab "review"/);
  assert.match(items[0].search, /keygen/);
});

test('the board space and worktree spaces are not offered', async () => {
  const snapshot = makeSnapshot();
  snapshot.workspaces[1].worktree = { repo_key: 'k', repo_name: 'o', repo_root: '/o', checkout_path: '/o', is_linked_worktree: false };
  snapshot.workspaces.push({ workspace_id: 'wP', label: 'Parked (2)', active_tab_id: 'wP:t1' });
  const { store, client } = setup({ snapshot, board: { workspace_id: 'wP', pane_id: 'wP:p1' } });
  const items = await listCandidates({ client, store, codexResolver: verified });
  assert.deepEqual(items.map((i) => i.id), ['w4']);
});

test('a space that cannot be inspected is listed as blocked with the reason', async () => {
  const { store, client } = setup({ processInfo: (id) => { if (id === 'w5:p1') throw new Error('pane_not_found'); return PROCESS_INFOS[id]; } });
  const items = await listCandidates({ client, store, codexResolver: verified });
  const other = items.find((i) => i.id === 'w5');
  assert.equal(other.age, '⚠ blocked');
  assert.match(other.blockers[0], /cannot inspect pane w5:p1/);
});

test('parkMany parks several spaces at once, up to the concurrency limit, and reports each outcome', async () => {
  let inFlight = 0;
  let peak = 0;
  const progress = [];
  const outcomes = { w2: { status: 'refused', blockers: ['w2:p1: claude is working'] }, w3: { status: 'failed', error: 'boom' } };
  const targets = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'].map((id) => ({ id, label: `space-${id}` }));
  const results = await parkMany({
    targets,
    focusedId: 'w1',
    concurrency: 4,
    parkOne: async (id) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 10));
      inFlight -= 1;
      return outcomes[id] ?? { status: 'parked' };
    },
    onProgress: (done, total) => progress.push(`${done}/${total}`),
  });
  assert.equal(peak, 4);
  assert.deepEqual(progress, ['1/6', '2/6', '3/6', '4/6', '5/6', '6/6']);
  assert.deepEqual(results.map((r) => r.id), ['w2', 'w3', 'w4', 'w5', 'w6', 'w1']);
  assert.deepEqual(results.find((r) => r.id === 'w2'), { id: 'w2', label: 'space-w2', status: 'refused', reason: 'w2:p1: claude is working' });
  assert.equal(results.find((r) => r.id === 'w3').reason, 'boom');
});

test('runBatch announces the batch, syncs the board once and notifies a summary', async () => {
  const notes = [];
  let syncs = 0;
  const results = await runBatch({
    targets: [{ id: 'w1', label: 'api' }, { id: 'w2', label: 'sizer' }],
    focusedId: null,
    parkOne: async (id) => (id === 'w2' ? { status: 'refused', blockers: ['w2:p1: claude is working'] } : { status: 'parked' }),
    notify: async (title, body) => notes.push([title, body]),
    syncBoard: async () => { syncs += 1; },
  });
  assert.equal(results.length, 2);
  assert.equal(syncs, 1);
  assert.deepEqual(notes[0], ['Parking 2 spaces…', 'api, sizer']);
  assert.deepEqual(notes[1], ['Parked 1 of 2 spaces', 'Not parked:\n· sizer: w2:p1: claude is working']);
});

test('runBatch keeps the summary short when everything was parked', async () => {
  const notes = [];
  await runBatch({
    targets: [{ id: 'w1', label: 'api' }],
    focusedId: null,
    parkOne: async () => ({ status: 'parked' }),
    notify: async (title, body) => notes.push([title, body]),
    syncBoard: async () => {},
  });
  assert.deepEqual(notes[1], ['Parked 1 space', 'api']);
});
