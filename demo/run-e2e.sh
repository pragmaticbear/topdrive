#!/usr/bin/env bash
# Live topdrive proof: an isolated OpenRig daemon with real agy/codex seats, the 5-step workflow, and topdrive
# supervising it from outside. drive.py answers the seats' trust/permission prompts.
# Needs: this repo built (npm ci && npm run build), tmux, python3, logged-in `agy` and `codex` CLIs, and an OpenRig
# `rig` on PATH (or RIG=/path/to/rig) that can launch agy seats, i.e. OpenRig with openrig-patches/ applied.
# topdrive itself only uses OpenRig's standard HTTP API.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$DIR/.." && pwd)"
TOPDRIVE="$REPO_DIR/dist/main.js"
RIG_BIN="${RIG:-rig}"
WORK_DIR="${TOPDRIVE_E2E_DIR:-/tmp/topdrive-e2e-run}"
PORT="${TOPDRIVE_E2E_PORT:-7445}"
DRIVE_SECONDS="${DRIVE_SECONDS:-180}"

for bin in node tmux python3 agy codex "$RIG_BIN"; do
  command -v "$bin" >/dev/null || { echo "missing prerequisite: $bin" >&2; exit 1; }
done
[ -f "$TOPDRIVE" ] || { echo "not built: run 'npm ci && npm run build' in $REPO_DIR" >&2; exit 1; }

# Isolated homes: this run never touches your ~/.openrig or ~/.topdrive.
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR/openrig" "$WORK_DIR/topdrive" "$WORK_DIR/real"
cp "$DIR/topdrive.yaml" "$WORK_DIR/topdrive/topdrive.yaml"
cp "$DIR/rig.yaml" "$DIR/flow.yaml" "$WORK_DIR/real/"
cp -r "$DIR/agents" "$WORK_DIR/real/"

[ -d /opt/homebrew/bin ] && PATH="/opt/homebrew/bin:$PATH"
unset OPENRIG_URL OPENRIG_HOST
export OPENRIG_HOME="$WORK_DIR/openrig" OPENRIG_PORT="$PORT" TOPDRIVE_HOME="$WORK_DIR/topdrive"
rig() { "$RIG_BIN" "$@"; }
topdrive() { node "$TOPDRIVE" --openrig-url "http://127.0.0.1:$PORT" "$@"; }

echo "=== Starting OpenRig daemon on port $PORT (OPENRIG_HOME=$OPENRIG_HOME) ==="
rig daemon start --port "$PORT" --no-kernel

echo "=== Launching rig ==="
rig up "$WORK_DIR/real/rig.yaml"

echo "=== Starting the topdrive supervisor (TOPDRIVE_HOME=$TOPDRIVE_HOME) ==="
topdrive start
topdrive doctor || true

echo "=== Instantiating workflow ==="
rig workflow instantiate "$WORK_DIR/real/flow.yaml" \
  --root-objective "Create /tmp/hello.txt containing: hello topdrive" \
  --created-by operator@tdrun --rig tdrun

echo "=== Running prompt driver (drive.py, ${DRIVE_SECONDS}s) ==="
python3 "$DIR/drive.py" "$DRIVE_SECONDS"

echo "=== Status ==="
rig queue list
rig workflow status
topdrive quota
tail -n 20 "$TOPDRIVE_HOME/topdrive.log"

ENVS="OPENRIG_HOME=$OPENRIG_HOME OPENRIG_PORT=$PORT TOPDRIVE_HOME=$TOPDRIVE_HOME"
echo "=== Done. Routing decisions: $ENVS node $TOPDRIVE --openrig-url http://127.0.0.1:$PORT roles <instance-id>"
echo "=== Tear down:   $ENVS node $TOPDRIVE stop; $ENVS $RIG_BIN down tdrun; $ENVS $RIG_BIN daemon stop"
