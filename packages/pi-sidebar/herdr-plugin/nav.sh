#!/bin/sh
# Pane focus that knows about pi-sidebar. Bind it in place of Herdr's focus_pane_* keys:
#
#   [[keys.command]]
#   key = "prefix+h"
#   type = "plugin_action"
#   command = "pi-sidebar-nav.focus-left"
#
# When the focused pane runs Pi, the move goes to Pi as a reserved key: pi-sidebar moves between
# main and Sidebar when it can, and otherwise asks Herdr for the normal pane move. Any other pane
# gets the normal move right away. The reserved keys must match NAV_KEYS in src/nav.ts.
set -u
dir=${1:-}
case $dir in
  left) key=ctrl+alt+shift+h ;;
  down) key=ctrl+alt+shift+j ;;
  up) key=ctrl+alt+shift+k ;;
  right) key=ctrl+alt+shift+l ;;
  *) echo "usage: nav.sh left|down|up|right" >&2; exit 2 ;;
esac
herdr=${HERDR_BIN_PATH:-herdr}
pane=${HERDR_PANE_ID:-}
if [ -z "$pane" ]; then
  exec "$herdr" pane focus --direction "$dir" --current
fi
if "$herdr" pane get "$pane" 2>/dev/null | grep -q '"agent":"pi"'; then
  exec "$herdr" pane send-keys "$pane" "$key"
fi
exec "$herdr" pane focus --direction "$dir" --pane "$pane"
