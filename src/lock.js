import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readProcessTable } from './proctree.js';

function readOwner(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function ownerIsAlive(owner, table) {
  const live = owner && table.get(owner.pid);
  return Boolean(live) && live.start === owner.start;
}

export async function lockOwnerAlive(path, { readTable = readProcessTable } = {}) {
  const owner = readOwner(path);
  return owner ? ownerIsAlive(owner, await readTable()) : false;
}

// Cross-process mutex. The lock file names its owner by (pid, start time); it is reclaimed only
// when that exact process is gone, never because of its age.
export async function withLock(path, fn, { readTable = readProcessTable, what = 'resume' } = {}) {
  const table = await readTable();
  const self = { pid: process.pid, start: table.get(process.pid)?.start ?? null };
  const busy = (pid) => Object.assign(new Error(`another ${what} is in progress${pid ? ` (pid ${pid})` : ''}`), { code: 'ELOCKED' });

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
    const owner = readOwner(path);
    if (ownerIsAlive(owner, table)) throw busy(owner.pid);
    rmSync(path, { force: true });
    if (!tryCreate()) throw busy();
  }

  try {
    return await fn();
  } finally {
    const owner = readOwner(path);
    if (owner && owner.pid === self.pid && owner.start === self.start) rmSync(path, { force: true });
  }
}
