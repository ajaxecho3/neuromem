# NeuroMem skill — install guide

A drop-in skill that tells any Claude-powered assistant to use your NeuroMem MCP server automatically — recalling relevant memory at the start of a conversation, writing new memories when something is worth keeping, and wrapping up with consolidation when a session ends.

## Prerequisites

The end user must already have:

1. The NeuroMem MCP server connected to their harness (Claude Code, Cowork, or another MCP-capable client). Tools exposed should include at minimum `remember`, `recall`, `associate`, `spreading_activation`, `forget`, `consolidate`, `reflect`.
2. A stable `agent_id` strategy. The skill will use whatever identifier the harness exposes (email, username) or fall back to `"default"`.

## Install

### Claude Code

Drop the `neuromem.skill` file into the user's skills folder:

```
~/.claude/skills/
```

Claude Code auto-detects `.skill` files on restart. Confirm with `/skills list`.

### Cowork

Place the `.skill` file in the Cowork skills directory (typically under the user's Cowork config; the app will surface it in the skills list). Alternatively, unzip the `.skill` and copy the `neuromem/` folder into the skills directory directly.

### Any other MCP-capable harness

If the harness supports skill folders, unzip `neuromem.skill` (it's a standard zip) and place the resulting `neuromem/` folder wherever the harness looks for skills. If the harness only supports system prompts, copy the body of `SKILL.md` into the system prompt.

## What the user will notice

- Early in each conversation the assistant will silently recall relevant context. Good memory is invisible — the user just notices the assistant already knows their preferences, ongoing projects, and past decisions.
- During the conversation, when the user states a preference, fact, or decision worth keeping, the assistant will remember it without announcing the call.
- When the user corrects something, the assistant will forget the wrong version and remember the new one.
- At session end, the assistant may consolidate (compress episodic into semantic and prune stale entries).

The skill is deliberately tasteful, not mechanical — it uses judgment about when memory would actually improve the exchange, rather than remembering every "ok" and "thanks."

## Tuning

The skill lives in a single `SKILL.md` and is safe to edit in place. Common tweaks:

- Change the `agent_id` default (e.g., always use the user's email prefix).
- Loosen or tighten the "when to remember" signals — a chatty personal-assistant use case may want more; a focused coding use case may want less.
- Add project-specific tags to the guidance so your team's clustering works well under `consolidate`.

## Troubleshooting

- **The assistant never calls the memory tools.** Confirm the MCP server is actually connected and tools are visible to the harness. Also confirm the skill was loaded (most harnesses show a skills list on startup).
- **Memory doesn't persist across sessions.** The `agent_id` is probably changing between sessions. Pin it in the harness configuration.
- **The assistant announces "checking my memory…".** The skill explicitly forbids this, but if it keeps happening, strengthen the rule in SKILL.md or add a short system-prompt reminder.
