#!/usr/bin/env sh

set -eu

PROJECT_ROOT=${PROJECT_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}
EXAMPLE_CONFIG_PATH=${EXAMPLE_CONFIG_PATH:-"$PROJECT_ROOT/config/databases.example.json"}
KEEP_TARBALL=${KEEP_TARBALL:-0}
PACKAGE_NAME="mcp-database-service"

run_step() {
  echo "==> $*"
  "$@"
}

cleanup_tarball() {
  if [ "${KEEP_TARBALL}" != "1" ] && [ -n "${TARBALL_PATH:-}" ] && [ -f "$TARBALL_PATH" ]; then
    rm -f "$TARBALL_PATH"
  fi
}

trap cleanup_tarball EXIT

if [ ! -f "$PROJECT_ROOT/package.json" ]; then
  echo "package.json not found under project root: $PROJECT_ROOT" >&2
  exit 1
fi

cd "$PROJECT_ROOT"

run_step npm install
run_step npm run build

PACK_OUTPUT=$(npm pack --json)
TARBALL_FILE=$(printf '%s' "$PACK_OUTPUT" | node -e "const fs = require('fs'); const text = fs.readFileSync(0, 'utf8'); const data = JSON.parse(text); if (!Array.isArray(data) || !data[0] || !data[0].filename) { process.exit(1); } process.stdout.write(data[0].filename);")
TARBALL_PATH="$PROJECT_ROOT/$TARBALL_FILE"

if ! npm uninstall -g "$PACKAGE_NAME"; then
  echo "Previous global installation was not removed cleanly. Continuing with fresh install."
fi

run_step npm install -g "$TARBALL_PATH"

echo
echo "Global installation completed."
echo "Command: mcp-database-service"
echo "Example start command:"
echo "  mcp-database-service --config $EXAMPLE_CONFIG_PATH"
echo
echo "Example MCP server configuration:"
cat <<EOF
{
  "mcpServers": {
    "database": {
      "command": "mcp-database-service",
      "args": [
        "--config",
        "$EXAMPLE_CONFIG_PATH"
      ]
    }
  }
}
EOF
