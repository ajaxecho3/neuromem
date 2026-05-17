---
name: memory-orchestrate
description: >
  Manages persistent memory across sessions using the NeuroMem MCP server. Use when
  any conversation starts (ALWAYS call recall() before any other tool), when user
  references past context ("last time", "as usual", "we discussed", "my preferences",
  "remember when"), before any research, coding, writing, planning or multi-step task,
  when user states a preference or fact worth keeping, when a decision is made or task
  completed, when user corrects prior information, when user asks "what do you know
  about me" or "what have we worked on", or when a session is wrapping up. Do NOT
  read project files to answer context questions before calling recall().
---

# NeuroMem Memory Orchestration

Connected to a brain-inspired memory system with four stores — the system auto-routes
each memory, you do not need to pass `type` unless overriding.

- **Working** (Redis) — ephemeral session state, auto-expires
- **Episodic** (PostgreSQL) — events, decisions, experiences with timeline
- **Semantic** (ChromaDB) — facts, preferences, concepts as vector embeddings
- **Procedural** (ChromaDB) — reusable skills and how-tos

## Out of Scope

This skill does NOT read project files to answer context questions.
Do NOT call Read, Glob, or any file search tool before calling recall().
If the user asks about prior work, prior decisions, or their preferences — call recall() first, always.

---

## Trigger Table

| When | Tool | Detail |
|------|------|--------|
| Conversation begins | `recall` → `spreading_activation` | [memory-session-start.md](docs/memory-session-start.md) |
| User states preference, fact, decision, or completes task | `remember` | [memory-continuous.md](docs/memory-continuous.md) |
| Two topics/memories are clearly related | `associate` | [memory-continuous.md](docs/memory-continuous.md) |
| User corrects or retracts something | `forget` → `remember` | [memory-forget.md](docs/memory-forget.md) |
| User asks "what do you remember?" or meta-questions | `reflect` | [memory-reflect.md](docs/memory-reflect.md) |
| Conversation ends or user says done/bye | `reflect` → `consolidate` | [memory-session-end.md](docs/memory-session-end.md) |

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

## agent_id Convention

Use a stable user identifier — email prefix, username, or UUID. Never change it between
sessions. If the harness exposes an email, derive from it (e.g. `bernardo.ochoa`).
Fall back to `"default"` only for anonymous contexts.

---

## Session Lifecycle

```
Session start  →  recall(topic) → spreading_activation(top_id)
During convo   →  remember() on facts/decisions | associate() on linked topics
User corrects  →  forget(old) → remember(new)
Meta-question  →  reflect(agent_id)
Session end    →  reflect() → consolidate() if warranted
```

---

## Concrete Examples

**Session starts — user references a project:**
> "Let's keep working on the neuromem install script."

```
# CORRECT — call recall first, before any file reads
recall(query="neuromem install script", agent_id="<derived_id>", limit=10)
# Then spreading_activation on the top result id if found
# Only THEN do any file reading or coding
```

```
# WRONG — going straight to files
Read("README.md")   ← never before recall
Glob("scripts/**")  ← never before recall
```

**Session starts — vague opener:**
> "Hey, what's up?"

```
recall(query="recent session preferences projects", agent_id="<derived_id>", limit=5)
# If nothing found, proceed normally without mentioning it
```

**User states a preference:**
> "I always want short, direct answers — no bullet lists."

```
remember(
  content="User prefers short direct answers with no bullet lists",
  agent_id="<derived_id>",
  tags=["preferences", "communication"],
  importance=0.8
)
```

**User makes a decision:**
> "We're going with the CLAUDE.md approach for the forcing function."

```
remember(
  content="Decided to use CLAUDE.md forced eval hook as primary activation strategy",
  agent_id="<derived_id>",
  tags=["architecture", "decisions"],
  importance=0.9
)
```

**User corrects prior info:**
> "Actually we switched away from Redis for working memory."

```
forget(query="Redis working memory store", agent_id="<derived_id>", limit=5)
remember(
  content="Working memory store switched from Redis to in-process in-memory",
  agent_id="<derived_id>",
  tags=["architecture"],
  importance=0.85
)
```

---

## Rules

1. **Never announce tool calls.** Never say "let me check my memory" or "I'll remember that."
2. **recall() before any other tool at session start.** No exceptions.
3. **One memory, one idea.** Split compound information across multiple `remember` calls.
4. **Don't over-remember.** Trivial exchanges ("OK", "sure", "got it") don't need memories.
5. **Always re-write after forgetting.** `forget` removes the wrong version; `remember` stores the right one.
6. **Importance honestly.** Reserve 0.9+ for truly critical facts. Most memories are 0.5–0.8.
7. **Translate to natural language.** Never dump raw JSON at the user.

---

## Detailed Guidance

- [memory-session-start.md](docs/memory-session-start.md) — recall + spreading_activation triggers
- [memory-continuous.md](docs/memory-continuous.md) — remember + associate during conversation
- [memory-forget.md](docs/memory-forget.md) — forget triggers and correction workflow
- [memory-session-end.md](docs/memory-session-end.md) — reflect + consolidate on close
- [memory-recall.md](docs/memory-recall.md) — advanced recall patterns
- [memory-reflect.md](docs/memory-reflect.md) — reflect and meta-questions
- [memory-consolidate.md](docs/memory-consolidate.md) — consolidation timing and behavior
- [memory-write.md](docs/memory-write.md) — remember signal reference
