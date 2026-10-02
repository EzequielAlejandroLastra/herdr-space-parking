import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sleep as realSleep } from './util.js';

const execFileP = promisify(execFile);

export const DEFAULT_KEEP = [/app-server-daemon/, /\bcodex app-server\b/];

// `lstart` is a fixed five-token date ("Thu Oct  1 17:55:08 2026") on macOS and procps.
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;

export function parsePs(text) {
  const table = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(PS_LINE);
    if (!match) continue;
    const pid = Number(match[1]);
    table.set(pid, { pid, ppid: Number(match[2]), start: match[3].replace(/\s+/g, ' '), command: match[4] });
  }
  return table;
}

export async function readProcessTable() {
  const { stdout } = await execFileP('ps', ['-axo', 'pid=,ppid=,lstart=,command='], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: 'C' },
  });
  return parsePs(stdout);
}

const identity = ({ pid, start, command }) => ({ pid, start, command });

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
    out.push(identity(table.get(pid)));
    stack.push(...(children.get(pid) ?? []));
  }
  return out;
}

// A process survives only if the same pid still runs the same command started at the same time;
// anything else is a different process that reused the pid.
export function survivors(before, afterTable) {
  return before.filter((proc) => {
    const now = afterTable.get(proc.pid);
    return now !== undefined && now.start === proc.start && now.command === proc.command;
  });
}

export async function reap(
  procs,
  { keep = DEFAULT_KEEP, kill = process.kill.bind(process), readTable = readProcessTable, sleep = realSleep, graceMs = 1000 } = {},
) {
  const targets = procs.filter((proc) => !keep.some((pattern) => pattern.test(proc.command)));
  const signal = (list, name) => {
    for (const proc of list) {
      try { kill(proc.pid, name); } catch { /* exited in between */ }
    }
  };

  const live = survivors(targets, await readTable());
  if (live.length === 0) return { killed: [], stillAlive: [] };
  signal(live, 'SIGTERM');
  await sleep(graceMs);
  signal(survivors(live, await readTable()), 'SIGKILL');
  await sleep(200);
  const stillAlive = survivors(live, await readTable());
  const killed = live.filter((proc) => !stillAlive.includes(proc));
  return { killed, stillAlive };
}
