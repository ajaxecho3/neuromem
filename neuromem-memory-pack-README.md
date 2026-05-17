# NeuroMem Memory Pack

A drop-in directive that tells *any* MCP-capable assistant to use the NeuroMem MCP server automatically — recalling relevant memory at the start of a conversation, writing new memories when something is worth keeping, associating related items, and consolidating at session end.

The pack is **agent and harness agnostic**. The same directive ships in five formats so you can install it wherever your assistant lives.

## What's inside

```
neuromem-memory-pack/
├── README.md                       you are here
├── PROMPT.md                       canonical, agent-neutral source of truth
└── formats/
    ├── neuromem.skill              Anthropic Skills format (Claude Code, Cowork, Claude.ai)
    ├── AGENTS.md                   cross-tool convention (Cursor, Aider, Codex, many others)
    ├── .cursorrules                Cursor-specific
    ├── system-prompt.md            paste-anywhere snippet for any system prompt
    └── agent-instruction.json      JSON manifest for SDK-style harnesses
```

All five files contain the same directive. Pick the one your harness reads.

## Prerequisites

The end user must already have:

1. The NeuroMem MCP server connected to their harness. Tools exposed should include at minimum: `remember`, `recall`, `associate`, `spreading_activation`, `forget`, `consolidate`, `reflect`. Optional: `build_context`, `remember_batch`, `memory_history`.
2. A stable `agent_id` strategy. The directive will use whatever identifier the harness exposes (email, username) and fall back to `"default"`.

## Install

### Anthropic-format harnesses (Claude Code, Cowork, Claude.ai)

Drop `formats/neuromem.skill` into the harness's skills folder.

- **Claude Code** — `~/.claude/skills/`. Confirm with `/skills list`.
- **Cowork** — place in the Cowork skills directory; the app surfaces it in the skills list.
- **Claude.ai with Skills enabled** — upload through the Skills UI.

### Cross-tool projects with AGENTS.md (Cursor, Aider, Codex, Continue, Claude Code, and others)

Place `formats/AGENTS.md` at the root of the project (or in `~/` for a global rule). Most modern coding agents read `AGENTS.md` automatically when present.

### Cursor

Copy `formats/.cursorrules` to the project root. Cursor reads `.cursorrules` as a project-level system prompt.

### Custom MCP clients, web UIs, CLI agents

Open `formats/system-prompt.md` and paste the contents into the harness's system prompt or instructions field. Any harness that supports a custom system prompt supports this.

### SDK-style harnesses (LangChain, LangGraph, OpenAI Agents SDK, CrewAI, AutoGen, custom orchestrators)

Load `formats/agent-instruction.json`, read the `instruction` field, and pass it as the system / instruction string when constructing your agent. The `requires_mcp_tools` field lists the tools the directive expects to find.

Minimal example:

```python
import json
manifest = json.load(open("formats/agent-instruction.json"))
agent = MyAgent(
    instructions=manifest["instruction"],
    tools=mcp_client.tools(),  # your existing NeuroMem MCP wiring
)
```

### Anything else

If your harness reads neither SKILL.md, AGENTS.md, .cursorrules, nor a custom system prompt, you can wire the directive in as the first user-turn message in each session. It works, just less elegantly.

## What the user will notice

Early in each conversation the assistant will silently recall relevant context. Good memory is invisible — the user just notices the assistant already knows their preferences, ongoing projects, and past decisions.

During the conversation, when the user states a preference, fact, or decision worth keeping, the assistant will remember it without announcing the call. When the user corrects something, the assistant will forget the wrong version and remember the new one. At session end, the assistant may consolidate (compress episodic into semantic and prune stale entries).

The directive is deliberately tasteful, not mechanical — it uses judgment about when memory would actually improve the exchange, rather than remembering every "ok" and "thanks."

## Tuning

The directive lives in a single source of truth (`PROMPT.md`) and is safe to edit. After editing, re-derive whichever format(s) you use. Common tweaks:

- Change the `agent_id` default (e.g., always use the user's email prefix).
- Loosen or tighten the "when to remember" signals — a chatty personal-assistant use case may want more; a focused coding use case may want less.
- Add project-specific tags so your team's clustering works well under `consolidate`.

## Troubleshooting

- **The assistant never calls the memory tools.** Confirm the MCP server is actually connected and the tools are visible to the harness. Also confirm the directive was loaded (most harnesses show some indication on startup).
- **Memory does not persist across sessions.** The `agent_id` is probably changing between sessions. Pin it in the harness configuration.
- **The assistant announces "checking my memory…".** The directive forbids this, but some models still slip. Strengthen rule #1 in the prompt or add a short reinforcing line to the system prompt.
- **Tool calls fail with unknown-tool errors.** The harness's MCP client may not be discovering the NeuroMem tools. Check the MCP connection status before debugging the directive.
