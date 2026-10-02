import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parsePs } from '../src/proctree.js';
import { createStore } from '../src/store.js';
import { resume, resumeArgv, shellQuote, toApplyNode, waitForShell } from '../src/resume.js';
import { CLAUDE_REF, CODEX_REF, KEYGEN, fakeClient, parkedRecord } from './fixtures.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hsp-resume-'));
const T = 'Thu Oct 1 17:55:08 2026';

function withIds(node, ws, counter) {
  if (node.type === 'split') return { ...node, first: withIds(node.first, ws, counter), second: withIds(node.second, ws, counter) };
  return { ...node, pane_id: `${ws}:p${++counter.n}` };
}

function setup({ liveAgents = [], livePanes = [], workspaces = [], applyError = null, record = parkedRecord(), codexResolver = () => ({ ref: null, method: 'unresolved', reason: 'n/a' }), table = '', reapProcs } = {}) {
  const store = createStore(tmp());
  store.save(record);
  const counter = { n: 0 };
  let tabs = 0;
  const client = fakeClient({
    'workspace.list': () => ({ type: 'workspace_list', workspaces }),
    'agent.list': () => ({ type: 'agent_list', agents: liveAgents }),
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: { workspaces, tabs: [], panes: livePanes, layouts: [], agents: [] } }),
    'workspace.create': () => ({ type: 'workspace_created', workspace: { workspace_id: 'w9' }, tab: { tab_id: 'w9:t1' }, root_pane: { pane_id: 'w9:p0' } }),
    'layout.apply': (params) => {
      tabs += 1;
      if (applyError && tabs === 2) throw applyError;
      const tabId = params.tab_id ?? `w9:t${tabs}`;
      return { type: 'layout_apply', layout: { workspace_id: 'w9', tab_id: tabId, zoomed: false, focused_pane_id: 'x', root: withIds(params.root, 'w9', counter) } };
    },
    'pane.send_text': () => ({ type: 'ok' }),
    'tab.focus': () => ({ type: 'ok' }),
  });
  const readTable = async () => parsePs(`  ${process.pid} 1 ${T} node\n${table}`);
  const deps = { wait: async () => true, cwdExists: () => true, readTable, sleep: async () => {}, ...(reapProcs ? { reapProcs } : {}) };
  return { client, store, deps, codexResolver };
}

const run = ({ client, store, deps, codexResolver }, id = 'rec-1', overrides = {}) =>
  resume({ client, store, id, codexResolver, deps: { ...deps, ...overrides } });
const sent = (client) => client.calls.filter((c) => c.method === 'pane.send_text').map((c) => c.params);

test('resumeArgv supports claude and codex (without the shared daemon) only', () => {
  assert.deepEqual(resumeArgv(CLAUDE_REF), ['claude', '--resume', CLAUDE_REF.value]);
  assert.deepEqual(resumeArgv(CODEX_REF), ['codex', '--no-daemon', 'resume', CODEX_REF.value]);
  assert.equal(resumeArgv({ ...CLAUDE_REF, kind: 'path' }), null);
  assert.equal(resumeArgv({ source: 'herdr:opencode', agent: 'opencode', kind: 'id', value: 'x' }), null);
  assert.equal(resumeArgv(null), null);
});

test('shellQuote leaves safe words alone and single-quotes the rest', () => {
  assert.equal(shellQuote(['claude', '--resume', '33e27c03-d4b1']), 'claude --resume 33e27c03-d4b1');
  assert.equal(shellQuote(['echo', "it's $HOME; rm -rf /"]), `echo 'it'\\''s $HOME; rm -rf /'`);
});

test('toApplyNode keeps the tree and falls back when a cwd is gone', () => {
  const root = parkedRecord().tabs[1].root;
  const applied = toApplyNode(root, { fallbackCwd: KEYGEN, cwdExists: (p) => p === KEYGEN });
  assert.deepEqual(applied, {
    type: 'split', direction: 'right', ratio: 0.6,
    first: { type: 'pane', cwd: KEYGEN },
    second: { type: 'pane', cwd: KEYGEN, label: 'server' },
  });
});

test('resume recreates tabs, types resume commands, focuses and deletes the record', async () => {
  const ctx = setup();
  const result = await run(ctx);
  assert.equal(result.status, 'resumed');
  assert.equal(result.workspaceId, 'w9');
  const applies = ctx.client.calls.filter((c) => c.method === 'layout.apply');
  assert.equal(applies[0].params.tab_id, 'w9:t1');
  assert.equal(applies[0].params.workspace_id, undefined);
  assert.equal(applies[1].params.workspace_id, 'w9');
  assert.equal(applies[1].params.tab_label, 'review');
  assert.deepEqual(sent(ctx.client), [
    { pane_id: 'w9:p1', text: `claude --resume ${CLAUDE_REF.value}\r` },
    { pane_id: 'w9:p2', text: `codex --no-daemon resume ${CODEX_REF.value}\r` },
  ]);
  assert.deepEqual(ctx.client.calls.find((c) => c.method === 'tab.focus').params, { tab_id: 'w9:t2' });
  assert.ok(result.warnings.some((w) => w.includes('"npm run dev" was running')));
  assert.equal(ctx.store.get('rec-1'), null);
});

test('a deleted pane subdirectory reopens in the project root', async () => {
  const ctx = setup();
  await run(ctx, 'rec-1', { cwdExists: (p) => p === KEYGEN });
  const second = ctx.client.calls.filter((c) => c.method === 'layout.apply')[1].params.root;
  assert.equal(second.second.cwd, KEYGEN);
});

test('a claude session already open in a herdr pane is not resumed twice', async () => {
  const ctx = setup({ liveAgents: [{ pane_id: 'w1:p1', agent: 'claude', agent_session: CLAUDE_REF }] });
  const result = await run(ctx);
  assert.equal(sent(ctx.client).length, 1);
  assert.match(sent(ctx.client)[0].text, /^codex /);
  assert.ok(result.warnings.some((w) => w.includes('already open in a herdr pane')));
});

test('codex occupancy comes from resolving live codex panes, not from herdr reports', async () => {
  const livePane = { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', cwd: KEYGEN, foreground_cwd: KEYGEN, agent_session: null };
  const ctx = setup({ livePanes: [livePane], codexResolver: () => ({ ref: CODEX_REF, method: 'inferred' }) });
  const result = await run(ctx);
  assert.deepEqual(sent(ctx.client).map((s) => s.text.split(' ')[0]), ['claude']);
  assert.ok(result.warnings.some((w) => w.includes(CODEX_REF.value)));
});

test('an unresolved live codex pane in the same directory blocks resuming codex there', async () => {
  const livePane = { pane_id: 'w1:p2', workspace_id: 'w1', agent: 'codex', cwd: KEYGEN, foreground_cwd: KEYGEN, agent_session: null };
  const ctx = setup({ livePanes: [livePane] });
  const result = await run(ctx);
  assert.deepEqual(sent(ctx.client).map((s) => s.text.split(' ')[0]), ['claude']);
  assert.ok(result.warnings.some((w) => w.includes('an unidentified codex is open in')));
});

test('the same session appearing twice in one record is resumed once', async () => {
  const record = parkedRecord();
  record.tabs[1].root.first = { ...record.tabs[0].root, source_pane_id: 'w4:p9' };
  const ctx = setup({ record });
  await run(ctx);
  assert.equal(sent(ctx.client).filter((s) => s.text.startsWith('claude')).length, 1);
});

test('a missing project directory fails before creating anything', async () => {
  const ctx = setup();
  const result = await run(ctx, 'rec-1', { cwdExists: () => false });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /directory no longer exists/);
  assert.ok(!ctx.client.calls.some((c) => c.method === 'workspace.create'));
  assert.equal(ctx.store.get('rec-1').state, 'parked');
});

test('a mid-way failure keeps the record as resume_failed with the partial workspace', async () => {
  const ctx = setup({ applyError: new Error('invalid_layout') });
  const result = await run(ctx);
  assert.equal(result.status, 'failed');
  const saved = ctx.store.get('rec-1');
  assert.equal(saved.state, 'resume_failed');
  assert.equal(saved.resumed_workspace_id, 'w9');
  assert.match(saved.error, /invalid_layout/);
});

test('retrying while the partially resumed workspace still exists is refused', async () => {
  const ctx = setup({ record: parkedRecord({ state: 'resume_failed', resumed_workspace_id: 'w9' }), workspaces: [{ workspace_id: 'w9', label: 'renamed' }] });
  const result = await run(ctx);
  assert.match(result.error, /close the partially resumed space first/);
  assert.ok(!ctx.client.calls.some((c) => c.method === 'workspace.create'));
});

test('leftover processes from parking must be gone before resuming', async () => {
  const pending = [{ pid: 777, start: T, command: 'node stubborn-mcp' }];
  const stuck = setup({
    record: parkedRecord({ state: 'cleanup_failed', pending_reap: pending }),
    table: `  777 1 ${T} node stubborn-mcp`,
    reapProcs: async (procs) => ({ killed: [], stillAlive: procs }),
  });
  const refused = await run(stuck);
  assert.match(refused.error, /cleanup incomplete: 777 node stubborn-mcp/);
  assert.ok(!stuck.client.calls.some((c) => c.method === 'workspace.create'));

  const cleared = setup({ record: parkedRecord({ state: 'cleanup_failed', pending_reap: pending }), reapProcs: async (procs) => ({ killed: procs, stillAlive: [] }) });
  assert.equal((await run(cleared)).status, 'resumed');
});

test('a resume already running in another process is refused', async () => {
  const ctx = setup();
  const other = parsePs(`  ${process.pid} 1 ${T} node\n  4242 1 ${T} node cli.js picker`);
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(ctx.store.dir, '..', 'resume.lock'), JSON.stringify({ pid: 4242, start: T }));
  const result = await run(ctx, 'rec-1', { readTable: async () => other });
  assert.match(result.error, /another resume is in progress/);
  assert.equal(ctx.store.get('rec-1').state, 'parked');
});

test('unknown or busy records are rejected', async () => {
  const ctx = setup({ record: parkedRecord({ state: 'resuming' }) });
  assert.match((await run(ctx)).error, /space is resuming/);
  assert.match((await run(ctx, 'nope')).error, /no parked space nope/);
});

test('waitForShell returns true once a shell is in the foreground', async () => {
  const states = [null, { shell_pid: 1, foreground_processes: [{ name: 'node' }] }, { shell_pid: 1, foreground_processes: [{ name: '-zsh' }] }];
  let i = 0;
  const client = fakeClient({ 'pane.process_info': () => ({ type: 'pane_process_info', process_info: states[Math.min(i++, 2)] }) });
  assert.equal(await waitForShell(client, 'w9:p1', { sleep: async () => {} }), true);
});

test('waitForShell gives up after the timeout', async () => {
  const client = fakeClient({ 'pane.process_info': () => ({ type: 'pane_process_info', process_info: { shell_pid: null, foreground_processes: [] } }) });
  assert.equal(await waitForShell(client, 'w9:p1', { timeoutMs: 50, settleMs: 0 }), false);
});

test('the partial workspace id is saved as soon as the workspace exists', async () => {
  const ctx = setup();
  const seen = [];
  const original = ctx.client.call;
  ctx.client.call = async (method, params) => {
    if (method === 'layout.apply') seen.push(ctx.store.get('rec-1')?.resumed_workspace_id);
    return original(method, params);
  };
  await run(ctx);
  assert.equal(seen[0], 'w9');
});

test('a record resumed by another process meanwhile is not resumed again', async () => {
  const ctx = setup();
  const table = parsePs(`  ${process.pid} 1 ${T} node`);
  const result = await run(ctx, 'rec-1', { readTable: async () => { ctx.store.remove('rec-1'); return table; } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /already resumed/);
  assert.ok(!ctx.client.calls.some((c) => c.method === 'workspace.create'));
  assert.equal(ctx.store.get('rec-1'), null);
});
