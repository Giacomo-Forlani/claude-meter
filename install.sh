#!/usr/bin/env bash
# Pack and install Claude Meter for the current user.
set -euo pipefail
cd "$(dirname "$0")"
./build.sh
gnome-extensions install --force dist/claude-meter@grillofra.shell-extension.zip
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/claude-meter@grillofra"
glib-compile-schemas "$DEST/schemas"
clear
echo "Claude Meter @ grillofra"
echo "Estensione installata con successo." 
echo "Ora esci e rientra nella sessione, poi esegui:"
echo "gnome-extensions enable claude-meter@grillofra"
