import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWorkspace, foregroundCommand, isShellProcess, leaves } from '../src/capture.js';
import { CLAUDE_REF, CODEX_REF, KEYGEN, LAYOUTS, PROCESS_INFOS, makeSnapshot } from './fixtures.js';

test('isShellProcess recognises login and plain shells only', () => {
  for (const name of ['zsh', '-zsh', 'bash', '/bin/bash', 'fish', 'sh']) assert.equal(isShellProcess(name), true, name);
  for (const name of ['node', 'claude', 'npm', 'zshx', '']) assert.equal(isShellProcess(name), false, name);
});

test('foregroundCommand ignores shells and joins busy commands', () => {
  assert.equal(foregroundCommand({ foreground_processes: [{ name: '-zsh' }] }), null);
  assert.equal(foregroundCommand(null), null);
  assert.equal(foregroundCommand({ foreground_processes: [{ name: 'npm', cmdline: 'npm run dev' }] }), 'npm run dev');
});

test('captureWorkspace orders tabs by number and keeps the split tree', () => {
  const captured = captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w4', layouts: LAYOUTS, processInfos: PROCESS_INFOS });
  assert.equal(captured.label, 'keygen');
  assert.equal(captured.cwd, KEYGEN);
  assert.deepEqual(captured.tabs.map((t) => [t.label, t.focused]), [['main', false], ['review', true]]);
  const review = captured.tabs[1].root;
  assert.equal(review.type, 'split');
  assert.equal(review.direction, 'right');
  assert.equal(review.ratio, 0.6);
  assert.deepEqual(leaves(review).map((l) => l.source_pane_id), ['w4:p2', 'w4:p3']);
});

test('captureWorkspace records agents, sessions, labels and running commands', () => {
  const infos = structuredClone(PROCESS_INFOS);
  infos['w4:p3'].foreground_processes = [{ pid: 302, name: 'npm', cmdline: 'npm run dev' }];
  const captured = captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w4', layouts: LAYOUTS, processInfos: infos });
  const [claude] = leaves(captured.tabs[0].root);
  const [codex, shell] = leaves(captured.tabs[1].root);
  assert.deepEqual(claude.agent_session, CLAUDE_REF);
  assert.equal(claude.was_running, null);
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.agent_session, null);
  assert.equal(shell.label, 'server');
  assert.equal(shell.cwd, `${KEYGEN}/api`);
  assert.equal(shell.was_running, 'npm run dev');
});

test('agentSessions override the reported session (codex)', () => {
  const captured = captureWorkspace({
    snapshot: makeSnapshot(), workspaceId: 'w4', layouts: LAYOUTS, processInfos: PROCESS_INFOS,
    agentSessions: { 'w4:p2': CODEX_REF },
  });
  assert.deepEqual(leaves(captured.tabs[1].root)[0].agent_session, CODEX_REF);
});

test('captureWorkspace fails loudly on a missing layout or workspace', () => {
  assert.throws(() => captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w4', layouts: {} }), /missing layout for tab/);
  assert.throws(() => captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w9', layouts: LAYOUTS }), /workspace w9 not found/);
});
