---
name: memory-session-start
description: >
  Fire ONCE at the start of every conversation, before your first substantive response.
  Calls `recall` to surface relevant prior context, then optionally calls
  `spreading_activation` to expand into connected memories.
---

# Memory Session Start

## Trigger — SHOULD fire when ANY of these are true

| Signal                              | Example                                                         |
| ----------------------------------- | --------------------------------------------------------------- |
| New conversation begins             | Any opening message                                             |
| User references prior context       | "as we discussed", "like last time", "my usual", "you know me"  |
| Topic has likely prior history      | User asks about their own project, preferences, or ongoing work |
| Agent is being introduced to a user | First contact, onboarding                                       |

## Override — skip when ALL of these are true

- Session is a quick one-shot lookup with no personal context (e.g., "what's 42 × 7")
- User is anonymous / no agent_id available
- Prior recall returned nothing for this agent in the last 3+ sessions

---

## Step 1: Recall

```
recall(
  query: "<derive from user's opening message or topic>",
  agent_id: "<user identifier or 'default'>",
  limit: 10,
  include_shared: true
)
```

**Derive the query** from the user's opening message — don't just pass "memory".

- Opening: "let's keep working on the auth module" → query: `"auth module"`
- Opening: "morning!" → query: `"recent work session preferences"`

---

## Step 2: Spreading Activation (conditional)

If Step 1 returned ≥1 memory AND the topic is complex or relational, pick the most relevant memory ID and expand:

```
spreading_activation(
  id: "<most relevant memory id from step 1>",
  hops: 2,
  limit: 10
)
```

Skip this step if:

- Recall returned 0 memories
- Opening message is simple/unrelated to prior work
- You've already surfaced enough context from recall alone

---

## How to Use the Results

- Weave relevant memories naturally into your response — do NOT announce "I checked my memory"
- If nothing was found, proceed normally without mentioning it
- If memories are outdated or contradicted by the user, trigger `memory-forget`
- Note the memory IDs of anything highly relevant — you may need them for `associate` later

---

## Example

User: "Hey, let's pick up where we left off on the payment integration."

```
recall(
  query: "payment integration",
  agent_id: "alice",
  limit: 10
)
```

→ Found: episodic memories about Stripe setup, a semantic memory about the user's preferred error handling pattern, a working memory with the last unfinished task.

Response weaves these in naturally: "Welcome back — you were working on the Stripe webhook handler. Last time you mentioned preferring explicit error objects over thrown exceptions. Want to pick up from the retry logic?"
