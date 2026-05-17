---
name: memory-forget
description: >
  Fire when user explicitly asks to forget something, corrects prior information,
  or when stale/wrong data is detected. Calls `forget` by query or by ID.
  Always re-write the corrected version after forgetting the old one.
---

# Memory Forget

## Trigger — SHOULD fire when ANY of these are true

| Signal                                 | Type     | Example                                                               |
| -------------------------------------- | -------- | --------------------------------------------------------------------- |
| Explicit deletion request              | Explicit | "forget that", "delete what you know about X", "clear my preferences" |
| Factual correction                     | Implicit | "actually it's PostgreSQL not MySQL", "no, I changed my mind"         |
| User marks info as outdated            | Implicit | "that's the old approach", "we moved away from that"                  |
| Agent detects a conflict with new info | Detected | New memory directly contradicts a stored fact                         |

## Override — skip when

- User says "forget it" as an idiom meaning "never mind" (not an actual deletion request)
- The information is already gone (user corrected something that was never stored)

---

## Decision: by ID or by query?

**Use `id`** when you have the exact memory ID (e.g., just recalled it, or it came from a `remember` response this session):

```
forget(id: "<memory id>")
```

**Use `query`** when you don't have the ID but know what to delete:

```
forget(
  query: "<natural language description of what to remove>",
  agent_id: "<agent id>",
  type: ["semantic"],   # optional: narrow the search
  limit: 10             # how many candidates to evaluate
)
```

The LLM inside `forget` will filter candidates before deleting — only truly relevant memories are removed.

---

## Always re-write after forgetting

Forget removes the wrong version. Then immediately write the correct version:

```
# 1. Remove wrong version
forget(query: "user's database preference", agent_id: "alice")

# 2. Write correct version
remember(
  content: "User uses PostgreSQL, not MySQL",
  agent_id: "alice",
  tags: ["preferences", "database"],
  importance: 0.8
)
```

---

## How to Communicate

**If the user asked explicitly:** Acknowledge it simply.

> "Done — cleared."

**If you're correcting a stored fact:** Don't announce the internals.

> "Got it — PostgreSQL. I've updated that."

**Never say:** "I called forget() with query 'database preference' and it removed 2 memories."

---

## Examples

**Explicit request:**

> User: "Actually forget everything I told you about using Redux."

```
forget(
  query: "Redux state management",
  agent_id: "alice",
  type: ["semantic", "episodic"],
  limit: 20
)
```

**Implicit correction:**

> User: "Wait no — we decided to use Paddle, not Stripe."

```
# Remove old decision
forget(
  query: "payment provider decision Stripe Paddle",
  agent_id: "alice",
  limit: 5
)

# Write corrected version
remember(
  content: "Decided to use Paddle over Stripe for payments",
  agent_id: "alice",
  tags: ["payments", "architecture", "decisions"],
  importance: 0.9
)
```
