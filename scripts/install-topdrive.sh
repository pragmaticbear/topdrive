#!/usr/bin/env bash
# Put the `topdrive` command on PATH: a symlink to this checkout's build (dist/main.js).
# It never installs or replaces `rig`; topdrive works with whatever OpenRig you already run.
# Usage: scripts/install-topdrive.sh [bin-dir]   (default ~/.local/bin)
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN="$REPO/dist/main.js"
[ -f "$MAIN" ] || { echo "not built: run 'npm ci && npm run build' in $REPO" >&2; exit 1; }
dest="${1:-$HOME/.local/bin}"
mkdir -p "$dest"
chmod +x "$MAIN"
ln -sfn "$MAIN" "$dest/topdrive"
echo "linked $dest/topdrive -> $MAIN"
case ":$PATH:" in *":$dest:"*) ;; *) echo "note: $dest is not on PATH; add it to your shell profile" ;; esac
