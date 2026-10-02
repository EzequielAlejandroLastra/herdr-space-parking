#!/usr/bin/env bash
# Parked spaces board, the pane of the "Parked (N)" space.
# Idle, it is this bash loop (~2 MB) showing a compact list that refreshes when the list changes.
# Any key opens the interactive browser (`cli.js tui`: search, details, resume, delete); the
# browser hands the terminal back when closed or after a minute without keys.
# Written for bash 3.2 (macOS /bin/bash).
set -u

ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="${HSP_CLI:-node $ROOT/src/cli.js}"
STATE_DIR="${HERDR_PLUGIN_STATE_DIR:-}"

cli() { $CLI "$@"; }

# File names under parked/ and refresh/: they change whenever a space is parked, resumed or
# deleted, and whenever the plugin syncs the board (refresh/ holds a fresh marker each time).
signature() { (cd "$STATE_DIR" 2>/dev/null && echo parked/*.json refresh/*); }

terminal_rows() {
  local rows
  rows=$(stty size 2>/dev/null | cut -d' ' -f1)
  echo "${LINES:-${rows:-24}}"
}

render() {
  local rows total=0 shown=0 room id label age state cwd summary
  rows=$(cli board-list 2>/dev/null)
  [ -n "$rows" ] && total=$(printf '%s\n' "$rows" | grep -c .)
  room=$(( $(terminal_rows) - 6 ))
  [ "$room" -lt 1 ] && room=1
  printf '\033[2J\033[H'
  printf '\033[1m Parked spaces (%d)\033[0m\n\n' "$total"
  while IFS=$'\037' read -r id label age state cwd summary; do
    [ -n "$id" ] || continue
    if [ "$shown" -ge "$room" ]; then
      printf '\033[2m  … and %d more\033[0m\n' $((total - shown))
      break
    fi
    shown=$((shown + 1))
    printf '  %-32.32s %8s  %s%s\n' "$label" "$age" "$summary" "${state:+  [$state]}"
  done <<< "$rows"
  [ "$total" -eq 0 ] && printf '\033[2m  No parked spaces.\033[0m\n'
  printf '\n\033[2m Press any key to browse, search, resume or delete\033[0m'
}

last_signature=$(signature)
render
while true; do
  if IFS= read -r -s -n 1 -t 3 _; then
    cli tui
    last_signature=$(signature)
    render
  else
    # bash 3.2 returns 1 both on the 3 s timeout and on EOF, so tell them apart by stdin:
    # on a terminal it was the timeout (closing the pane sends SIGHUP); otherwise input ended.
    [ -t 0 ] || exit 0
    current=$(signature)
    if [ "$current" != "$last_signature" ]; then
      last_signature=$current
      render
    fi
  fi
done
