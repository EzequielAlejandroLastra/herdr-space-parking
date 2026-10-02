# herdr-space-parking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A herdr plugin that parks a Space (snapshots it, stops every process, closes it) and resumes it later with its layout and its native Claude Code / Codex sessions.

**Architecture:** Short-lived Node CLI invoked by herdr plugin actions. It talks NDJSON over `$HERDR_SOCKET_PATH`, persists one JSON record per parked Space in `$HERDR_PLUGIN_STATE_DIR/parked/`, and keeps nothing resident. Each step is a small module with injected dependencies, so every module is unit-testable with a fake client.

**Tech Stack:** Node ≥18 ESM, zero dependencies, `node:test` + `node:assert/strict`, herdr 0.9.0 socket API.

**Spec:** `docs/superpowers/specs/2026-10-02-space-parking-design.md`

## Global Constraints

- Node ≥18, ESM (`"type": "module"`), **no npm dependencies**.
- herdr `min_herdr_version = "0.9.0"`; platforms `["macos", "linux"]`.
- Plugin id `herdr-space-parking`. Action ids: `park`, `park-force`, `resume`, `list`. Pane entrypoint: `picker`.
- Record files: `$HERDR_PLUGIN_STATE_DIR/parked/<id>.json`, written atomically (tmp + rename). Record ids match `/^[A-Za-z0-9-]{1,64}$/`.
- Record states: `parking`, `parked`, `park_failed`, `resuming`, `resume_failed`.
- Resume commands are exactly `claude --resume <id>` and `codex --no-daemon resume <id>`.
- The default kill allowlist is `[/app-server-daemon/, /\bcodex app-server\b/]`, so the shared Codex daemon is never killed.
- The plugin never edits user shell or agent config files.

## Review Focus

1. **Resume command typed before the shell is ready** (slow `.zshrc`, powerlevel10k instant prompt). Expected: wait up to 5 s for a shell foreground, then send anyway. Pinned in Task 8 (`waitForShell` timeout test).
2. **A saved pane cwd that no longer exists** (e.g. a deleted sub-directory). Expected: that pane opens in `record.cwd` instead of failing the resume. Pinned in Task 8.
3. **Session ids or labels containing shell metacharacters or quotes.** Expected: the typed command is safely single-quoted. Pinned in Task 8 (`shellQuote` test).
4. **A corrupt or foreign file in the state dir.** Expected: list skips it and never deletes it. Pinned in Task 2.
5. **Running the CLI outside herdr (env vars missing).** Expected: a clear error naming the missing variable. Pinned in Task 1 and Task 2.

---

## File Structure

```text
herdr-space-parking/
├── herdr-plugin.toml          # manifest: actions + popup pane (Task 9)
├── package.json               # scripts only (Task 1)
├── README.md                  # install, keybinds, smoke test (Task 10)
├── src/
│   ├── util.js                # sleep()  (Task 1)
│   ├── herdr-client.js        # NDJSON socket client (Task 1)
│   ├── store.js               # record persistence (Task 2)
│   ├── capture.js             # snapshot → record tabs; leaves(); shell detection (Task 3)
│   ├── codex-sessions.js      # verify/infer Codex session ids (Task 4)
│   ├── preflight.js           # blockers + warnings (Task 5)
│   ├── proctree.js            # ps table, descendants, survivors, reap (Task 6)
│   ├── git-info.js            # branch + dirty count (Task 7)
│   ├── park.js                # park + reconcile orchestration (Task 7)
│   ├── resume.js              # resume orchestration (Task 8)
│   ├── picker.js              # popup UI (Task 9)
│   └── cli.js                 # entrypoint dispatch (Task 9)
└── test/
    ├── fixtures.js            # shared snapshot/layout/record fixtures + fakeClient (Task 3)
    ├── *.test.js              # unit tests per module
    └── integration/park-resume.test.js   # gated real-herdr test (Task 10)
```

---

### Task 1: Scaffold + socket client

**Files:**
- Create: `package.json`, `.gitignore`, `src/util.js`, `src/herdr-client.js`
- Test: `test/herdr-client.test.js`

**Interfaces:**
- Produces:
  - `sleep(ms: number): Promise<void>` from `src/util.js`.
  - `class HerdrError extends Error { code: string }`.
  - `createClient({ socketPath?: string, timeoutMs?: number }): { call(method: string, params?: object): Promise<object> }`. It resolves with the response `result` and rejects with `HerdrError` whose `code` is the API error code, `timeout`, `socket_error`, `socket_closed` or `bad_response`.

- [ ] **Step 1: Create the scaffold files**

`package.json`:
```json
{
  "name": "herdr-space-parking",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=18" },
  "scripts": {
    "test": "node --test",
    "test:integration": "HSP_INTEGRATION=1 node --test test/integration/park-resume.test.js"
  }
}
```

`.gitignore`:
```text
node_modules/
*.tmp
```

`src/util.js`:
```js
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
```

- [ ] **Step 2: Write the failing test** `test/herdr-client.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { createClient, HerdrError } from '../src/herdr-client.js';

function fakeServer(handler) {
  const path = join(tmpdir(), `hsp-${process.pid}-${Math.random().toString(36).slice(2, 8)}.sock`);
  const server = net.createServer((sock) => {
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      const i = buf.indexOf('\n');
      if (i === -1) return;
      const req = JSON.parse(buf.slice(0, i));
      const reply = handler(req);
      if (reply !== undefined) sock.write(JSON.stringify({ id: req.id, ...reply }) + '\n');
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) =>
    server.listen(path, () => resolve({ path, close: () => { server.close(); rmSync(path, { force: true }); } })),
  );
}

test('call sends method and params and resolves with result', async () => {
  const srv = await fakeServer((req) => ({ result: { type: 'echo', method: req.method, params: req.params } }));
  try {
    const client = createClient({ socketPath: srv.path });
    const result = await client.call('workspace.list', { a: 1 });
    assert.deepEqual(result, { type: 'echo', method: 'workspace.list', params: { a: 1 } });
  } finally { srv.close(); }
});

test('call rejects with HerdrError carrying the API error code', async () => {
  const srv = await fakeServer(() => ({ error: { code: 'workspace_not_found', message: 'nope' } }));
  try {
    const client = createClient({ socketPath: srv.path });
    await assert.rejects(client.call('workspace.get', {}), (err) => err instanceof HerdrError && err.code === 'workspace_not_found');
  } finally { srv.close(); }
});

test('call times out when the server never answers', async () => {
  const srv = await fakeServer(() => undefined);
  try {
    const client = createClient({ socketPath: srv.path, timeoutMs: 100 });
    await assert.rejects(client.call('ping'), (err) => err instanceof HerdrError && err.code === 'timeout');
  } finally { srv.close(); }
});

test('createClient without a socket path names the missing variable', () => {
  assert.throws(() => createClient({ socketPath: '' }), /HERDR_SOCKET_PATH/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/herdr-client.test.js`
Expected: FAIL with `Cannot find module '.../src/herdr-client.js'`.

- [ ] **Step 4: Implement** `src/herdr-client.js`

```js
import net from 'node:net';

export class HerdrError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'HerdrError';
    this.code = code;
  }
}

let counter = 0;

export function createClient({ socketPath = process.env.HERDR_SOCKET_PATH, timeoutMs = 5000 } = {}) {
  if (!socketPath) throw new Error('HERDR_SOCKET_PATH is not set; run this inside herdr');

  function call(method, params = {}) {
    const id = `herdr-space-parking:${process.pid}:${++counter}`;
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let buffer = '';
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        fn(value);
      };
      const timer = setTimeout(
        () => finish(reject, new HerdrError('timeout', `${method} timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      socket.setEncoding('utf8');
      socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
      socket.on('data', (chunk) => {
        buffer += chunk;
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        let message;
        try {
          message = JSON.parse(buffer.slice(0, newline));
        } catch (err) {
          finish(reject, new HerdrError('bad_response', err.message));
          return;
        }
        if (message.error) finish(reject, new HerdrError(message.error.code, message.error.message));
        else finish(resolve, message.result);
      });
      socket.on('error', (err) => finish(reject, new HerdrError('socket_error', err.message)));
      socket.on('close', () => finish(reject, new HerdrError('socket_closed', `${method}: connection closed without a response`)));
    });
  }

  return { call };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/herdr-client.test.js`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json .gitignore src/util.js src/herdr-client.js test/herdr-client.test.js
git commit -m "feat: scaffold plugin and herdr socket client"
```

---

### Task 2: Record store

**Files:**
- Create: `src/store.js`
- Test: `test/store.test.js`

**Interfaces:**
- Produces: `createStore(stateDir: string): { dir: string, save(record): void, get(id): object|null, list(): object[], remove(id): void }`.
  - `list()` is sorted by `parked_at`, newest first, and skips unreadable files.
  - `save` stamps `updated_at`.
  - An invalid id throws.
  - A missing `stateDir` throws, naming `HERDR_PLUGIN_STATE_DIR`.

- [ ] **Step 1: Write the failing test** `test/store.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hsp-store-'));

test('save then get round-trips and stamps updated_at', () => {
  const store = createStore(tmp());
  store.save({ id: 'a-1', label: 'x', parked_at: '2026-10-01T00:00:00.000Z' });
  const got = store.get('a-1');
  assert.equal(got.label, 'x');
  assert.match(got.updated_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(readdirSync(store.dir), ['a-1.json']);
});

test('get returns null for a missing record', () => {
  assert.equal(createStore(tmp()).get('nope'), null);
});

test('list is newest first and skips corrupt files without deleting them', () => {
  const store = createStore(tmp());
  store.save({ id: 'old', parked_at: '2026-10-01T00:00:00.000Z' });
  store.save({ id: 'new', parked_at: '2026-10-02T00:00:00.000Z' });
  writeFileSync(join(store.dir, 'broken.json'), '{not json');
  writeFileSync(join(store.dir, 'notes.txt'), 'hello');
  assert.deepEqual(store.list().map((r) => r.id), ['new', 'old']);
  assert.ok(readdirSync(store.dir).includes('broken.json'));
});

test('remove deletes the record', () => {
  const store = createStore(tmp());
  store.save({ id: 'gone', parked_at: '2026-10-01T00:00:00.000Z' });
  store.remove('gone');
  assert.equal(store.get('gone'), null);
});

test('invalid ids are rejected', () => {
  const store = createStore(tmp());
  assert.throws(() => store.get('../etc/passwd'), /invalid record id/);
  assert.throws(() => store.save({ id: 'a/b' }), /invalid record id/);
});

test('missing state dir names the env var', () => {
  assert.throws(() => createStore(undefined), /HERDR_PLUGIN_STATE_DIR/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/store.test.js`
Expected: FAIL with `Cannot find module '.../src/store.js'`.

- [ ] **Step 3: Implement** `src/store.js`

```js
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export function createStore(stateDir) {
  if (!stateDir) throw new Error('HERDR_PLUGIN_STATE_DIR is not set; run this inside herdr');
  const dir = join(stateDir, 'parked');
  mkdirSync(dir, { recursive: true });

  const fileFor = (id) => {
    if (!ID_PATTERN.test(String(id))) throw new Error(`invalid record id: ${id}`);
    return join(dir, `${id}.json`);
  };

  return {
    dir,
    save(record) {
      const path = fileFor(record.id);
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ ...record, updated_at: new Date().toISOString() }, null, 2));
      renameSync(tmp, path);
    },
    get(id) {
      try {
        return JSON.parse(readFileSync(fileFor(id), 'utf8'));
      } catch (err) {
        if (err.code === 'ENOENT') return null;
        throw err;
      }
    },
    list() {
      const records = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        try {
          records.push(JSON.parse(readFileSync(join(dir, name), 'utf8')));
        } catch {
          // unreadable record: skip it, never delete user data
        }
      }
      return records.sort((a, b) => String(b.parked_at).localeCompare(String(a.parked_at)));
    },
    remove(id) {
      rmSync(fileFor(id), { force: true });
    },
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/store.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/store.js test/store.test.js
git commit -m "feat: atomic parked-space record store"
```

---

### Task 3: Capture (snapshot → record tabs) + shared fixtures

**Files:**
- Create: `src/capture.js`, `test/fixtures.js`
- Test: `test/capture.test.js`

**Interfaces:**
- Consumes: herdr shapes `SessionSnapshot`, `LayoutDescription` (`{workspace_id, tab_id, zoomed, focused_pane_id, root}`), `PaneProcessInfo`.
- Produces:
  - `isShellProcess(name: string): boolean`
  - `foregroundCommand(processInfo): string|null`. It returns the non-shell foreground command, or null.
  - `leaves(node): PaneNode[]`, in order (`first` before `second`).
  - `captureWorkspace({ snapshot, workspaceId, layouts: {[tab_id]: LayoutDescription}, processInfos?: {[pane_id]: PaneProcessInfo|null}, agentSessions?: {[pane_id]: AgentSessionInfo|null} }): { label, cwd, worktree, tabs: [{ label, focused, root: Node }] }`.
    - `PaneNode = { type:'pane', source_pane_id, cwd, label, agent, agent_session, was_running }`.
    - `SplitNode = { type:'split', direction, ratio, first, second }`.
    - `agentSessions` entries override the pane's reported `agent_session` (this is used for Codex).
  - `test/fixtures.js` exports: `KEYGEN`, `CLAUDE_REF`, `CODEX_REF`, `makeSnapshot()`, `LAYOUTS`, `PROCESS_INFOS`, `parkedRecord(overrides?)`, `fakeClient(handlers)`.

- [ ] **Step 1: Write the shared fixtures** `test/fixtures.js`

```js
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
```

- [ ] **Step 2: Write the failing test** `test/capture.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWorkspace, foregroundCommand, isShellProcess, leaves } from '../src/capture.js';
import { CLAUDE_REF, CODEX_REF, KEYGEN, LAYOUTS, PROCESS_INFOS, makeSnapshot } from './fixtures.js';

test('isShellProcess recognises login and plain shells only', () => {
  for (const name of ['zsh', '-zsh', 'bash', '/bin/bash', 'fish', 'sh']) assert.equal(isShellProcess(name), true, name);
  for (const name of ['node', 'claude', 'npm', 'zshx', '']) assert.equal(isShellProcess(name), false, name);
});

test('foregroundCommand ignores shells and joins busy commands', () => {
  assert.equal(foregroundCommand({ foreground_processes: [{ name: '-zsh' }] }), null);
  assert.equal(foregroundCommand(null), null);
  assert.equal(foregroundCommand({ foreground_processes: [{ name: 'npm', cmdline: 'npm run dev' }] }), 'npm run dev');
});

test('captureWorkspace orders tabs by number and keeps the split tree', () => {
  const captured = captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w4', layouts: LAYOUTS, processInfos: PROCESS_INFOS });
  assert.equal(captured.label, 'keygen');
  assert.equal(captured.cwd, KEYGEN);
  assert.deepEqual(captured.tabs.map((t) => [t.label, t.focused]), [['main', false], ['review', true]]);
  const review = captured.tabs[1].root;
  assert.equal(review.type, 'split');
  assert.equal(review.direction, 'right');
  assert.equal(review.ratio, 0.6);
  assert.deepEqual(leaves(review).map((l) => l.source_pane_id), ['w4:p2', 'w4:p3']);
});

test('captureWorkspace records agents, sessions, labels and running commands', () => {
  const infos = structuredClone(PROCESS_INFOS);
  infos['w4:p3'].foreground_processes = [{ pid: 302, name: 'npm', cmdline: 'npm run dev' }];
  const captured = captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w4', layouts: LAYOUTS, processInfos: infos });
  const [claude] = leaves(captured.tabs[0].root);
  const [codex, shell] = leaves(captured.tabs[1].root);
  assert.deepEqual(claude.agent_session, CLAUDE_REF);
  assert.equal(claude.was_running, null);
  assert.equal(codex.agent, 'codex');
  assert.equal(codex.agent_session, null);
  assert.equal(shell.label, 'server');
  assert.equal(shell.cwd, `${KEYGEN}/api`);
  assert.equal(shell.was_running, 'npm run dev');
});

test('agentSessions override the reported session (codex)', () => {
  const captured = captureWorkspace({
    snapshot: makeSnapshot(), workspaceId: 'w4', layouts: LAYOUTS, processInfos: PROCESS_INFOS,
    agentSessions: { 'w4:p2': CODEX_REF },
  });
  assert.deepEqual(leaves(captured.tabs[1].root)[0].agent_session, CODEX_REF);
});

test('captureWorkspace fails loudly on a missing layout or workspace', () => {
  assert.throws(() => captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w4', layouts: {} }), /missing layout for tab/);
  assert.throws(() => captureWorkspace({ snapshot: makeSnapshot(), workspaceId: 'w9', layouts: LAYOUTS }), /workspace w9 not found/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `node --test test/capture.test.js`
Expected: FAIL with `Cannot find module '.../src/capture.js'`.

- [ ] **Step 4: Implement** `src/capture.js`

```js
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

  const capturedTabs = tabs.map((tab) => {
    const layout = layouts[tab.tab_id];
    if (!layout) throw new Error(`missing layout for tab ${tab.tab_id}`);
    return {
      label: tab.label ?? null,
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
    was_running: isAgent ? null : foregroundCommand(ctx.processInfos[node.pane_id]),
  };
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/capture.test.js`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/capture.js test/fixtures.js test/capture.test.js
git commit -m "feat: capture workspace layout, agents and running commands"
```

---

### Task 4: Codex session resolution

**Files:**
- Create: `src/codex-sessions.js`
- Test: `test/codex-sessions.test.js`

**Interfaces:**
- Consumes: a herdr `PaneInfo`-like object `{ agent_session, cwd, foreground_cwd, terminal_title, terminal_title_stripped }`.
- Produces:
  - `threadNameFromTitle(title: string|null): string|null`
  - `createCodexResolver({ codexHome?: string }): (pane) => { ref: AgentSessionInfo|null, method: 'verified'|'inferred'|'unresolved', reason?: string }`. The `ref` shape is `{ source:'herdr:codex', agent:'codex', kind:'id', value }`.

- [ ] **Step 1: Write the failing test** `test/codex-sessions.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexResolver, threadNameFromTitle } from '../src/codex-sessions.js';

const A = '01a0eea8-02ca-7ba2-953a-4d0f83360abe';
const B = '01a0fa33-6e3b-7000-8615-273a111ca99f';
const C = '01a0fc7e-3eeb-7f91-84b3-460d93d15abf';

function codexHome({ rollouts, index }) {
  const home = mkdtempSync(join(tmpdir(), 'hsp-codex-'));
  const day = join(home, 'sessions', '2026', '09', '29');
  mkdirSync(day, { recursive: true });
  for (const [id, cwd] of Object.entries(rollouts)) {
    writeFileSync(join(day, `rollout-2026-09-29T16-33-03-${id}.jsonl`), `${JSON.stringify({ type: 'session_meta', payload: { id, cwd } })}\n{"type":"other"}\n`);
  }
  writeFileSync(join(home, 'session_index.jsonl'), index.map((e) => JSON.stringify(e)).join('\n') + '\n');
  return home;
}

const pane = (extra) => ({ agent: 'codex', agent_session: null, cwd: '/work/keygen', foreground_cwd: '/work/keygen', terminal_title_stripped: null, ...extra });

test('threadNameFromTitle strips the trailing directory segment', () => {
  assert.equal(threadNameFromTitle('Revisa efectos colaterales PR #351 | keygen'), 'Revisa efectos colaterales PR #351');
  assert.equal(threadNameFromTitle('chat-api'), 'chat-api');
  assert.equal(threadNameFromTitle(''), null);
  assert.equal(threadNameFromTitle(null), null);
});

test('a reported id whose rollout cwd matches is verified', () => {
  const resolve = createCodexResolver({ codexHome: codexHome({ rollouts: { [A]: '/work/keygen' }, index: [] }) });
  const result = resolve(pane({ agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: A } }));
  assert.equal(result.method, 'verified');
  assert.equal(result.ref.value, A);
});

test('a reported id from another directory is not trusted; inference takes over', () => {
  const home = codexHome({ rollouts: { [A]: '/work/other', [B]: '/work/keygen' }, index: [{ id: B, thread_name: 'Fix login' }] });
  const result = createCodexResolver({ codexHome: home })(pane({
    agent_session: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: A },
    terminal_title_stripped: 'Fix login | keygen',
  }));
  assert.equal(result.method, 'inferred');
  assert.equal(result.ref.value, B);
});

test('a unique thread name in the same cwd is inferred; the latest rename wins', () => {
  const home = codexHome({
    rollouts: { [A]: '/work/keygen' },
    index: [{ id: A, thread_name: 'Old name' }, { id: A, thread_name: 'Revisa PR #351' }],
  });
  const result = createCodexResolver({ codexHome: home })(pane({ terminal_title_stripped: 'Revisa PR #351 | keygen' }));
  assert.deepEqual(result, { ref: { source: 'herdr:codex', agent: 'codex', kind: 'id', value: A }, method: 'inferred' });
});

test('ambiguous names, unnamed threads and missing titles stay unresolved', () => {
  const home = codexHome({
    rollouts: { [A]: '/work/keygen', [B]: '/work/keygen', [C]: '/work/other' },
    index: [{ id: A, thread_name: 'Guardian review' }, { id: B, thread_name: 'Guardian review' }, { id: C, thread_name: 'Solo' }],
  });
  const resolve = createCodexResolver({ codexHome: home });
  assert.match(resolve(pane({ terminal_title_stripped: 'Guardian review | keygen' })).reason, /2 codex threads/);
  assert.match(resolve(pane({ terminal_title_stripped: 'Solo | keygen' })).reason, /no codex thread named "Solo"/);
  assert.match(resolve(pane({ terminal_title_stripped: 'keygen' })).reason, /no codex thread named "keygen"/);
  assert.equal(resolve(pane({})).method, 'unresolved');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/codex-sessions.test.js`
Expected: FAIL with `Cannot find module '.../src/codex-sessions.js'`.

- [ ] **Step 3: Implement** `src/codex-sessions.js`

```js
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROLLOUT = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/;

export function threadNameFromTitle(title) {
  if (!title) return null;
  const name = String(title).replace(/\s+\|\s+[^|]*$/, '').trim();
  return name || null;
}

const codexRef = (value) => ({ source: 'herdr:codex', agent: 'codex', kind: 'id', value });

function readFirstLine(path) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(65536);
    const n = readSync(fd, buf, 0, buf.length, 0);
    const text = buf.subarray(0, n).toString('utf8');
    const newline = text.indexOf('\n');
    return newline === -1 ? text : text.slice(0, newline);
  } finally {
    closeSync(fd);
  }
}

export function createCodexResolver({ codexHome = process.env.CODEX_HOME || join(homedir(), '.codex') } = {}) {
  let rolloutPaths = null;
  let idsByName = null;

  function rollouts() {
    if (rolloutPaths) return rolloutPaths;
    rolloutPaths = new Map();
    const walk = (dir) => {
      if (!existsSync(dir)) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) walk(path);
        else {
          const match = entry.name.match(ROLLOUT);
          if (match) rolloutPaths.set(match[1], path);
        }
      }
    };
    walk(join(codexHome, 'sessions'));
    return rolloutPaths;
  }

  function rolloutCwd(id) {
    const path = rollouts().get(id);
    if (!path) return null;
    try {
      return JSON.parse(readFirstLine(path)).payload?.cwd ?? null;
    } catch {
      return null;
    }
  }

  function threadIdsByName() {
    if (idsByName) return idsByName;
    idsByName = new Map();
    const path = join(codexHome, 'session_index.jsonl');
    if (!existsSync(path)) return idsByName;
    const latest = new Map();
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.id) latest.set(entry.id, entry.thread_name ?? null);
      } catch {
        // ignore malformed index lines
      }
    }
    for (const [id, name] of latest) {
      if (!name) continue;
      if (!idsByName.has(name)) idsByName.set(name, []);
      idsByName.get(name).push(id);
    }
    return idsByName;
  }

  return function resolve(pane) {
    const cwd = pane.foreground_cwd ?? pane.cwd ?? null;
    const reported = pane.agent_session?.kind === 'id' ? pane.agent_session.value : null;
    if (reported && cwd && rolloutCwd(reported) === cwd) return { ref: codexRef(reported), method: 'verified' };

    const name = threadNameFromTitle(pane.terminal_title_stripped ?? pane.terminal_title);
    if (!name) return { ref: null, method: 'unresolved', reason: 'no thread name in the terminal title' };
    const candidates = (threadIdsByName().get(name) ?? []).filter((id) => rolloutCwd(id) === cwd);
    if (candidates.length === 1) return { ref: codexRef(candidates[0]), method: 'inferred' };
    return {
      ref: null,
      method: 'unresolved',
      reason: candidates.length === 0 ? `no codex thread named "${name}" in ${cwd}` : `${candidates.length} codex threads named "${name}" in ${cwd}`,
    };
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/codex-sessions.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/codex-sessions.js test/codex-sessions.test.js
git commit -m "feat: verify or infer codex session ids without trusting daemon reports"
```

---

### Task 5: Preflight (blockers and warnings)

**Files:**
- Create: `src/preflight.js`
- Test: `test/preflight.test.js`

**Interfaces:**
- Consumes: `leaves` from `src/capture.js`; the `captureWorkspace` output; the codex resolver results.
- Produces: `preflight({ snapshot, workspaceId, captured, codexResults?: {[pane_id]: {method, reason?}} }): { blockers: string[], warnings: string[] }`.

- [ ] **Step 1: Write the failing test** `test/preflight.test.js`

```js
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
  assert.deepEqual(run(), { blockers: [], warnings: [] });
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

test('a worktree parent with linked worktree spaces blocks parking', () => {
  const { blockers } = run({
    mutate: (s) => {
      s.workspaces[0].worktree = { repo_key: 'k', repo_name: 'keygen', repo_root: '/work/keygen', checkout_path: '/work/keygen', is_linked_worktree: false };
      s.workspaces[1].worktree = { repo_key: 'k', repo_name: 'keygen', repo_root: '/work/keygen', checkout_path: '/work/keygen-feat', is_linked_worktree: true };
    },
  });
  assert.deepEqual(blockers, ['has 1 linked worktree space(s); park them first']);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/preflight.test.js`
Expected: FAIL with `Cannot find module '.../src/preflight.js'`.

- [ ] **Step 3: Implement** `src/preflight.js`

```js
import { leaves } from './capture.js';

const RESUMABLE_AGENTS = new Set(['claude', 'codex']);

export function preflight({ snapshot, workspaceId, captured, codexResults = {} }) {
  const blockers = [];
  const warnings = [];

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

  const worktree = captured.worktree;
  if (worktree && !worktree.is_linked_worktree) {
    const linked = snapshot.workspaces.filter(
      (w) => w.workspace_id !== workspaceId && w.worktree?.repo_key === worktree.repo_key && w.worktree.is_linked_worktree,
    );
    if (linked.length > 0) blockers.push(`has ${linked.length} linked worktree space(s); park them first`);
  }

  return { blockers, warnings };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/preflight.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/preflight.js test/preflight.test.js
git commit -m "feat: preflight blockers and warnings before parking"
```

---

### Task 6: Process tree + orphan reaping

**Files:**
- Create: `src/proctree.js`
- Test: `test/proctree.test.js`

**Interfaces:**
- Produces:
  - `DEFAULT_KEEP: RegExp[]`
  - `parsePs(text): Map<pid, { pid, ppid, command }>`
  - `readProcessTable(): Promise<Map>`. It runs `ps -axo pid=,ppid=,command=`.
  - `descendants(table, rootPids: number[]): { pid, command }[]`. The roots are included.
  - `survivors(before: {pid, command}[], afterTable): {pid, command}[]`. A process counts only if its pid is alive with the **same** command, which guards against pid reuse.
  - `reap(procs, { keep?, kill?, sleep?, graceMs? }): Promise<{pid, command}[]>`. It sends SIGTERM, waits `graceMs`, then sends SIGKILL to the ones still alive. It returns the targeted processes, excluding `keep` matches.

- [ ] **Step 1: Write the failing test** `test/proctree.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DEFAULT_KEEP, descendants, parsePs, reap, survivors } from '../src/proctree.js';

const PS = `
  101     1 -zsh
  102   101 claude
  103   102 node /Users/x/.npm/_npx/abc/node_modules/.bin/chrome-devtools-mcp
  104   103 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless
  201     1 -zsh
  202   201 codex
  203   202 /Users/x/.codex/packages/app-server-daemon/releases/0.160.0/bin/codex app-server daemon
  999     1 /sbin/launchd
`;

test('parsePs reads pid, ppid and full command lines', () => {
  const table = parsePs(PS);
  assert.equal(table.size, 8);
  assert.deepEqual(table.get(104), { pid: 104, ppid: 103, command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless' });
});

test('descendants walks the whole tree from the given roots', () => {
  const pids = descendants(parsePs(PS), [101, 404]).map((p) => p.pid).sort();
  assert.deepEqual(pids, [101, 102, 103, 104]);
});

test('survivors ignores reused pids with a different command', () => {
  const before = descendants(parsePs(PS), [101]);
  const after = parsePs('  103   1 node /Users/x/.npm/_npx/abc/node_modules/.bin/chrome-devtools-mcp\n  104   1 unrelated-new-process\n');
  assert.deepEqual(survivors(before, after).map((p) => p.pid), [103]);
});

test('reap keeps allowlisted daemons and escalates to SIGKILL', async () => {
  const signals = [];
  const alive = new Set([103, 203]);
  const kill = (pid, signal) => {
    signals.push([pid, signal]);
    if (signal === 0 && !alive.has(pid)) throw new Error('ESRCH');
    if (signal === 'SIGKILL') alive.delete(pid);
  };
  const targets = descendants(parsePs(PS), [202]).concat([{ pid: 103, command: 'node chrome-devtools-mcp' }]);
  const killed = await reap(targets, { kill, sleep: async () => {}, keep: DEFAULT_KEEP });
  assert.deepEqual(killed.map((p) => p.pid).sort(), [103, 202]);
  assert.ok(!signals.some(([pid]) => pid === 203), 'codex daemon must never be signalled');
  assert.deepEqual(signals.filter(([pid]) => pid === 103), [[103, 'SIGTERM'], [103, 0], [103, 'SIGKILL']]);
});

test('reap really terminates a live process', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 100));
  await reap([{ pid: child.pid, command: 'sleep 30' }], { graceMs: 200 });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(child.pid, 0));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/proctree.test.js`
Expected: FAIL with `Cannot find module '.../src/proctree.js'`.

- [ ] **Step 3: Implement** `src/proctree.js`

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep as realSleep } from './util.js';

const execFileP = promisify(execFile);

export const DEFAULT_KEEP = [/app-server-daemon/, /\bcodex app-server\b/];

export function parsePs(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), command: match[3] });
  }
  return table;
}

export async function readProcessTable() {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 });
  return parsePs(stdout);
}

export function descendants(table, rootPids) {
  const children = new Map();
  for (const proc of table.values()) {
    if (!children.has(proc.ppid)) children.set(proc.ppid, []);
    children.get(proc.ppid).push(proc.pid);
  }
  const out = [];
  const seen = new Set();
  const stack = rootPids.filter((pid) => table.has(pid));
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) continue;
    seen.add(pid);
    out.push({ pid, command: table.get(pid).command });
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

export function survivors(before, afterTable) {
  return before.filter((proc) => afterTable.get(proc.pid)?.command === proc.command);
}

export async function reap(procs, { keep = DEFAULT_KEEP, kill = process.kill.bind(process), sleep = realSleep, graceMs = 1000 } = {}) {
  const targets = procs.filter((proc) => !keep.some((pattern) => pattern.test(proc.command)));
  const isAlive = (pid) => {
    try {
      kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  for (const proc of targets) {
    try { kill(proc.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  await sleep(graceMs);
  for (const proc of targets) {
    if (isAlive(proc.pid)) {
      try { kill(proc.pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  return targets;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/proctree.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/proctree.js test/proctree.test.js
git commit -m "feat: process tree capture and orphan reaping"
```

---

### Task 7: Park orchestration + reconcile

**Files:**
- Create: `src/git-info.js`, `src/park.js`
- Test: `test/park.test.js`

**Interfaces:**
- Consumes:
  - `captureWorkspace` and `leaves` (Task 3)
  - `preflight` (Task 5)
  - `readProcessTable`, `descendants`, `survivors` and `reap` (Task 6)
  - `createStore` (Task 2)
  - a client with `call()` (Task 1)
  - a codex resolver (Task 4)
- Produces:
  - `gitInfo(cwd, run?): Promise<{ branch, dirty_files }|null>`
  - `park({ client, store, workspaceId, force?, codexResolver, deps? }): Promise<{ status:'parked', record, warnings } | { status:'refused', blockers, warnings } | { status:'failed', error, record? }>`. The injectable `deps` are `{ readTable, reapProcs, git, sleep, newId, settleMs }`.
  - `reconcile({ client, store }): Promise<void>`

- [ ] **Step 1: Write the failing test** `test/park.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaves } from '../src/capture.js';
import { gitInfo } from '../src/git-info.js';
import { park, reconcile } from '../src/park.js';
import { parsePs } from '../src/proctree.js';
import { createStore } from '../src/store.js';
import { CLAUDE_REF, CODEX_REF, KEYGEN, LAYOUTS, PROCESS_INFOS, fakeClient, makeSnapshot, parkedRecord } from './fixtures.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hsp-park-'));
const BEFORE = parsePs(`
  101 1 -zsh
  102 101 claude
  103 102 node chrome-devtools-mcp
  201 1 -zsh
  202 201 codex
  203 202 /x/app-server-daemon/bin/codex app-server daemon
  301 1 -zsh
`);
const AFTER = parsePs(`
  103 1 node chrome-devtools-mcp
  203 1 /x/app-server-daemon/bin/codex app-server daemon
`);

function setup({ snapshots = [makeSnapshot()], closeError = null } = {}) {
  let snapshotCalls = 0;
  const client = fakeClient({
    'session.snapshot': () => ({ type: 'session_snapshot', snapshot: snapshots[Math.min(snapshotCalls++, snapshots.length - 1)] }),
    'layout.export': ({ tab_id }) => ({ type: 'layout_export', layout: LAYOUTS[tab_id] }),
    'pane.process_info': ({ pane_id }) => ({ type: 'pane_process_info', process_info: PROCESS_INFOS[pane_id] }),
    'workspace.close': () => { if (closeError) throw closeError; return { type: 'ok' }; },
  });
  let reads = 0;
  const reaped = [];
  const deps = {
    readTable: async () => (reads++ === 0 ? BEFORE : AFTER),
    reapProcs: async (procs) => { reaped.push(...procs); return procs.filter((p) => !/app-server/.test(p.command)); },
    git: async () => ({ branch: 'main', dirty_files: 2 }),
    sleep: async () => {},
    newId: () => 'rec-1',
  };
  return { client, deps, reaped, store: createStore(tmp()) };
}

const verifiedCodex = () => ({ ref: CODEX_REF, method: 'verified' });

test('parks: saves the record, closes the workspace and reaps survivors', async () => {
  const { client, deps, reaped, store } = setup();
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(result.status, 'parked');
  const saved = store.get('rec-1');
  assert.equal(saved.state, 'parked');
  assert.equal(saved.label, 'keygen');
  assert.equal(saved.cwd, KEYGEN);
  assert.equal(saved.tabs.length, 2);
  assert.deepEqual(leaves(saved.tabs[1].root)[0].agent_session, CODEX_REF);
  assert.deepEqual(reaped.map((p) => p.pid).sort(), [103, 203]);
  assert.deepEqual(saved.orphans_killed.map((p) => p.pid), [103]);
  assert.ok(saved.warnings.some((w) => w.includes('2 uncommitted file(s) on main')));
  assert.ok(client.calls.some((c) => c.method === 'workspace.close' && c.params.workspace_id === 'w4'));
});

test('refuses with blockers and leaves the space untouched', async () => {
  const { client, deps, store } = setup();
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: () => ({ ref: null, method: 'unresolved', reason: 'ambiguous' }), deps });
  assert.equal(result.status, 'refused');
  assert.deepEqual(result.blockers, ['w4:p2: codex session unknown (ambiguous)']);
  assert.ok(!client.calls.some((c) => c.method === 'workspace.close'));
  assert.deepEqual(store.list(), []);
});

test('force parks despite blockers and records them as warnings', async () => {
  const { client, deps, store } = setup();
  const result = await park({ client, store, workspaceId: 'w4', force: true, codexResolver: () => ({ ref: null, method: 'unresolved', reason: 'ambiguous' }), deps });
  assert.equal(result.status, 'parked');
  const saved = store.get('rec-1');
  assert.equal(leaves(saved.tabs[1].root)[0].agent_session, null);
  assert.ok(saved.warnings.includes('forced: w4:p2: codex session unknown (ambiguous)'));
});

test('refreshes claude session ids right before closing', async () => {
  const later = makeSnapshot();
  later.panes[0].agent_session = { ...CLAUDE_REF, value: 'aaaaaaaa-0000-0000-0000-000000000000' };
  const { client, deps, store } = setup({ snapshots: [makeSnapshot(), later] });
  await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(leaves(store.get('rec-1').tabs[0].root)[0].agent_session.value, 'aaaaaaaa-0000-0000-0000-000000000000');
});

test('a failed close keeps the record as park_failed', async () => {
  const { client, deps, store } = setup({ closeError: new Error('boom') });
  const result = await park({ client, store, workspaceId: 'w4', codexResolver: verifiedCodex, deps });
  assert.equal(result.status, 'failed');
  assert.equal(store.get('rec-1').state, 'park_failed');
  assert.match(store.get('rec-1').error, /workspace.close failed: boom/);
});

test('an unknown workspace fails without saving anything', async () => {
  const { client, deps, store } = setup();
  const result = await park({ client, store, workspaceId: 'w9', codexResolver: verifiedCodex, deps });
  assert.deepEqual(result, { status: 'failed', error: 'workspace w9 not found' });
  assert.deepEqual(store.list(), []);
});

test('reconcile drops aborted parks and promotes finished ones', async () => {
  const store = createStore(tmp());
  store.save(parkedRecord({ id: 'aborted', state: 'parking', source_workspace_id: 'w4', label: 'keygen' }));
  store.save(parkedRecord({ id: 'done', state: 'park_failed', source_workspace_id: 'w7', label: 'gone' }));
  store.save(parkedRecord({ id: 'retry', state: 'resume_failed' }));
  const client = fakeClient({ 'workspace.list': () => ({ type: 'workspace_list', workspaces: [{ workspace_id: 'w4', label: 'keygen' }] }) });
  await reconcile({ client, store });
  assert.equal(store.get('aborted'), null);
  assert.equal(store.get('done').state, 'parked');
  assert.equal(store.get('retry').state, 'resume_failed');
});

test('gitInfo reports branch and dirty file count, null outside a repo', async () => {
  const repo = tmp();
  execFileSync('git', ['init', '-q', '-b', 'main', repo]);
  writeFileSync(join(repo, 'a.txt'), 'x');
  assert.deepEqual(await gitInfo(repo), { branch: 'main', dirty_files: 1 });
  assert.equal(await gitInfo(tmp()), null);
  assert.equal(await gitInfo(null), null);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/park.test.js`
Expected: FAIL with `Cannot find module '.../src/git-info.js'`.

- [ ] **Step 3: Implement** `src/git-info.js`

```js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export async function gitInfo(cwd, run = execFileP) {
  if (!cwd) return null;
  try {
    // `branch --show-current` also works on a repo with no commits yet; it is empty on a detached HEAD.
    const branch = (await run('git', ['-C', cwd, 'branch', '--show-current'])).stdout.trim() || '(detached)';
    const status = (await run('git', ['-C', cwd, 'status', '--porcelain'])).stdout;
    return { branch, dirty_files: status.split('\n').filter(Boolean).length };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Implement** `src/park.js`

```js
import { randomUUID } from 'node:crypto';
import { captureWorkspace, leaves } from './capture.js';
import { gitInfo } from './git-info.js';
import { preflight } from './preflight.js';
import { descendants, readProcessTable, reap, survivors } from './proctree.js';
import { sleep as realSleep } from './util.js';

export async function park({ client, store, workspaceId, force = false, codexResolver, deps = {} }) {
  const {
    readTable = readProcessTable,
    reapProcs = reap,
    git = gitInfo,
    sleep = realSleep,
    newId = randomUUID,
    settleMs = 1500,
  } = deps;

  const { snapshot } = await client.call('session.snapshot');
  if (!snapshot.workspaces.some((w) => w.workspace_id === workspaceId)) {
    return { status: 'failed', error: `workspace ${workspaceId} not found` };
  }
  const panes = snapshot.panes.filter((p) => p.workspace_id === workspaceId);
  const tabs = snapshot.tabs.filter((t) => t.workspace_id === workspaceId);

  const layouts = {};
  for (const tab of tabs) layouts[tab.tab_id] = (await client.call('layout.export', { tab_id: tab.tab_id })).layout;

  const processInfos = {};
  for (const pane of panes) {
    try {
      processInfos[pane.pane_id] = (await client.call('pane.process_info', { pane_id: pane.pane_id })).process_info;
    } catch {
      processInfos[pane.pane_id] = null;
    }
  }

  const codexResults = {};
  const agentSessions = {};
  for (const pane of panes.filter((p) => p.agent === 'codex')) {
    const result = codexResolver(pane);
    codexResults[pane.pane_id] = result;
    agentSessions[pane.pane_id] = result.ref;
  }

  const captured = captureWorkspace({ snapshot, workspaceId, layouts, processInfos, agentSessions });
  const { blockers, warnings } = preflight({ snapshot, workspaceId, captured, codexResults });
  if (blockers.length > 0 && !force) return { status: 'refused', blockers, warnings };

  const gitState = await git(captured.cwd);
  const allWarnings = [...blockers.map((b) => `forced: ${b}`), ...warnings];
  if (gitState?.dirty_files) allWarnings.push(`${gitState.dirty_files} uncommitted file(s) on ${gitState.branch} (kept on disk)`);

  const record = {
    v: 1,
    id: newId(),
    state: 'parking',
    label: captured.label,
    cwd: captured.cwd,
    source_workspace_id: workspaceId,
    parked_at: new Date().toISOString(),
    git: gitState,
    worktree: captured.worktree,
    tabs: captured.tabs,
    warnings: allWarnings,
    orphans_killed: [],
    error: null,
    resumed_workspace_id: null,
  };
  store.save(record);

  const shellPids = Object.values(processInfos).map((info) => info?.shell_pid).filter(Boolean);
  const tree = descendants(await readTable(), shellPids);

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
    record.state = 'park_failed';
    record.error = `workspace.close failed: ${err.message}`;
    store.save(record);
    return { status: 'failed', error: record.error, record };
  }

  await sleep(settleMs);
  const leftovers = survivors(tree, await readTable());
  record.orphans_killed = (await reapProcs(leftovers, { sleep })).map(({ pid, command }) => ({ pid, command }));
  record.state = 'parked';
  store.save(record);
  return { status: 'parked', record, warnings: record.warnings };
}

export async function reconcile({ client, store }) {
  const { workspaces } = await client.call('workspace.list');
  for (const record of store.list()) {
    if (record.state !== 'parking' && record.state !== 'park_failed') continue;
    const live = workspaces.find((w) => w.workspace_id === record.source_workspace_id);
    if (live && live.label === record.label) {
      store.remove(record.id);
    } else {
      record.state = 'parked';
      store.save(record);
    }
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test test/park.test.js`
Expected: PASS (8 tests).

- [ ] **Step 6: Run the full suite**

Run: `npm test`
Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add src/git-info.js src/park.js test/park.test.js
git commit -m "feat: park orchestration with failure states and reconcile"
```

---

### Task 8: Resume orchestration

**Files:**
- Create: `src/resume.js`
- Test: `test/resume.test.js`

**Interfaces:**
- Consumes: `leaves` and `isShellProcess` (Task 3); store (Task 2); client (Task 1).
- Produces:
  - `resumeArgv(session): string[]|null`
  - `shellQuote(argv: string[]): string`
  - `toApplyNode(node, { fallbackCwd?, cwdExists? }): LayoutNode`. It emits herdr `layout.apply` nodes; a pane cwd that doesn't exist becomes `fallbackCwd`.
  - `waitForShell(client, paneId, { timeoutMs?, sleep?, settleMs? }): Promise<boolean>`
  - `resume({ client, store, id, deps? }): Promise<{ status:'resumed', workspaceId, warnings } | { status:'failed', error, workspaceId?, warnings? }>`. The injectable `deps` are `{ wait, cwdExists }`.

- [ ] **Step 1: Write the failing test** `test/resume.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../src/store.js';
import { resume, resumeArgv, shellQuote, toApplyNode, waitForShell } from '../src/resume.js';
import { CLAUDE_REF, CODEX_REF, KEYGEN, fakeClient, parkedRecord } from './fixtures.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'hsp-resume-'));

function withIds(node, ws, counter) {
  if (node.type === 'split') return { ...node, first: withIds(node.first, ws, counter), second: withIds(node.second, ws, counter) };
  return { ...node, pane_id: `${ws}:p${++counter.n}` };
}

function setup({ liveAgents = [], applyError = null, record = parkedRecord() } = {}) {
  const store = createStore(tmp());
  store.save(record);
  const counter = { n: 0 };
  let tabs = 0;
  const client = fakeClient({
    'agent.list': () => ({ type: 'agent_list', agents: liveAgents }),
    'workspace.create': () => ({ type: 'workspace_created', workspace: { workspace_id: 'w9' }, tab: { tab_id: 'w9:t1' }, root_pane: { pane_id: 'w9:p0' } }),
    'layout.apply': (params) => {
      tabs += 1;
      if (applyError && tabs === 2) throw applyError;
      const tabId = params.tab_id ?? `w9:t${tabs}`;
      return { type: 'layout_apply', layout: { workspace_id: 'w9', tab_id: tabId, zoomed: false, focused_pane_id: 'x', root: withIds(params.root, 'w9', counter) } };
    },
    'pane.send_text': () => ({ type: 'ok' }),
    'tab.focus': () => ({ type: 'ok' }),
  });
  const deps = { wait: async () => true, cwdExists: () => true };
  return { client, store, deps };
}

test('resumeArgv supports claude and codex (without the shared daemon) only', () => {
  assert.deepEqual(resumeArgv(CLAUDE_REF), ['claude', '--resume', CLAUDE_REF.value]);
  assert.deepEqual(resumeArgv(CODEX_REF), ['codex', '--no-daemon', 'resume', CODEX_REF.value]);
  assert.equal(resumeArgv({ ...CLAUDE_REF, kind: 'path' }), null);
  assert.equal(resumeArgv({ source: 'herdr:opencode', agent: 'opencode', kind: 'id', value: 'x' }), null);
  assert.equal(resumeArgv(null), null);
});

test('shellQuote leaves safe words alone and single-quotes the rest', () => {
  assert.equal(shellQuote(['claude', '--resume', '33e27c03-d4b1']), 'claude --resume 33e27c03-d4b1');
  assert.equal(shellQuote(['echo', "it's $HOME; rm -rf /"]), `echo 'it'\\''s $HOME; rm -rf /'`);
});

test('toApplyNode keeps the tree and falls back when a cwd is gone', () => {
  const root = parkedRecord().tabs[1].root;
  const applied = toApplyNode(root, { fallbackCwd: KEYGEN, cwdExists: (p) => p === KEYGEN });
  assert.deepEqual(applied, {
    type: 'split', direction: 'right', ratio: 0.6,
    first: { type: 'pane', cwd: KEYGEN },
    second: { type: 'pane', cwd: KEYGEN, label: 'server' },
  });
});

test('resume recreates tabs, types resume commands, focuses and deletes the record', async () => {
  const { client, store, deps } = setup();
  const result = await resume({ client, store, id: 'rec-1', deps });
  assert.equal(result.status, 'resumed');
  assert.equal(result.workspaceId, 'w9');
  const applies = client.calls.filter((c) => c.method === 'layout.apply');
  assert.equal(applies[0].params.tab_id, 'w9:t1');
  assert.equal(applies[0].params.workspace_id, undefined);
  assert.equal(applies[1].params.workspace_id, 'w9');
  assert.equal(applies[1].params.tab_label, 'review');
  const sent = client.calls.filter((c) => c.method === 'pane.send_text').map((c) => c.params);
  assert.deepEqual(sent, [
    { pane_id: 'w9:p1', text: `claude --resume ${CLAUDE_REF.value}\r` },
    { pane_id: 'w9:p2', text: `codex --no-daemon resume ${CODEX_REF.value}\r` },
  ]);
  assert.deepEqual(client.calls.find((c) => c.method === 'tab.focus').params, { tab_id: 'w9:t2' });
  assert.ok(result.warnings.some((w) => w.includes('"npm run dev" was running')));
  assert.equal(store.get('rec-1'), null);
});

test('a session already open elsewhere is not resumed twice', async () => {
  const { client, store, deps } = setup({ liveAgents: [{ pane_id: 'w1:p1', agent_session: CLAUDE_REF }] });
  const result = await resume({ client, store, id: 'rec-1', deps });
  const sent = client.calls.filter((c) => c.method === 'pane.send_text');
  assert.equal(sent.length, 1);
  assert.match(sent[0].params.text, /^codex /);
  assert.ok(result.warnings.some((w) => w.includes('already open')));
});

test('a missing project directory fails before creating anything', async () => {
  const { client, store } = setup();
  const result = await resume({ client, store, id: 'rec-1', deps: { wait: async () => true, cwdExists: () => false } });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /directory no longer exists/);
  assert.ok(!client.calls.some((c) => c.method === 'workspace.create'));
  assert.equal(store.get('rec-1').state, 'parked');
});

test('a mid-way failure keeps the record as resume_failed with the partial workspace', async () => {
  const { client, store, deps } = setup({ applyError: new Error('invalid_layout') });
  const result = await resume({ client, store, id: 'rec-1', deps });
  assert.equal(result.status, 'failed');
  const saved = store.get('rec-1');
  assert.equal(saved.state, 'resume_failed');
  assert.equal(saved.resumed_workspace_id, 'w9');
  assert.match(saved.error, /invalid_layout/);
});

test('unknown or busy records are rejected', async () => {
  const { client, store, deps } = setup({ record: parkedRecord({ state: 'resuming' }) });
  assert.match((await resume({ client, store, id: 'rec-1', deps })).error, /space is resuming/);
  assert.match((await resume({ client, store, id: 'nope', deps })).error, /no parked space nope/);
});

test('waitForShell returns true once a shell is in the foreground', async () => {
  const states = [null, { shell_pid: 1, foreground_processes: [{ name: 'node' }] }, { shell_pid: 1, foreground_processes: [{ name: '-zsh' }] }];
  let i = 0;
  const client = fakeClient({ 'pane.process_info': () => ({ type: 'pane_process_info', process_info: states[Math.min(i++, 2)] }) });
  assert.equal(await waitForShell(client, 'w9:p1', { sleep: async () => {} }), true);
});

test('waitForShell gives up after the timeout', async () => {
  const client = fakeClient({ 'pane.process_info': () => ({ type: 'pane_process_info', process_info: { shell_pid: null, foreground_processes: [] } }) });
  assert.equal(await waitForShell(client, 'w9:p1', { timeoutMs: 50, settleMs: 0 }), false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test test/resume.test.js`
Expected: FAIL with `Cannot find module '.../src/resume.js'`.

- [ ] **Step 3: Implement** `src/resume.js`

```js
import { existsSync } from 'node:fs';
import { isShellProcess, leaves } from './capture.js';
import { sleep as realSleep } from './util.js';

export function resumeArgv(session) {
  if (!session || session.kind !== 'id') return null;
  if (session.source === 'herdr:claude' && session.agent === 'claude') return ['claude', '--resume', session.value];
  // --no-daemon: Codex's shared app-server daemon breaks per-pane session reporting (herdr#4649).
  if (session.source === 'herdr:codex' && session.agent === 'codex') return ['codex', '--no-daemon', 'resume', session.value];
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

export async function resume({ client, store, id, deps = {} }) {
  const { wait = waitForShell, cwdExists = existsSync } = deps;
  const record = store.get(id);
  if (!record) return { status: 'failed', error: `no parked space ${id}` };
  if (record.state !== 'parked' && record.state !== 'resume_failed') return { status: 'failed', error: `space is ${record.state}` };
  if (!record.cwd || !cwdExists(record.cwd)) return { status: 'failed', error: `directory no longer exists: ${record.cwd}` };

  const { agents } = await client.call('agent.list');
  const liveSessions = new Set(agents.map((a) => a.agent_session?.value).filter(Boolean));
  const warnings = [];
  record.state = 'resuming';
  store.save(record);

  let workspaceId = null;
  try {
    const created = await client.call('workspace.create', { cwd: record.cwd, label: record.label, focus: true });
    workspaceId = created.workspace.workspace_id;
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
        if (liveSessions.has(leaf.agent_session.value)) {
          warnings.push(`${leaf.agent} session ${leaf.agent_session.value} is already open elsewhere; not resumed`);
          continue;
        }
        const paneId = fresh[i]?.pane_id;
        if (!paneId) {
          warnings.push(`could not find the new pane for ${leaf.agent} in tab "${tab.label}"`);
          continue;
        }
        await wait(client, paneId);
        await client.call('pane.send_text', { pane_id: paneId, text: `${shellQuote(argv)}\r` });
      }
    }

    if (focusTabId) await client.call('tab.focus', { tab_id: focusTabId });
  } catch (err) {
    record.state = 'resume_failed';
    record.error = err.message;
    record.resumed_workspace_id = workspaceId;
    store.save(record);
    return { status: 'failed', error: err.message, workspaceId, warnings };
  }

  store.remove(record.id);
  return { status: 'resumed', workspaceId, warnings };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --test test/resume.test.js`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add src/resume.js test/resume.test.js
git commit -m "feat: resume parked spaces with native claude/codex sessions"
```

---

### Task 9: CLI, picker and manifest

**Files:**
- Create: `src/picker.js`, `src/cli.js`, `herdr-plugin.toml`
- Test: `test/picker.test.js`, `test/cli.test.js`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - `formatList(records, now?): string`
  - `runPicker({ client, store, input?, output?, resumeFn? }): Promise<number>`
  - `summary(record): { id, label, cwd, state, parked_at, tabs }`
  - `main(argv: string[], env?: object): Promise<number>`. Commands: `park [ws]`, `park-force [ws]`, `resume <id>`, `list`, `open-picker`, `picker`.

- [ ] **Step 1: Write the failing tests**

`test/picker.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatList, runPicker } from '../src/picker.js';
import { createStore } from '../src/store.js';
import { parkedRecord } from './fixtures.js';

test('formatList shows label, age, state and cwd', () => {
  const now = Date.parse('2026-10-02T13:00:00.000Z');
  const text = formatList([parkedRecord(), parkedRecord({ id: 'b', label: 'chat-api', state: 'resume_failed', parked_at: '2026-09-29T13:00:00.000Z' })], now);
  assert.match(text, / 1\. keygen  3h ago\n {4}\/work\/keygen/);
  assert.match(text, / 2\. chat-api  3d ago  \[resume_failed\]/);
  assert.equal(formatList([], now), 'No parked spaces.');
});

test('runPicker resumes the chosen record', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-pick-')));
  store.save(parkedRecord());
  const input = new PassThrough();
  const output = new PassThrough();
  const chosen = [];
  const done = runPicker({ client: {}, store, input, output, resumeFn: async ({ id }) => { chosen.push(id); return { status: 'resumed', warnings: [] }; } });
  input.write('1\n');
  assert.equal(await done, 0);
  assert.deepEqual(chosen, ['rec-1']);
});

test('runPicker does nothing on an empty answer', async () => {
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-pick-')));
  store.save(parkedRecord());
  const input = new PassThrough();
  const done = runPicker({ client: {}, store, input, output: new PassThrough(), resumeFn: async () => assert.fail('must not resume') });
  input.write('\n');
  assert.equal(await done, 0);
});
```

`test/cli.test.js`:
```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summary } from '../src/cli.js';
import { parkedRecord } from './fixtures.js';

test('summary exposes the listing fields', () => {
  assert.deepEqual(summary(parkedRecord()), {
    id: 'rec-1', label: 'keygen', cwd: '/work/keygen', state: 'parked', parked_at: '2026-10-02T10:00:00.000Z', tabs: 2,
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/picker.test.js test/cli.test.js`
Expected: FAIL with `Cannot find module '.../src/picker.js'`.

- [ ] **Step 3: Implement** `src/picker.js`

```js
import readline from 'node:readline/promises';
import { resume } from './resume.js';

function ago(iso, now) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 2880) return `${Math.round(minutes / 60)}h ago`;
  return `${Math.round(minutes / 1440)}d ago`;
}

export function formatList(records, now = Date.now()) {
  if (records.length === 0) return 'No parked spaces.';
  return records
    .map((r, i) => `${String(i + 1).padStart(2)}. ${r.label}  ${ago(r.parked_at, now)}${r.state === 'parked' ? '' : `  [${r.state}]`}\n    ${r.cwd}`)
    .join('\n');
}

export async function runPicker({ client, store, input = process.stdin, output = process.stdout, resumeFn = resume }) {
  const records = store.list().filter((r) => r.state === 'parked' || r.state === 'resume_failed');
  const rl = readline.createInterface({ input, output, terminal: false });
  try {
    output.write(`Parked spaces\n\n${formatList(records)}\n\n`);
    if (records.length === 0) {
      await rl.question('Press Enter to close');
      return 0;
    }
    const answer = (await rl.question('Number to resume (Enter to cancel): ')).trim();
    const record = records[Number(answer) - 1];
    if (!answer || !record) return 0;
    output.write(`Resuming ${record.label}...\n`);
    const result = await resumeFn({ client, store, id: record.id });
    if (result.status === 'resumed') {
      if (result.warnings.length > 0) {
        output.write(`${result.warnings.join('\n')}\n`);
        await rl.question('Press Enter to close');
      }
      return 0;
    }
    output.write(`Resume failed: ${result.error}\n`);
    await rl.question('Press Enter to close');
    return 1;
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 4: Implement** `src/cli.js`

```js
#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCodexResolver } from './codex-sessions.js';
import { createClient } from './herdr-client.js';
import { park, reconcile } from './park.js';
import { runPicker } from './picker.js';
import { resume } from './resume.js';
import { createStore } from './store.js';

function pluginContext(env) {
  try {
    return JSON.parse(env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  } catch {
    return {};
  }
}

async function notify(client, title, body) {
  try {
    await client.call('notification.show', { title, body });
  } catch {
    // notifications are best effort
  }
}

export function summary(record) {
  return { id: record.id, label: record.label, cwd: record.cwd, state: record.state, parked_at: record.parked_at, tabs: record.tabs.length };
}

export async function main(argv, env = process.env) {
  const [command, arg] = argv;
  const client = createClient({ socketPath: env.HERDR_SOCKET_PATH, timeoutMs: 10000 });
  const store = createStore(env.HERDR_PLUGIN_STATE_DIR);

  switch (command) {
    case 'park':
    case 'park-force': {
      const workspaceId = arg || pluginContext(env).workspace_id || env.HERDR_WORKSPACE_ID;
      if (!workspaceId) throw new Error('no workspace in the plugin context');
      const result = await park({ client, store, workspaceId, force: command === 'park-force', codexResolver: createCodexResolver() });
      if (result.status === 'parked') {
        const killed = result.record.orphans_killed.length;
        const lines = [...result.warnings, killed > 0 ? `${killed} leftover process(es) stopped` : null].filter(Boolean);
        console.log(JSON.stringify({ status: 'parked', id: result.record.id, warnings: result.warnings }));
        await notify(client, `Parked ${result.record.label}`, lines.join('\n') || 'All processes released.');
        return 0;
      }
      console.log(JSON.stringify(result));
      if (result.status === 'refused') await notify(client, 'Space not parked', [...result.blockers, 'Use "Park space (force)" to park anyway.'].join('\n'));
      else await notify(client, 'Park failed', result.error);
      return 1;
    }
    case 'resume': {
      await reconcile({ client, store });
      const result = await resume({ client, store, id: arg });
      console.log(JSON.stringify(result));
      if (result.status !== 'resumed') await notify(client, 'Resume failed', result.error);
      else if (result.warnings.length > 0) await notify(client, 'Resumed with warnings', result.warnings.join('\n'));
      return result.status === 'resumed' ? 0 : 1;
    }
    case 'list': {
      await reconcile({ client, store });
      console.log(JSON.stringify(store.list().map(summary), null, 2));
      return 0;
    }
    case 'open-picker': {
      await client.call('plugin.pane.open', { plugin_id: env.HERDR_PLUGIN_ID, entrypoint: 'picker' });
      return 0;
    }
    case 'picker': {
      await reconcile({ client, store });
      return runPicker({ client, store });
    }
    default:
      console.error(`unknown command: ${command ?? '(none)'}; expected park | park-force | resume <id> | list | open-picker | picker`);
      return 2;
  }
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err.stack || String(err));
      process.exit(1);
    },
  );
}
```

- [ ] **Step 5: Create** `herdr-plugin.toml`

```toml
id = "herdr-space-parking"
name = "herdr-space-parking"
version = "0.1.0"
min_herdr_version = "0.9.0"
description = "Park spaces to release their agents and processes; resume them later with native Claude Code / Codex sessions."
platforms = ["macos", "linux"]

[[actions]]
id = "park"
title = "Park space"
description = "Snapshot the focused space, stop all of its processes and close it"
contexts = ["workspace"]
command = ["sh", "-c", "exec node \"$HERDR_PLUGIN_ROOT/src/cli.js\" park"]

[[actions]]
id = "park-force"
title = "Park space (force)"
description = "Park even if agents are working, commands are running or a Codex session is unknown"
contexts = ["workspace"]
command = ["sh", "-c", "exec node \"$HERDR_PLUGIN_ROOT/src/cli.js\" park-force"]

[[actions]]
id = "resume"
title = "Resume parked space"
description = "Pick a parked space and resume it"
contexts = ["global"]
command = ["sh", "-c", "exec node \"$HERDR_PLUGIN_ROOT/src/cli.js\" open-picker"]

[[actions]]
id = "list"
title = "List parked spaces"
description = "Print parked spaces as JSON"
contexts = ["global"]
command = ["sh", "-c", "exec node \"$HERDR_PLUGIN_ROOT/src/cli.js\" list"]

[[panes]]
id = "picker"
title = "Parked spaces"
placement = "popup"
width = "70%"
height = "60%"
command = ["sh", "-c", "exec node \"$HERDR_PLUGIN_ROOT/src/cli.js\" picker"]
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test`
Expected: all tests PASS (the integration test does not exist yet).

- [ ] **Step 7: Check that herdr accepts the manifest**

Run: `herdr plugin link "$PWD" && herdr plugin action list | grep herdr-space-parking`
Expected: four actions listed: `herdr-space-parking.park`, `.park-force`, `.resume`, `.list`. If `link` reports a manifest error, fix the field it names and re-run.

- [ ] **Step 8: Commit**

```bash
git add src/picker.js src/cli.js herdr-plugin.toml test/picker.test.js test/cli.test.js
git commit -m "feat: cli entrypoint, resume picker popup and plugin manifest"
```

---

### Task 10: Integration test, smoke test and README

**Files:**
- Create: `test/integration/park-resume.test.js`, `README.md`

**Interfaces:**
- Consumes: `createClient`, `createStore`, `park`, `resume`, `readProcessTable`.
- Produces: proof that a parked Space releases even processes that escaped the pane's POSIX session.

- [ ] **Step 1: Find how an isolated herdr server is started and where its socket lives**

Run:
```bash
export HSP_CFG=$(mktemp -d) && XDG_CONFIG_HOME=$HSP_CFG herdr server & sleep 2; find "$HSP_CFG" -name '*.sock'; XDG_CONFIG_HOME=$HSP_CFG herdr server stop
```
Expected: a socket such as `$HSP_CFG/herdr/herdr.sock`, and no change to your real `~/.config/herdr` session.

If `herdr server` with no subcommand does not start a headless server, try `XDG_CONFIG_HOME=$HSP_CFG herdr --session hsp-it server` and `herdr session stop hsp-it`. Then use the command that worked and the socket path printed by `find` in `startServer()` below. If `XDG_CONFIG_HOME` is not honoured, the socket shows up under `~/.config/herdr/`; in that case use `--session hsp-it` so your default session is never touched.

- [ ] **Step 2: Write the integration test** `test/integration/park-resume.test.js`

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '../../src/herdr-client.js';
import { park } from '../../src/park.js';
import { readProcessTable } from '../../src/proctree.js';
import { resume } from '../../src/resume.js';
import { createStore } from '../../src/store.js';
import { sleep } from '../../src/util.js';

const enabled = process.env.HSP_INTEGRATION === '1';

async function startServer() {
  const configHome = mkdtempSync(join(tmpdir(), 'hsp-it-cfg-'));
  const socketPath = join(configHome, 'herdr', 'herdr.sock'); // adjust to what Step 1 printed
  const server = spawn('herdr', ['server'], { env: { ...process.env, XDG_CONFIG_HOME: configHome }, stdio: 'ignore', detached: true });
  for (let i = 0; i < 100 && !existsSync(socketPath); i++) await sleep(100);
  assert.ok(existsSync(socketPath), `herdr socket not found at ${socketPath}`);
  return {
    socketPath,
    async stop(client) {
      try { await client.call('server.stop'); } catch { /* already stopping */ }
      try { process.kill(-server.pid, 'SIGKILL'); } catch { /* gone */ }
      rmSync(configHome, { recursive: true, force: true });
    },
  };
}

const running = (table, needle) => [...table.values()].some((p) => p.command.includes(needle));

test('park releases background and setsid processes; resume restores the layout', { skip: !enabled }, async () => {
  const server = await startServer();
  const client = createClient({ socketPath: server.socketPath, timeoutMs: 10000 });
  const project = mkdtempSync(join(tmpdir(), 'hsp-it-proj-'));
  const store = createStore(mkdtempSync(join(tmpdir(), 'hsp-it-state-')));
  const tag = `hsp${process.pid}`;
  try {
    const created = await client.call('workspace.create', { cwd: project, label: 'it-space', focus: true });
    const workspaceId = created.workspace.workspace_id;
    const { layout } = await client.call('layout.apply', {
      tab_id: created.tab.tab_id,
      root: { type: 'split', direction: 'right', ratio: 0.5, first: { type: 'pane', cwd: project }, second: { type: 'pane', cwd: project, label: 'side' } },
    });
    const paneId = layout.root.first.pane_id;
    await sleep(1500);
    await client.call('pane.send_text', {
      pane_id: paneId,
      text: `sleep 1001 & python3 -c "import os,time; os.setsid(); time.sleep(1002)  # ${tag}" &\r`,
    });
    await sleep(1500);
    let table = await readProcessTable();
    assert.ok(running(table, 'sleep 1001'), 'background job should be running');
    assert.ok(running(table, tag), 'setsid process should be running');

    const parked = await park({ client, store, workspaceId, codexResolver: () => ({ ref: null, method: 'unresolved', reason: 'n/a' }) });
    assert.equal(parked.status, 'parked', JSON.stringify(parked));
    const { workspaces } = await client.call('workspace.list');
    assert.ok(!workspaces.some((w) => w.workspace_id === workspaceId), 'workspace must be closed');
    table = await readProcessTable();
    assert.ok(!running(table, 'sleep 1001'), 'background job must be gone');
    assert.ok(!running(table, tag), 'setsid process must be gone');
    assert.ok(parked.record.orphans_killed.some((p) => p.command.includes(tag)), 'the setsid process is reaped by the plugin');

    const resumed = await resume({ client, store, id: parked.record.id });
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
```

- [ ] **Step 3: Run the integration test**

Run: `npm run test:integration`
Expected: PASS (1 test). If it fails at `herdr socket not found`, apply Step 1's finding to `startServer()`. If it fails on an assertion, the message says which resource was not released; fix the code, not the assertion.

- [ ] **Step 4: Confirm the unit suite skips it**

Run: `npm test`
Expected: all unit tests PASS and the integration test is reported as skipped.

- [ ] **Step 5: Write** `README.md`

````markdown
# herdr-space-parking

Park herdr Spaces you aren't using. Parking stops every process in the Space and closes it: shells, Claude Code, Codex and their MCP servers. Resume it later with the same tabs, splits and Claude Code / Codex conversations.

## Install

```sh
herdr plugin link /path/to/herdr-space-parking
```

Requires herdr ≥ 0.9.0 and Node ≥ 18 on the herdr server's `PATH`. macOS and Linux.

## Keybindings

Add to `~/.config/herdr/config.toml`, choosing keys that are free in your setup:

```toml
[[keys.command]]
key = "prefix+p"
type = "plugin_action"
command = "herdr-space-parking.park"
description = "park space"

[[keys.command]]
key = "prefix+r"
type = "plugin_action"
command = "herdr-space-parking.resume"
description = "resume parked space"
```

`herdr-space-parking.park-force` parks even when the Space has blockers. The CLI forms are `herdr plugin action invoke herdr-space-parking.park` and `herdr plugin action invoke herdr-space-parking.list`.

## What parking does

1. Saves tabs, splits, cwds, labels and agent session ids to `$HERDR_PLUGIN_STATE_DIR/parked/<id>.json`.
2. Refuses if an agent is working or waiting, a command such as a dev server is running, a Claude/Codex session id is unknown, or the Space has linked worktree Spaces. Use force to park anyway.
3. Closes the Space. Herdr stops each pane's processes. The plugin then stops leftovers that escaped the pane, such as MCP servers, browsers and background tasks. It never stops the shared Codex daemon.

Uncommitted changes stay on disk; parking only reports how many files are dirty.

## What resuming does

It recreates the Space in its directory, rebuilds the tabs and splits, and runs `claude --resume <id>` / `codex --no-daemon resume <id>` in the right panes. Dev servers are not restarted.

## Codex note

Codex ≥ 0.157 reports sessions through a shared daemon, so herdr can miss or misattribute Codex session ids (herdr#4649). The plugin double-checks every Codex id against `~/.codex` before trusting it. If an id is missing, it infers the session from the pane title. If it can't be sure, it asks you to force-park, and that pane then restores as a plain shell. Resumed Codex sessions run with `--no-daemon`, so they report correctly from then on.

## Manual smoke test

1. Open a Space with a Claude pane, send a message, and note the conversation.
2. Note the Claude PID: `herdr pane process-info <pane>` (or `ps`).
3. Park the Space. `ps -p <pid>` should print nothing.
4. Resume it from the picker. Claude should open the same conversation.
5. Repeat with a Codex pane that has a named thread (send at least one prompt first).
````

- [ ] **Step 6: Run the manual smoke test from the README**

Follow "Manual smoke test" in your real herdr. Expected: the Claude conversation comes back after resume, the old PID is gone after park, and `herdr plugin action invoke herdr-space-parking.list` shows `[]` after resuming.

- [ ] **Step 7: Commit**

```bash
git add test/integration/park-resume.test.js README.md
git commit -m "test: integration proof that parked spaces release processes; docs"
```

---

## Amendments after Codex review (2026-10-02, debate `herdr-space-parking-plan-review`)

These amendments override the task code above wherever they conflict. Each amended task keeps its TDD cycle: add the listed tests first.

**A1 — Process identity (Task 6).**
- `parsePs` reads `ps -axo pid=,ppid=,lstart=,command=`. `lstart` is 5 tokens.
- Identity is `{pid, start, command}`. `survivors()` matches all three.
- `reap()` re-reads the table right before SIGTERM and again before SIGKILL, and signals only identity-matching entries. After a final short wait it returns `{ killed, stillAlive }`.
- Accepted residual risk: `lstart` has 1-second precision. A pid reused by an identical command that started in the same second could be mis-identified anywhere between the pre-close capture and the last signal (≈ 2.5 s + ps→kill gaps).

**A2 — Inspection is mandatory (Task 7).** If `pane.process_info` fails, or a pane has no `shell_pid`, park returns `failed`. Force cannot bypass this.

**A3 — Durable cleanup (Task 7).**
- Before `workspace.close`, the record stores `shells` (the identities of the pane shells) and `pending_reap` (the identities of every descendant).
- After reaping:
  - if every process is gone: `pending_reap = []` and `state = parked`;
  - otherwise: `pending_reap = survivors` and `state = cleanup_failed`.
- `reconcile()` handles `parking` / `park_failed` / `cleanup_failed` records:
  - **Aborted:** remove the record only if a workspace with `source_workspace_id` exists **and** one of its current panes reports, via `pane.process_info`, a `shell_pid` whose full identity matches a saved shell.
  - **Otherwise:** reap `pending_reap`, then set `parked` or `cleanup_failed`.
- `resume()` re-reaps `pending_reap` first, and refuses while any identity-matching process is still alive.

**A4 — Resume retry (Task 8).** A `resume_failed` record whose `resumed_workspace_id` exists in `workspace.list` (id match alone) is refused with "close the partially resumed space first".

**A5 — Strict Codex resolution (Task 4).**
- An id is accepted only when the title-derived thread name maps to exactly one thread whose rollout cwd equals the pane cwd.
- `method` is `verified` when that id equals herdr's reported id, and `inferred` otherwise.
- A reported id without title confirmation is `unresolved`.
- In park, if two Codex panes resolve to the same id, both become unresolved.

**A6 — Occupancy and lock (Task 8).**
- Occupancy is made of:
  - Claude ids from `agent.list`;
  - Codex ids from running the strict resolver over every live Codex pane in `session.snapshot`;
  - ids sent during the current run.
- A Codex leaf is skipped (with a warning) if any live Codex pane in the same cwd is unresolved.
- Resume holds `$STATE_DIR/resume.lock`, created with `wx` and holding `{pid, start}`. It is reclaimed only when that owner identity is gone.
- Warnings say "open in a herdr pane".

**A7 — Record validation (Task 2).** `list()` / `get()` return only records with `v === 1`, `id` equal to the filename stem, a known `state`, and an array `tabs`. Anything else is ignored and never modified. Known states: `parking`, `parked`, `park_failed`, `cleanup_failed`, `resuming`, `resume_failed`.

**A8 — Stable cwd (Task 7).** `record.cwd` is `git -C <firstLeafCwd> rev-parse --show-toplevel`, falling back to `firstLeafCwd`. A test deletes the first pane's subdirectory and resumes successfully.

**A9 — Worktree scope (Task 5).** Any workspace with `worktree` membership is refused ("worktree spaces are not supported yet"). Force cannot bypass this. This is a v1 non-goal.

**A10 — Integration test (Task 10).**
- The escaped process is created by a Python parent that stays alive and forks a child that calls `setsid()`.
- The test asserts that the child's session differs from the shell's before parking.
- Documented limitation: processes reparented to init/launchd **before** park cannot be attributed and are not reaped.
