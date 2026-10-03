# herdr-space-parking

Park herdr Spaces you aren't using. Parking stops every process in the Space and closes it: shells, Claude Code, Codex and their MCP servers. Resume it later with the same tabs, splits and Claude Code / Codex conversations.

## Install

```sh
herdr plugin link /path/to/herdr-space-parking
```

Requires herdr ≥ 0.9.0 and Node ≥ 18 on the herdr server's `PATH`. macOS and Linux.

## Keybindings

Add to `~/.config/herdr/config.toml`, choosing keys that are free in your setup:

```toml
[[keys.command]]
key = "prefix+a"
type = "plugin_action"
command = "herdr-space-parking.park"
description = "park space"

[[keys.command]]
key = "prefix+shift+u"
type = "plugin_action"
command = "herdr-space-parking.park-many"
description = "park several spaces"

[[keys.command]]
key = "prefix+u"
type = "plugin_action"
command = "herdr-space-parking.resume"
description = "resume parked space"
```

`herdr-space-parking.park-force` parks even when the Space has blockers. The CLI forms are `herdr plugin action invoke herdr-space-parking.park` and `herdr plugin action invoke herdr-space-parking.list`.

## Parked spaces in the sidebar

While at least one space is parked, the plugin keeps a **"Parked (N)"** space at the end of the Spaces sidebar. At rest it shows a compact list (name, age, tabs and agents) from a ~2 MB bash loop that refreshes when something changes.

Press any key there to open the **browser**:

| Key | Action |
|---|---|
| `↑` `↓` / `j` `k`, `PgUp` `PgDn`, `g` `G` | Move |
| `/` | Search by name, folder, branch, tab names, conversation titles or agents (every word must match) |
| `Enter` | Resume the selected space |
| `d` then `y` | Delete it (only the parked record; the project and the conversations stay on disk) |
| `q` / `Esc` | Close |

The right side shows the selected space's details: folder, branch and uncommitted files at park time, when it was parked, each tab with its agents and conversation titles, any command that was running, and warnings.

The browser is a short-lived Node process. It gives the terminal back to the bash loop when closed or after a minute without keys, so nothing heavy stays resident. The "Resume parked space" action (`prefix+u`) opens the same browser as a popup.

The board disappears when nothing is parked. After a herdr restart or a plugin update, the startup hook rebuilds it.

## Parking several spaces at once

"Park spaces…" (`herdr-space-parking.park-many`) opens a popup that lists every open space with its agents. Each space shows as `idle`, or as `⚠ blocked`, in which case the detail panel says why.

| Key | Action |
|---|---|
| `Space` | Select or unselect the space |
| `a` | Select every idle space that matches the current search (press again to clear) |
| `/` | Search |
| `Enter` | Park the selected spaces, or the current one if none is selected |
| `q` | Close |

On `Enter` the popup closes right away. Parking continues in the background, up to 4 spaces at a time (the space you were on goes last), and is reported through herdr notifications: one when it starts, and a summary of what was parked and what was not, and why. Three idle spaces take about a second. Blocked spaces are never forced in bulk: use "Park space (force)" on them one at a time. The "Parked" board and worktree spaces are not offered.

## What parking does

1. Saves tabs, splits, cwds, labels and agent session ids to `$HERDR_PLUGIN_STATE_DIR/parked/<id>.json`.
2. Refuses if an agent is working or waiting, a command such as a dev server is running, or a Claude/Codex session id is unknown. Use force to park anyway. Spaces that belong to a herdr worktree group are not supported yet, and force does not override that.
3. Closes the Space. Herdr stops each pane's processes. The plugin then stops leftovers that escaped the pane, such as MCP servers, browsers and background tasks. It never stops the shared Codex daemon. Every process is identified by pid, start time and command before it is signalled. If something can't be stopped, the Space is listed as `cleanup_failed`, and it can't be resumed until the leftovers are gone; the plugin retries the cleanup automatically.

Uncommitted changes stay on disk; parking only reports how many files are dirty.

## What resuming does

It recreates the Space in its directory, rebuilds the tabs and splits, and runs `claude --resume <id>` / `codex resume <id>` in the right panes. Dev servers are not restarted. A session that is already open in another herdr pane is not opened a second time.

## Codex note

Codex ≥ 0.157 reports sessions through a shared daemon, so herdr can miss or misattribute Codex session ids (herdr#4649). The plugin double-checks every Codex id against `~/.codex` before trusting it. If an id is missing, it infers the session from the pane title. If it can't be sure, it asks you to force-park, and that pane then restores as a plain shell. Resumed Codex sessions reattach to the shared Codex daemon, which still holds the conversation after parking.

## Limitations

- Processes that already detached and were re-parented to launchd/init before you park (classic daemons) can't be attributed to the Space and are left running.
- Process identity uses `ps` start times, which have 1-second precision. A pid reused by an identical command started in the same second could be mistaken for the original.

## Tests

```sh
npm test                 # unit tests
npm run test:integration # starts an isolated herdr server in $TMPDIR
```

## Manual smoke test

1. Open a Space with a Claude pane, send a message, and note the conversation.
2. Note the Claude PID: `herdr pane process-info <pane>` (or `ps`).
3. Park the Space. `ps -p <pid>` should print nothing.
4. Resume it from the picker. Claude should open the same conversation.
5. Repeat with a Codex pane that has a named thread (send at least one prompt first).
