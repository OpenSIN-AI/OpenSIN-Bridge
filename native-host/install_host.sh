#!/bin/bash
set -euo pipefail

# This installer registers the OpenSIN native messaging manifest for the local
# Chrome profile on macOS. The manifest is generated via manifest-lib.mjs so the
# extension id stays deterministic and testable.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DEFAULT_MANIFEST_PATH="$REPO_ROOT/extension/manifest.json"
DEFAULT_HOST_PATH="$SCRIPT_DIR/opensin_host.py"
DEFAULT_HOST_NAME="ai.opensin.bridge.host"
DEFAULT_TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"

MANIFEST_PATH="$DEFAULT_MANIFEST_PATH"
HOST_PATH="$DEFAULT_HOST_PATH"
HOST_NAME="$DEFAULT_HOST_NAME"
TARGET_DIR="$DEFAULT_TARGET_DIR"
EXTENSION_ID=""
PRINT_ONLY="false"
DRY_RUN="false"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --manifest)
      MANIFEST_PATH="$2"
      shift 2
      ;;
    --host-path)
      HOST_PATH="$2"
      shift 2
      ;;
    --host-name)
      HOST_NAME="$2"
      shift 2
      ;;
    --target-dir)
      TARGET_DIR="$2"
      shift 2
      ;;
    --extension-id)
      EXTENSION_ID="$2"
      shift 2
      ;;
    --print-manifest)
      PRINT_ONLY="true"
      shift
      ;;
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

if [[ ! -f "$MANIFEST_PATH" ]]; then
  echo "Extension manifest not found: $MANIFEST_PATH" >&2
  exit 1
fi

if [[ ! -f "$HOST_PATH" ]]; then
  echo "Native host entrypoint not found: $HOST_PATH" >&2
  exit 1
fi

chmod +x "$HOST_PATH"

NODE_ARGS=(
  "$SCRIPT_DIR/manifest-lib.mjs"
  --manifest "$MANIFEST_PATH"
  --host-path "$HOST_PATH"
  --host-name "$HOST_NAME"
)

if [[ -n "$EXTENSION_ID" ]]; then
  NODE_ARGS+=(--extension-id "$EXTENSION_ID")
fi

MANIFEST_JSON="$(node "${NODE_ARGS[@]}")"
MANIFEST_FILE="$TARGET_DIR/$HOST_NAME.json"

if [[ "$PRINT_ONLY" == "true" ]]; then
  printf '%s\n' "$MANIFEST_JSON"
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo "[dry-run] Would write native messaging manifest to: $MANIFEST_FILE"
  printf '%s\n' "$MANIFEST_JSON"
  exit 0
fi

mkdir -p "$TARGET_DIR"
printf '%s\n' "$MANIFEST_JSON" > "$MANIFEST_FILE"

python3 - <<'PY' "$MANIFEST_FILE"
import json
import pathlib
import sys

manifest_path = pathlib.Path(sys.argv[1])
with manifest_path.open('r', encoding='utf-8') as handle:
    manifest = json.load(handle)

required_keys = {'name', 'description', 'path', 'type', 'allowed_origins'}
missing = sorted(required_keys.difference(manifest.keys()))
if missing:
    raise SystemExit(f'Manifest validation failed, missing keys: {missing}')
PY

echo "Installed OpenSIN native host manifest: $MANIFEST_FILE"
echo "Allowed origin: $(python3 - <<'PY' "$MANIFEST_FILE"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as handle:
    manifest = json.load(handle)
print(manifest['allowed_origins'][0])
PY
)"
