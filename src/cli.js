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
  const codexResolver = createCodexResolver();

  switch (command) {
    case 'park':
    case 'park-force': {
      const workspaceId = arg || pluginContext(env).workspace_id || env.HERDR_WORKSPACE_ID;
      if (!workspaceId) throw new Error('no workspace in the plugin context');
      const result = await park({ client, store, workspaceId, force: command === 'park-force', codexResolver });
      console.log(JSON.stringify(result.record ? { status: result.status, id: result.record.id, warnings: result.warnings } : result));
      if (result.status === 'parked' || result.status === 'cleanup_failed') {
        const killed = result.record.orphans_killed.length;
        const lines = [...result.warnings, killed > 0 ? `${killed} leftover process(es) stopped` : null].filter(Boolean);
        const title = result.status === 'parked' ? `Parked ${result.record.label}` : `Parked ${result.record.label}, cleanup incomplete`;
        await notify(client, title, lines.join('\n') || 'All processes released.');
        return 0;
      }
      if (result.status === 'refused') {
        const hint = result.forceable ? ['Use "Park space (force)" to park anyway.'] : [];
        await notify(client, 'Space not parked', [...result.blockers, ...hint].join('\n'));
      } else {
        await notify(client, 'Park failed', result.error);
      }
      return 1;
    }
    case 'resume': {
      await reconcile({ client, store });
      const result = await resume({ client, store, id: arg, codexResolver });
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
      return runPicker({ client, store, resumeFn: (args) => resume({ ...args, codexResolver }) });
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
