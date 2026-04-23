---
name: memory-recall
description: Use at the start of a conversation or when the user's reference suggests prior context ("as we discussed", "my usual", "last time"). Calls `recall` for hybrid search across all memory stores — vector similarity for semantic/procedural, keyword+timeline for episodic, fast lookup for working.
---

# Memory Recall Skill

## When to Use
ALWAYS check memory at the start of a conversation. Also:
- User references past context (anaphora, "as usual", etc.)
- About to ask something the user may have already told you
- Topic plausibly overlaps prior memories

## How to Call

```
recall(
  query: "user's deployment preferences",
  agent_id: "<agent id>",
  type: ["semantic", "episodic"],  # optional narrowing
  limit: 5
)
```

## Advanced: Spreading Activation
When you find one relevant memory, use `spreading_activation` to find its neighbors in the association graph — this surfaces context you wouldn't catch with keyword/vector alone.

```
spreading_activation(id: "<found memory id>", hops: 2, limit: 10)
```

## Post-Recall
- Weave relevant memories naturally into your response
- Don't announce the lookup ("Let me check my memory...")
- If nothing found, just proceed without mentioning it
