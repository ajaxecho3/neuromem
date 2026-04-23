---
name: memory-session-end
description: >
  Fire ONCE when a conversation is winding down. Calls `reflect` to assess
  memory state, then `consolidate` if the episodic count warrants it.
  Closes the memory loop for the session.
---

# Memory Session End

## Trigger — SHOULD fire when ANY of these are true

| Signal                                 | Example                                                     |
| -------------------------------------- | ----------------------------------------------------------- |
| Explicit goodbye                       | "thanks", "bye", "that's all for now", "done", "talk later" |
| User marks task complete               | "shipped it", "merged", "done with that"                    |
| Natural conversation close             | Long idle, topic fully resolved with no follow-up           |
| Agent detects consolidation is overdue | `reflect` shows episodic count > 20 with low semantic ratio |

## Override — skip when ALL of these are true

- Session was very short (< 3 exchanges)
- No new information was written to memory this session
- Consolidation was run within the last hour for this agent

---

## Step 1: Reflect

Always run this first to decide whether consolidation is needed:

```
reflect(
  agent_id: "<agent id>",
  timeframe_days: 7
)
```

**Decision rule:**

- `counts.episodic > 15` AND `counts.semantic < counts.episodic * 0.4` → consolidate
- `counts.episodic ≤ 5` → skip consolidation, just close naturally
- Otherwise → your judgment

---

## Step 2: Consolidate (conditional)

Only if the reflect result indicates it's warranted:

```
consolidate(agent_id: "<agent id>")
```

Returns `{ processed, consolidated, forgotten, new_semantic, new_skills, duration_ms }`.

---

## How to Communicate This

**If consolidation ran:** Share a brief natural summary — do NOT dump the JSON.

> "I've organized what we covered today — filed away the key decisions and cleared out the day-to-day noise."

**If consolidation was skipped:** Say nothing. Don't tell the user you decided not to consolidate.

**Never say:** "Consolidation returned `{ processed: 12, consolidated: 5... }`"

---

## Example

User: "Alright, I'm done for today. Thanks!"

```
reflect(agent_id: "bernardo", timeframe_days: 7)
# → { counts: { episodic: 23, semantic: 6 }, graph: { nodes: 29, edges: 14 } }
# 23 episodic, only 6 semantic → consolidate

consolidate(agent_id: "bernardo")
# → { processed: 23, consolidated: 11, forgotten: 4, new_semantic: 3, new_skills: 1 }
```

Response: "Have a good one! I've tidied up today's session — the key stuff is filed away for next time."
