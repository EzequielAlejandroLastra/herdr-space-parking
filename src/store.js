import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export const STATES = new Set(['parking', 'parked', 'park_failed', 'cleanup_failed', 'resuming', 'resume_failed']);

// Only files this plugin wrote count as records; anything else in the directory is left alone.
function isRecord(value, expectedId) {
  return Boolean(value) && value.v === 1 && value.id === expectedId && STATES.has(value.state) && Array.isArray(value.tabs);
}

export function createStore(stateDir) {
  if (!stateDir) throw new Error('HERDR_PLUGIN_STATE_DIR is not set; run this inside herdr');
  const dir = join(stateDir, 'parked');
  mkdirSync(dir, { recursive: true });

  const fileFor = (id) => {
    if (!ID_PATTERN.test(String(id))) throw new Error(`invalid record id: ${id}`);
    return join(dir, `${id}.json`);
  };

  const read = (path, id) => {
    try {
      const value = JSON.parse(readFileSync(path, 'utf8'));
      return isRecord(value, id) ? value : null;
    } catch {
      return null;
    }
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
      return read(fileFor(id), id);
    },
    list() {
      const records = [];
      for (const name of readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const record = read(join(dir, name), name.slice(0, -'.json'.length));
        if (record) records.push(record);
      }
      return records.sort((a, b) => String(b.parked_at).localeCompare(String(a.parked_at)));
    },
    remove(id) {
      rmSync(fileFor(id), { force: true });
    },
  };
}
