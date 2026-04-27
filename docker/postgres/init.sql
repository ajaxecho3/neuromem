-- ═══════════════════════════════════════════════════════════════
-- NeuroMem — Hippocampus & Amygdala schema
-- Episodic memories (events) + Affective weighting
-- ═══════════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";  -- for fuzzy text search

-- ─── Agents ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agents (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata      JSONB DEFAULT '{}'::jsonb
);

-- ─── Episodic memories (Hippocampus) ────────────────────────────
CREATE TABLE IF NOT EXISTS episodic_memories (
  id                  TEXT PRIMARY KEY,
  agent_id            TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  title               TEXT NOT NULL,
  content             TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_accessed       TIMESTAMPTZ NOT NULL DEFAULT now(),
  access_count        INTEGER NOT NULL DEFAULT 0,
  -- Affective (Amygdala) weighting
  importance          REAL NOT NULL DEFAULT 0.5 CHECK (importance BETWEEN 0 AND 1),
  valence             TEXT NOT NULL DEFAULT 'neutral' CHECK (valence IN ('positive','negative','neutral')),
  arousal             REAL NOT NULL DEFAULT 0.3 CHECK (arousal BETWEEN 0 AND 1),
  -- Consolidation tracking
  consolidation_level REAL NOT NULL DEFAULT 0 CHECK (consolidation_level BETWEEN 0 AND 1),
  decay_rate          REAL NOT NULL DEFAULT 0.05,
  -- Metadata
  tags                TEXT[] NOT NULL DEFAULT '{}',
  source              TEXT,
  shared              BOOLEAN NOT NULL DEFAULT FALSE,
  metadata            JSONB DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_episodic_agent_time
  ON episodic_memories (agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_importance
  ON episodic_memories (agent_id, importance DESC);
CREATE INDEX IF NOT EXISTS idx_episodic_tags
  ON episodic_memories USING GIN (tags);
CREATE INDEX IF NOT EXISTS idx_episodic_content_trgm
  ON episodic_memories USING GIN (content gin_trgm_ops);
CREATE INDEX IF NOT EXISTS idx_episodic_shared
  ON episodic_memories (shared) WHERE shared = TRUE;

-- ─── Skills (Procedural memory manifest) ────────────────────────
-- Actual skill vectors live in ChromaDB; this table tracks metadata.
CREATE TABLE IF NOT EXISTS skills (
  id               TEXT PRIMARY KEY,
  agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL,
  steps            JSONB NOT NULL DEFAULT '[]'::jsonb,
  success_count    INTEGER NOT NULL DEFAULT 0,
  failure_count    INTEGER NOT NULL DEFAULT 0,
  last_used        TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  shared           BOOLEAN NOT NULL DEFAULT FALSE,
  tags             TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_skills_agent ON skills (agent_id);
CREATE INDEX IF NOT EXISTS idx_skills_tags ON skills USING GIN (tags);

-- ─── Consolidation log ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS consolidation_runs (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  started_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at       TIMESTAMPTZ,
  processed_count    INTEGER NOT NULL DEFAULT 0,
  consolidated_count INTEGER NOT NULL DEFAULT 0,
  forgotten_count    INTEGER NOT NULL DEFAULT 0,
  new_semantic_count INTEGER NOT NULL DEFAULT 0,
  new_skills_count   INTEGER NOT NULL DEFAULT 0,
  report             JSONB
);

CREATE INDEX IF NOT EXISTS idx_consolidation_agent_time
  ON consolidation_runs (agent_id, started_at DESC);

-- ─── Default agent ──────────────────────────────────────────────
INSERT INTO agents (id, name) VALUES ('default', 'Default Agent')
ON CONFLICT (id) DO NOTHING;

-- ─── Helper: bump access on recall ──────────────────────────────
CREATE OR REPLACE FUNCTION touch_episodic(p_id TEXT)
RETURNS VOID AS $$
  UPDATE episodic_memories
    SET access_count  = access_count + 1,
        last_accessed = now()
    WHERE id = p_id;
$$ LANGUAGE SQL;

-- ─── Recall metering (live token-savings proof) ────────────────
-- One row per recall() call. Used by the UI to show real, cumulative
-- tokens NeuroMem has saved vs. the naive "stuff every memory into context"
-- baseline — i.e. how the system earns its keep in production, as opposed
-- to the synthetic benchmark numbers in .bench/*.json.
--
-- agent_id is intentionally not a FK to agents(id): we want metering to
-- survive agent deletion (for lifetime analytics) and not couple the hot
-- path to referential integrity.
CREATE TABLE IF NOT EXISTS recall_stats (
  id                     BIGSERIAL PRIMARY KEY,
  agent_id               TEXT NOT NULL,
  recalled_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  total_memory_count     INTEGER NOT NULL,
  returned_memory_count  INTEGER NOT NULL,
  baseline_tokens        INTEGER NOT NULL,
  neuromem_tokens        INTEGER NOT NULL,
  saved_tokens           INTEGER NOT NULL
                         GENERATED ALWAYS AS (baseline_tokens - neuromem_tokens) STORED,
  encoding               TEXT NOT NULL DEFAULT 'cl100k_base'
);

CREATE INDEX IF NOT EXISTS idx_recall_stats_agent_time
  ON recall_stats (agent_id, recalled_at DESC);
CREATE INDEX IF NOT EXISTS idx_recall_stats_time
  ON recall_stats (recalled_at DESC);

-- ─── Memory versions (versioning feature) ───────────────────────
-- Stores previous versions of episodic memories before update/replace.
CREATE TABLE IF NOT EXISTS memory_versions (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  memory_id     TEXT NOT NULL,          -- original episodic_memories.id
  agent_id      TEXT NOT NULL,
  version       INTEGER NOT NULL,       -- monotonically increasing per memory_id
  content       TEXT NOT NULL,
  title         TEXT NOT NULL,
  importance    REAL NOT NULL,
  tags          TEXT[] NOT NULL DEFAULT '{}',
  archived_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  reason        TEXT                    -- why it was superseded: 'update' | 'conflict_replace'
);

CREATE INDEX IF NOT EXISTS idx_memory_versions_memory_id
  ON memory_versions (memory_id, version DESC);
CREATE INDEX IF NOT EXISTS idx_memory_versions_agent
  ON memory_versions (agent_id, archived_at DESC);
