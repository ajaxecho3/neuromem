#!/usr/bin/env bash
# Block until all NeuroMem backing services are healthy.
set -euo pipefail

MAX_WAIT=${MAX_WAIT:-120}
ELAPSED=0

check() {
  local name=$1
  docker inspect --format='{{.State.Health.Status}}' "$name" 2>/dev/null || echo "missing"
}

echo "⏳ Waiting for services to become healthy (up to ${MAX_WAIT}s)..."

while [ $ELAPSED -lt $MAX_WAIT ]; do
  PG=$(check neuromem-postgres)
  CH=$(check neuromem-chromadb)
  NE=$(check neuromem-neo4j)
  RD=$(check neuromem-redis)

  printf "\r  postgres:%-10s  chroma:%-10s  neo4j:%-10s  redis:%-10s" \
    "$PG" "$CH" "$NE" "$RD"

  if [ "$PG" = "healthy" ] && [ "$CH" = "healthy" ] && \
     [ "$NE" = "healthy" ] && [ "$RD" = "healthy" ]; then
    echo -e "\n✅ All services healthy"
    exit 0
  fi

  sleep 2
  ELAPSED=$((ELAPSED + 2))
done

echo -e "\n❌ Timeout waiting for services"
exit 1
