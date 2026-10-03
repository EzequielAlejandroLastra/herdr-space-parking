import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaves } from '../src/capture.js';
import { gitInfo } from '../src/git-info.js';
import { park, reconcile } from '../src/park.js';
import { parsePs } from '../src/proctree.js';
import { createStore } from '../src/store.js';
import { CLAUDE_REF, CODEX_REF, KEYGEN, LAYOUTS, PROCESS_INFOS, fakeClient, makeSnapshot, parkedRecord } from './fixtures.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hsp-park-'));
const T = 'Thu Oct 1 17:55:08 2026';
const BEFORE = parsePs(`
  101 1 ${T} -zsh
  102 101 ${T} claude
  103 102 ${T} node chrome-devtools-mcp
  201 1 ${T} -zsh
  202 201 ${T} codex
  203 202 ${T} /x/app-server-daemon/bin/codex app-server daemon
  301 1 ${T} -zsh
`);
const AFTER = parsePs(`
  103 1 ${T} node chrome-devtools-mcp
  203 1 ${T} /x/app-server-daemon/bin/codex app-server daemon
`);
const ident = (pid, command) => ({ pid, start: T, command });

function setup({ snapshots = [makeSnapshot()], closeError = null, processInfo = (id) => PROCESS_INFOS[id], stillAlive = [], gitState = { branch: 'main', dirty_files: 2, toplevel: KEYGEN } } = {}) {
  let snapshotCalls = 0;
  const client = fakeClient({
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: snapshots[Math.min(snapshotCalls++, snapshots.length - 1)] }),
    'layout.export': ({ tab_id }) => ({ type: 'layout_export', layout: LAYOUTS[tab_id] }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: processInfo(pane_id) }),
    'workspace.close': () => { if (closeError) throw closeError; return { type: 'ok' }; },
  });
  let reads = 0;
  const reaped = [];
  const deps = {
    readTable: async () => (reads++ === 0 ? BEFORE : AFTER),
    reapProcs: async (procs) => {
      reaped.push(...procs);
      const alive = procs.filter((p) => stillAlive.includes(p.pid));
      return { killed: procs.filter((p) => !/app-server/.test(p.command) && !alive.includes(p)), stillAlive: alive };
    },
    git: async () => gitState,
    sleep: async () => {},
    newId: () => 'rec-1',
  };
  return { client, deps, reaped, store: createStore(tmp()) };
}

const verifiedCodex = () => ({ ref: CODEX_REF, method: 'verified' });

test('parks: saves the record, closes the workspace and reaps survivors', async () => {
  const { client, deps, reaped, store } = setup();
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(result.status, 'parked');
  const saved = store.get('rec-1');
  assert.equal(saved.state, 'parked');
  assert.equal(saved.label, 'keygen');
  assert.equal(saved.cwd, KEYGEN);
  assert.equal(saved.tabs.length, 2);
  assert.deepEqual(leaves(saved.tabs[1].root)[0].agent_session, CODEX_REF);
  assert.deepEqual(saved.shells, [ident(101, '-zsh'), ident(201, '-zsh'), ident(301, '-zsh')]);
  assert.deepEqual(reaped.map((p) => p.pid).sort(), [103, 203]);
  assert.deepEqual(saved.orphans_killed.map((p) => p.pid), [103]);
  assert.deepEqual(saved.pending_reap, []);
  assert.ok(saved.warnings.some((w) => w.includes('2 uncommitted file(s) on main')));
  assert.ok(client.calls.some((c) => c.method === 'workspace.close' && c.params.workspace_id === 'w4'));
});

test('the project root (git toplevel) is the record cwd, not a pane subdirectory', async () => {
  const { client, deps, store } = setup({ gitState: { branch: 'main', dirty_files: 0, toplevel: '/work' } });
  await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(store.get('rec-1').cwd, '/work');
  const outside = setup({ gitState: null });
  await park({ client: outside.client, store: outside.store, workspaceId: 'w4', codexResolver: verifiedCodex, deps: outside.deps });
  assert.equal(outside.store.get('rec-1').cwd, KEYGEN);
});

test('refuses with blockers and leaves the space untouched', async () => {
  const { client, deps, store } = setup();
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: () => ({ ref: null, method: 'unresolved', reason: 'ambiguous' }), deps });
  assert.equal(result.status, 'refused');
  assert.equal(result.forceable, true);
  assert.deepEqual(result.blockers, ['w4:p2: codex session unknown (ambiguous)']);
  assert.ok(!client.calls.some((c) => c.method === 'workspace.close'));
  assert.deepEqual(store.list(), []);
});

test('force parks despite blockers and records them as warnings', async () => {
  const { client, deps, store } = setup();
  const result = await park({ client, store, workspaceId: 'w4', force: true, codexResolver: () => ({ ref: null, method: 'unresolved', reason: 'ambiguous' }), deps });
  assert.equal(result.status, 'parked');
  const saved = store.get('rec-1');
  assert.equal(leaves(saved.tabs[1].root)[0].agent_session, null);
  assert.ok(saved.warnings.includes('forced: w4:p2: codex session unknown (ambiguous)'));
});

test('worktree spaces are refused even with force', async () => {
  const snapshot = makeSnapshot();
  snapshot.workspaces[0].worktree = { repo_key: 'k', repo_name: 'keygen', repo_root: KEYGEN, checkout_path: KEYGEN, is_linked_worktree: false };
  const { client, deps, store } = setup({ snapshots: [snapshot] });
  const result = await park({ client, store, workspaceId: 'w4', force: true, codexResolver: verifiedCodex, deps });
  assert.deepEqual(result, { status: 'refused', forceable: false, blockers: ['worktree spaces are not supported yet'], warnings: [] });
  assert.ok(!client.calls.some((c) => c.method === 'workspace.close'));
});

test('two codex panes resolving to the same session are both unresolved', async () => {
  const snapshot = makeSnapshot();
  snapshot.panes[2].agent = 'codex';
  const infos = (id) => (id === 'w4:p3' ? { ...PROCESS_INFOS['w4:p3'], foreground_processes: [{ pid: 302, name: 'codex' }] } : PROCESS_INFOS[id]);
  const { client, deps, store } = setup({ snapshots: [snapshot], processInfo: infos });
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.blockers, [
    'w4:p2: codex session unknown (the same codex session was resolved for two panes)',
    'w4:p3: codex session unknown (the same codex session was resolved for two panes)',
  ]);
});

test('a pane that cannot be inspected aborts park, even with force', async () => {
  const failing = setup({ processInfo: (id) => { if (id === 'w4:p3') throw new Error('pane_not_found'); return PROCESS_INFOS[id]; } });
  const result = await park({ client: failing.client, store: failing.store, workspaceId: 'w4', force: true, codexResolver: verifiedCodex, deps: failing.deps });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /cannot inspect pane w4:p3/);
  assert.deepEqual(failing.store.list(), []);
  const noShell = setup({ processInfo: (id) => (id === 'w4:p3' ? { pane_id: id, shell_pid: null, foreground_processes: [] } : PROCESS_INFOS[id]) });
  const second = await park({ client: noShell.client, store: noShell.store, workspaceId: 'w4', force: true, codexResolver: verifiedCodex, deps: noShell.deps });
  assert.match(second.error, /cannot inspect pane w4:p3: no shell process/);
});

test('refreshes claude session ids right before closing', async () => {
  const later = makeSnapshot();
  later.panes[0].agent_session = { ...CLAUDE_REF, value: 'aaaaaaaa-0000-0000-0000-000000000000' };
  const { client, deps, store } = setup({ snapshots: [makeSnapshot(), later] });
  await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(leaves(store.get('rec-1').tabs[0].root)[0].agent_session.value, 'aaaaaaaa-0000-0000-0000-000000000000');
});

test('a failed close keeps the record as park_failed with what must be reaped', async () => {
  const { client, deps, store } = setup({ closeError: new Error('boom') });
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(result.status, 'failed');
  const saved = store.get('rec-1');
  assert.equal(saved.state, 'park_failed');
  assert.match(saved.error, /workspace.close failed: boom/);
  assert.equal(saved.pending_reap.length, 7);
});

test('processes that cannot be stopped leave the record in cleanup_failed', async () => {
  const { client, deps, store } = setup({ stillAlive: [103] });
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(result.status, 'cleanup_failed');
  const saved = store.get('rec-1');
  assert.equal(saved.state, 'cleanup_failed');
  assert.deepEqual(saved.pending_reap, [ident(103, 'node chrome-devtools-mcp')]);
  assert.ok(saved.warnings.includes('1 process(es) could not be stopped'));
});

test('an unknown workspace fails without saving anything', async () => {
  const { client, deps, store } = setup();
  const result = await park({ client, store, workspaceId: 'w9', codexResolver: verifiedCodex, deps });
  assert.deepEqual(result, { status: 'failed', error: 'workspace w9 not found' });
  assert.deepEqual(store.list(), []);
});

function reconcileSetup({ workspaces, panes = [], shellPid = 101, table }) {
  const snapshot = { ...makeSnapshot(), panes };
  const client = fakeClient({
    'workspace.list': () => ({ type: 'workspace_list', workspaces }),
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: { pane_id, shell_pid: shellPid, foreground_processes: [] } }),
  });
  const reaped = [];
  const deps = {
    readTable: async () => table,
    reapProcs: async (procs) => { reaped.push(...procs); return { killed: procs, stillAlive: [] }; },
    sleep: async () => {},
  };
  return { client, deps, reaped };
}

test('reconcile removes a park that never closed its workspace (original shell alive in a current pane)', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'aborted', state: 'parking', shells: [ident(101, '-zsh')], pending_reap: [ident(101, '-zsh')] }));
  const { client, deps, reaped } = reconcileSetup({
    workspaces: [{ workspace_id: 'w4', label: 'keygen' }],
    panes: [{ pane_id: 'w4:p1', workspace_id: 'w4' }],
    table: parsePs(`  101 1 ${T} -zsh`),
  });
  await reconcile({ client, store, deps });
  assert.equal(store.get('aborted'), null);
  assert.deepEqual(reaped, []);
});

test('reconcile does not trust a recycled workspace id without the original shell', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'closed', state: 'parking', shells: [ident(101, '-zsh')], pending_reap: [ident(103, 'node mcp')] }));
  const { client, deps, reaped } = reconcileSetup({
    workspaces: [{ workspace_id: 'w4', label: 'keygen' }],
    panes: [{ pane_id: 'w4:p1', workspace_id: 'w4' }],
    shellPid: 555,
    table: parsePs(`  555 1 Fri Oct 2 09:00:00 2026 -zsh\n  103 1 ${T} node mcp`),
  });
  await reconcile({ client, store, deps });
  const saved = store.get('closed');
  assert.equal(saved.state, 'parked');
  assert.deepEqual(reaped.map((p) => p.pid), [103]);
  assert.deepEqual(saved.orphans_killed.map((p) => p.pid), [103]);
  assert.deepEqual(saved.pending_reap, []);
});

test('reconcile retries cleanup_failed records and leaves other states alone', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'dirty', state: 'cleanup_failed', pending_reap: [ident(103, 'node mcp')] }));
  store.save(parkedRecord({ id: 'retry', state: 'resume_failed' }));
  const { client, deps } = reconcileSetup({ workspaces: [], table: parsePs('') });
  await reconcile({ client, store, deps });
  assert.equal(store.get('dirty').state, 'parked');
  assert.equal(store.get('retry').state, 'resume_failed');
});

test('gitInfo reports branch, dirty count and toplevel; null outside a repo', async () => {
  const repo = tmp();
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  writeFileSync(join(repo, 'a.txt'), 'x');
  mkdirSync(join(repo, 'sub'));
  assert.deepEqual(await gitInfo(join(repo, 'sub')), { branch: 'main', dirty_files: 1, toplevel: realpathSync(repo) });
  assert.equal(await gitInfo(tmp()), null);
  assert.equal(await gitInfo(null), null);
});

test('a close that finds the workspace already gone drops the duplicate record', async () => {
  const { HerdrError } = await import('../src/herdr-client.js');
  const { client, deps, store } = setup({ closeError: new HerdrError('workspace_not_found', 'workspace w4 not found') });
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /already closed/);
  assert.deepEqual(store.list(), []);
});

test('a park already running in another process is refused', async () => {
  const { client, deps, store } = setup();
  const { writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  writeFileSync(join(dirname(store.dir), 'park.lock'), JSON.stringify({ pid: 4242, start: T }));
  const lockTable = async () => parsePs(`  ${process.pid} 1 ${T} node\n  4242 1 ${T} node cli.js park`);
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps: { ...deps, lockReadTable: lockTable } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /another park is in progress/);
  assert.ok(!client.calls.some((c) => c.method === 'workspace.close'));
});

test('reconcile leaves a record alone when it cannot inspect the live workspace', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'unsure', state: 'park_failed', shells: [ident(101, '-zsh')], pending_reap: [ident(103, 'node mcp')] }));
  const { client, deps, reaped } = reconcileSetup({
    workspaces: [{ workspace_id: 'w4', label: 'keygen' }],
    panes: [{ pane_id: 'w4:p1', workspace_id: 'w4' }],
    table: parsePs(`  103 1 ${T} node mcp`),
  });
  client.call = async (method, params) => {
    if (method === 'pane.process_info') throw new Error('timeout');
    return fakeClient({
      'workspace.list': () => ({ workspaces: [{ workspace_id: 'w4', label: 'keygen' }] }),
      'session.snapshot': () => ({ snapshot: { ...makeSnapshot(), panes: [{ pane_id: 'w4:p1', workspace_id: 'w4' }] } }),
    }).call(method, params);
  };
  await reconcile({ client, store, deps });
  assert.equal(store.get('unsure').state, 'park_failed');
  assert.deepEqual(reaped, []);
});

test('reconcile recognises the original shell even after `exec zsh` changed its command', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'aborted', state: 'parking', shells: [ident(101, '-zsh')], pending_reap: [ident(101, '-zsh')] }));
  const { client, deps, reaped } = reconcileSetup({
    workspaces: [{ workspace_id: 'w4', label: 'keygen' }],
    panes: [{ pane_id: 'w4:p1', workspace_id: 'w4' }],
    table: parsePs(`  101 1 ${T} zsh`),
  });
  await reconcile({ client, store, deps });
  assert.equal(store.get('aborted'), null);
  assert.deepEqual(reaped, []);
});

test('reconcile leaves a record alone when the workspace exists but no shells were recorded', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'noshells', state: 'park_failed', shells: [], pending_reap: [ident(103, 'node mcp')] }));
  const { client, deps, reaped } = reconcileSetup({
    workspaces: [{ workspace_id: 'w4', label: 'keygen' }],
    panes: [{ pane_id: 'w4:p1', workspace_id: 'w4' }],
    table: parsePs(`  103 1 ${T} node mcp`),
  });
  await reconcile({ client, store, deps });
  assert.equal(store.get('noshells').state, 'park_failed');
  assert.deepEqual(reaped, []);
});

test('reconcile turns an interrupted resume into resume_failed unless a resume is still running', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'stuck', state: 'resuming', resumed_workspace_id: 'w9' }));
  const { client, deps } = reconcileSetup({ workspaces: [], table: parsePs(`  ${process.pid} 1 ${T} node`) });
  await reconcile({ client, store, deps });
  assert.equal(store.get('stuck').state, 'resume_failed');

  const busy = createStore(tmp());
  busy.save(parkedRecord({ id: 'running', state: 'resuming' }));
  const { writeFileSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  writeFileSync(join(dirname(busy.dir), 'resume.lock'), JSON.stringify({ pid: 4242, start: T }));
  const other = reconcileSetup({ workspaces: [], table: parsePs(`  4242 1 ${T} node cli.js picker`) });
  await reconcile({ client: other.client, store: busy, deps: other.deps });
  assert.equal(busy.get('running').state, 'resuming');
});

test('park does not wait once everything but the shared codex daemon is gone', async () => {
  const { client, deps, store } = setup();
  const onlyDaemon = parsePs(`  203 1 ${T} /x/app-server-daemon/bin/codex app-server daemon`);
  let reads = 0;
  const sleeps = [];
  const result = await park({
    client, store, workspaceId: 'w4', codexResolver: verifiedCodex,
    deps: { ...deps, readTable: async () => (reads++ === 0 ? BEFORE : onlyDaemon), sleep: async (ms) => sleeps.push(ms) },
  });
  assert.equal(result.status, 'parked');
  assert.deepEqual(sleeps, []);
});

test('park waits for exiting processes in short steps, up to the settle time', async () => {
  const { client, deps, store } = setup();
  const sleeps = [];
  await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps: { ...deps, sleep: async (ms) => sleeps.push(ms) } });
  assert.ok(sleeps.length > 1 && sleeps.every((ms) => ms <= 100), JSON.stringify(sleeps));
  assert.ok(sleeps.reduce((a, b) => a + b, 0) <= 1500);
});
