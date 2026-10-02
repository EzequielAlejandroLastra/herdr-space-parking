import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { captureWorkspace, leaves } from './capture.js';
import { gitInfo } from './git-info.js';
import { lockOwnerAlive, withLock } from './lock.js';
import { preflight } from './preflight.js';
import { DEFAULT_KEEP, descendants, readProcessTable, reap, survivors } from './proctree.js';
import { sleep as realSleep } from './util.js';

const DUPLICATE_CODEX = 'the same codex session was resolved for two panes';

function resolveCodexPanes(panes, codexResolver) {
  const results = {};
  for (const pane of panes.filter((p) => p.agent === 'codex')) results[pane.pane_id] = codexResolver(pane);
  const owners = new Map();
  for (const [paneId, result] of Object.entries(results)) {
    if (!result.ref) continue;
    owners.set(result.ref.value, [...(owners.get(result.ref.value) ?? []), paneId]);
  }
  for (const paneIds of owners.values()) {
    if (paneIds.length < 2) continue;
    for (const paneId of paneIds) results[paneId] = { ref: null, method: 'unresolved', reason: DUPLICATE_CODEX };
  }
  return results;
}

// After the close, children such as MCP servers usually exit on their own within a few hundred ms.
// Give them up to `settleMs`, checking every 100 ms, and stop as soon as only kept daemons remain.
async function waitForExit(pending, { readTable, sleep, settleMs }) {
  const watched = (pending ?? []).filter((proc) => !DEFAULT_KEEP.some((pattern) => pattern.test(proc.command)));
  for (let waited = 0; waited < settleMs; waited += 100) {
    if (survivors(watched, await readTable()).length === 0) return;
    await sleep(100);
  }
}

// Reap whatever the record still lists as pending and record the outcome on it.
async function finishCleanup(record, { readTable, reapProcs, sleep }) {
  const leftovers = survivors(record.pending_reap ?? [], await readTable());
  const { killed, stillAlive } = await reapProcs(leftovers, { sleep, readTable });
  record.orphans_killed = [...(record.orphans_killed ?? []), ...killed];
  record.pending_reap = stillAlive;
  record.warnings = (record.warnings ?? []).filter((w) => !w.endsWith('process(es) could not be stopped'));
  if (stillAlive.length > 0) record.warnings.push(`${stillAlive.length} process(es) could not be stopped`);
  record.state = stillAlive.length > 0 ? 'cleanup_failed' : 'parked';
}

// Everything park needs to know about a space before touching it: its layout, what runs in each
// pane, its agent sessions and what would block parking it. Read-only.
export async function inspectWorkspace({ client, snapshot, workspaceId, codexResolver }) {
  if (!snapshot.workspaces.some((w) => w.workspace_id === workspaceId)) return { error: `workspace ${workspaceId} not found` };
  const panes = snapshot.panes.filter((p) => p.workspace_id === workspaceId);
  const tabs = snapshot.tabs.filter((t) => t.workspace_id === workspaceId);

  const layouts = {};
  for (const tab of tabs) layouts[tab.tab_id] = (await client.call('layout.export', { tab_id: tab.tab_id })).layout;

  // Without each pane's shell we can neither see what is running nor find what must be reaped.
  const processInfos = {};
  for (const pane of panes) {
    let info;
    try {
      info = (await client.call('pane.process_info', { pane_id: pane.pane_id })).process_info;
    } catch (err) {
      return { error: `cannot inspect pane ${pane.pane_id}: ${err.message}` };
    }
    if (!info?.shell_pid) return { error: `cannot inspect pane ${pane.pane_id}: no shell process` };
    processInfos[pane.pane_id] = info;
  }

  const codexResults = resolveCodexPanes(panes, codexResolver);
  const agentSessions = Object.fromEntries(Object.entries(codexResults).map(([paneId, result]) => [paneId, result.ref]));
  const captured = captureWorkspace({ snapshot, workspaceId, layouts, processInfos, agentSessions });
  const { blockers, warnings, fatal } = preflight({ snapshot, workspaceId, captured, codexResults });
  return { panes, processInfos, captured, blockers, warnings, fatal };
}

// One park (or one bulk batch) at a time: two parks of the same space would otherwise both save a
// record for it. Resolves with fn's result, or { status: 'failed' } when another park holds the lock.
export async function withParkLock(store, fn, { readTable = readProcessTable } = {}) {
  try {
    return await withLock(join(dirname(store.dir), 'park.lock'), fn, { readTable, what: 'park' });
  } catch (err) {
    if (err.code === 'ELOCKED') return { status: 'failed', error: err.message };
    throw err;
  }
}

export async function park(args) {
  return withParkLock(args.store, () => parkLocked(args), { readTable: args.deps?.lockReadTable });
}

// For callers that already hold the park lock (a bulk batch parks several spaces concurrently).
export const parkUnlocked = (args) => parkLocked(args);

async function parkLocked({ client, store, workspaceId, force = false, codexResolver, deps = {} }) {
  const {
    readTable = readProcessTable,
    reapProcs = reap,
    git = gitInfo,
    sleep = realSleep,
    newId = randomUUID,
    settleMs = 1500,
  } = deps;

  const { snapshot } = await client.call('session.snapshot');
  const inspection = await inspectWorkspace({ client, snapshot, workspaceId, codexResolver });
  if (inspection.error) return { status: 'failed', error: inspection.error };
  const { panes, processInfos, captured, blockers, warnings, fatal } = inspection;
  if (fatal.length > 0) return { status: 'refused', forceable: false, blockers: fatal, warnings };
  if (blockers.length > 0 && !force) return { status: 'refused', forceable: true, blockers, warnings };

  const gitState = await git(captured.cwd);
  const allWarnings = [...blockers.map((b) => `forced: ${b}`), ...warnings];
  if (gitState?.dirty_files) allWarnings.push(`${gitState.dirty_files} uncommitted file(s) on ${gitState.branch} (kept on disk)`);

  const table = await readTable();
  const shellPids = panes.map((p) => processInfos[p.pane_id].shell_pid);
  const shells = shellPids.map((pid) => table.get(pid)).filter(Boolean).map(({ pid, start, command }) => ({ pid, start, command }));

  const record = {
    v: 1,
    id: newId(),
    state: 'parking',
    label: captured.label,
    cwd: gitState?.toplevel || captured.cwd,
    source_workspace_id: workspaceId,
    parked_at: new Date().toISOString(),
    git: gitState ? { branch: gitState.branch, dirty_files: gitState.dirty_files } : null,
    worktree: captured.worktree,
    tabs: captured.tabs,
    warnings: allWarnings,
    shells,
    pending_reap: descendants(table, shellPids),
    orphans_killed: [],
    error: null,
    resumed_workspace_id: null,
  };
  store.save(record);

  // An agent may have switched sessions (/clear, /resume) since the first snapshot.
  const fresh = (await client.call('session.snapshot')).snapshot;
  const freshPanes = new Map(fresh.panes.map((p) => [p.pane_id, p]));
  for (const tab of record.tabs) {
    for (const leaf of leaves(tab.root)) {
      const live = freshPanes.get(leaf.source_pane_id);
      if (live?.agent && live.agent !== 'codex' && live.agent_session) leaf.agent_session = live.agent_session;
    }
  }

  try {
    await client.call('workspace.close', { workspace_id: workspaceId });
  } catch (err) {
    if (err.code === 'workspace_not_found') {
      // Someone else closed (or parked) it between our snapshot and now; this record is a duplicate.
      store.remove(record.id);
      return { status: 'failed', error: `workspace ${workspaceId} was already closed` };
    }
    record.state = 'park_failed';
    record.error = `workspace.close failed: ${err.message}`;
    store.save(record);
    return { status: 'failed', error: record.error, record };
  }

  await waitForExit(record.pending_reap, { readTable, sleep, settleMs });
  await finishCleanup(record, { readTable, reapProcs, sleep });
  store.save(record);
  return { status: record.state, record, warnings: record.warnings };
}

// Decide what happened to a park that did not finish:
// - 'closed': the source workspace is gone, or all of its current panes run shells other than the originals;
// - 'aborted': a current pane of that workspace still runs an original shell (same pid and start time;
//   the command may differ after `exec zsh`), so the workspace was never closed;
// - 'unknown': we could not tell, so nothing is reaped this round.
async function parkOutcome(record, workspaces, { client, readTable, snapshotCache }) {
  if (!workspaces.some((w) => w.workspace_id === record.source_workspace_id)) return 'closed';
  const shells = record.shells ?? [];
  if (shells.length === 0) return 'unknown';
  if (!snapshotCache.value) snapshotCache.value = (await client.call('session.snapshot')).snapshot;
  const table = await readTable();
  for (const pane of snapshotCache.value.panes.filter((p) => p.workspace_id === record.source_workspace_id)) {
    let info;
    try {
      info = (await client.call('pane.process_info', { pane_id: pane.pane_id })).process_info;
    } catch {
      return 'unknown';
    }
    const shell = table.get(info?.shell_pid);
    if (!shell) return 'unknown';
    if (shells.some((s) => s.pid === shell.pid && s.start === shell.start)) return 'aborted';
  }
  return 'closed';
}

export async function reconcile({ client, store, deps = {} }) {
  const { readTable = readProcessTable, reapProcs = reap, sleep = realSleep } = deps;
  const { workspaces } = await client.call('workspace.list');
  const snapshotCache = {};
  const resumeLock = join(dirname(store.dir), 'resume.lock');
  for (const record of store.list()) {
    if (record.state === 'resuming') {
      // The process that was resuming it died (Ctrl-C in the picker, popup closed): make it retryable.
      if (!(await lockOwnerAlive(resumeLock, { readTable }))) {
        record.state = 'resume_failed';
        record.error = 'resume was interrupted';
        store.save(record);
      }
      continue;
    }
    if (!['parking', 'park_failed', 'cleanup_failed'].includes(record.state)) continue;
    if (record.state !== 'cleanup_failed') {
      const outcome = await parkOutcome(record, workspaces, { client, readTable, snapshotCache });
      if (outcome === 'unknown') continue;
      if (outcome === 'aborted') {
        store.remove(record.id);
        continue;
      }
    }
    await finishCleanup(record, { readTable, reapProcs, sleep });
    store.save(record);
  }
}

export { finishCleanup };
