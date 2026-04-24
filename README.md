# 🧠 NeuroMem

A **brain-inspired persistent memory framework** for AI agents, running as a self-hosted Docker stack. Gives agents episodic, semantic, procedural, working, and affective memory — each backed by the optimal storage engine — with spaced-repetition decay, temporal reasoning, memory versioning, and a built-in web UI for inspection.

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│              Agents (Claude, GPT, custom…)               │
└──────────────────┬───────────────────────────────────────┘
                   │ MCP (stdio / SSE) · REST /tools/*
┌──────────────────▼───────────────────────────────────────┐
│              NeuroMem Server (TypeScript / Node)         │
│  remember · recall · associate · forget                  │
│  consolidate · reflect · memory_history · build_context  │
│                                                          │
│  ┌────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │MemoryRouter│  │BackgroundCog.│  │  InnerThought   │  │
│  │(LLM-aided) │  │(sleep cycle) │  │(Ollama/OAI/ANT) │  │
│  └────────────┘  └──────────────┘  └─────────────────┘  │
└──┬────────┬────────┬────────┬────────────────────────────┘
   │        │        │        │
   ▼        ▼        ▼        ▼
┌──────┬────────┬────────┬────────┐
│Redis │Postgres│ Chroma │ Neo4j  │
│(PFC) │ (Hip)  │ (TC)   │ (EC)   │
└──────┴────────┴────────┴────────┘
                   │
         ┌─────────▼─────────┐
         │   Web UI (React)  │
         │  localhost:3000   │
         └───────────────────┘
```

| Brain Region          | Memory Type  | Backend               | Why                           |
| --------------------- | ------------ | --------------------- | ----------------------------- |
| **Prefrontal Cortex** | Working      | Redis                 | Fast, TTL-based, bounded      |
| **Hippocampus**       | Episodic     | PostgreSQL            | Timeline + structured queries |
| **Amygdala**          | Affective    | PostgreSQL (weighted) | Valence/arousal metadata      |
| **Temporal Cortex**   | Semantic     | ChromaDB              | Vector similarity for facts   |
| **Cerebellum**        | Procedural   | ChromaDB              | Similar how-tos via vectors   |
| **Entorhinal Cortex** | Associations | Neo4j                 | Graph of memory links         |

---

## 🔬 Technical Deep Dive

### Memory Lifecycle

Every call to `remember()` passes through this pipeline:

```
Content
  │
  ▼
MemoryRouter.routeWithReasoning()
  ├─ Pattern matching (regex rules per type)
  ├─ Score all patterns → pick best match
  ├─ If bestScore <= 1 (ambiguous) → InnerThought LLM call
  │    └─ Returns: type, importance, valence, arousal, tags, reasoning
  └─ Resolved RoutingDecision
       │
       ▼
  Duplicate check (embedding similarity > 0.95 threshold)
       │
       ▼
  Conflict detection (semantic/procedural only)
  ├─ Negation heuristic: "not", "no longer", "wrong", etc. in related memories
  └─ InnerThought LLM call if related memories found
       │
       ▼
  Store in target backend
  ├─ working   → Redis (SETEX with TTL)
  ├─ episodic  → Postgres (episodic_memories)
  ├─ affective → Postgres (episodic_memories, weighted)
  ├─ semantic  → ChromaDB (semantic_memories collection)
  └─ procedural→ ChromaDB (procedural_memories collection)
```

### MemoryRouter — Classification

Routes content using a two-stage classifier:

**Stage 1 — Pattern matching** (fast, no LLM):

- `PROCEDURAL_PATTERNS`: "how to", "step-by-step", numbered lists, install/configure/deploy verbs
- `EPISODIC_PATTERNS`: temporal words (yesterday, today), first-person past actions ("I saw/did/met")
- `SEMANTIC_PATTERNS`: definitional phrases ("is a", "means", "by default", "generally")
- `AFFECTIVE_PATTERNS`: emotion words ("feel", "anxious", "frustrated", "grateful")
- `WORKING_PATTERNS`: transient markers ("current task", "right now", "remind me", "wip")

**Stage 2 — LLM enrichment** (when `bestScore <= 1`, i.e. ambiguous or no match):

- Calls `InnerThought` with a structured prompt
- Returns enriched metadata: type override, importance (0–1), valence, arousal, tags, reasoning
- Falls back to pattern result if LLM times out or fails

### InnerThought — Pluggable LLM

Abstraction layer over multiple LLM backends. Configured via `LLM_PROVIDER`:

| Provider    | Env var             | Default model                               |
| ----------- | ------------------- | ------------------------------------------- |
| `ollama`    | `OLLAMA_URL`        | `INNER_THOUGHT_MODEL=gemma4`                |
| `openai`    | `OPENAI_API_KEY`    | `INNER_THOUGHT_MODEL=gpt-4o-mini`           |
| `anthropic` | `ANTHROPIC_API_KEY` | `INNER_THOUGHT_MODEL=claude-haiku-20240307` |
| `none`      | —                   | Noop — skips all LLM calls                  |

Key settings:

- `INNER_THOUGHT_TIMEOUT_MS=2000` — hard timeout per LLM call
- `max_tokens=200` — kept small; InnerThought generates structured JSON only

### BackgroundCognition — Sleep Cycle

Runs on a configurable interval (`COGNITION_INTERVAL_MINUTES=30`) when `COGNITION_ENABLED=true`:

```
For each registered agent:
  1. reflect()   — compute memory health stats
  2. listForConsolidation() — fetch episodic memories with consolidation_level < 1
  3. For each candidate memory:
     InnerThought decides: forget | consolidate | promote | keep
  4. Execute decisions via MemoryManager
  5. Log cognition summary to working memory (TTL=1h)
```

Runs safely — all errors are caught and logged without crashing the server.

### Spaced Repetition — Ebbinghaus Forgetting Curve

Every recalled memory gets an annotated `retention` score computed as:

$$R = e^{-\Delta t \;/\; (S \times k)}$$

where:

- $\Delta t$ = days since `last_accessed`
- $k$ = `RETENTION_SCALE_DAYS` (default 30)
- $S$ = stability = `importance × (1 + ln(1 + access_count)) × (1 + consolidation_level)`

**`applyDecay`** (called during consolidation) recalculates each memory's importance proportionally:

```
new_importance = retention × original_importance
```

**Forget gate** — consolidator only forgets episodic memories where **all four** conditions hold:

1. `importance < 0.2`
2. `ageDays > 30`
3. `access_count < 2`
4. `retention < 0.1` (Ebbinghaus — nearly forgotten)

### Memory Versioning

Every `update()` on an episodic memory automatically archives the prior state:

```sql
-- memory_versions table
id          UUID PRIMARY KEY
memory_id   TEXT             -- references episodic_memories.id
agent_id    TEXT
version     INTEGER          -- monotonically increasing per memory_id
content     TEXT
title       TEXT
importance  REAL
tags        TEXT[]
archived_at TIMESTAMPTZ
reason      TEXT             -- 'update' | 'conflict_replace'
```

`archiveVersion(id, reason)` is called before every `update()` — the caller never needs to think about it.

### Hybrid Recall

`recall()` fans out across all relevant stores in parallel, then merges and re-ranks:

```
query
  │
  ├─ Working store   → Redis key scan (if type includes 'working')
  ├─ Episodic store  → Postgres ILIKE + importance×recency score
  └─ Semantic store  → ChromaDB embedding similarity (queryEmbeddings)
        │
        ▼
  Merge all results
  score = importance × 0.6 + recency × 0.4
        │
        ▼
  Slice to limit, annotate with retention score
        │
        ▼
  Fire-and-forget: reinforce access_count for episodic hits
```

**Browse mode** (`listAll`): skips embedding search entirely — uses Postgres `ORDER BY` and ChromaDB `.get()` with metadata filters. No query string required.

### Embeddings

Three pluggable providers via `EMBEDDING_PROVIDER`:

| Provider          | How                                                          | Dimensions |
| ----------------- | ------------------------------------------------------------ | ---------- |
| `local` (default) | `@xenova/transformers` — `all-MiniLM-L6-v2`, runs in-process | 384        |
| `openai`          | `text-embedding-3-small` via API                             | 1536       |
| `voyage`          | `voyage-3-lite` via API                                      | 512        |

### Data Schema (Postgres)

```sql
episodic_memories
  id TEXT PK, agent_id TEXT FK,
  title TEXT, content TEXT,
  occurred_at TIMESTAMPTZ, last_accessed TIMESTAMPTZ,
  access_count INTEGER,
  importance REAL [0,1], valence TEXT, arousal REAL [0,1],
  consolidation_level REAL [0,1], decay_rate REAL,
  tags TEXT[], shared BOOLEAN, metadata JSONB

memory_versions
  id UUID PK, memory_id TEXT, agent_id TEXT,
  version INTEGER, content TEXT, title TEXT,
  importance REAL, tags TEXT[],
  archived_at TIMESTAMPTZ, reason TEXT

agents
  id TEXT PK, name TEXT, created_at TIMESTAMPTZ, metadata JSONB

consolidation_runs
  id UUID PK, agent_id TEXT,
  started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
  processed_count, consolidated_count, forgotten_count,
  new_semantic_count, new_skills_count, report JSONB
```

### Environment Variables

| Variable                              | Default                  | Description                                   |
| ------------------------------------- | ------------------------ | --------------------------------------------- |
| `SERVER_MODE`                         | `http`                   | `http` or `stdio` (for Claude Desktop)        |
| `HTTP_PORT`                           | `3000`                   | Server port                                   |
| `LLM_PROVIDER`                        | `ollama`                 | `ollama` \| `openai` \| `anthropic` \| `none` |
| `INNER_THOUGHT_MODEL`                 | `gemma4`                 | Model name for the chosen provider            |
| `INNER_THOUGHT_TIMEOUT_MS`            | `2000`                   | LLM call hard timeout                         |
| `COGNITION_ENABLED`                   | `true`                   | Enable background sleep cycle                 |
| `COGNITION_INTERVAL_MINUTES`          | `30`                     | How often the sleep cycle runs                |
| `RETENTION_SCALE_DAYS`                | `30`                     | Ebbinghaus decay scale constant               |
| `EMBEDDING_PROVIDER`                  | `local`                  | `local` \| `openai` \| `voyage`               |
| `OLLAMA_URL`                          | `http://localhost:11434` | Ollama server URL                             |
| `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | —                        | Postgres connection                           |
| `CHROMA_HOST/PORT/TOKEN`              | —                        | ChromaDB connection                           |
| `NEO4J_URI/USER/PASSWORD`             | —                        | Neo4j connection                              |
| `REDIS_HOST/PORT/PASSWORD`            | —                        | Redis connection                              |

---

```bash
# 1. Clone + configure
git clone <your-repo> neuromem
cd neuromem
cp .env.example .env
# edit .env — at minimum, change the passwords

# 2. Bring up the stack
docker compose up -d --build

# 3. Wait for all services to be healthy
./scripts/wait-for-services.sh

# 4. Verify
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}

# 5. Open the Web UI
open http://localhost:3000
```

## 🔌 Connecting Agents

### Option A: REST

```bash
curl -X POST http://localhost:3000/tools/remember \
  -H 'Content-Type: application/json' \
  -d '{"content":"User prefers dark mode","agent_id":"alice","importance":0.8}'
```

---

### Option B: Claude Desktop (MCP via stdio)

The stdio process runs locally and connects to the Docker services directly. Build the project first, then add the entry to Claude Desktop's config.

**Step 1 — Build**

```bash
cd /path/to/neuromem
npm install && npm run build
```

**Step 2 — Add to `~/Library/Application Support/Claude/claude_desktop_config.json`**

```json
{
  "mcpServers": {
    "neuromem": {
      "command": "node",
      "args": ["/absolute/path/to/neuromem/dist/mcp/server.js"],
      "env": {
        "SERVER_MODE": "stdio",
        "POSTGRES_HOST": "localhost",
        "POSTGRES_PORT": "5432",
        "POSTGRES_DB": "neuromem",
        "POSTGRES_USER": "neuromem",
        "POSTGRES_PASSWORD": "your-postgres-password",
        "CHROMA_HOST": "localhost",
        "CHROMA_PORT": "8000",
        "CHROMA_TOKEN": "your-chroma-token",
        "NEO4J_URI": "bolt://localhost:7687",
        "NEO4J_USER": "neo4j",
        "NEO4J_PASSWORD": "your-neo4j-password",
        "REDIS_HOST": "localhost",
        "REDIS_PORT": "6379",
        "REDIS_PASSWORD": "your-redis-password",
        "LLM_PROVIDER": "none"
      }
    }
  }
}
```

> Use the passwords from your `.env` file. `LLM_PROVIDER=none` skips InnerThought in the stdio process — the Docker server already handles cognition.

**Step 3 — Restart Claude Desktop** and look for the 🔨 tools icon in the chat input.

---

### Option C: VS Code / GitHub Copilot (MCP via Streamable HTTP)

The server exposes MCP over HTTP at `/mcp` — no build needed, works directly against the running Docker container.

Add to `.vscode/mcp.json` in your workspace (or VS Code `settings.json`):

```json
{
  "servers": {
    "neuromem": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

---

### Option D: Claude CLI

```bash
claude mcp add --transport http neuromem http://localhost:3000/mcp

# Verify
claude mcp list
```

---

### Option E: Any MCP-compatible client (Streamable HTTP)

Point your client at:

```
http://localhost:3000/mcp
```

Supports the MCP Streamable HTTP transport spec (POST/GET/DELETE on the same endpoint with `mcp-session-id` header).

## 🛠️ MCP Tools

| Tool                   | Purpose                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| `remember`             | Store a memory (auto-routed by type + LLM enrichment)                   |
| `recall`               | Hybrid search across all stores; supports natural-language time queries |
| `associate`            | Link two memories in the association graph                              |
| `spreading_activation` | Find memories within N graph hops of a seed memory                      |
| `forget`               | Delete by ID or by semantic query                                       |
| `consolidate`          | Run the sleep-inspired compression pass for an agent                    |
| `reflect`              | Aggregate stats — counts, top tags, consolidation ratio                 |
| `memory_history`       | Retrieve the full version history of an episodic memory                 |
| `build_context`        | Return a compact, ready-to-inject context string for LLM prompts        |

## 🧠 Writing Memories

The router auto-classifies content using pattern matching + LLM fallback:

```json
POST /tools/remember
{
  "content": "How to deploy: 1. npm build  2. Push  3. Verify",
  "agent_id": "alice"
}
```

→ routed to `procedural` (step-by-step pattern)

Override with an explicit type or add tags:

```json
{
  "content": "The API rate limit is 1000 req/min",
  "type": "semantic",
  "importance": 0.9,
  "tags": ["api", "limits"]
}
```

## 🔍 Recalling Memories

```json
POST /tools/recall
{
  "query": "deployment process",
  "agent_id": "alice",
  "type": ["procedural", "semantic"],
  "limit": 5
}
```

Results are ranked by `importance × recency` and annotated with a **retention score** (Ebbinghaus forgetting curve). Retrieval bumps each memory's access count.

### Time-based queries

```json
{
  "query": "what did we discuss",
  "agent_id": "alice",
  "time_query": "last week"
}
```

Supports: `today`, `yesterday`, `last N days/weeks/months`, `this week`, `past N hours`.

## 💤 Consolidation

Mirrors sleep-based memory consolidation. Run periodically or let the background loop handle it:

```json
POST /tools/consolidate
{ "agent_id": "alice" }
```

Effects:

1. Cluster episodic memories by shared tags
2. Abstract clusters into semantic memories (LLM summarizer via `InnerThought`)
3. Forget memories that are old, low-importance, rarely accessed, **and** have near-zero retention (Ebbinghaus decay)

## 📈 Spaced Repetition & Decay

Memories decay using the **Ebbinghaus forgetting curve**. Each memory carries a computed `retention` score on recall:

- `stability` is derived from importance, access count, and consolidation level
- `decay_rate` adjusts per-memory based on usage
- The consolidator only forgets memories where importance, age, access count, **and** retention all indicate disuse
- `applyDecay` recalculates importance proportionally instead of using a flat SQL UPDATE

Configure the decay scale: `RETENTION_SCALE_DAYS=30` (default).

## 🔢 Memory Versioning

Every `PUT /api/ui/memories/:id` automatically archives the previous state before updating. Full history is retrievable:

```bash
GET /api/ui/memories/:id/history
# Returns all previous versions with timestamp and reason
```

Via MCP:

```json
{ "tool": "memory_history", "id": "epi_abc123" }
```

Note: versioning applies to episodic (`epi_`) memories only.

## 🕸️ Cross-Agent Memory

Mark a memory `"shared": true` to put it in the shared pool. Any agent's `recall` with `include_shared: true` (default) can retrieve it.

## 🖥️ Web UI

Built-in React dashboard served at `http://localhost:3000`:

| View                | Description                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------------- |
| **Memory Browser**  | Browse all memories across agents, filter by type/importance/tags, paginate, click through to detail |
| **Memory Detail**   | Edit title, importance, tags; view version history; delete                                           |
| **Graph View**      | Visual association graph — nodes by memory type, edges by association strength                       |
| **Context Builder** | Build and preview an LLM-ready context string for any agent + query                                  |
| **Agent Dashboard** | Per-agent memory counts, consolidation stats, decay overview                                         |
| **Cognition Log**   | Live stream of InnerThought background processing events                                             |

## 🗂️ Project Structure

```
neuromem/
├── docker-compose.yml          # 5-service stack
├── docker/
│   ├── Dockerfile              # NeuroMem server image
│   └── postgres/init.sql       # Schema: episodic, memory_versions, skills, consolidation_runs
├── src/
│   ├── stores/
│   │   ├── EpisodicStore.ts    # Postgres — episodic + versioning
│   │   ├── SemanticStore.ts    # ChromaDB — semantic + procedural
│   │   ├── WorkingStore.ts     # Redis — working memory
│   │   ├── AssociationStore.ts # Neo4j — memory graph
│   │   └── MemoryManager.ts    # Orchestrator + listAll + recall
│   ├── router/
│   │   └── MemoryRouter.ts     # Pattern + LLM-based type classifier
│   ├── consolidation/
│   │   └── Consolidator.ts     # Sleep cycle — cluster, abstract, forget
│   ├── cognition/
│   │   ├── BackgroundCognition.ts  # Autonomous sleep loop
│   │   ├── InnerThought.ts     # Pluggable LLM client (Ollama/OpenAI/Anthropic)
│   │   └── LLMProvider.ts
│   ├── embeddings/             # Pluggable: local / OpenAI / Voyage
│   ├── mcp/server.ts           # MCP + HTTP entry point
│   ├── ui-api/routes.ts        # REST API for the Web UI
│   └── utils/
│       ├── config.ts           # Env-based config
│       ├── retention.ts        # Ebbinghaus forgetting curve math
│       └── timeParser.ts       # Natural language → time range
├── ui/                         # React + Vite dashboard
│   └── src/
│       ├── views/              # MemoryBrowser, MemoryDetail, GraphView, …
│       ├── components/         # DataGrid, ImportanceBar, AgentSelector, …
│       └── api/                # Typed API client
├── skills/                     # Agent skill files (tell agents when/how to use NeuroMem)
│   ├── memory-session-start/
│   ├── memory-continuous/
│   ├── memory-consolidate/
│   ├── memory-recall/
│   ├── memory-reflect/
│   └── memory-session-end/
├── scripts/
│   ├── backup.sh               # Snapshot all data volumes
│   ├── reset.sh                # Nuclear reset
│   └── wait-for-services.sh    # Health poller
└── examples/demo.ts            # End-to-end demo
```

## 🔐 Security Notes

Before deploying beyond localhost:

- Change ALL passwords in `.env`
- Put the server behind an auth proxy (reverse proxy + bearer token)
- Restrict Postgres/Chroma/Neo4j/Redis ports to the Docker network only (remove `ports:` in compose for internal services)
- Disable Neo4j HTTP (`7474`) in production

## 🗺️ Roadmap

- [x] LLM-powered consolidation (Ollama/gemma4 via `InnerThought`)
- [x] Background cognition loop — autonomous sleep-cycle memory management
- [x] Spaced repetition / Ebbinghaus forgetting curve decay
- [x] Temporal reasoning — natural-language time queries (`"last week"`, `"past 3 hours"`)
- [x] LLM router threshold improvement — catches ambiguous single-hit classifications
- [x] Memory versioning — auto-archive before every update, full history via API + MCP
- [x] Web UI — memory browser, graph view, context builder, agent dashboard, cognition log
- [x] Multi-agent enumeration — agents listed from registry, all-agents browse mode
- [ ] Conflict detection + auto-replace on contradiction
- [ ] Embedding caching layer
- [ ] Python client SDK
- [x] Benchmark suite: recall@K, MRR, nDCG, latency — `npm run bench` (see [src/eval/README.md](src/eval/README.md))
- [x] Proof suite: persistence, cross-harness portability (REST → MCP), task utility (cold vs warm LLM) — `npm run proof` (see [src/eval/proof/README.md](src/eval/proof/README.md))

## 📜 License

MIT
