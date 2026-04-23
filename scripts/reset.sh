#!/usr/bin/env bash
# Tear down and recreate the NeuroMem stack from scratch.
# WARNING: deletes all memory data.
set -euo pipefail

read -rp "⚠️  This will delete ALL memory data. Continue? [y/N] " reply
if [[ ! "$reply" =~ ^[Yy]$ ]]; then
  echo "Aborted."
  exit 0
fi

echo "🗑  Stopping and removing containers + volumes..."
docker compose down -v

echo "🚀 Rebuilding and starting fresh..."
docker compose up -d --build

echo "⏳ Waiting for services..."
./scripts/wait-for-services.sh

echo "✅ Reset complete. NeuroMem running on http://localhost:${NEUROMEM_PORT:-3000}"
