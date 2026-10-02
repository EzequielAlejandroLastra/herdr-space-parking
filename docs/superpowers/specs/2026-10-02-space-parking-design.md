# herdr-space-parking — design

Date: 2026-10-02 · Target: upstream herdr 0.9.0 (herdrdev/herdr), macOS + Linux

## Problem

One herdr Space per repo. Idle Spaces keep their shells, Claude Code / Codex processes and their MCP children alive. Measured on the author's machine: the herdr server itself uses ~17 MB, while 15 pane process trees use ~1.35 GB RSS (22–360 MB each).

Goal: **park** a Space so it consumes no runtime resources, and **resume** it later with its layout and its native Claude/Codex conversations.

## Non-goals (v1)

- Process checkpointing, scrollback restore, re-running dev servers.
- A native "PARKED" sidebar section or context-menu entry. Plugins cannot add these in 0.9.0; a separate upstream PR may follow.
- Automatic parking of inactive Spaces.
- Agents other than Claude Code and Codex. Their panes restore as plain shells.

## Facts this design relies on (verified in herdr v0.9.0 source)

- **`workspace.close`** removes all workspace state. For every pane it sends SIGHUP → SIGTERM → SIGKILL (250 ms apart) to each process in the pane's **POSIX session** (`src/pane.rs:1493`). Processes that called `setsid` are not reached. On the author's machine, 27 processes were outside their pane's session: MCP servers, Chrome, the Codex daemon, and Claude background tasks.
- **Panes expose `agent_session {source, agent, kind, value}`** (`session.snapshot`, `agent.list`), reported by herdr's Claude/Codex hooks. Claude refs are reliable.
- **Codex refs are not reliable.** Codex ≥0.157 runs hooks inside one shared `app-server-daemon` that keeps the env of the pane that first started it. Refs are missing or bound to the wrong pane (herdr#4649; dup herdr#4859). Workaround endorsed by the maintainers: `codex --no-daemon resume <id>`.
- **Layout and pane APIs:**
  - `layout.export {tab_id}` returns a tree of `pane{pane_id,cwd,label}` / `split{direction right|down, ratio, first, second}` nodes.
  - `layout.apply {tab_id | workspace_id, tab_label?, root}` builds a tab from such a tree. With `tab_id` it replaces that tab, and the response contains the new pane ids.
  - `workspace.create {cwd, label, focus}` returns `{workspace, tab, root_pane}`.
  - `pane.process_info {pane_id}` returns `{shell_pid, foreground_processes[{pid,name,cmdline}]}`.
- **Plugin runtime:**
  - Actions run `command` argv with `HERDR_SOCKET_PATH`, `HERDR_PLUGIN_ID`, `HERDR_PLUGIN_ROOT`, `HERDR_PLUGIN_STATE_DIR` and `HERDR_PLUGIN_CONTEXT_JSON` (`workspace_id`, …).
  - Popup panes (`placement = "popup"`) are interactive terminals.
  - The socket protocol is NDJSON: `{id, method, params}` → `{id, result}` | `{id, error{code,message}}`.

## Architecture

The plugin is plain Node ≥18 (ESM), with no dependencies. It talks to herdr over the socket and stores state in `$HERDR_PLUGIN_STATE_DIR/parked/<uuid>.json`. Nothing stays resident: every action is a short-lived process.

UI:

- **Park space** action (`contexts=["workspace"]`, bound to a key). It parks the focused Space, or refuses and lists the blockers in a herdr notification.
- **Park space (force)** action. It parks despite blockers.
- **Resume parked space** action. It opens a popup picker; choosing an entry resumes it.
- **List parked spaces** action. It prints JSON (for scripting/debugging).

## Record (v1)

```json
{
  "v": 1, "id": "uuid", "state": "parking|parked|park_failed|resuming|resume_failed",
  "label": "keygen", "cwd": "/…/keygen", "source_workspace_id": "w4",
  "parked_at": "ISO", "updated_at": "ISO",
  "git": {"branch": "main", "dirty_files": 2} | null,
  "worktree": WorkspaceWorktreeInfo | null,
  "tabs": [{"label": "review", "focused": true, "root": Node}],
  "warnings": ["…"], "orphans_killed": [{"pid": 1, "command": "…"}],
  "error": null, "resumed_workspace_id": null
}
```

`Node` is either:

- `{type:"split", direction, ratio, first, second}`, or
- `{type:"pane", source_pane_id, cwd, label, agent, agent_session, was_running}`.

## Park flow

1. Capture state:
   - `session.snapshot`
   - `layout.export` for each tab of the workspace
   - `pane.process_info` for each pane
2. Codex panes: verify or infer the session id (see below). Every other agent pane keeps its herdr `agent_session`.
3. Run preflight. **Blockers** (refuse unless forced):
   - an agent is `working` or `blocked`;
   - a Codex session can't be resolved;
   - a Claude pane has no session id;
   - a non-agent pane has a non-shell foreground process (e.g. a dev server);
   - the Space is the parent of linked-worktree Spaces.

   **Warnings**:
   - dirty git tree (files stay on disk);
   - inferred Codex id;
   - unsupported agent.
4. Save the record with `state=parking` (atomic tmp + rename).
5. Record the descendant process tree of every pane shell (`ps`, walked by PPID, not by session).
6. Re-read `agent_session` for non-Codex panes. An agent may have run `/clear` or `/resume` since step 1.
7. Call `workspace.close`. If it fails, set `state=park_failed` and stop; the workspace is still alive.
8. Wait 1.5 s. Every process from step 5 that is still alive with the same command gets SIGTERM, then SIGKILL after 1 s. Exception: an allowlist that by default keeps the shared Codex daemon (`app-server-daemon`, `codex app-server`). These processes are recorded in `orphans_killed`.
9. Set `state=parked`.

**Reconcile** runs before list, picker and resume. A `parking` or `park_failed` record:

- is removed (the park was aborted) if its workspace still exists with the same label;
- otherwise is marked `parked`.

## Codex session resolution

1. If the pane has a reported id **and** the first line of that id's rollout (`~/.codex/sessions/**/rollout-*-<id>.jsonl`, `payload.cwd`) equals the pane's cwd, the id is **verified**.
2. Otherwise, take the thread name from the terminal title: Codex sets `"<thread name> | <dir>"`, and the `" | <dir>"` suffix is stripped. Look the name up in `~/.codex/session_index.jsonl` (last entry per id wins) and keep only ids whose rollout cwd equals the pane cwd. Exactly one match means the id is **inferred**.
3. Anything else is **unresolved**, which blocks the park unless forced. A forced park restores that pane as a shell.

This never binds silently on ambiguity, which addresses the maintainer's concern in herdr#4649.

## Resume flow

1. Load the record. It must be `parked` or `resume_failed`, and `record.cwd` must exist.
2. Call `agent.list` and collect the live session ids. A session that is already open is not resumed again, because two processes would corrupt one transcript.
3. Set `state=resuming`.
4. Call `workspace.create {cwd, label, focus:true}`.
5. For each tab, call `layout.apply` with the saved tree:
   - shells only;
   - a pane whose cwd is missing falls back to `record.cwd`;
   - the first tab replaces the default tab via `tab_id`.

   Saved leaves map to the new panes by in-order position.
6. For each leaf with a resumable session:
   - wait until the pane's foreground process is a shell (max 5 s);
   - then `pane.send_text` either `claude --resume <id>\r` or `codex --no-daemon resume <id>\r`.
7. Focus the tab that was focused, and delete the record.
8. On any error, set `state=resume_failed` with `error` and `resumed_workspace_id`, and keep the record so it can be retried.

## Resource outcome

A parked Space leaves:

- no herdr state;
- no pane processes;
- no leftover descendants (except allowlisted shared daemons);
- one 2–10 KB JSON file.

100 records take under 1 MB on disk and zero RAM.

## Testing

- Unit tests (`node:test`) for every module, with fake socket/client and fixtures.
- Gated integration test against an isolated herdr server. It parks a Space whose pane runs a background job and a `setsid` process, asserts both are gone, resumes it, and asserts the layout is back.
- Manual smoke test with real Claude and Codex.
