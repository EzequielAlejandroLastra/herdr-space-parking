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

  // Codex's shared daemon can attach one pane's id to another pane (herdr#4649), so an id is
  // only accepted when the pane's own title points at exactly one thread in the same cwd.
  return function resolve(pane) {
    const cwd = pane.foreground_cwd ?? pane.cwd ?? null;
    const reported = pane.agent_session?.kind === 'id' ? pane.agent_session.value : null;

    const name = threadNameFromTitle(pane.terminal_title_stripped ?? pane.terminal_title);
    if (!name) return { ref: null, method: 'unresolved', reason: 'no thread name in the terminal title' };
    const candidates = (threadIdsByName().get(name) ?? []).filter((id) => rolloutCwd(id) === cwd);
    if (candidates.length === 1) return { ref: codexRef(candidates[0]), method: candidates[0] === reported ? 'verified' : 'inferred' };
    return {
      ref: null,
      method: 'unresolved',
      reason: candidates.length === 0 ? `no codex thread named "${name}" in ${cwd}` : `${candidates.length} codex threads named "${name}" in ${cwd}`,
    };
  };
}
