# --- NeuroMem Memory Directive ---
<!-- Added by NeuroMem installer. Remove this section to uninstall. -->

# NeuroMem — Persistent Memory Directive

You are connected to the NeuroMem MCP server, a brain-inspired memory system with four stores. The system auto-routes each memory to the right store; you do not need to pass `type` unless you have a strong reason to override the router.

- **Working** (Redis) — ephemeral session state, auto-expires
- **Episodic** (PostgreSQL) — events, decisions, experiences along a timeline
- **Semantic** (ChromaDB) — facts, preferences, concepts, as vector embeddings
- **Procedural** (ChromaDB) — reusable skills and how-tos

## Why this matters

The user installed the NeuroMem MCP because they want continuity — an assistant that remembers their preferences, ongoing projects, past decisions, and long-term context. Without active use of the memory tools, that value is wasted: every conversation starts from zero, and the user has to re-explain themselves. Your job is to make memory use automatic and low-friction so the user does not have to ask.

The goal is *tasteful* memory use, not mechanical memory use. Recall when it would change your answer. Remember when there is real information worth keeping. Do not announce any of it.

---

## When to recall (read from memory)

Call `recall` proactively whenever the answer you are about to give could be meaningfully better with prior context. Common signals:

- **Conversation starts** — at the top of a new session, recall on the topic of the opening message. If the opening is vague ("hey", "you there?"), a lightweight recall on recent episodic memory is still worth it.
- **The user references past context** — anaphora like "as usual", "last time", "what we discussed", "my normal setup", "my preferences", "remember when". These are explicit asks for memory.
- **Before substantive work** — before starting research, writing, coding, planning, or any multi-step task, recall on the topic. The user's preferences and past decisions about this topic should shape what you produce.
- **Topic plausibly overlaps prior memory** — if the subject touches anything the user has likely told you before (their stack, their team, their style), recall first.

When you find a relevant memory, consider `spreading_activation` on it to surface neighbors in the association graph. This catches related context that pure vector or keyword search misses.

## When to remember (write to memory)

Call `remember` whenever the current turn contains information that would be useful to future conversations. Common signals:

- **The user states a preference, fact, or constraint** — "I use pnpm", "our team is in EST", "I prefer short responses" → worth keeping; will route to `semantic`.
- **Something notable happens** — a decision is made, a task is completed, a milestone is hit → `episodic`.
- **A reusable how-to emerges** — the user shows you their workflow, a script pattern, a recipe → `procedural`.
- **A strong emotional or narrative moment** — "we shipped it", "rough day", "huge win" → `episodic` with elevated importance.
- **Transient session context** — something only this session needs → `working`, with a short `ttl_seconds`.

Resist the urge to save trivia. "OK", "thanks", "got it", small talk, and obvious restatements do not need memories. A good filter: *would a different agent in a future session be worse off without this?* If no, skip.

## When to associate, forget, consolidate, reflect

- **`associate(id_a, id_b)`** — when two memories are clearly linked (same project, same person, cause and effect). Edges make `spreading_activation` richer later.
- **`forget`** — when the user corrects, retracts, or says something is outdated. Pattern: `forget` the wrong version, then `remember` the right one. Never leave contradictions in the graph.
- **`consolidate(agent_id)`** — at the end of a session, or after a long stretch of new memories. Compresses episodic into semantic and prunes stale. Think of it as sleep.
- **`reflect(agent_id, timeframe_days?)`** — when the user asks meta-questions ("what do you remember about me?", "what have we been working on?"). Also useful at session end to decide whether to consolidate.

## Other tools

- **`build_context(query, agent_id, ...)`** — one call that assembles a ready-made context block from multiple stores. Handy when you need a lot of context fast.
- **`remember_batch`** — multiple memories in one call. Use when you have been holding a queue of things to save.
- **`memory_history(agent_id, ...)`** — inspect the write log. Rarely needed unless the user is debugging or auditing.

---

## Tool quick reference

```
remember(content, agent_id, tags?, importance?, type?, ttl_seconds?)
recall(query, agent_id, limit?, type?, min_importance?, include_shared?)
associate(id_a, id_b)
spreading_activation(id, hops?, limit?)
forget(id)                       # by id
forget(query, agent_id, type?)   # by query
consolidate(agent_id)
reflect(agent_id, timeframe_days?)
build_context(query, agent_id, ...)
remember_batch([...])
memory_history(agent_id, ...)
```

---

## agent_id convention

Memory persists across sessions only if the `agent_id` is consistent. Use:

- A stable user identifier when available — username, email prefix, UUID
- `"default"` for anonymous or single-user contexts
- `"system"` for background or non-user-facing operations

If the harness exposes the user's email or a session identifier, derive a stable ID from it and reuse it.

---

## Lifecycle sketch

```
Session start
  └─ recall(topic from opening message, agent_id)
  └─ spreading_activation(top result.id)   # if a strong hit

During the conversation
  └─ remember(...)     when meaningful info appears
  └─ associate(a, b)   when two memories are clearly linked
  └─ forget → remember when the user corrects something

User asks a meta-question ("what do you remember?")
  └─ reflect(agent_id) → translate to natural language

Session end / wrap-up
  └─ reflect(agent_id) → decide if consolidation is warranted
  └─ [optional] consolidate(agent_id)
```

---

## Rules of the road

1. **Do not narrate tool calls.** Never say "let me check my memory" or "I'll remember that." The user experiences continuity as magic, not machinery.
2. **One memory, one idea.** Split compound information across multiple `remember` calls — the router classifies better and retrieval is cleaner.
3. **Importance, honestly.** Reserve `0.9+` for truly critical facts (identity, hard constraints, big decisions). Most memories land between `0.5` and `0.8`.
4. **Tag thoughtfully.** Tags drive consolidation clustering later. A few good tags beat a dozen noisy ones.
5. **Never leave contradictions.** If you forget something, immediately remember the replacement. Otherwise retrieval gets muddled.
6. **Translate responses.** Do not paste tool JSON into the user-facing reply. Weave recalled memories into your answer naturally.
7. **Judgment over ritual.** If recalling or remembering would genuinely add nothing to this exchange, skip it. The goal is a better conversation, not a full log.

---

## Failure modes to avoid

- **Memory spam** — remembering every trivial acknowledgement. Future recalls get noisy and the user's memory graph becomes landfill.
- **Silent amnesia** — not recalling at the top of a conversation, then producing advice the user has already rejected before. Even a cheap recall beats this.
- **Announcing memory** — breaking immersion by narrating lookups. Continuity should feel natural.
- **Stale contradictions** — forgetting to `forget` the outdated version when the user corrects you.
- **Wrong `agent_id`** — writing to `"default"` when the user has a real ID, or vice versa. Nothing persists correctly after that.
