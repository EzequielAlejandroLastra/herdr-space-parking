import { isBoardWorkspace } from './board.js';
import { inspectWorkspace } from './park.js';
import { tabsDetail } from './tui.js';

// Bulk parking: offer every live space with what would block it, then park the chosen ones.

export async function listCandidates({ client, store, codexResolver }) {
  const { snapshot } = await client.call('session.snapshot');
  const items = [];
  for (const workspace of snapshot.workspaces) {
    if (isBoardWorkspace(store, workspace.workspace_id)) continue;
    const inspection = await inspectWorkspace({ client, snapshot, workspaceId: workspace.workspace_id, codexResolver });
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

// Parks targets one at a time. The focused space goes last: closing it moves herdr's focus, and
// everything else is already done if the caller (a popup over it) goes away with it.
export async function parkMany({ targets, focusedId, parkOne, onProgress = () => {} }) {
  const ordered = [...targets.filter((t) => t.id !== focusedId), ...targets.filter((t) => t.id === focusedId)];
  const results = [];
  for (const [index, target] of ordered.entries()) {
    onProgress(index + 1, ordered.length, target.label);
    const result = await parkOne(target.id);
    results.push({ id: target.id, label: target.label, status: result.status, reason: reasonOf(result) });
  }
  return results;
}
