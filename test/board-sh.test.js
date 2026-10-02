import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BOARD = new URL('../bin/board.sh', import.meta.url).pathname;

// A stand-in for `node src/cli.js` that logs its arguments and serves a fixed list.
function fakeCli(rows) {
  const dir = mkdtempSync(join(tmpdir(), 'hsp-sh-'));
  const log = join(dir, 'calls.log');
  const cli = join(dir, 'cli.sh');
  writeFileSync(cli, `#!/bin/sh\necho "$*" >> "${log}"\nif [ "$1" = board-list ]; then printf '%s' '${rows.join('\n')}'; fi\nif [ "$1" = resume ] && [ "$2" = bad ]; then echo '{"status":"failed","error":"directory no longer exists: /x"}'; exit 1; fi\n`);
  chmodSync(cli, 0o755);
  mkdirSync(join(dir, 'parked'));
  return { cli, log, stateDir: dir };
}

function run(args, input, cli) {
  // LINES pins the height the board would read from the terminal.
  const result = spawnSync('bash', [BOARD, ...args], {
    input,
    env: { ...process.env, HSP_CLI: cli.cli, HERDR_PLUGIN_STATE_DIR: cli.stateDir, LINES: '24' },
    encoding: 'utf8',
    timeout: 10000,
  });
  let calls = [];
  try { calls = readFileSync(cli.log, 'utf8').trim().split('\n'); } catch { /* no calls */ }
  return { ...result, calls };
}

const S = '\u001f';
const ROWS = [['rec-1', 'keygen', '3h ago', '', '/work/keygen', '2 tabs · claude, codex'].join(S), ['rec-2', 'sizer', '3d ago', 'cleanup_failed', '/work/sizer', '1 tab'].join(S)];

test('the idle board shows a compact list and how to open the browser', () => {
  const out = run([], '', fakeCli(ROWS));
  assert.equal(out.status, 0);
  assert.match(out.stdout, /Parked spaces \(2\)/);
  assert.match(out.stdout, /keygen +3h ago +2 tabs · claude, codex/);
  assert.match(out.stdout, /sizer +3d ago +1 tab +\[cleanup_failed\]/);
  assert.match(out.stdout, /Press any key to browse, search, resume or delete/);
});

test('any key opens the interactive browser', () => {
  const out = run([], 'x', fakeCli(ROWS));
  assert.ok(out.calls.includes('tui'), out.calls.join('|'));
});

test('a long list is cut to the terminal height with a count of the rest', () => {
  const rows = Array.from({ length: 60 }, (_, i) => [`r${i}`, `space-${i}`, '1h ago', '', '/w', '1 tab'].join(S));
  const out = run([], '', fakeCli(rows));
  assert.match(out.stdout, /… and \d+ more/);
  assert.doesNotMatch(out.stdout, /space-59/);
});

test('shows an empty state and the board loop ends when its input closes', () => {
  const out = run([], '', fakeCli([]));
  assert.equal(out.status, 0);
  assert.match(out.stdout, /No parked spaces/);
});

test('the board keeps running on a real terminal after its refresh timeout (bash 3.2 returns 1 on timeout)', async () => {
  const { spawn } = await import('node:child_process');
  const { existsSync } = await import('node:fs');
  const cli = fakeCli(ROWS);
  const marker = join(cli.stateDir, 'board-exited');
  const inner = `bash ${BOARD}; touch ${marker}`;
  // `script` needs a real pipe on stdin (node's 'pipe' is a socket), so feed it from `sleep`.
  const pty = process.platform === 'darwin' ? `script -q /dev/null bash -c '${inner}'` : `script -qc '${inner}' /dev/null`;
  const child = spawn('sh', ['-c', `sleep 30 | ${pty}`], {
    env: { ...process.env, HSP_CLI: cli.cli, HERDR_PLUGIN_STATE_DIR: cli.stateDir },
    stdio: 'ignore',
    detached: true,
  });
  await new Promise((resolve) => setTimeout(resolve, 4500));
  const exitedEarly = existsSync(marker);
  process.kill(-child.pid, 'SIGKILL');
  assert.equal(exitedEarly, false, 'board exited after its first 3 s refresh timeout');
});
