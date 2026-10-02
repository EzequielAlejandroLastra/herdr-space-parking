import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../../src/herdr-client.js';
import { park } from '../../src/park.js';
import { readProcessTable } from '../../src/proctree.js';
import { resume, waitForShell } from '../../src/resume.js';
import { createStore } from '../../src/store.js';
import { sleep } from '../../src/util.js';

const enabled = process.env.HSP_INTEGRATION === '1';
const noCodex = () => ({ ref: null, method: 'unresolved', reason: 'n/a' });

// An isolated herdr server: XDG_CONFIG_HOME points at a short temp dir so the socket path fits sun_path.
async function startServer() {
  const configHome = mkdtempSync(join(tmpdir(), 'hsp-'));
  const socketPath = join(configHome, 'herdr', 'herdr.sock');
  const env = { ...process.env, XDG_CONFIG_HOME: configHome };
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_SESSION;
  const server = spawn('herdr', ['server'], { env, stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(100);
  assert.ok(existsSync(socketPath), `herdr socket not found at ${socketPath}`);
  return {
    socketPath,
    async stop(client) {
      try { await client.call('server.stop'); } catch { /* already stopping */ }
      await sleep(500);
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

const tagged = (table, tag) => [...table.values()].filter((p) => p.command.includes(tag));
const sessionOf = (pid) => Number(execFileSync('python3', ['-c', 'import os,sys; print(os.getsid(int(sys.argv[1])))', String(pid)]).toString());

test('park releases background and setsid processes; resume restores the layout', { skip: !enabled, timeout: 60000 }, async () => {
  const server = await startServer();
  const client = createClient({ socketPath: server.socketPath, timeoutMs: 10000 });
  const project = mkdtempSync(join(tmpdir(), 'hsp-proj-'));
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-state-')));
  const tag = `hsp${process.pid}`;
  try {
    const created = await client.call('workspace.create', { cwd: project, label: 'it-space', focus: true });
    const workspaceId = created.workspace.workspace_id;
    const { layout } = await client.call('layout.apply', {
      tab_id: created.tab.tab_id,
      root: { type: 'split', direction: 'right', ratio: 0.5, first: { type: 'pane', cwd: project }, second: { type: 'pane', cwd: project, label: 'side' } },
    });
    const paneId = layout.root.first.pane_id;
    assert.ok(await waitForShell(client, paneId, { timeoutMs: 15000 }), 'pane shell should become ready');
    // A background job, plus a python parent that stays alive and forks a child that leaves the pane's session.
    await client.call('pane.send_text', {
      pane_id: paneId,
      text: `sleep 1001 & python3 -c "import os,time; pid=os.fork(); os.setsid() if pid == 0 else None; time.sleep(1002)  # ${tag}" &\r`,
    });
    let table = await readProcessTable();
    for (let i = 0; i < 50 && tagged(table, tag).length < 2; i++) {
      await sleep(200);
      table = await readProcessTable();
    }
    assert.ok(tagged(table, 'sleep 1001').length === 1, 'background job should be running');
    const pythons = tagged(table, tag);
    assert.equal(pythons.length, 2, 'python parent and setsid child should be running');
    const { process_info: info } = await client.call('pane.process_info', { pane_id: paneId });
    const shellSession = sessionOf(info.shell_pid);
    const escaped = pythons.filter((p) => sessionOf(p.pid) !== shellSession);
    assert.equal(escaped.length, 1, 'exactly one python process must have left the pane session');

    const parked = await park({ client, store, workspaceId, codexResolver: noCodex });
    assert.equal(parked.status, 'parked', JSON.stringify(parked));
    const { workspaces } = await client.call('workspace.list');
    assert.ok(!workspaces.some((w) => w.workspace_id === workspaceId), 'workspace must be closed');
    table = await readProcessTable();
    assert.equal(tagged(table, 'sleep 1001').length, 0, 'background job must be gone');
    assert.equal(tagged(table, tag).length, 0, 'python processes must be gone, including the setsid one');
    assert.ok(parked.record.orphans_killed.some((p) => p.pid === escaped[0].pid), 'the escaped process is reaped by the plugin');

    const resumed = await resume({ client, store, id: parked.record.id, codexResolver: noCodex });
    assert.equal(resumed.status, 'resumed', JSON.stringify(resumed));
    const { snapshot } = await client.call('session.snapshot');
    const ws = snapshot.workspaces.find((w) => w.workspace_id === resumed.workspaceId);
    assert.equal(ws.label, 'it-space');
    assert.equal(ws.pane_count, 2);
    const exported = await client.call('layout.export', { tab_id: ws.active_tab_id });
    assert.equal(exported.layout.root.type, 'split');
    assert.equal(exported.layout.root.second.label, 'side');
    assert.equal(store.list().length, 0);
  } finally {
    await server.stop(client);
    rmSync(project, { recursive: true, force: true });
  }
});
