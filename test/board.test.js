import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { boardSync, deleteParked, formatBoardList, isBoardWorkspace } from '../src/board.js';
import { createStore } from '../src/store.js';
import { fakeClient, parkedRecord } from './fixtures.js';

const ENV = { HERDR_SOCKET_PATH: '/s.sock', HERDR_PLUGIN_ROOT: '/plugin', HERDR_PLUGIN_ID: 'herdr-space-parking' };

function setup({ records = [parkedRecord()], board = null, workspaces = [{ workspace_id: 'w1', label: 'api' }], foreground = 'bash /plugin/bin/board.sh' } = {}) {
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-board-')));
  for (const r of records) store.save(r);
  const boardFile = join(dirname(store.dir), 'board.json');
  if (board) writeFileSync(boardFile, JSON.stringify(board));
  const client = fakeClient({
    'workspace.list': () => ({ workspaces }),
    'workspace.create': () => ({ workspace: { workspace_id: 'wP' }, tab: { tab_id: 'wP:t1' }, root_pane: { pane_id: 'wP:p1' } }),
    'layout.apply': (params) => ({ layout: { tab_id: params.tab_id, root: { ...params.root, pane_id: 'wP:p2' } } }),
    'workspace.move': () => ({ type: 'ok' }),
    'workspace.rename': () => ({ type: 'ok' }),
    'workspace.close': () => ({ type: 'ok' }),
    'pane.process_info': () => ({ process_info: { shell_pid: 1, foreground_processes: [{ pid: 2, name: 'bash', cmdline: foreground }] } }),
  });
  const env = { ...ENV, HERDR_PLUGIN_STATE_DIR: dirname(store.dir) };
  return { store, client, env, boardFile };
}

const methods = (client) => client.calls.map((c) => c.method);

test('creates the board space at the end of the sidebar when something is parked', async () => {
  const two = [parkedRecord(), parkedRecord({ id: 'rec-2', label: 'sizer' })];
  const { store, client, env, boardFile } = setup({ records: two });
  const result = await boardSync({ client, store, env });
  assert.equal(result.workspaceId, 'wP');
  const create = client.calls.find((c) => c.method === 'workspace.create').params;
  assert.deepEqual(create, { cwd: env.HERDR_PLUGIN_STATE_DIR, label: 'Parked (2)', focus: false });
  const apply = client.calls.find((c) => c.method === 'layout.apply').params;
  assert.equal(apply.tab_id, 'wP:t1');
  assert.deepEqual(apply.root.command, ['bash', '/plugin/bin/board.sh']);
  assert.equal(apply.root.env.HERDR_PLUGIN_STATE_DIR, env.HERDR_PLUGIN_STATE_DIR);
  assert.equal(apply.root.env.HERDR_SOCKET_PATH, '/s.sock');
  assert.deepEqual(client.calls.find((c) => c.method === 'workspace.move').params, { workspace_id: 'wP', insert_index: 1 });
  assert.deepEqual(JSON.parse(readFileSync(boardFile, 'utf8')), { workspace_id: 'wP', pane_id: 'wP:p2' });
});

test('an existing board only gets its count updated', async () => {
  const { store, client, env } = setup({
    board: { workspace_id: 'wP', pane_id: 'wP:p2' },
    workspaces: [{ workspace_id: 'w1', label: 'api' }, { workspace_id: 'wP', label: 'Parked (3)', active_tab_id: 'wP:t1' }],
  });
  await boardSync({ client, store, env });
  assert.deepEqual(methods(client), ['workspace.list', 'workspace.rename', 'pane.process_info']);
  assert.deepEqual(client.calls[1].params, { workspace_id: 'wP', label: 'Parked (1)' });
});

test('a board pane that is no longer running the board (herdr restart) is rebuilt in place', async () => {
  const { store, client, env, boardFile } = setup({
    board: { workspace_id: 'wP', pane_id: 'wP:p2' },
    workspaces: [{ workspace_id: 'wP', label: 'Parked (1)', active_tab_id: 'wP:t1' }],
    foreground: '-zsh',
  });
  await boardSync({ client, store, env });
  const apply = client.calls.find((c) => c.method === 'layout.apply').params;
  assert.equal(apply.tab_id, 'wP:t1');
  assert.ok(!methods(client).includes('workspace.create'));
  assert.equal(JSON.parse(readFileSync(boardFile, 'utf8')).pane_id, 'wP:p2');
});

test('a saved board that no longer exists is recreated', async () => {
  const { store, client, env } = setup({ board: { workspace_id: 'wP', pane_id: 'wP:p2' }, workspaces: [{ workspace_id: 'w1', label: 'api' }] });
  await boardSync({ client, store, env });
  assert.ok(methods(client).includes('workspace.create'));
});

test('a workspace that reused the board id but is not the board is left alone', async () => {
  const { store, client, env } = setup({ board: { workspace_id: 'wP', pane_id: 'wP:p2' }, workspaces: [{ workspace_id: 'wP', label: 'keygen' }] });
  await boardSync({ client, store, env });
  assert.ok(!methods(client).includes('workspace.rename'));
  assert.ok(!methods(client).includes('workspace.close'));
  assert.ok(methods(client).includes('workspace.create'));
});

test('with nothing parked the board is closed and forgotten', async () => {
  const { store, client, env, boardFile } = setup({
    records: [],
    board: { workspace_id: 'wP', pane_id: 'wP:p2' },
    workspaces: [{ workspace_id: 'wP', label: 'Parked (1)' }],
  });
  const result = await boardSync({ client, store, env });
  assert.equal(result.workspaceId, null);
  assert.deepEqual(client.calls.at(-1), { method: 'workspace.close', params: { workspace_id: 'wP' } });
  assert.equal(existsSync(boardFile), false);
  const empty = setup({ records: [] });
  await boardSync({ client: empty.client, store: empty.store, env: empty.env });
  assert.deepEqual(methods(empty.client), ['workspace.list']);
});

test('isBoardWorkspace recognises the saved board id', () => {
  const { store } = setup({ board: { workspace_id: 'wP', pane_id: 'wP:p2' } });
  assert.equal(isBoardWorkspace(store, 'wP'), true);
  assert.equal(isBoardWorkspace(store, 'w1'), false);
  assert.equal(isBoardWorkspace(setup().store, 'wP'), false);
});

test('formatBoardList prints one unit-separated row per record for the shell UI', () => {
  const now = Date.parse('2026-10-02T13:00:00.000Z');
  const rows = formatBoardList([parkedRecord(), parkedRecord({ id: 'rec-2', label: 'sizer', state: 'cleanup_failed', parked_at: '2026-09-29T13:00:00.000Z' })], now).split('\n');
  assert.deepEqual(rows[0].split('\u001f'), ['rec-1', 'keygen', '3h ago', '', '/work/keygen', '2 tabs · claude, codex']);
  assert.deepEqual(rows[1].split('\u001f'), ['rec-2', 'sizer', '3d ago', 'cleanup_failed', '/work/keygen', '2 tabs · claude, codex']);
  assert.equal(formatBoardList([], now), '');
});

test('deleteParked removes a record but never one that is being resumed', () => {
  const { store } = setup({ records: [parkedRecord(), parkedRecord({ id: 'busy', state: 'resuming' })] });
  assert.deepEqual(deleteParked({ store, id: 'rec-1' }), { status: 'deleted', label: 'keygen' });
  assert.equal(store.get('rec-1'), null);
  assert.match(deleteParked({ store, id: 'busy' }).error, /being resumed/);
  assert.match(deleteParked({ store, id: 'nope' }).error, /no parked space nope/);
});
