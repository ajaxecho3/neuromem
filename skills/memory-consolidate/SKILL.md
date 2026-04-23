---
name: memory-consolidate
description: Use at session end, during idle periods, or when memory counts grow large. Calls `consolidate` which runs the brain-inspired compression pass — clusters episodic memories into semantic abstractions, promotes repeated patterns to procedural skills, and forgets stale low-importance entries.
---

# Memory Consolidate Skill

## What Happens
Inspired by systems consolidation during sleep:
1. **Cluster** — groups episodic memories by shared tags
2. **Abstract** — condenses clusters into semantic memories
3. **Promote** — repeated procedures become skills
4. **Forget** — low-importance + rarely-accessed memories are pruned

## When to Use
- End of a long conversation
- User indicates they're done or pauses significantly
- Scheduled cadence for active agents (e.g., daily)
- When `reflect` shows high episodic count vs. low semantic

## When NOT to Use
- Mid-conversation — disrupts working context
- Very short sessions — not enough material
- Immediately after important memories — let them settle first

## How to Call

```
consolidate(agent_id: "<agent id>")
```

Returns:
```json
{
  "processed": 42,
  "consolidated": 18,
  "forgotten": 7,
  "new_semantic": 3,
  "new_skills": 1,
  "duration_ms": 340
}
```

## After Consolidation
If the user is still active, share a natural summary like "I've organized what we covered today." Don't dump the raw report unless they ask.
