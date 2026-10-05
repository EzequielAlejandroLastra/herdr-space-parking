import { threadNameFromTitle } from './codex-sessions.js';

const SHELL_NAME = /^-?(zsh|bash|fish|sh|dash|ksh|tcsh|nu)$/;

export function isShellProcess(name) {
  return SHELL_NAME.test(String(name ?? '').split('/').pop());
}

export function foregroundCommand(processInfo) {
  const busy = (processInfo?.foreground_processes ?? []).filter((p) => !isShellProcess(p.name));
  if (busy.length === 0) return null;
  return busy.map((p) => p.cmdline || (p.argv ?? []).join(' ') || p.name).join(' | ');
}

export function leaves(node) {
  return node.type === 'split' ? [...leaves(node.first), ...leaves(node.second)] : [node];
}

export function captureWorkspace({ snapshot, workspaceId, layouts, processInfos = {}, agentSessions = {} }) {
  const workspace = snapshot.workspaces.find((w) => w.workspace_id === workspaceId);
  if (!workspace) throw new Error(`workspace ${workspaceId} not found`);
  const panesById = new Map(snapshot.panes.filter((p) => p.workspace_id === workspaceId).map((p) => [p.pane_id, p]));
  const tabs = snapshot.tabs.filter((t) => t.workspace_id === workspaceId).sort((a, b) => a.number - b.number);

  const capturedTabs = tabs.map((tab, index) => {
    const layout = layouts[tab.tab_id];
    if (!layout) throw new Error(`missing layout for tab ${tab.tab_id}`);
    return {
      // herdr names unnamed tabs after their position; re-applying that would freeze it as a custom name.
      label: tab.label && tab.label !== String(index + 1) ? tab.label : null,
      focused: tab.tab_id === workspace.active_tab_id,
      root: captureNode(layout.root, { panesById, processInfos, agentSessions }),
    };
  });

  const firstLeaf = capturedTabs.length > 0 ? leaves(capturedTabs[0].root)[0] : null;
  return { label: workspace.label, cwd: firstLeaf?.cwd ?? null, worktree: workspace.worktree ?? null, tabs: capturedTabs };
}

function captureNode(node, ctx) {
  if (node.type === 'split') {
    return { type: 'split', direction: node.direction, ratio: node.ratio, first: captureNode(node.first, ctx), second: captureNode(node.second, ctx) };
  }
  const pane = ctx.panesById.get(node.pane_id) ?? {};
  const isAgent = Boolean(pane.agent);
  const cwd = isAgent ? (pane.foreground_cwd ?? pane.cwd) : (pane.cwd ?? pane.foreground_cwd);
  return {
    type: 'pane',
    source_pane_id: node.pane_id ?? null,
    cwd: cwd ?? node.cwd ?? null,
    label: node.label ?? null,
    agent: pane.agent ?? null,
    agent_session: Object.hasOwn(ctx.agentSessions, node.pane_id) ? ctx.agentSessions[node.pane_id] : (pane.agent_session ?? null),
    title: isAgent ? conversationTitle(pane) : null,
    was_running: isAgent ? null : foregroundCommand(ctx.processInfos[node.pane_id]),
  };
}

// The agent's conversation title, as the agent sets it in the terminal title.
function conversationTitle(pane) {
  const title = pane.terminal_title_stripped ?? pane.terminal_title ?? null;
  if (!title) return null;
  return pane.agent === 'codex' ? threadNameFromTitle(title) : title.trim() || null;
}
