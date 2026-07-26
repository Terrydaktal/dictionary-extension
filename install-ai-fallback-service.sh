#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
UNIT_SOURCE="$SCRIPT_DIR/systemd/dictai-ai-fallback.service"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT_TARGET="$UNIT_DIR/dictai-ai-fallback.service"

mkdir -p "$UNIT_DIR"
install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
systemctl --user daemon-reload
systemctl --user enable --now dictai-ai-fallback.service

echo "Installed and started dictai-ai-fallback.service"
echo "Status: systemctl --user status dictai-ai-fallback.service"
echo "Logs:   journalctl --user -u dictai-ai-fallback.service -f"
