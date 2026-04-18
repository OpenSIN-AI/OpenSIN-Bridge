#!/usr/bin/env bash
# Applies the Supabase schema to the project's Supabase instance.
# Prerequisites: supabase CLI installed and linked, OR psql available.
# Usage: ./setup_supabase.sh [supabase|psql]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
MIGRATION="$SCRIPT_DIR/../supabase/migrations/001_initial_schema.sql"

MODE="${1:-supabase}"

if [[ "$MODE" == "supabase" ]]; then
    echo "[setup] Pushing schema via supabase CLI..."
    supabase db push --file "$MIGRATION"
    echo "[setup] Done. Supabase schema applied."
elif [[ "$MODE" == "psql" ]]; then
    if [[ -z "${SUPABASE_DB_URL:-}" ]]; then
        echo "Error: SUPABASE_DB_URL env var required for psql mode."
        exit 1
    fi
    echo "[setup] Applying schema via psql..."
    psql "$SUPABASE_DB_URL" -f "$MIGRATION"
    echo "[setup] Done."
else
    echo "Usage: $0 [supabase|psql]"
    exit 1
fi
