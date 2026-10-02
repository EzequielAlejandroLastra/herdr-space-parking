import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { listCandidates, parkMany } from '../src/bulk.js';
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

test('parkMany parks one by one, the focused space last, and reports each outcome', async () => {
  const order = [];
  const progress = [];
  const outcomes = { w1: { status: 'parked' }, w2: { status: 'refused', blockers: ['w2:p1: claude is working'] }, w3: { status: 'failed', error: 'boom' } };
  const results = await parkMany({
    targets: [{ id: 'w3', label: 'focused' }, { id: 'w1', label: 'one' }, { id: 'w2', label: 'two' }],
    focusedId: 'w3',
    parkOne: async (id) => { order.push(id); return outcomes[id]; },
    onProgress: (done, total, label) => progress.push(`${done}/${total} ${label}`),
  });
  assert.deepEqual(order, ['w1', 'w2', 'w3']);
  assert.deepEqual(progress, ['1/3 one', '2/3 two', '3/3 focused']);
  assert.deepEqual(results, [
    { id: 'w1', label: 'one', status: 'parked', reason: null },
    { id: 'w2', label: 'two', status: 'refused', reason: 'w2:p1: claude is working' },
    { id: 'w3', label: 'focused', status: 'failed', reason: 'boom' },
  ]);
});
