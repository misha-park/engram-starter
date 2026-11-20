#!/bin/bash
# Engram's updater (docs/ORIGINAL-SPEC.md §9). Waits for Engram to quit, then swaps an app into place:
#   update:   updates/next/Engram.app goes in; the app it replaces becomes updates/previous/
#   rollback: updates/previous/Engram.app goes in; the app it replaces becomes the previous one
# If the new app can't be moved in, the old one is put back. Either way Engram is reopened
# (unless the fifth argument is "no-open"). Run by Engram itself (Restart to update, Roll back)
# and by `npm run release` when Engram isn't running. Arguments after the fifth are passed to
# the reopened app (an Engram started with --user-data-dir reopens with it).
#
# usage: update-swap.sh <pid to wait for, or 0> <update|rollback> <app path> <updates dir>
#                       [open|no-open] [app arguments...]

set -u
PID="$1"
MODE="$2"
APP="$3"
DIR="$4"
OPEN="${5:-open}"
shift $(($# < 5 ? $# : 5))
APP_ARGS=("$@")

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') [$MODE] $*"; }
reopen() {
  [ "$OPEN" = "open" ] || return 0
  if [ ${#APP_ARGS[@]} -gt 0 ]; then
    # -n: a copy with its own data folder runs beside any other Engram.
    open -n "$APP" --args "${APP_ARGS[@]}"
  else
    open "$APP"
  fi
}

if [ "$PID" != "0" ]; then
  for _ in $(seq 1 300); do
    kill -0 "$PID" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$PID" 2>/dev/null; then
    log "Engram didn't quit within 30 s; nothing changed."
    exit 1
  fi
fi

case "$MODE" in
  update) SRC="$DIR/next" ;;
  rollback) SRC="$DIR/previous" ;;
  *) log "Unknown mode."; exit 1 ;;
esac

if [ ! -d "$SRC/Engram.app" ]; then
  log "No app in $SRC; nothing changed."
  reopen
  exit 1
fi

ASIDE="$DIR/swap"
rm -rf "$ASIDE"
mkdir -p "$ASIDE"

if [ -d "$APP" ] && ! mv "$APP" "$ASIDE/Engram.app"; then
  log "Couldn't move $APP aside; nothing changed."
  reopen
  exit 1
fi

if ! mv "$SRC/Engram.app" "$APP"; then
  log "Couldn't move the new app into $APP; putting the old one back."
  [ -d "$ASIDE/Engram.app" ] && mv "$ASIDE/Engram.app" "$APP"
  reopen
  exit 1
fi

# The app that was replaced is now the previous one.
if [ -d "$ASIDE/Engram.app" ]; then
  rm -rf "$DIR/previous"
  mkdir -p "$DIR/previous"
  mv "$ASIDE/Engram.app" "$DIR/previous/Engram.app"
fi
rm -rf "$ASIDE"
[ "$MODE" = "update" ] && rm -rf "$DIR/next"

log "Done: $APP"
reopen
exit 0
