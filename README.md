# 🧠 NeuroMem

**Persistent, brain-inspired memory for AI agents — episodic, semantic, procedural, working, and affective — via MCP or a drop-in LLM proxy.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-22%2B-green.svg)](https://nodejs.org)
[![Docker](https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white)](docker-compose.yml)
[![MCP](https://img.shields.io/badge/MCP-compatible-blueviolet)](https://modelcontextprotocol.io)

NeuroMem is a self-hosted memory framework that gives AI agents long-term memory across sessions. It maps five human memory systems onto the optimal storage engine for each, wraps them behind an MCP server and REST API, and adds spaced-repetition decay, background consolidation, and a web UI for inspection — so agents remember what matters and forget what doesn't.

---

## Why NeuroMem?

Most AI agents are stateless — every conversation starts from scratch. NeuroMem solves that without gluing in a single flat vector store:

- **Five memory types, five backends** — each optimised for its job (Redis for fast working memory, Postgres for episodic timelines, ChromaDB for semantic similarity, Neo4j for associations, Postgres weighted for affective valence)
- **Automatic routing** — content is classified and stored in the right type without the agent having to decide
- **Forgetting curve** — memories decay by the Ebbinghaus model, so the agent isn't drowning in stale context
- **Zero-code integration** — point any OpenAI-compatible agent at the proxy, and memory injection + extraction happen automatically on every turn
- **Works with any MCP client** — Claude Desktop, VS Code Copilot, the Claude CLI, or any Streamable HTTP client

---

## 🏗️ Architecture

```
┌──────────────────────────────────────────────────────────┐
│              Agents (Claude, GPT, custom…)               │
└──────────────────┬───────────────────────────────────────┘
                   │ MCP (stdio / SSE) · REST /tools/*
                   │ OpenAI-compatible proxy (optional)
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

## 🚀 Quick Start

```bash
# 1. Clone + configure
git clone https://github.com/your-org/neuromem.git
cd neuromem
cp .env.example .env
# edit .env — at minimum, change the passwords

# 2. Start the stack
docker compose up -d --build

# 3. Wait for all services to be healthy
./scripts/wait-for-services.sh

# 4. Verify
curl http://localhost:3000/health
# → {"status":"ok","timestamp":"..."}

# 5. Open the Web UI
open http://localhost:3000
```

---

## 🔌 Connecting Agents

### Option A: REST

```bash
curl -X POST http://localhost:3000/tools/remember \
  -H 'Content-Type: application/json' \
  -d '{"content":"User prefers dark mode","agent_id":"alice","importance":0.8}'
```

---

### Option B: Claude Desktop (MCP via stdio)

Build first, then add the entry to Claude Desktop's config:

**Step 1 — Build**

```bash
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

**Step 3 — Restart Claude Desktop** and look for the 🔨 tools icon.

---

### Option C: VS Code / GitHub Copilot (MCP via Streamable HTTP)

Add to `.vscode/mcp.json` in your workspace:

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

### Option D: Claude Code / Copilot CLI (`make install` — recommended)

Runs the full setup in one command: starts Docker, registers the MCP server, installs the `memory-orchestrate` skill, and writes a `~/.claude/CLAUDE.md` with a forced eval hook so the agent calls `recall()` before any other tool at session start.

```bash
make install
# or for Claude Code only:
make install-claude
```

What `make install` does for Claude Code:
1. Registers `http://localhost:3000/mcp` as an MCP server via `claude mcp add`
2. Installs `skills/memory-orchestrate/` → `~/.claude/skills/memory-orchestrate/`
3. Writes/patches `~/.claude/CLAUDE.md` with your pinned `agent_id` and the memory eval hook

To connect manually:

```bash
claude mcp add --transport http neuromem http://localhost:3000/mcp
cp -r skills/memory-orchestrate ~/.claude/skills/
# then patch ~/.claude/CLAUDE.md — see neuromem-AGENTS.md for the block to add
```

---

### Option E: Any MCP-compatible client (Streamable HTTP)

```
http://localhost:3000/mcp
```

Supports the MCP Streamable HTTP transport spec (POST/GET/DELETE on the same endpoint with `mcp-session-id` header).

---

### Option F: Drop-in LLM Proxy (zero-code memory injection)

NeuroMem can act as an OpenAI-compatible proxy between your agent and any LLM API. Your agent only changes its `baseURL` — no other code changes required.

**Per-request flow:**
1. Parse the incoming chat request
2. Recall relevant memories → inject a `<memory>` block into the system prompt
3. Forward the augmented request to the real LLM API
4. Stream/return the response with observability headers
5. Run `extractAndStore()` in the background — automatically mines the exchange for facts, decisions, and preferences

**Enable in `.env`:**

```env
PROXY_ENABLED=true
PROXY_TARGET_URL=https://api.openai.com   # or https://api.anthropic.com
PROXY_TARGET_PROVIDER=openai              # openai | anthropic
PROXY_PORT=3001
PROXY_MEMORY_BUDGET_PCT=0.20
```

**Point your agent at the proxy:**

```python
# OpenAI SDK
client = OpenAI(
    base_url="http://localhost:3001/v1",
    api_key=os.environ["OPENAI_API_KEY"],
    default_headers={"X-NeuroMem-Agent-Id": "my-agent"}
)
```

```typescript
// Vercel AI SDK / any OpenAI-compatible client
const openai = createOpenAI({ baseURL: "http://localhost:3001/v1" });
```

Use `extract_turn` directly (see MCP Tools) if you prefer explicit control over extraction rather than the proxy.

---

## 🛠️ MCP Tools

| Tool                   | Purpose                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `remember`             | Store a memory (auto-routed by type + LLM enrichment)                                               |
| `remember_batch`       | Store multiple memories in one call — reduces round-trips at session end                             |
| `recall`               | Hybrid search across all stores; supports natural-language time queries                              |
| `associate`            | Link two memories in the association graph                                                           |
| `spreading_activation` | Find memories within N graph hops of a seed memory                                                   |
| `forget`               | Delete by ID or by semantic query                                                                    |
| `consolidate`          | Run the sleep-inspired compression pass for an agent                                                 |
| `reflect`              | Aggregate stats — counts, top tags, consolidation ratio                                              |
| `memory_history`       | Retrieve the full version history of an episodic memory                                              |
| `build_context`        | Return a token-budgeted, ready-to-inject context string; supports `project_root` for staleness checks |
| `extract_turn`         | Manually trigger post-turn extraction on a conversation exchange — identifies and stores key facts   |

---

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

---

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

---

## 🧹 Staleness Detection

Memories can be linked to source files at store time (the proxy and `extract_turn` do this automatically when `project_root` is set). When `build_context` is called with `project_root`, NeuroMem hashes each recalled memory's source file against the version stored when the memory was written. Memories whose file has since changed or been deleted are excluded from injection and reported in `stale_files`:

```json
POST /tools/build_context
{
  "query": "how does auth work",
  "agent_id": "alice",
  "project_root": "/absolute/path/to/project",
  "model": "gpt-4o",
  "context_budget": 2048
}
```

Response includes:

```json
{
  "context": "...",
  "metadata": {
    "injected_count": 4,
    "tokens_used": 312,
    "stale_files": ["src/auth/middleware.ts"]
  }
}
```

`stale_files` is a signal to re-analyse those files and refresh the affected memories.

---

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

---

## 📈 Spaced Repetition & Decay

Memories decay using the **Ebbinghaus forgetting curve**. Each memory carries a computed `retention` score on recall:

$$R = e^{-\Delta t \;/\; (S \times k)}$$

where:

- $\Delta t$ = days since `last_accessed`
- $k$ = `RETENTION_SCALE_DAYS` (default 30)
- $S$ = stability = `importance × (1 + ln(1 + access_count)) × (1 + consolidation_level)`

- `stability` is derived from importance, access count, and consolidation level
- `decay_rate` adjusts per-memory based on usage
- The consolidator only forgets memories where importance, age, access count, **and** retention all indicate disuse
- Configure the scale: `RETENTION_SCALE_DAYS=30`

---

## 🔢 Memory Versioning

Every `PUT /api/ui/memories/:id` automatically archives the previous state. Full history is retrievable:

```bash
GET /api/ui/memories/:id/history
# Returns all previous versions with timestamp and reason
```

Via MCP:

```json
{ "tool": "memory_history", "id": "epi_abc123" }
```

Note: versioning applies to episodic (`epi_`) memories only.

---

## 🕸️ Cross-Agent Memory

Mark a memory `"shared": true` to put it in the shared pool. Any agent's `recall` with `include_shared: true` (default) can retrieve it.

---

## 🖥️ Web UI

Built-in React dashboard at `http://localhost:3000`:

| View                | Description                                                                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------ |
| **Memory Browser**  | Browse all memories across agents; filter by type/importance/tags; live "tokens saved" metering tiles |
| **Memory Detail**   | Edit title, importance, tags; view version history; delete                                             |
| **Graph View**      | Visual association graph — nodes by memory type, edges by association strength                         |
| **Context Builder** | Build and preview an LLM-ready context string for any agent + query                                    |
| **Agent Dashboard** | Per-agent memory counts, consolidation stats, decay overview                                           |
| **Cognition Log**   | Live stream of InnerThought background processing events                                               |

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
| `ollama`    | `OLLAMA_URL`        | `INNER_THOUGHT_MODEL=llama3.2:3b`           |
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

| Provider          | How                                                           | Dimensions |
| ----------------- | ------------------------------------------------------------- | ---------- |
| `local` (default) | `@xenova/transformers` — `all-MiniLM-L6-v2`, runs in-process | 384        |
| `openai`          | `text-embedding-3-small` via API                              | 1536       |
| `voyage`          | `voyage-3-lite` via API                                       | 512        |

### Memory Versioning (internals)

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

---

## ⚙️ Environment Variables

| Variable                              | Default                  | Description                                            |
| ------------------------------------- | ------------------------ | ------------------------------------------------------ |
| `SERVER_MODE`                         | `http`                   | `http` or `stdio` (for Claude Desktop)                 |
| `HTTP_PORT`                           | `3000`                   | Server port                                            |
| `LLM_PROVIDER`                        | `ollama`                 | `ollama` \| `openai` \| `anthropic` \| `none`          |
| `INNER_THOUGHT_MODEL`                 | `llama3.2:3b`            | Model name for the chosen provider                     |
| `INNER_THOUGHT_TIMEOUT_MS`            | `2000`                   | LLM call hard timeout                                  |
| `COGNITION_ENABLED`                   | `true`                   | Enable background sleep cycle                          |
| `COGNITION_INTERVAL_MINUTES`          | `30`                     | How often the sleep cycle runs                         |
| `RETENTION_SCALE_DAYS`                | `30`                     | Ebbinghaus decay scale constant                        |
| `EMBEDDING_PROVIDER`                  | `local`                  | `local` \| `openai` \| `voyage`                        |
| `OLLAMA_URL`                          | `http://localhost:11434` | Ollama server URL                                      |
| `POSTGRES_HOST/PORT/DB/USER/PASSWORD` | —                        | Postgres connection                                    |
| `CHROMA_HOST/PORT/TOKEN`              | —                        | ChromaDB connection                                    |
| `NEO4J_URI/USER/PASSWORD`             | —                        | Neo4j connection                                       |
| `REDIS_HOST/PORT/PASSWORD`            | —                        | Redis connection                                       |
| `PROXY_ENABLED`                       | `false`                  | Enable the drop-in LLM proxy                           |
| `PROXY_PORT`                          | `3001`                   | Port the proxy listens on                              |
| `PROXY_TARGET_URL`                    | —                        | Upstream LLM base URL (e.g. `https://api.openai.com`)  |
| `PROXY_TARGET_PROVIDER`               | `openai`                 | `openai` \| `anthropic` — affects SSE parsing          |
| `PROXY_MEMORY_BUDGET_PCT`             | `0.20`                   | Fraction of context for memories (clamped 0.05–0.40)   |

---

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
│   │   ├── MemoryManager.ts    # Orchestrator + listAll + recall
│   │   ├── RecallStatsStore.ts # Per-recall token metering (powers UI "tokens saved" tiles)
│   │   └── IndexManager.ts     # JSON side-indices for fast lookup (metadata, tags, associations)
│   ├── router/
│   │   └── MemoryRouter.ts     # Pattern + LLM-based type classifier
│   ├── consolidation/
│   │   └── Consolidator.ts     # Sleep cycle — cluster, abstract, forget
│   ├── cognition/
│   │   ├── BackgroundCognition.ts  # Autonomous sleep loop
│   │   ├── InnerThought.ts     # Pluggable LLM client (Ollama/OpenAI/Anthropic)
│   │   ├── Extractor.ts        # Post-turn extraction pipeline (auto-mines facts from exchanges)
│   │   ├── StalenessChecker.ts # Validates memory freshness against source file hashes
│   │   └── LLMProvider.ts
│   ├── proxy/
│   │   └── ProxyServer.ts      # Drop-in OpenAI-compatible proxy with memory injection + extraction
│   ├── embeddings/             # Pluggable: local / OpenAI / Voyage
│   ├── mcp/server.ts           # MCP + HTTP entry point
│   ├── ui-api/routes.ts        # REST API for the Web UI
│   └── utils/
│       ├── config.ts           # Env-based config
│       ├── retention.ts        # Ebbinghaus forgetting curve math
│       ├── SourceHasher.ts     # File hashing for staleness detection
│       └── timeParser.ts       # Natural language → time range
├── ui/                         # React + Vite dashboard
│   └── src/
│       ├── views/              # MemoryBrowser, MemoryDetail, GraphView, …
│       ├── components/         # DataGrid, ImportanceBar, AgentSelector, …
│       └── api/                # Typed API client
├── skills/                     # Agent skill files (tell agents when/how to use NeuroMem)
│   └── memory-orchestrate/     # Single discoverable skill — optimised description + USE WHEN triggers
│       ├── SKILL.md            # Entry point; loaded by the skill router at session start
│       └── docs/               # Granular guides loaded on-demand (not indexed at startup)
│           ├── memory-session-start.md
│           ├── memory-continuous.md
│           ├── memory-forget.md
│           ├── memory-session-end.md
│           ├── memory-recall.md
│           ├── memory-reflect.md
│           ├── memory-consolidate.md
│           └── memory-write.md
├── scripts/
│   ├── backup.sh               # Snapshot all data volumes
│   ├── reset.sh                # Nuclear reset
│   └── wait-for-services.sh    # Health poller
└── examples/demo.ts            # End-to-end demo
```

---

## 🔐 Security Notes

Before deploying beyond localhost:

- Change **all** passwords in `.env`
- Put the server behind an auth proxy (reverse proxy + bearer token)
- Restrict Postgres/Chroma/Neo4j/Redis ports to the Docker network (remove `ports:` for internal services)
- Disable Neo4j HTTP (`7474`) in production

---

## 🗺️ Roadmap

- [x] LLM-powered consolidation (Ollama/local via `InnerThought`)
- [x] Background cognition loop — autonomous sleep-cycle memory management
- [x] Spaced repetition / Ebbinghaus forgetting curve decay
- [x] Temporal reasoning — natural-language time queries (`"last week"`, `"past 3 hours"`)
- [x] LLM router threshold improvement — catches ambiguous single-hit classifications
- [x] Memory versioning — auto-archive before every update, full history via API + MCP
- [x] Web UI — memory browser, graph view, context builder, agent dashboard, cognition log
- [x] Multi-agent enumeration — agents listed from registry, all-agents browse mode
- [x] Conflict detection — negation heuristic + LLM arbitration; `conflict_replace` tracked in version history
- [x] Drop-in LLM proxy — OpenAI-compatible with automatic memory injection and post-turn extraction
- [x] Post-turn memory extraction — `extract_turn` tool + `Extractor` pipeline
- [x] Staleness detection — source-file hashing; stale memories excluded from `build_context` injection
- [x] Token metering — per-recall baseline vs injected token counts, surfaced in Memory Browser
- [x] Benchmark suite: recall@K, MRR, nDCG, latency — `npm run bench` (see [src/eval/README.md](src/eval/README.md))
- [x] Proof suite: persistence, cross-harness portability (REST → MCP), task utility — `npm run proof` (see [src/eval/proof/README.md](src/eval/proof/README.md))
- [x] Skill restructure — single `memory-orchestrate` skill with progressive disclosure via `docs/`; eliminates router ambiguity from 9 competing top-level skills
- [x] Optimised skill descriptions — USE WHEN triggers, third-person voice, Out of Scope blocks, concrete before/after examples; activation rate ~20% → 50%+
- [x] `make install` generates `~/.claude/CLAUDE.md` — forced eval hook pins `agent_id` and ensures `recall()` fires before any file read at session start
- [ ] Embedding caching layer
- [ ] Python client SDK

---

## 🤝 Contributing

Issues and pull requests are welcome. For large changes, open an issue first to discuss the approach.

```bash
npm install
npm run dev          # start the server in watch mode
npm run dev:ui       # start the Vite UI dev server
npm run test:unit    # unit tests (no Docker required)
npm run test:all     # full integration suite (requires Docker)
npm run bench        # recall benchmark
```

---

## 📜 License

[MIT](LICENSE)
