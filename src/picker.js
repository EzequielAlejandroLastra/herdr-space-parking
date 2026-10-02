import readline from 'node:readline/promises';
import { resume } from './resume.js';
import { ago } from './util.js';

export function formatList(records, now = Date.now()) {
  if (records.length === 0) return 'No parked spaces.';
  return records
    .map((r, i) => `${String(i + 1).padStart(2)}. ${r.label}  ${ago(r.parked_at, now)}${r.state === 'parked' ? '' : `  [${r.state}]`}\n    ${r.cwd}`)
    .join('\n');
}

export async function runPicker({ client, store, input = process.stdin, output = process.stdout, resumeFn = resume }) {
  const records = store.list().filter((r) => ['parked', 'resume_failed', 'cleanup_failed'].includes(r.state));
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
