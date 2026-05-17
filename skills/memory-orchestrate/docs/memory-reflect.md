---
name: memory-reflect
description: Use when user asks meta-questions about memory state ("what do you remember about me?", "summarize what we've done") or when you want to surface patterns across recent activity. Calls `reflect` for aggregate counts + graph stats.
---

# Memory Reflect Skill

## When to Use
- User asks what you remember or know
- User wants a summary over a time period
- Before consolidation, to decide whether it's needed
- Diagnosing retrieval behavior

## How to Call

```
reflect(
  agent_id: "<agent id>",
  timeframe_days: 7
)
```

## Returns
- Counts by memory type (working, episodic, semantic, procedural)
- Graph stats (nodes + edges in the association graph)

## Translate Raw Numbers to Conversation

> Raw: `{ counts: { episodic: 12, semantic: 4 }, graph: { nodes: 16, edges: 9 } }`
>
> Good response: "I have about a dozen recent events logged and four distilled facts. There are some connections between them I can explore if useful."

Don't dump the JSON at the user.
