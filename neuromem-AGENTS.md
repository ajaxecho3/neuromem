# NeuroMem — Persistent Memory Directive

You are connected to the NeuroMem MCP server. Your `agent_id` for all memory
calls is: **NEUROMEM_AGENT_ID** *(set by the installer — do not change)*

Before making any other tool call at the start of a session, evaluate:
> "Have I called `recall()` yet this session?"

If the answer is no — **call it now**, using the topic from the user's opening
message as the query. Do NOT read files, search the codebase, or call any other
tool before completing this step.

The memory system has four stores — auto-routed, no need to pass `type`:

- **Working** (Redis) — ephemeral session state, auto-expires
- **Episodic** (PostgreSQL) — events, decisions, experiences along a timeline
- **Semantic** (ChromaDB) — facts, preferences, concepts as vector embeddings
- **Procedural** (ChromaDB) — reusable skills and how-tos

---

## Forced Evaluation — Session Start

```
# STEP 1 — always, before anything else
recall(
  query: "<derived from user's opening message>",
  agent_id: "NEUROMEM_AGENT_ID",
  limit: 10,
  include_shared: true
)

# STEP 2 — if step 1 returned ≥1 result and topic is complex
spreading_activation(id: "<top result id>", hops: 2, limit: 10)
```

**Query derivation:**
- "let's keep working on the auth module" → `"auth module"`
- "can you recall what this project can do?" → `"project capabilities"`
- "morning!" → `"recent sessions preferences"`
- "what's 42 × 7?" → *skip recall — no personal context possible*

**Right vs wrong:**

```
# CORRECT
recall(query="neuromem install script", agent_id="NEUROMEM_AGENT_ID")
# → then use recalled context, then read files only if still needed

# WRONG — never do this before recall
Read("README.md")
Glob("scripts/**")
WebSearch("what does this project do")
```

---

## During the Conversation

Call `remember` when the current turn contains something worth keeping:

| Signal | Type | Importance |
|--------|------|------------|
| User states a preference or constraint | `semantic` | 0.7–0.9 |
| User shares a personal fact | `semantic` | 0.6–0.8 |
| A decision is made | `episodic` | 0.8–0.95 |
| A task is completed or started | `episodic` | 0.7–0.85 |
| A reusable procedure is discussed | `procedural` | 0.75–0.9 |
| Temporary session context | `working` | 0.5 |

Call `associate(id_a, id_b)` when two memories are clearly linked — same
project, cause and effect, or the user explicitly connects them.

**Skip** trivial exchanges: "OK", "thanks", "got it", small talk.

---

## Corrections

When the user corrects something:
```
forget(query: "<what was wrong>", agent_id: "NEUROMEM_AGENT_ID")
remember(content: "<corrected version>", agent_id: "NEUROMEM_AGENT_ID", ...)
```
Never leave contradictions — always forget the old version, then write the new one.

---

## Session End

```
reflect(agent_id: "NEUROMEM_AGENT_ID", timeframe_days: 7)
# if counts.episodic > 15 and semantic ratio is low → consolidate
consolidate(agent_id: "NEUROMEM_AGENT_ID")
```

---

## Tool Quick Reference

```
remember(content, agent_id, tags?, importance?, type?, ttl_seconds?)
recall(query, agent_id, limit?, type?, min_importance?, include_shared?)
associate(id_a, id_b)
spreading_activation(id, hops?, limit?)
forget(id)
forget(query, agent_id, type?, limit?)
consolidate(agent_id)
reflect(agent_id, timeframe_days?)
build_context(query, agent_id, ...)
remember_batch([...])
memory_history(agent_id, ...)
```

---

## Rules

1. **Never announce tool calls.** No "let me check my memory" or "I'll remember that."
2. **recall() before any other tool at session start.** No exceptions.
3. **One memory, one idea.** Split compound information across multiple `remember` calls.
4. **Importance honestly.** Reserve 0.9+ for truly critical facts. Most are 0.5–0.8.
5. **Translate responses.** Never dump raw JSON — weave recalled context naturally.
6. **agent_id is fixed.** Always use `NEUROMEM_AGENT_ID` — never `"default"`.
