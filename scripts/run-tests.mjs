// Runs node's test runner with a private TMPDIR and removes it afterwards, so the many temp
// folders the tests create never pile up in the system temp directory.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Short prefix: the integration test puts a herdr socket under it, and socket paths are limited.
const dir = mkdtempSync(join(tmpdir(), 'hspt-'));
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: { ...process.env, TMPDIR: dir },
});
rmSync(dir, { recursive: true, force: true });
process.exit(result.status ?? 1);
