---
name: neuromem-memory
description: >
  NeuroMem persistent memory orchestration for GitHub Copilot. Use when starting
  a conversation, storing facts or decisions, linking related memories, correcting
  outdated info, or ending a session. Triggers all 7 MCP tools: remember, recall,
  associate, spreading_activation, forget, consolidate, reflect. Required whenever
  the NeuroMem MCP server is connected.
---

# NeuroMem Memory Orchestration

You are connected to a brain-inspired persistent memory system via MCP.
Four stores handle memory automatically — you don't need to specify `type` unless overriding:

| Store      | Backend    | What goes here                              |
| ---------- | ---------- | ------------------------------------------- |
| Working    | Redis      | Ephemeral session state, auto-expires       |
| Episodic   | PostgreSQL | Events, decisions, experiences + timestamps |
| Semantic   | ChromaDB   | Facts, preferences, concepts (vector)       |
| Procedural | ChromaDB   | Reusable skills and how-tos (vector)        |

---

## Lifecycle

### Session Start

```
recall(query: first topic from user's opening message, agent_id)
→ if relevant memories found: spreading_activation(id: top result id)
```

- Do this silently before your first reply.
- Keeps the conversation grounded in existing knowledge.
- See [memory-session-start](../../../skills/memory-session-start/SKILL.md) for full rules.

### During Conversation — on every exchange

**Remember** when the user:

- States a preference, fact, or constraint
- Makes a decision or reaches a conclusion
- Completes a task or milestone
- Shares personal context

```
remember(content: single atomic fact, agent_id, importance: 0.0–1.0)
```

**Associate** when two topics are clearly linked:

```
associate(id_a: id from recall result, id_b: id from a new remember call)
```

See [memory-continuous](../../../skills/memory-continuous/SKILL.md) for importance scoring and signal types.

### Corrections — when user says "actually", "that's wrong", "ignore that", or contradicts prior info

```
forget(query: the incorrect fact, agent_id)
→ immediately: remember(content: corrected version, agent_id, importance: ≥0.7)
```

Never forget without re-writing the correct version.
See [memory-forget](../../../skills/memory-forget/SKILL.md) for explicit vs implicit triggers.

### Session End — when user says done, bye, goodbye, or ends the conversation

```
reflect(agent_id)
→ if reflect shows >10 new episodic memories: consolidate(agent_id)
```

Only consolidate if the session was substantive. See [memory-session-end](../../../skills/memory-session-end/SKILL.md).

---

## Tool Quick Reference

```
remember(content, agent_id, tags?, importance?, type?, ttl_seconds?)
recall(query, agent_id, limit?, type?, min_importance?, include_shared?)
spreading_activation(id, hops?, limit?)
associate(id_a, id_b)
forget(id)  |  forget(query, agent_id, type?, limit?)
reflect(agent_id, timeframe_days?)
consolidate(agent_id)
```

---

## Rules

1. **Never announce tool calls** — memory is invisible infrastructure, not narration.
2. **One fact per `remember`** — split compound information into separate calls.
3. **Always re-write after `forget`** — never delete without replacing with the correct version.
4. **`agent_id` convention**: use a stable user identifier when available; fall back to `"default"`.
5. **Translate tool output** — convert JSON responses to natural language before replying.
6. **Importance scale**: 1.0 = identity/critical; 0.7–0.9 = strong preference/key decision; 0.4–0.6 = useful context; 0.1–0.3 = ephemeral/low signal.

---

## Full Trigger Table

| Signal                                              | Tool(s)                           |
| --------------------------------------------------- | --------------------------------- |
| Conversation begins                                 | `recall` → `spreading_activation` |
| User states preference, fact, or makes a decision   | `remember`                        |
| Two topics/memories are clearly related             | `associate`                       |
| User corrects or retracts previous info             | `forget` → `remember`             |
| User asks "what do you remember?" or meta-questions | `reflect`                         |
| Conversation ends                                   | `reflect` → `consolidate`         |
