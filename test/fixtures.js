export const KEYGEN = '/work/keygen';
export const CLAUDE_REF = { source: 'herdr:claude', agent: 'claude', kind: 'id', value: '33e27c03-d4b1-45a6-bda0-973be4fd3169' };
export const CODEX_REF = { source: 'herdr:codex', agent: 'codex', kind: 'id', value: '01a0eea8-02ca-7ba2-953a-4d0f83360abe' };

function pane(pane_id, workspace_id, tab_id, extra) {
  return {
    pane_id, workspace_id, tab_id, terminal_id: `term_${pane_id}`, focused: false,
    agent: null, agent_status: 'idle', agent_session: null, revision: 1, label: null,
    terminal_title: null, terminal_title_stripped: null, cwd: null, foreground_cwd: null,
    ...extra,
  };
}

export function makeSnapshot() {
  return structuredClone({
    version: '0.9.0',
    protocol: 22,
    workspaces: [
      { workspace_id: 'w4', number: 4, label: 'keygen', focused: true, pane_count: 3, tab_count: 2, active_tab_id: 'w4:t2', agent_status: 'idle', worktree: null },
      { workspace_id: 'w5', number: 5, label: 'other', focused: false, pane_count: 1, tab_count: 1, active_tab_id: 'w5:t1', agent_status: 'idle', worktree: null },
    ],
    tabs: [
      { tab_id: 'w4:t2', workspace_id: 'w4', number: 2, label: 'review', focused: true, pane_count: 2, agent_status: 'idle' },
      { tab_id: 'w4:t1', workspace_id: 'w4', number: 1, label: 'main', focused: false, pane_count: 1, agent_status: 'idle' },
      { tab_id: 'w5:t1', workspace_id: 'w5', number: 1, label: '1', focused: false, pane_count: 1, agent_status: 'idle' },
    ],
    panes: [
      pane('w4:p1', 'w4', 'w4:t1', { agent: 'claude', agent_session: CLAUDE_REF, cwd: KEYGEN, foreground_cwd: KEYGEN }),
      pane('w4:p2', 'w4', 'w4:t2', { agent: 'codex', cwd: KEYGEN, foreground_cwd: KEYGEN, terminal_title_stripped: 'Revisa PR #351 | keygen' }),
      pane('w4:p3', 'w4', 'w4:t2', { cwd: `${KEYGEN}/api`, foreground_cwd: `${KEYGEN}/api` }),
      pane('w5:p1', 'w5', 'w5:t1', { cwd: '/tmp' }),
    ],
    layouts: [],
    agents: [],
  });
}

export const LAYOUTS = {
  'w4:t1': { workspace_id: 'w4', tab_id: 'w4:t1', zoomed: false, focused_pane_id: 'w4:p1', root: { type: 'pane', pane_id: 'w4:p1', cwd: KEYGEN } },
  'w4:t2': {
    workspace_id: 'w4', tab_id: 'w4:t2', zoomed: false, focused_pane_id: 'w4:p2',
    root: {
      type: 'split', direction: 'right', ratio: 0.6,
      first: { type: 'pane', pane_id: 'w4:p2', cwd: KEYGEN },
      second: { type: 'pane', pane_id: 'w4:p3', cwd: `${KEYGEN}/api`, label: 'server' },
    },
  },
};

export const PROCESS_INFOS = {
  'w4:p1': { pane_id: 'w4:p1', shell_pid: 101, foreground_processes: [{ pid: 102, name: 'claude', cmdline: 'claude' }] },
  'w4:p2': { pane_id: 'w4:p2', shell_pid: 201, foreground_processes: [{ pid: 202, name: 'codex', cmdline: 'codex' }] },
  'w4:p3': { pane_id: 'w4:p3', shell_pid: 301, foreground_processes: [{ pid: 301, name: '-zsh', cmdline: '-zsh' }] },
};

export function parkedRecord(overrides = {}) {
  return structuredClone({
    v: 1, id: 'rec-1', state: 'parked', label: 'keygen', cwd: KEYGEN, source_workspace_id: 'w4',
    parked_at: '2026-10-02T10:00:00.000Z', git: null, worktree: null, warnings: [], orphans_killed: [], error: null,
    tabs: [
      { label: 'main', focused: false, root: { type: 'pane', source_pane_id: 'w4:p1', cwd: KEYGEN, label: null, agent: 'claude', agent_session: CLAUDE_REF, was_running: null } },
      {
        label: 'review', focused: true,
        root: {
          type: 'split', direction: 'right', ratio: 0.6,
          first: { type: 'pane', source_pane_id: 'w4:p2', cwd: KEYGEN, label: null, agent: 'codex', agent_session: CODEX_REF, was_running: null },
          second: { type: 'pane', source_pane_id: 'w4:p3', cwd: `${KEYGEN}/api`, label: 'server', agent: null, agent_session: null, was_running: 'npm run dev' },
        },
      },
    ],
    ...overrides,
  });
}

export function fakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, params = {}) {
      calls.push({ method, params });
      const handler = handlers[method];
      if (!handler) throw new Error(`unexpected call ${method}`);
      return handler(params, calls);
    },
  };
}
