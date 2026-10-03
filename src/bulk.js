import { isBoardWorkspace } from './board.js';
import { inspectWorkspace } from './park.js';
import { tabsDetail } from './tui.js';

// Bulk parking: offer every live space with what would block it, then park the chosen ones.

export async function listCandidates({ client, store, codexResolver }) {
  const { snapshot } = await client.call('session.snapshot');
  const workspaces = snapshot.workspaces.filter((w) => !isBoardWorkspace(store, w.workspace_id));
  const inspections = await Promise.all(workspaces.map((w) => inspectWorkspace({ client, snapshot, workspaceId: w.workspace_id, codexResolver })));
  const items = [];
  for (const [index, workspace] of workspaces.entries()) {
    const inspection = inspections[index];
    if (inspection.fatal?.length > 0) continue;
    const blockers = inspection.error ? [inspection.error] : inspection.blockers;
    const warnings = inspection.warnings ?? [];
    const panes = snapshot.panes.filter((p) => p.workspace_id === workspace.workspace_id);
    const agents = panes.map((p) => p.agent).filter(Boolean);
    const cwd = inspection.captured?.cwd ?? panes[0]?.cwd ?? '';
    const tabs = inspection.captured?.tabs ?? [];
    const detail = [
      { text: workspace.label, style: 'bold' },
      { text: cwd, style: 'dim' },
      ...blockers.map((text) => ({ text: `⚠ ${text}`, style: 'warn' })),
      ...warnings.map((text) => ({ text: `· ${text}`, style: 'dim' })),
      ...tabsDetail(tabs, cwd),
    ];
    const titles = tabs.flatMap((tab) => [tab.label, ...collectTitles(tab.root)]);
    items.push({
      id: workspace.workspace_id,
      label: workspace.label,
      age: blockers.length > 0 ? '⚠ blocked' : 'idle',
      agents,
      state: 'parked',
      blockers,
      detail,
      search: [workspace.label, cwd, ...agents, ...titles].filter(Boolean).join(' ').toLowerCase(),
    });
  }
  return items;
}

function collectTitles(node) {
  return node.type === 'split' ? [...collectTitles(node.first), ...collectTitles(node.second)] : [node.title, node.was_running];
}

function reasonOf(result) {
  switch (result.status) {
    case 'parked':
      return null;
    case 'refused':
      return (result.blockers ?? []).join('; ');
    case 'cleanup_failed':
      return 'parked, but some processes could not be stopped';
    default:
      return result.error ?? 'unknown error';
  }
}

// Parks up to `concurrency` targets at a time (their settle and cleanup waits overlap). Results keep
// the target order, with the focused space last: closing it moves herdr's focus.
export async function parkMany({ targets, focusedId, parkOne, onProgress = () => {}, concurrency = 4 }) {
  const ordered = [...targets.filter((t) => t.id !== focusedId), ...targets.filter((t) => t.id === focusedId)];
  const results = new Array(ordered.length);
  let next = 0;
  let done = 0;
  async function worker() {
    while (next < ordered.length) {
      const index = next++;
      const target = ordered[index];
      const result = await parkOne(target.id);
      results[index] = { id: target.id, label: target.label, status: result.status, reason: reasonOf(result) };
      done += 1;
      onProgress(done, ordered.length, target.label);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ordered.length) }, worker));
  return results;
}

const plural = (n) => `${n} space${n === 1 ? '' : 's'}`;

// The whole bulk park, reported through herdr notifications (it runs detached from the popup).
export async function runBatch({ targets, focusedId, parkOne, notify, syncBoard }) {
  await notify(`Parking ${plural(targets.length)}…`, targets.map((t) => t.label).join(', '));
  const results = await parkMany({ targets, focusedId, parkOne });
  await syncBoard();
  const parked = results.filter((r) => r.status === 'parked' || r.status === 'cleanup_failed');
  const missed = results.filter((r) => !parked.includes(r));
  if (missed.length === 0) {
    await notify(`Parked ${plural(parked.length)}`, parked.map((r) => r.label).join(', '));
  } else {
    await notify(`Parked ${parked.length} of ${plural(results.length)}`, ['Not parked:', ...missed.map((r) => `· ${r.label}: ${r.reason}`)].join('\n'));
  }
  return results;
}
