import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { main, summary } from '../src/cli.js';
import { createStore } from '../src/store.js';
import { fakeClient, parkedRecord } from './fixtures.js';

function setup(records = [parkedRecord()]) {
  const stateDir = mkdtempSync(join(tmpdir(), 'hsp-cli-'));
  const store = createStore(stateDir);
  for (const r of records) store.save(r);
  const client = fakeClient({
    'workspace.list': () => ({ workspaces: [{ workspace_id: 'wP', label: 'Parked (1)' }] }),
    'workspace.close': () => ({ type: 'ok' }),
    'workspace.rename': () => ({ type: 'ok' }),
    'pane.process_info': () => ({ process_info: { foreground_processes: [{ cmdline: 'bash /p/bin/board.sh' }] } }),
    'notification.show': () => ({ type: 'ok' }),
  });
  const env = { HERDR_SOCKET_PATH: '/s', HERDR_PLUGIN_STATE_DIR: stateDir, HERDR_PLUGIN_ROOT: '/p', HERDR_PLUGIN_ID: 'herdr-space-parking' };
  return { store, client, env, stateDir };
}

function capture(fn) {
  const lines = [];
  const original = console.log;
  console.log = (line) => lines.push(String(line));
  return fn().finally(() => { console.log = original; }).then((code) => ({ code, out: lines.join('\n') }));
}

test('summary exposes the listing fields', () => {
  assert.deepEqual(summary(parkedRecord()), {
    id: 'rec-1', label: 'keygen', cwd: '/work/keygen', state: 'parked', parked_at: '2026-10-02T10:00:00.000Z', tabs: 2,
  });
});

test('board-list prints the board rows', async () => {
  const { client, env } = setup();
  const { code, out } = await capture(() => main(['board-list'], env, { client }));
  assert.equal(code, 0);
  assert.equal(out.split('\u001f')[0], 'rec-1');
});

test('delete removes the record and closes the board when nothing is left', async () => {
  const { client, env, store, stateDir } = setup();
  writeFileSync(join(stateDir, 'board.json'), JSON.stringify({ workspace_id: 'wP', pane_id: 'wP:p1' }));
  const { code } = await capture(() => main(['delete', 'rec-1'], env, { client }));
  assert.equal(code, 0);
  assert.equal(store.get('rec-1'), null);
  assert.ok(client.calls.some((c) => c.method === 'workspace.close' && c.params.workspace_id === 'wP'));
});

test('parking the board space itself is refused', async () => {
  const { client, env, stateDir } = setup();
  writeFileSync(join(dirname(join(stateDir, 'parked')), 'board.json'), JSON.stringify({ workspace_id: 'wP', pane_id: 'wP:p1' }));
  const { code } = await capture(() => main(['park', 'wP'], env, { client }));
  assert.equal(code, 1);
  assert.ok(!client.calls.some((c) => c.method === 'session.snapshot'));
  assert.match(client.calls.find((c) => c.method === 'notification.show').params.body, /parked spaces board/);
});

test('commands that need an id say so', async () => {
  const { client, env } = setup();
  const errors = [];
  const original = console.error;
  console.error = (line) => errors.push(String(line));
  try {
    assert.equal(await main(['resume'], env, { client }), 2);
    assert.equal(await main(['delete'], env, { client }), 2);
  } finally { console.error = original; }
  assert.match(errors.join('\n'), /resume needs a parked space id/);
});

test('tui deletes through the browser and keeps the board in sync', async () => {
  const { PassThrough } = await import('node:stream');
  const { client, env, store } = setup([parkedRecord(), parkedRecord({ id: 'rec-2', label: 'sizer' })]);
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const done = main(['tui', '--once'], env, { client, input, output });
  for (const key of ['d', 'y', 'q']) {
    input.write(key);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(await done, 0);
  assert.equal(store.get('rec-1'), null);
  assert.ok(store.get('rec-2'));
  assert.ok(client.calls.some((c) => c.method === 'workspace.rename' || c.method === 'workspace.list'));
});

test('open-park-picker opens the multi-select popup', async () => {
  const { client, env } = setup();
  client.call = (() => {
    const original = client.call.bind(client);
    return async (method, params) => (method === 'plugin.pane.open' ? (client.calls.push({ method, params }), { type: 'ok' }) : original(method, params));
  })();
  assert.equal(await main(['open-park-picker'], env, { client }), 0);
  assert.deepEqual(client.calls.at(-1), { method: 'plugin.pane.open', params: { plugin_id: 'herdr-space-parking', entrypoint: 'park-picker' } });
});

test('park-select lists live spaces and closes on q without parking', async () => {
  const { PassThrough } = await import('node:stream');
  const { client, env } = setup([]);
  const base = client.call.bind(client);
  client.call = async (method, params) => (method === 'session.snapshot' ? { snapshot: { workspaces: [], panes: [], tabs: [] } } : base(method, params));
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const done = main(['park-select'], env, { client, input, output });
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write('q');
  assert.equal(await done, 0);
  assert.ok(!client.calls.some((c) => c.method === 'workspace.close'));
});

test('park-batch parks the given spaces under the park lock and reports through notifications', async () => {
  const { client, env } = setup([]);
  const base = client.call.bind(client);
  client.call = async (method, params) => {
    if (method === 'session.snapshot') return { snapshot: { workspaces: [], panes: [], tabs: [] } };
    if (method === 'workspace.list') { client.calls.push({ method, params }); return { workspaces: [{ workspace_id: 'wZ', label: 'ghost' }] }; }
    return base(method, params);
  };
  assert.equal(await main(['park-batch', '-', 'wZ'], env, { client }), 0);
  const notes = client.calls.filter((c) => c.method === 'notification.show').map((c) => c.params);
  assert.deepEqual(notes[0], { title: 'Parking 1 space…', body: 'ghost' });
  assert.equal(notes[1].title, 'Parked 0 of 1 space');
  assert.match(notes[1].body, /ghost: workspace wZ not found/);
});
