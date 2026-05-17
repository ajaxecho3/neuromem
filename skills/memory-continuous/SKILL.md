---
name: memory-continuous
description: >
  Fire continuously DURING a conversation whenever information worth persisting
  appears, or when two concepts are clearly related. Calls `remember` to write
  memories and `associate` to link related ones.
---

# Memory Continuous

## Trigger — SHOULD fire when ANY of these appear in the current exchange

### `remember` triggers

| Signal                                                   | Memory type                 | Importance |
| -------------------------------------------------------- | --------------------------- | ---------- |
| User states a preference or constraint                   | `semantic`                  | 0.7–0.9    |
| User shares a personal fact                              | `semantic`                  | 0.6–0.8    |
| A decision is made                                       | `episodic`                  | 0.8–0.95   |
| A task is completed or started                           | `episodic`                  | 0.7–0.85   |
| A reusable procedure is discussed                        | `procedural`                | 0.75–0.9   |
| Strong emotional signal (frustration, excitement, pride) | `episodic` + high `arousal` | 0.7+       |
| Temporary session context (current file, branch, ticket) | `working`                   | 0.5        |

### `associate` triggers

| Signal                                                 | Example                                                     |
| ------------------------------------------------------ | ----------------------------------------------------------- |
| Two topics in the same exchange are explicitly linked  | "the auth bug is caused by the token expiry issue"          |
| User references two prior memories in the same context | "like we did with the payment module" while discussing auth |
| A new memory clearly belongs to an existing cluster    | New decision about a feature that has prior memories        |

---

## How to Call

### Writing a memory

```
remember(
  content: "<specific, self-contained statement of the fact/event>",
  agent_id: "<agent id>",
  tags: ["<topic>", "<sub-topic>"],
  importance: <0.0–1.0>
)
```

**One memory, one idea.** If you have three things to record, call `remember` three times.

Let the router classify `type` automatically unless you have a strong reason to override.

---

### Associating memories

First, you need IDs — either from this session's `remember` responses, or from `recall`:

```
associate(
  id_a: "<memory id>",
  id_b: "<other memory id>"
)
```

**Only associate when the link is meaningful and durable** — not just coincidental co-occurrence.

---

## Override — skip when

- Information is trivially transient ("OK", "got it", "sure")
- User explicitly says not to remember something ("don't log this")
- The exact same content was already written this session

---

## Examples

**Preference detected:**

> User: "I always use kebab-case for CSS class names."

```
remember(
  content: "User prefers kebab-case for CSS class names",
  agent_id: "alice",
  tags: ["preferences", "css", "naming"],
  importance: 0.75
)
```

**Decision made:**

> User: "We're going with Stripe over Paddle — the API is simpler."

```
remember(
  content: "Decided to use Stripe over Paddle for payments — simpler API",
  agent_id: "alice",
  tags: ["payments", "architecture", "decisions"],
  importance: 0.9
)
```

**Association:**

> User: "The webhook failures are related to the timeout issue we fixed last week."

```
# id_a = id of the new webhook memory just written
# id_b = id recalled from last week's timeout fix
associate(id_a: "epi_abc123", id_b: "epi_xyz789")
```
