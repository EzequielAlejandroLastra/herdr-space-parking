import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readProcessTable } from './proctree.js';

// Cross-process mutex. The lock file names its owner by (pid, start time); it is reclaimed only
// when that exact process is gone, never because of its age.
export async function withLock(path, fn, { readTable = readProcessTable } = {}) {
  const table = await readTable();
  const self = { pid: process.pid, start: table.get(process.pid)?.start ?? null };

  const tryCreate = () => {
    try {
      writeFileSync(path, JSON.stringify(self), { flag: 'wx' });
      return true;
    } catch (err) {
      if (err.code === 'EEXIST') return false;
      throw err;
    }
  };

  if (!tryCreate()) {
    let owner = null;
    try {
      owner = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      // unreadable lock: treat its owner as gone
    }
    const live = owner && table.get(owner.pid);
    if (live && live.start === owner.start) throw new Error(`another resume is in progress (pid ${owner.pid})`);
    rmSync(path, { force: true });
    if (!tryCreate()) throw new Error('another resume is in progress');
  }

  try {
    return await fn();
  } finally {
    try {
      const owner = JSON.parse(readFileSync(path, 'utf8'));
      if (owner.pid === self.pid && owner.start === self.start) rmSync(path, { force: true });
    } catch {
      // already gone
    }
  }
}
