#!/usr/bin/env bash
# Parked spaces board: lists parked spaces and resumes or deletes them.
#   board.sh          long-running board (the "Parked (N)" space); refreshes when the list changes
#   board.sh --once   popup mode: one action, then exit
# Written for bash 3.2 (macOS /bin/bash). Idle cost: one bash process waking every 3 s.
set -u

ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1
ROOT="${HERDR_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
CLI="${HSP_CLI:-node $ROOT/src/cli.js}"
PARKED_DIR="${HERDR_PLUGIN_STATE_DIR:-}/parked"

IDS=()
LABELS=()

cli() { $CLI "$@"; }

# Names of the record files; changes whenever a space is parked, resumed or deleted.
signature() { (cd "$PARKED_DIR" 2>/dev/null && echo *.json); }

render() {
  IDS=()
  LABELS=()
  local rows n=0 id label age state cwd summary
  rows=$(cli board-list 2>/dev/null)
  printf '\033[2J\033[H'
  printf 'Parked spaces\n\n'
  while IFS=$'\037' read -r id label age state cwd summary; do
    [ -n "$id" ] || continue
    n=$((n + 1))
    IDS+=("$id")
    LABELS+=("$label")
    printf '%2d. %s  %s%s\n    %s  %s\n' "$n" "$label" "$age" "${state:+  [$state]}" "$cwd" "$summary"
  done <<< "$rows"
  if [ "$n" -eq 0 ]; then
    printf 'No parked spaces.\n'
  fi
  printf '\n<number> resume · d <number> delete · r refresh'
  [ "$ONCE" -eq 1 ] && printf ' · Enter close'
  printf '\n> '
}

pause() {
  printf 'Press Enter to continue'
  read -r _ || true
}

# Prints the error of a failed CLI call (its JSON result) in a readable way.
report_failure() {
  local message
  message=$(printf '%s' "$1" | sed -n 's/.*"error":"\([^"]*\)".*/\1/p')
  printf '%s\n' "${message:-$1}"
}

# Runs one command line; returns 0 when popup mode should exit.
handle() {
  local line="$1" index id label output
  case "$line" in
    "" | q) [ "$ONCE" -eq 1 ] && return 0 ;;
    r) ;;
    d\ * | d[0-9]*)
      index="${line#d}"
      index="${index// /}"
      id="${IDS[$((index - 1))]:-}"
      if [ -z "$id" ] || ! [[ "$index" =~ ^[0-9]+$ ]]; then
        printf 'No parked space number %s\n' "$index"
        pause
        return 1
      fi
      label="${LABELS[$((index - 1))]}"
      printf "Delete parked space '%s'? Its project and conversations stay on disk. [y/N] " "$label"
      read -r answer || answer=""
      if [ "$answer" = "y" ] || [ "$answer" = "Y" ]; then
        if output=$(cli delete "$id" 2>&1); then
          [ "$ONCE" -eq 1 ] && return 0
        else
          report_failure "$output"
          pause
        fi
      fi
      ;;
    *)
      if ! [[ "$line" =~ ^[0-9]+$ ]] || [ -z "${IDS[$((line - 1))]:-}" ]; then
        printf 'No parked space number %s\n' "$line"
        pause
        return 1
      fi
      printf 'Resuming %s...\n' "${LABELS[$((line - 1))]}"
      if output=$(cli resume "${IDS[$((line - 1))]}" 2>&1); then
        [ "$ONCE" -eq 1 ] && return 0
      else
        report_failure "$output"
        pause
      fi
      ;;
  esac
  return 1
}

last_signature=$(signature)
render
while true; do
  if IFS= read -r -t 3 line; then
    handle "$line" && exit 0
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
