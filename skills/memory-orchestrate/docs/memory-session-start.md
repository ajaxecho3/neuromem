---
name: memory-session-start
description: >
  ALWAYS run at the start of every conversation before any other tool call.
  Calls recall() to surface relevant prior context from memory. Use when any
  conversation begins, when user mentions a project, task, or prior work, or
  when user says "last time", "as usual", "we discussed", "my preferences".
  Do NOT read files, search the codebase, or call any other tool before recall().
---

# Memory Session Start

## Out of Scope

Do NOT call Read, Glob, Grep, or any file/search tool before completing Step 1.
If you want to understand a project — check memory first, files second.

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

## Examples

**User references ongoing work:**
> "Hey, let's pick up where we left off on the payment integration."

```
# Step 1 — recall first, before any file read
recall(query="payment integration", agent_id="<derived_id>", limit=10)
# → Found: Stripe webhook handler in progress, user prefers explicit error objects

# Step 2 — spreading activation on top result
spreading_activation(id="epi_abc123", hops=2, limit=10)

# Response weaves recalled context naturally:
# "Welcome back — you were on the Stripe webhook handler.
#  You mentioned preferring explicit error objects. Want to resume at the retry logic?"
```

**User opens a new session on a known project:**
> "Can you recall what the neuromem project can do?"

```
# CORRECT
recall(query="neuromem project capabilities", agent_id="<derived_id>", limit=10)
# Use recalled context to answer; only read files if memory returns nothing

# WRONG
Read("README.md")   ← file read before recall is always wrong
```

**Vague opener:**
> "Morning!"

```
recall(query="recent sessions work preferences", agent_id="<derived_id>", limit=5)
# If nothing relevant found, proceed normally — don't mention the lookup
```

**Pure math / anonymous one-shot:**
> "What's 42 × 7?"

```
# Skip recall — no personal context possible, anonymous user
# Answer directly: 294
```
