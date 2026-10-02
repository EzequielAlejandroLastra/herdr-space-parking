#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { boardSync, deleteParked, formatBoardList, isBoardWorkspace } from './board.js';
import { createCodexResolver } from './codex-sessions.js';
import { createClient } from './herdr-client.js';
import { park, reconcile } from './park.js';
import { resume } from './resume.js';
import { createStore } from './store.js';
import { runTui } from './tui.js';

const USAGE = 'expected park | park-force | resume <id> | delete <id> | list | tui [--once] | board-list | board-sync | open-picker';
const BOARD_IDLE_MS = 60_000;

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

// Keeping the "Parked (N)" space in step is best effort: the park/resume/delete itself already happened.
async function syncBoard(client, store, env) {
  try {
    await boardSync({ client, store, env });
  } catch (err) {
    console.error(`board sync failed: ${err.message}`);
  }
}

export function summary(record) {
  return { id: record.id, label: record.label, cwd: record.cwd, state: record.state, parked_at: record.parked_at, tabs: record.tabs.length };
}

export async function main(argv, env = process.env, { client: injectedClient, input = process.stdin, output = process.stdout } = {}) {
  const [command, arg] = argv;
  if (['resume', 'delete'].includes(command) && !arg) {
    console.error(`${command} needs a parked space id`);
    return 2;
  }
  const client = injectedClient ?? createClient({ socketPath: env.HERDR_SOCKET_PATH, timeoutMs: 10000 });
  const store = createStore(env.HERDR_PLUGIN_STATE_DIR);
  const codexResolver = createCodexResolver();

  switch (command) {
    case 'park':
    case 'park-force': {
      const workspaceId = arg || pluginContext(env).workspace_id || env.HERDR_WORKSPACE_ID;
      if (!workspaceId) throw new Error('no workspace in the plugin context');
      if (isBoardWorkspace(store, workspaceId)) {
        await notify(client, 'Space not parked', 'This is the parked spaces board; use it to resume or delete parked spaces.');
        return 1;
      }
      const result = await park({ client, store, workspaceId, force: command === 'park-force', codexResolver });
      console.log(JSON.stringify(result.record ? { status: result.status, id: result.record.id, warnings: result.warnings } : result));
      if (result.status === 'parked' || result.status === 'cleanup_failed') {
        await syncBoard(client, store, env);
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
      if (result.status === 'resumed') {
        await syncBoard(client, store, env);
        if (result.warnings.length > 0) await notify(client, 'Resumed with warnings', result.warnings.join('\n'));
        return 0;
      }
      await notify(client, 'Resume failed', result.error);
      return 1;
    }
    case 'delete': {
      const result = deleteParked({ store, id: arg });
      console.log(JSON.stringify(result));
      if (result.status !== 'deleted') return 1;
      await syncBoard(client, store, env);
      return 0;
    }
    case 'list': {
      await reconcile({ client, store });
      console.log(JSON.stringify(store.list().map(summary), null, 2));
      return 0;
    }
    case 'tui': {
      // --once: the resume popup (no idle timeout); otherwise opened from the board, which gets the
      // terminal back after a minute without keys so node does not stay resident.
      const once = arg === '--once';
      if (!once) await reconcile({ client, store });
      const actions = {
        resume: async (id) => {
          const result = await resume({ client, store, id, codexResolver });
          if (result.status === 'resumed') {
            if (result.warnings.length > 0) await notify(client, 'Resumed with warnings', result.warnings.join('\n'));
            await syncBoard(client, store, env);
          }
          return result;
        },
        remove: async (id) => {
          const result = deleteParked({ store, id });
          if (result.status === 'deleted') await syncBoard(client, store, env);
          return result;
        },
      };
      await runTui({
        load: () => store.list(),
        input,
        output,
        actions,
        size: () => ({ columns: output.columns || 100, rows: output.rows || 30 }),
        idleMs: once ? 0 : BOARD_IDLE_MS,
      });
      return 0;
    }
    case 'board-list': {
      console.log(formatBoardList(store.list()));
      return 0;
    }
    case 'board-sync': {
      await reconcile({ client, store });
      await syncBoard(client, store, env);
      return 0;
    }
    case 'open-picker': {
      await client.call('plugin.pane.open', { plugin_id: env.HERDR_PLUGIN_ID, entrypoint: 'picker' });
      return 0;
    }
    default:
      console.error(`unknown command: ${command ?? '(none)'}; ${USAGE}`);
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
