---
name: memory-orchestrate
description: >
  Master skill for agents using the NeuroMem MCP server. Load this skill to get
  full lifecycle memory behavior — session start, continuous capture, association,
  forgetting, and session end. Covers all 7 MCP tools: remember, recall,
  associate, spreading_activation, forget, consolidate, reflect.
---

# NeuroMem Memory Orchestration

You are connected to a brain-inspired memory system with four stores:

- **Working** (Redis) — ephemeral session state, auto-expires
- **Episodic** (PostgreSQL) — events, decisions, experiences with timeline
- **Semantic** (ChromaDB) — facts, preferences, concepts as vector embeddings
- **Procedural** (ChromaDB) — reusable skills and how-tos

The system auto-routes memories to the right store. You don't need to specify `type` unless you have a strong reason.

---

## Full Trigger Table

| When                                                        | Tool                              | Detailed guidance      |
| ----------------------------------------------------------- | --------------------------------- | ---------------------- |
| Conversation begins                                         | `recall` → `spreading_activation` | `memory-session-start` |
| User states preference, fact, decision, or completes a task | `remember`                        | `memory-continuous`    |
| Two topics/memories are clearly related                     | `associate`                       | `memory-continuous`    |
| User corrects, retracts, or marks something outdated        | `forget` → `remember`             | `memory-forget`        |
| User asks "what do you remember?" or meta-questions         | `reflect`                         | Below                  |
| Conversation ends or user says done/bye                     | `reflect` → `consolidate`         | `memory-session-end`   |

---

## Quick Reference: All 7 Tools

```
# Store a memory
remember(content, agent_id, tags?, importance?, type?, ttl_seconds?)

# Retrieve memories
recall(query, agent_id, limit?, type?, min_importance?, include_shared?)

# Expand from a known memory through the association graph
spreading_activation(id, hops?, limit?)

# Link two memories
associate(id_a, id_b)

# Delete by ID or by query
forget(id)
forget(query, agent_id, type?, limit?)

# Aggregate stats for an agent
reflect(agent_id, timeframe_days?)

# Sleep-cycle compression: episodic → semantic, prune stale
consolidate(agent_id)
```

---

## agent_id Convention

- Use a stable user identifier when you have one (username, email prefix, UUID)
- Fall back to `"default"` for anonymous or single-user contexts
- Use `"system"` for background / non-user-facing operations
- Keep it consistent across sessions for the same user — this is how memory persists

---

## Lifecycle at a Glance

```
Session start
  └─ recall(topic from opening message)
  └─ spreading_activation(most relevant id) [if needed]

During conversation — on every exchange
  └─ [signal detected?] remember(fact/event/decision)
  └─ [two things linked?] associate(id_a, id_b)
  └─ [correction detected?] forget(old) → remember(new)

User asks meta-question
  └─ reflect(agent_id) → translate to natural language

Session end
  └─ reflect(agent_id) → decide if consolidation needed
  └─ [if warranted] consolidate(agent_id)
```

---

## Rules

1. **Never announce tool calls.** Don't say "Let me check my memory..." or "I'm calling remember now."
2. **One memory, one idea.** Split compound information across multiple `remember` calls.
3. **Don't over-remember.** Trivial exchanges ("OK", "sure", "got it") don't need memories.
4. **Always re-write after forgetting.** `forget` removes the wrong version; `remember` stores the right one.
5. **Importance honestly.** Reserve 0.9+ for truly critical facts. Most memories are 0.5–0.8.
6. **Don't dump JSON.** Translate tool responses to natural language before showing the user.

---

## Detailed Guidance

For full examples and edge cases, see the lifecycle skill files:

- `memory-session-start` — recall + spreading_activation triggers
- `memory-continuous` — remember + associate during conversation
- `memory-forget` — forget triggers and correction workflow
- `memory-session-end` — reflect + consolidate on close
