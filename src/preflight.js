import { leaves } from './capture.js';

const RESUMABLE_AGENTS = new Set(['claude', 'codex']);

// blockers: parking would lose work or a session; `park-force` may override them.
// fatal: v1 cannot park this space safely at all; nothing overrides them.
export function preflight({ snapshot, workspaceId, captured, codexResults = {} }) {
  const blockers = [];
  const warnings = [];
  const fatal = [];

  for (const pane of snapshot.panes.filter((p) => p.workspace_id === workspaceId)) {
    if (!pane.agent) continue;
    if (pane.agent_status === 'working') blockers.push(`${pane.pane_id}: ${pane.agent} is working`);
    if (pane.agent_status === 'blocked') blockers.push(`${pane.pane_id}: ${pane.agent} is waiting for input`);
    if (pane.agent === 'codex') {
      const codex = codexResults[pane.pane_id];
      if (!codex || codex.method === 'unresolved') blockers.push(`${pane.pane_id}: codex session unknown (${codex?.reason ?? 'not resolved'})`);
      else if (codex.method === 'inferred') warnings.push(`${pane.pane_id}: codex session inferred from its title`);
    } else if (pane.agent === 'claude') {
      if (!pane.agent_session) blockers.push(`${pane.pane_id}: claude has no session id, it can't be resumed`);
    } else if (!RESUMABLE_AGENTS.has(pane.agent)) {
      warnings.push(`${pane.pane_id}: ${pane.agent} resume is not supported; it will restore as a shell`);
    }
  }

  for (const tab of captured.tabs) {
    for (const leaf of leaves(tab.root)) {
      if (leaf.was_running) blockers.push(`${leaf.source_pane_id}: running "${leaf.was_running}"`);
    }
  }

  // Resuming through workspace.create would drop herdr's worktree membership, so v1 does not park these.
  if (captured.worktree) fatal.push('worktree spaces are not supported yet');

  return { blockers, warnings, fatal };
}
