import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isShellProcess, leaves } from './capture.js';
import { withLock } from './lock.js';
import { finishCleanup } from './park.js';
import { readProcessTable, reap } from './proctree.js';
import { sleep as realSleep } from './util.js';

const RESUMABLE_STATES = new Set(['parked', 'resume_failed', 'cleanup_failed']);

export function resumeArgv(session) {
  if (!session || session.kind !== 'id') return null;
  if (session.source === 'herdr:claude' && session.agent === 'claude') return ['claude', '--resume', session.value];
  // No --no-daemon: parking stops the Codex window, but the shared app-server daemon keeps the thread
  // open, and a standalone Codex then refuses it ("This conversation is open in another app").
  if (session.source === 'herdr:codex' && session.agent === 'codex') return ['codex', 'resume', session.value];
  return null;
}

export function shellQuote(argv) {
  return argv.map((arg) => (/^[A-Za-z0-9_\-./:=@%+]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`)).join(' ');
}

export function toApplyNode(node, { fallbackCwd = null, cwdExists = existsSync } = {}) {
  if (node.type === 'split') {
    return {
      type: 'split',
      direction: node.direction,
      ratio: node.ratio,
      first: toApplyNode(node.first, { fallbackCwd, cwdExists }),
      second: toApplyNode(node.second, { fallbackCwd, cwdExists }),
    };
  }
  const out = { type: 'pane' };
  const cwd = node.cwd && cwdExists(node.cwd) ? node.cwd : fallbackCwd;
  if (cwd) out.cwd = cwd;
  if (node.label) out.label = node.label;
  return out;
}

export async function waitForShell(client, paneId, { timeoutMs = 5000, sleep = realSleep, settleMs = 300 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { process_info: info } = await client.call('pane.process_info', { pane_id: paneId });
      const procs = info?.foreground_processes ?? [];
      if (info?.shell_pid && procs.length > 0 && procs.every((p) => isShellProcess(p.name))) {
        await sleep(settleMs);
        return true;
      }
    } catch {
      // the pane may not be ready yet
    }
    await sleep(100);
  }
  return false;
}

// Sessions already running in herdr. Codex ids reported by herdr are not trusted (herdr#4649),
// so live Codex panes are resolved the same strict way park does.
async function liveOccupancy(client, codexResolver) {
  const occupied = new Set();
  const unidentifiedCodexCwds = new Set();
  const { agents } = await client.call('agent.list');
  for (const agent of agents) {
    if (agent.agent_session && agent.agent_session.source !== 'herdr:codex') occupied.add(agent.agent_session.value);
  }
  const { snapshot } = await client.call('session.snapshot');
  for (const pane of snapshot.panes.filter((p) => p.agent === 'codex')) {
    const result = codexResolver(pane);
    if (result.ref) occupied.add(result.ref.value);
    else unidentifiedCodexCwds.add(pane.foreground_cwd ?? pane.cwd);
  }
  return { occupied, unidentifiedCodexCwds };
}

export async function resume({ client, store, id, codexResolver, deps = {} }) {
  const {
    wait = waitForShell,
    cwdExists = existsSync,
    readTable = readProcessTable,
    reapProcs = reap,
    sleep = realSleep,
  } = deps;

  const record = store.get(id);
  if (!record) return { status: 'failed', error: `no parked space ${id}` };
  if (!RESUMABLE_STATES.has(record.state)) return { status: 'failed', error: `space is ${record.state}` };

  if ((record.pending_reap ?? []).length > 0) {
    await finishCleanup(record, { readTable, reapProcs, sleep });
    store.save(record);
    if (record.state === 'cleanup_failed') {
      const leftovers = record.pending_reap.map((p) => `${p.pid} ${p.command}`).join(', ');
      return { status: 'failed', error: `cleanup incomplete: ${leftovers}` };
    }
  }

  if (record.resumed_workspace_id) {
    const { workspaces } = await client.call('workspace.list');
    if (workspaces.some((w) => w.workspace_id === record.resumed_workspace_id)) {
      return { status: 'failed', error: `close the partially resumed space first (${record.resumed_workspace_id}), then retry` };
    }
  }

  if (!record.cwd || !cwdExists(record.cwd)) return { status: 'failed', error: `directory no longer exists: ${record.cwd}` };

  const warnings = [];
  let workspaceId = null;
  let alreadyResumed = false;
  try {
    await withLock(join(dirname(store.dir), 'resume.lock'), async () => {
      // Another run may have resumed (and removed) this record while we were checking it.
      const current = store.get(id);
      if (!current || !RESUMABLE_STATES.has(current.state)) {
        alreadyResumed = true;
        return;
      }
      const { occupied, unidentifiedCodexCwds } = await liveOccupancy(client, codexResolver);
      record.state = 'resuming';
      store.save(record);

      const created = await client.call('workspace.create', { cwd: record.cwd, label: record.label, focus: true });
      workspaceId = created.workspace.workspace_id;
      record.resumed_workspace_id = workspaceId;
      store.save(record);
      let focusTabId = null;

      for (const [index, tab] of record.tabs.entries()) {
        const root = toApplyNode(tab.root, { fallbackCwd: record.cwd, cwdExists });
        const params = index === 0 ? { tab_id: created.tab.tab_id, root } : { workspace_id: workspaceId, root };
        if (tab.label) params.tab_label = tab.label;
        const { layout } = await client.call('layout.apply', params);
        if (tab.focused) focusTabId = layout.tab_id;

        const fresh = leaves(layout.root);
        for (const [i, leaf] of leaves(tab.root).entries()) {
          if (leaf.was_running) warnings.push(`"${leaf.was_running}" was running before parking; start it again if needed`);
          const argv = resumeArgv(leaf.agent_session);
          if (!argv) {
            if (leaf.agent) warnings.push(`${leaf.agent} in tab "${tab.label}" restored as a shell (no resumable session)`);
            continue;
          }
          const sessionId = leaf.agent_session.value;
          if (occupied.has(sessionId)) {
            warnings.push(`${leaf.agent} session ${sessionId} is already open in a herdr pane; not resumed`);
            continue;
          }
          if (leaf.agent === 'codex' && unidentifiedCodexCwds.has(leaf.cwd)) {
            warnings.push(`an unidentified codex is open in ${leaf.cwd}; codex session ${sessionId} not resumed`);
            continue;
          }
          const paneId = fresh[i]?.pane_id;
          if (!paneId) {
            warnings.push(`could not find the new pane for ${leaf.agent} in tab "${tab.label}"`);
            continue;
          }
          await wait(client, paneId);
          await client.call('pane.send_text', { pane_id: paneId, text: `${shellQuote(argv)}\r` });
          occupied.add(sessionId);
        }
      }

      if (focusTabId) await client.call('tab.focus', { tab_id: focusTabId });
    }, { readTable });
  } catch (err) {
    if (record.state !== 'resuming') return { status: 'failed', error: err.message };
    record.state = 'resume_failed';
    record.error = err.message;
    record.resumed_workspace_id = workspaceId;
    store.save(record);
    return { status: 'failed', error: err.message, workspaceId, warnings };
  }

  if (alreadyResumed) return { status: 'failed', error: 'this space was already resumed by another run' };
  store.remove(record.id);
  return { status: 'resumed', workspaceId, warnings };
}
