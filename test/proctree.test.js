import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DEFAULT_KEEP, descendants, parsePs, readProcessTable, reap, survivors } from '../src/proctree.js';
import { sleep } from '../src/util.js';

const T = 'Thu Oct  1 17:55:08 2026';
const PS = `
  101     1 ${T} -zsh
  102   101 ${T} claude
  103   102 Thu Oct  1 17:56:00 2026 node /Users/x/.npm/_npx/abc/node_modules/.bin/chrome-devtools-mcp
  104   103 ${T} /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless
  201     1 ${T} -zsh
  202   201 ${T} codex
  203   202 ${T} /Users/x/.codex/packages/app-server-daemon/releases/0.160.0/bin/codex app-server daemon
  999     1 ${T} /sbin/launchd
`;

test('parsePs reads pid, ppid, start time and full command lines', () => {
  const table = parsePs(PS);
  assert.equal(table.size, 8);
  assert.deepEqual(table.get(104), { pid: 104, ppid: 103, start: 'Thu Oct 1 17:55:08 2026', command: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless' });
});

test('descendants walks the whole tree from the given roots with identities', () => {
  const procs = descendants(parsePs(PS), [101, 404]);
  assert.deepEqual(procs.map((p) => p.pid).sort(), [101, 102, 103, 104]);
  assert.deepEqual(procs.find((p) => p.pid === 103), { pid: 103, start: 'Thu Oct 1 17:56:00 2026', command: 'node /Users/x/.npm/_npx/abc/node_modules/.bin/chrome-devtools-mcp' });
});

test('survivors requires pid, start time and command to all match', () => {
  const before = descendants(parsePs(PS), [101]);
  const after = parsePs([
    `  103   1 Thu Oct  1 17:56:00 2026 node /Users/x/.npm/_npx/abc/node_modules/.bin/chrome-devtools-mcp`,
    `  104   1 Thu Oct  2 09:00:00 2026 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless`,
    `  102   1 ${T} unrelated`,
  ].join('\n'));
  assert.deepEqual(survivors(before, after).map((p) => p.pid), [103]);
});

function fakeWorld(initial) {
  const table = new Map(initial.map((p) => [p.pid, { ...p, ppid: 1 }]));
  const signals = [];
  const behaviour = new Map();
  return {
    signals,
    behaviour,
    table,
    readTable: async () => new Map(table),
    kill: (pid, signal) => {
      signals.push([pid, signal]);
      const onSignal = behaviour.get(pid)?.[signal];
      if (onSignal === 'die') table.delete(pid);
    },
  };
}

test('reap keeps allowlisted daemons, escalates only when needed and reports leftovers', async () => {
  const procs = [
    { pid: 10, start: T, command: 'node mcp-dies-on-term' },
    { pid: 11, start: T, command: 'node mcp-needs-kill' },
    { pid: 12, start: T, command: 'zombie-like survivor' },
    { pid: 13, start: T, command: '/x/app-server-daemon/bin/codex app-server daemon' },
  ];
  const world = fakeWorld(procs);
  world.behaviour.set(10, { SIGTERM: 'die' });
  world.behaviour.set(11, { SIGKILL: 'die' });
  const result = await reap(procs, { keep: DEFAULT_KEEP, kill: world.kill, readTable: world.readTable, sleep: async () => {} });
  assert.deepEqual(result.killed.map((p) => p.pid), [10, 11]);
  assert.deepEqual(result.stillAlive.map((p) => p.pid), [12]);
  assert.deepEqual(world.signals, [[10, 'SIGTERM'], [11, 'SIGTERM'], [12, 'SIGTERM'], [11, 'SIGKILL'], [12, 'SIGKILL']]);
});

test('reap never signals a pid whose identity changed (pid reuse)', async () => {
  const world = fakeWorld([{ pid: 20, start: 'Fri Oct  2 10:00:00 2026', command: 'someone else' }]);
  const result = await reap([{ pid: 20, start: T, command: 'node old-mcp' }], { kill: world.kill, readTable: world.readTable, sleep: async () => {} });
  assert.deepEqual(world.signals, []);
  assert.deepEqual(result, { killed: [], stillAlive: [] });
});

test('reap really terminates a live process', async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  await sleep(200);
  const identity = (await readProcessTable()).get(child.pid);
  assert.ok(identity, 'spawned process should be in the table');
  const result = await reap([identity], { graceMs: 200 });
  assert.deepEqual(result.killed.map((p) => p.pid), [child.pid]);
  assert.throws(() => process.kill(child.pid, 0));
});

test('reap returns at once when nothing is left to stop', async () => {
  const sleeps = [];
  const world = fakeWorld([]);
  const result = await reap([{ pid: 30, start: T, command: 'gone' }], { kill: world.kill, readTable: world.readTable, sleep: async (ms) => sleeps.push(ms) });
  assert.deepEqual(result, { killed: [], stillAlive: [] });
  assert.deepEqual(sleeps, []);
});
