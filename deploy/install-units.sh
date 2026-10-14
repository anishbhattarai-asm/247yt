#!/usr/bin/env bash
# Installs (or refreshes) the systemd units in deploy/: the panel service and
# the Terminal tab's socket. setup.sh and update.sh run it; it is safe to run
# again at any time. Run as the panel's user (it uses sudo), or as root with
# PANEL_USER=<that user>.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [ "$(id -u)" -eq 0 ]; then
  SUDO=()
  PANEL_USER="${PANEL_USER:?run as the panel user, or set PANEL_USER when running as root}"
else
  SUDO=(sudo)
  PANEL_USER="$(id -un)"
fi
NODE="$(command -v node)"

install_unit() { # $1 = file in deploy/
  sed -e "s#__USER__#${PANEL_USER}#g" -e "s#__DIR__#${DIR}#g" -e "s#__NODE__#${NODE}#g" \
    "$DIR/deploy/$1" | "${SUDO[@]}" tee "/etc/systemd/system/$1" >/dev/null
}

install_unit stream-panel.service
install_unit stream-panel-terminal.socket
install_unit stream-panel-terminal@.service
"${SUDO[@]}" systemctl daemon-reload
"${SUDO[@]}" systemctl enable --now stream-panel-terminal.socket >/dev/null 2>&1
