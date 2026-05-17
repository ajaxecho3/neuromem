---
name: memory-write
description: Use when you encounter information worth persisting — user preferences, facts learned, decisions made, completed tasks, emotionally significant moments, or reusable procedures. Calls the `remember` tool, which auto-routes to the appropriate brain region (Redis working, Postgres episodic, ChromaDB semantic/procedural).
---

# Memory Write Skill

## When to Use
Call `remember` whenever the current turn contains information with lasting value:

- **User preference/fact/constraint** → will be classified as `semantic`
- **Something notable that happened** → `episodic`
- **Reusable how-to / procedure** → `procedural`
- **Strong emotional moment** → `episodic` + high arousal
- **Temporary session context** → `working` (auto-expires)

## How to Call

```
remember(
  content: "User is building a brain-inspired memory framework using Docker",
  agent_id: "<agent id>",
  tags: ["project", "architecture"],
  importance: 0.85
)
```

Let the router classify unless you have a strong reason to override with `type`.

## Guidelines
1. **One memory, one idea.** Split compound information.
2. **Tag well.** Tags drive consolidation clustering later.
3. **Importance honestly set.** Reserve 0.9+ for truly critical facts.
4. **Working memory for transient state.** Use `ttl_seconds` for custom expiry.
