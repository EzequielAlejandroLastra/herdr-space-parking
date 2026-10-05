import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { leaves } from './capture.js';
import { ago } from './util.js';

// The board is one ordinary herdr Space, "Parked (N)", whose single pane runs bin/board.sh:
// a tiny bash loop that lists parked spaces and resumes or deletes them. It is the only
// process the plugin keeps alive, and it exists only while something is parked.
const BOARD_PREFIX = 'Parked (';
const boardLabel = (count) => `${BOARD_PREFIX}${count})`;
const boardFile = (store) => join(dirname(store.dir), 'board.json');

// Identifies the board script; a running board with another version is restarted, because bash
// keeps executing the script it loaded at start even after the plugin is updated.
export function boardVersion() {
  const script = readFileSync(new URL('../bin/board.sh', import.meta.url));
  return createHash('sha1').update(script).digest('hex').slice(0, 12);
}

// The board loop re-renders when the names in parked/ or refresh/ change; record state changes
// (parking -> parked) keep the same file name, so every sync leaves a new refresh marker.
function touchRefresh(store) {
  const dir = join(dirname(store.dir), 'refresh');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${Date.now()}-${process.pid}`), '');
}

function readBoard(store) {
  try {
    return JSON.parse(readFileSync(boardFile(store), 'utf8'));
  } catch {
    return null;
  }
}

export function isBoardWorkspace(store, workspaceId) {
  return readBoard(store)?.workspace_id === workspaceId;
}

function agentsSummary(record) {
  const agents = [...new Set(record.tabs.flatMap((tab) => leaves(tab.root).map((leaf) => leaf.agent)).filter(Boolean))];
  const tabs = `${record.tabs.length} tab${record.tabs.length === 1 ? '' : 's'}`;
  return agents.length > 0 ? `${tabs} · ${agents.join(', ')}` : tabs;
}

// One line per record: id, label, age, state (empty when simply parked), cwd, summary, separated by
// U+001F: a tab would collapse empty fields in bash `read`.
const SEP = '\u001f';
export function formatBoardList(records, now = Date.now()) {
  const clean = (value) => String(value ?? '').replace(/[\u001f\n]/g, ' ');
  return records
    .map((r) => [r.id, r.label, ago(r.parked_at, now), r.state === 'parked' ? '' : r.state, r.cwd, agentsSummary(r)].map(clean).join(SEP))
    .join('\n');
}

export function deleteParked({ store, id }) {
  const record = store.get(id);
  if (!record) return { status: 'failed', error: `no parked space ${id}` };
  if (record.state === 'resuming') return { status: 'failed', error: `${record.label} is being resumed right now` };
  store.remove(id);
  return { status: 'deleted', label: record.label };
}

async function runsBoard(client, paneId) {
  try {
    const { process_info: info } = await client.call('pane.process_info', { pane_id: paneId });
    return (info?.foreground_processes ?? []).some((p) => /board\.sh|src\/cli\.js/.test(p.cmdline ?? ''));
  } catch {
    return false;
  }
}

async function applyBoardPane(client, tabId, env) {
  const root = {
    type: 'pane',
    cwd: env.HERDR_PLUGIN_STATE_DIR,
    label: 'parked spaces',
    command: ['bash', join(env.HERDR_PLUGIN_ROOT, 'bin', 'board.sh')],
    env: {
      HERDR_SOCKET_PATH: env.HERDR_SOCKET_PATH,
      HERDR_PLUGIN_STATE_DIR: env.HERDR_PLUGIN_STATE_DIR,
      HERDR_PLUGIN_ROOT: env.HERDR_PLUGIN_ROOT,
      HERDR_PLUGIN_ID: env.HERDR_PLUGIN_ID,
    },
  };
  const { layout } = await client.call('layout.apply', { tab_id: tabId, root });
  return layout.root.pane_id;
}

export async function boardSync({ client, store, env }) {
  const count = store.list().length;
  const saved = readBoard(store);
  const { workspaces } = await client.call('workspace.list');
  const board = saved && workspaces.find((w) => w.workspace_id === saved.workspace_id && String(w.label).startsWith(BOARD_PREFIX));

  if (count === 0) {
    rmSync(boardFile(store), { force: true });
    rmSync(join(dirname(store.dir), 'refresh'), { recursive: true, force: true });
    if (board) await client.call('workspace.close', { workspace_id: board.workspace_id });
    return { workspaceId: null };
  }

  if (!board) {
    const created = await client.call('workspace.create', { cwd: env.HERDR_PLUGIN_STATE_DIR, label: boardLabel(count), focus: false });
    const workspaceId = created.workspace.workspace_id;
    const paneId = await applyBoardPane(client, created.tab.tab_id, env);
    await client.call('workspace.move', { workspace_id: workspaceId, insert_index: workspaces.length });
    writeFileSync(boardFile(store), JSON.stringify({ workspace_id: workspaceId, pane_id: paneId, version: boardVersion() }));
    touchRefresh(store);
    return { workspaceId };
  }

  if (board.label !== boardLabel(count)) await client.call('workspace.rename', { workspace_id: board.workspace_id, label: boardLabel(count) });
  // herdr restores panes as plain shells after a restart, and an updated plugin needs a fresh loop.
  if (saved.version !== boardVersion() || !(await runsBoard(client, saved.pane_id))) {
    const paneId = await applyBoardPane(client, board.active_tab_id, env);
    writeFileSync(boardFile(store), JSON.stringify({ workspace_id: board.workspace_id, pane_id: paneId, version: boardVersion() }));
  }
  touchRefresh(store);
  return { workspaceId: board.workspace_id };
}

// New spaces (created, resumed or dragged) can land below the board; put it back at the end.
// Called from herdr workspace events. Our own move fires workspace.moved again, which is then a no-op.
export async function keepBoardLast({ client, store }) {
  const saved = readBoard(store);
  if (!saved) return false;
  const { workspaces } = await client.call('workspace.list');
  const index = workspaces.findIndex((w) => w.workspace_id === saved.workspace_id && String(w.label).startsWith(BOARD_PREFIX));
  if (index === -1 || index === workspaces.length - 1) return false;
  // insert_index counts positions before the move (herdr move_workspace), so the end is length.
  await client.call('workspace.move', { workspace_id: saved.workspace_id, insert_index: workspaces.length });
  return true;
}
