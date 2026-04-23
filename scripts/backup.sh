#!/usr/bin/env bash
# Back up all NeuroMem data volumes to ./backups/YYYY-MM-DD/
set -euo pipefail

TIMESTAMP=$(date +%Y-%m-%d_%H-%M-%S)
BACKUP_DIR="./backups/$TIMESTAMP"
mkdir -p "$BACKUP_DIR"

echo "📦 Backing up to $BACKUP_DIR..."

# Postgres
echo "  → postgres"
docker exec neuromem-postgres pg_dump -U "${POSTGRES_USER:-neuromem}" "${POSTGRES_DB:-neuromem}" \
  > "$BACKUP_DIR/postgres.sql"

# Redis
echo "  → redis"
docker exec neuromem-redis redis-cli -a "${REDIS_PASSWORD:-neuromem-redis}" --no-auth-warning SAVE > /dev/null
docker cp neuromem-redis:/data/dump.rdb "$BACKUP_DIR/redis.rdb"

# Neo4j (dump via cypher)
echo "  → neo4j"
docker exec neuromem-neo4j cypher-shell \
  -u "${NEO4J_USER:-neo4j}" -p "${NEO4J_PASSWORD:-neuromem-pass}" \
  "CALL apoc.export.cypher.all(null, {stream:true, format:'plain'}) YIELD cypherStatements RETURN cypherStatements" \
  > "$BACKUP_DIR/neo4j.cypher" 2>/dev/null || echo "    (apoc export requires APOC plugin — skipped)"

# Chroma (copy volume)
echo "  → chromadb"
docker run --rm \
  -v neuromem_chromadb_data:/source:ro \
  -v "$(pwd)/$BACKUP_DIR":/backup \
  alpine tar czf /backup/chromadb.tar.gz -C /source .

echo "✅ Backup complete: $BACKUP_DIR"
