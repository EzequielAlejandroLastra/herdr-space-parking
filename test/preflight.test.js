import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWorkspace } from '../src/capture.js';
import { preflight } from '../src/preflight.js';
import { LAYOUTS, PROCESS_INFOS, makeSnapshot } from './fixtures.js';

function run({ mutate = () => {}, infos = PROCESS_INFOS, codexResults = { 'w4:p2': { method: 'verified' } } } = {}) {
  const snapshot = makeSnapshot();
  mutate(snapshot);
  const captured = captureWorkspace({ snapshot, workspaceId: 'w4', layouts: LAYOUTS, processInfos: infos });
  return preflight({ snapshot, workspaceId: 'w4', captured, codexResults });
}

test('an idle space with resolvable sessions has no blockers', () => {
  assert.deepEqual(run(), { blockers: [], warnings: [], fatal: [] });
});

test('working or blocked agents block parking', () => {
  const { blockers } = run({ mutate: (s) => { s.panes[0].agent_status = 'working'; s.panes[1].agent_status = 'blocked'; } });
  assert.deepEqual(blockers, ['w4:p1: claude is working', 'w4:p2: codex is waiting for input']);
});

test('unresolved codex blocks; inferred codex warns', () => {
  assert.deepEqual(run({ codexResults: { 'w4:p2': { method: 'unresolved', reason: 'no thread name in the terminal title' } } }).blockers,
    ['w4:p2: codex session unknown (no thread name in the terminal title)']);
  assert.deepEqual(run({ codexResults: { 'w4:p2': { method: 'inferred' } } }).warnings, ['w4:p2: codex session inferred from its title']);
});

test('claude without a session id blocks; unsupported agents warn', () => {
  assert.deepEqual(run({ mutate: (s) => { s.panes[0].agent_session = null; } }).blockers, ["w4:p1: claude has no session id, it can't be resumed"]);
  assert.deepEqual(run({ mutate: (s) => { s.panes[0].agent = 'opencode'; } }).warnings, ['w4:p1: opencode resume is not supported; it will restore as a shell']);
});

test('a non-agent pane running a command blocks parking', () => {
  const infos = structuredClone(PROCESS_INFOS);
  infos['w4:p3'].foreground_processes = [{ pid: 302, name: 'npm', cmdline: 'npm run dev' }];
  assert.deepEqual(run({ infos }).blockers, ['w4:p3: running "npm run dev"']);
});

test('any worktree membership is fatal in v1 (force cannot bypass it)', () => {
  const worktree = (checkout_path, is_linked_worktree) => ({ repo_key: 'k', repo_name: 'keygen', repo_root: '/work/keygen', checkout_path, is_linked_worktree });
  const parent = run({ mutate: (s) => { s.workspaces[0].worktree = worktree('/work/keygen', false); } });
  assert.deepEqual(parent.fatal, ['worktree spaces are not supported yet']);
  assert.deepEqual(parent.blockers, []);
  const linked = run({ mutate: (s) => { s.workspaces[0].worktree = worktree('/work/keygen-feat', true); } });
  assert.deepEqual(linked.fatal, ['worktree spaces are not supported yet']);
});
