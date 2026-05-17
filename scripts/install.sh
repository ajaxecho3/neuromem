#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# NeuroMem — Install & Connect Script
#
# Usage:
#   bash scripts/install.sh [--tools <list>] [--port <n>] [--agent-id <id>]
#
# Options:
#   --tools       Comma-separated list of tools to connect.
#                 Options: claude-code, opencode, cursor, all
#                 Default: all (auto-detects what's installed)
#   --port        NeuroMem server port (default: 3000)
#   --agent-id    Stable agent ID to use (default: derived from $USER)
#   --skip-docker Skip Docker stack setup (if already running)
#   --help        Show this message
#
# What this script does:
#   1. Checks prerequisites (Docker, docker compose)
#   2. Copies .env.example → .env if missing, prompts for key values
#   3. Starts the Docker stack and waits for all services to be healthy
#   4. Connects NeuroMem to whichever AI tools you have installed:
#        Claude Code  → installs neuromem.skill + registers MCP server
#        OpenCode     → registers MCP server in config.json + drops AGENTS.md
#        Cursor       → drops .cursorrules into current directory
#   5. Prints a summary with next steps
# ─────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

ok()   { echo -e "${GREEN}  ✔${RESET}  $*"; }
warn() { echo -e "${YELLOW}  ⚠${RESET}  $*"; }
err()  { echo -e "${RED}  ✖${RESET}  $*"; }
info() { echo -e "${CYAN}  →${RESET}  $*"; }
hdr()  { echo -e "\n${BOLD}$*${RESET}"; }

# ── Defaults ─────────────────────────────────────────────────────
NEUROMEM_PORT=3000
AGENT_ID="${USER:-default}"
TOOLS="all"
SKIP_DOCKER=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Arg parsing ──────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tools)       TOOLS="$2"; shift 2 ;;
    --port)        NEUROMEM_PORT="$2"; shift 2 ;;
    --agent-id)    AGENT_ID="$2"; shift 2 ;;
    --skip-docker) SKIP_DOCKER=true; shift ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# ──/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

NEUROMEM_URL="http://localhost:${NEUROMEM_PORT}"
NEUROMEM_SSE_URL="${NEUROMEM_URL}/mcp"

# ─────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}🧠  NeuroMem Installer${RESET}"
echo    "────────────────────────────────────────"

# ─────────────────────────────────────────────────────────────────
# 1. PREREQUISITES
# ─────────────────────────────────────────────────────────────────
hdr "1/5  Checking prerequisites"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    ok "$1 found ($(command -v "$1"))"
    return 0
  else
    return 1
  fi
}

# Docker
if ! check_cmd docker; then
  err "Docker not found. Install from https://docs.docker.com/get-docker/"
  exit 1
fi

# docker compose (v2 plugin or standalone)
if docker compose version &>/dev/null 2>&1; then
  COMPOSE="docker compose"
  ok "docker compose (plugin) found"
elif command -v docker-compose &>/dev/null; then
  COMPOSE="docker-compose"
  ok "docker-compose (standalone) found"
else
  err "docker compose not found. Update Docker Desktop or install the plugin."
  exit 1
fi

# jq (optional — used for OpenCode config patching)
HAS_JQ=false
if check_cmd jq; then HAS_JQ=true; fi

# ─────────────────────────────────────────────────────────────────
# 2. ENV SETUP
# ─────────────────────────────────────────────────────────────────
hdr "2/5  Environment setup"

cd "$PROJECT_DIR"

if [[ -f .env ]]; then
  ok ".env already exists — skipping copy"
else
  cp .env.example .env
  ok "Copied .env.example → .env"

  # Prompt for the LLM provider key so inner-thought enrichment works
  echo ""
  echo -e "  ${CYAN}NeuroMem's memory router uses an LLM (InnerThought) to classify"
  echo -e "  ambiguous memories. Without this, it falls back to pattern matching.${RESET}"
  echo ""
  echo -e "  Which LLM provider do you want to use for InnerThought?"
  echo -e "    1) anthropic  (recommended — you already have Claude)"
  echo -e "    2) openai"
  echo -e "    3) ollama     (local, no API key needed)"
  echo -e "    4) none       (skip LLM enrichment)"
  echo ""
  read -rp "  Choice [1]: " llm_choice
  llm_choice="${llm_choice:-1}"

  case "$llm_choice" in
    1|anthropic)
      sed -i.bak 's/^LLM_PROVIDER=.*/LLM_PROVIDER=anthropic/' .env
      sed -i.bak 's/^INNER_THOUGHT_MODEL=.*/INNER_THOUGHT_MODEL=claude-haiku-20240307/' .env
      read -rp "  Anthropic API key (sk-ant-...): " api_key
      if [[ -n "$api_key" ]]; then
        sed -i.bak "s|^# ANTHROPIC_API_KEY=.*|ANTHROPIC_API_KEY=${api_key}|" .env
        ok "Anthropic provider configured"
      else
        warn "No key entered — set ANTHROPIC_API_KEY in .env before starting"
      fi
      ;;
    2|openai)
      sed -i.bak 's/^LLM_PROVIDER=.*/LLM_PROVIDER=openai/' .env
      sed -i.bak 's/^INNER_THOUGHT_MODEL=.*/INNER_THOUGHT_MODEL=gpt-4o-mini/' .env
      read -rp "  OpenAI API key (sk-...): " api_key
      if [[ -n "$api_key" ]]; then
        sed -i.bak "s|^# OPENAI_API_KEY=.*|OPENAI_API_KEY=${api_key}|" .env
        ok "OpenAI provider configured"
      fi
      ;;
    3|ollama)
      sed -i.bak 's/^LLM_PROVIDER=.*/LLM_PROVIDER=ollama/' .env
      ok "Ollama configured — make sure Ollama is running with your model pulled"
      ;;
    4|none)
      sed -i.bak 's/^LLM_PROVIDER=.*/LLM_PROVIDER=none/' .env
      ok "LLM enrichment disabled — pattern matching only"
      ;;
    *)
      warn "Unknown choice, defaulting to none"
      sed -i.bak 's/^LLM_PROVIDER=.*/LLM_PROVIDER=none/' .env
      ;;
  esac

  # Also prompt for embedding provider
  echo ""
  echo -e "  ${CYAN}Embeddings power semantic recall. 'local' uses hash-based fallback"
  echo -e "  (poor quality). OpenAI or Voyage give much better results.${RESET}"
  echo ""
  echo -e "  Embedding provider?"
  echo -e "    1) local    (no API key, low quality)"
  echo -e "    2) openai"
  echo -e "    3) voyage"
  echo ""
  read -rp "  Choice [1]: " emb_choice
  emb_choice="${emb_choice:-1}"

  case "$emb_choice" in
    2|openai)
      sed -i.bak 's/^EMBEDDING_PROVIDER=.*/EMBEDDING_PROVIDER=openai/' .env
      if [[ -z "${api_key:-}" ]]; then
        read -rp "  OpenAI API key (sk-...): " emb_key
        [[ -n "$emb_key" ]] && sed -i.bak "s|^# OPENAI_API_KEY=.*|OPENAI_API_KEY=${emb_key}|" .env
      fi
      ok "OpenAI embeddings configured"
      ;;
    3|voyage)
      sed -i.bak 's/^EMBEDDING_PROVIDER=.*/EMBEDDING_PROVIDER=voyage/' .env
      read -rp "  Voyage API key: " voyage_key
      [[ -n "$voyage_key" ]] && sed -i.bak "s|^# VOYAGE_API_KEY=.*|VOYAGE_API_KEY=${voyage_key}|" .env
      ok "Voyage embeddings configured"
      ;;
    *)
      ok "Using local embeddings (hash-based fallback)"
      ;;
  esac

  rm -f .env.bak
fi

# Sync port from .env if already set there
if grep -q "^NEUROMEM_PORT=" .env 2>/dev/null; then
  ENV_PORT=$(grep "^NEUROMEM_PORT=" .env | cut -d= -f2)
  NEUROMEM_PORT="${ENV_PORT:-$NEUROMEM_PORT}"
  NEUROMEM_URL="http://localhost:${NEUROMEM_PORT}"
  NEUROMEM_SSE_URL="${NEUROMEM_URL}/mcp"
fi

# ─────────────────────────────────────────────────────────────────
# 3. DOCKER STACK
# ─────────────────────────────────────────────────────────────────
hdr "3/5  Docker stack"

if [[ "$SKIP_DOCKER" == "true" ]]; then
  warn "--skip-docker set — skipping stack setup"
else
  info "Building and starting NeuroMem services..."
  $COMPOSE up -d --build

  info "Waiting for all services to become healthy..."
  bash "$SCRIPT_DIR/wait-for-services.sh"
fi

# Quick connectivity check
if curl -sf "${NEUROMEM_URL}/health" >/dev/null 2>&1; then
  ok "NeuroMem server reachable at ${NEUROMEM_URL}"
else
  warn "Server not yet responding at ${NEUROMEM_URL} — it may still be starting"
  warn "Run 'make logs' to check. You can re-run this script with --skip-docker once it's up."
fi

# ─────────────────────────────────────────────────────────────────
# 4. CONNECT TO AI TOOLS
# ─────────────────────────────────────────────────────────────────
hdr "4/5  Connecting to AI tools"

# Helper: detect if a tool should be installed
should_install() {
  local tool="$1"
  [[ "$TOOLS" == "all" ]] || echo "$TOOLS" | tr ',' '\n' | grep -qx "$tool"
}

# Auto-detect installed tools when --tools all
detect_tools() {
  local detected=()
  command -v claude &>/dev/null        && detected+=("claude-code")
  command -v opencode &>/dev/null      && detected+=("opencode")
  command -v cursor &>/dev/null        && detected+=("cursor")
  # Cursor also detectable by app bundle on macOS
  [[ -d "/Applications/Cursor.app" ]] && ! printf '%s\n' "${detected[@]}" | grep -q cursor && detected+=("cursor")
  # Copilot: detect via VS Code installation
  command -v code &>/dev/null          && detected+=("copilot")
  [[ -d "/Applications/Visual Studio Code.app" ]] && ! printf '%s\n' "${detected[@]}" | grep -q copilot && detected+=("copilot")
  echo "${detected[@]:-}"
}

CONNECTED=()
SKIPPED=()

# ── Claude Code ───────────────────────────────────────────────────
install_claude_code() {
  echo ""
  info "Setting up Claude Code..."

  # 1. Install the skill
  SKILL_DIR="${HOME}/.claude/skills"
  mkdir -p "$SKILL_DIR"

  # Install memory-orchestrate as the single discoverable skill.
  # The 9 granular skills live inside memory-orchestrate/docs/ and are
  # referenced on-demand — they are NOT installed as top-level skills to
  # avoid router ambiguity and wasted token budget at session start.
  ORCHESTRATE_SRC="$PROJECT_DIR/skills/memory-orchestrate"
  if [[ -d "$ORCHESTRATE_SRC" ]]; then
    ORCHESTRATE_DEST="${SKILL_DIR}/memory-orchestrate"
    rm -rf "$ORCHESTRATE_DEST"
    cp -r "$ORCHESTRATE_SRC" "$ORCHESTRATE_DEST"
    ok "memory-orchestrate skill installed → $ORCHESTRATE_DEST"
  else
    warn "skills/memory-orchestrate not found — skipping skill install"
  fi

  # 2. Register MCP server in Claude Code
  #    Claude Code stores MCP config in ~/.claude.json (global) under mcpServers
  CLAUDE_CONFIG="${HOME}/.claude.json"

  MCP_ENTRY=$(cat <<EOF
{
  "type": "sse",
  "url": "${NEUROMEM_SSE_URL}"
}
EOF
)

  if command -v claude &>/dev/null; then
    # Use the CLI if available — cleanest method
    if claude mcp add neuromem --transport sse "${NEUROMEM_SSE_URL}" 2>/dev/null; then
      ok "MCP server registered via 'claude mcp add'"
    else
      # Fall back to direct JSON edit
      _patch_json_mcp "$CLAUDE_CONFIG" "neuromem" "$MCP_ENTRY"
    fi
  else
    _patch_json_mcp "$CLAUDE_CONFIG" "neuromem" "$MCP_ENTRY"
  fi

  # 3. Write/patch ~/.claude/CLAUDE.md with forced memory eval hook + pinned agent_id
  GLOBAL_CLAUDE_MD="${HOME}/.claude/CLAUDE.md"
  NEUROMEM_START_MARKER="<!-- NeuroMem Memory Directive -->"
  NEUROMEM_END_MARKER="<!-- End NeuroMem Memory Directive -->"

  CLAUDE_MD_BLOCK="${NEUROMEM_START_MARKER}
## Memory (NeuroMem)

Your agent_id for all memory calls is: **${AGENT_ID}**

Before making any other tool call at the start of a session, evaluate:
> \"Have I called recall() yet this session?\"
If the answer is no — call it now using the topic from the user's opening message.

Rules:
- recall() runs FIRST, before Read, Glob, Grep, WebSearch, or any other tool
- remember() whenever the user states a preference, fact, constraint, or decision
- forget() then remember() when the user corrects something
- reflect() + consolidate() at session end when warranted
- Never announce memory tool calls to the user
${NEUROMEM_END_MARKER}"

  mkdir -p "$(dirname "$GLOBAL_CLAUDE_MD")"

  if [[ -f "$GLOBAL_CLAUDE_MD" ]] && grep -qF "$NEUROMEM_START_MARKER" "$GLOBAL_CLAUDE_MD"; then
    # Replace existing block using python3 (safer than sed for multiline)
    python3 - "$GLOBAL_CLAUDE_MD" "$AGENT_ID" <<'PYEOF'
import sys, re
filepath, agent_id = sys.argv[1], sys.argv[2]
with open(filepath) as f:
    content = f.read()
block = (
    "<!-- NeuroMem Memory Directive -->\n"
    "## Memory (NeuroMem)\n\n"
    f"Your agent_id for all memory calls is: **{agent_id}**\n\n"
    "Before making any other tool call at the start of a session, evaluate:\n"
    '> "Have I called recall() yet this session?"\n'
    "If the answer is no — call it now using the topic from the user's opening message.\n\n"
    "Rules:\n"
    "- recall() runs FIRST, before Read, Glob, Grep, WebSearch, or any other tool\n"
    "- remember() whenever the user states a preference, fact, constraint, or decision\n"
    "- forget() then remember() when the user corrects something\n"
    "- reflect() + consolidate() at session end when warranted\n"
    "- Never announce memory tool calls to the user\n"
    "<!-- End NeuroMem Memory Directive -->"
)
new = re.sub(
    r'<!-- NeuroMem Memory Directive -->.*?<!-- End NeuroMem Memory Directive -->',
    block, content, flags=re.DOTALL
)
with open(filepath, 'w') as f:
    f.write(new)
PYEOF
    ok "CLAUDE.md memory directive updated (agent_id: ${AGENT_ID})"
  elif [[ -f "$GLOBAL_CLAUDE_MD" ]]; then
    printf '\n%s\n' "$CLAUDE_MD_BLOCK" >> "$GLOBAL_CLAUDE_MD"
    ok "CLAUDE.md memory directive appended → $GLOBAL_CLAUDE_MD"
  else
    printf '%s\n' "$CLAUDE_MD_BLOCK" > "$GLOBAL_CLAUDE_MD"
    ok "CLAUDE.md created with memory directive → $GLOBAL_CLAUDE_MD"
  fi

  CONNECTED+=("Claude Code")
}

# ── OpenCode ──────────────────────────────────────────────────────
install_opencode() {
  echo ""
  info "Setting up OpenCode..."

  # OpenCode config: ~/.config/opencode/config.json
  # MCP servers live under the "mcp" key
  OC_CONFIG_DIR="${HOME}/.config/opencode"
  OC_CONFIG="${OC_CONFIG_DIR}/config.json"
  mkdir -p "$OC_CONFIG_DIR"

  MCP_ENTRY=$(cat <<EOF
{
  "type": "sse",
  "url": "${NEUROMEM_SSE_URL}"
}
EOF
)

  _patch_json_mcp "$OC_CONFIG" "neuromem" "$MCP_ENTRY" "mcp"

  # Also drop/merge AGENTS.md into current working directory (OpenCode reads it)
  AGENTS_SRC="$PROJECT_DIR/neuromem-AGENTS.md"
  AGENTS_DEST="$(pwd)/AGENTS.md"
  NEUROMEM_MARKER="# --- NeuroMem Memory Directive ---"

  if [[ -f "$AGENTS_SRC" ]]; then
    if [[ -f "$AGENTS_DEST" ]]; then
      # Check if neuromem block already present
      if grep -qF "$NEUROMEM_MARKER" "$AGENTS_DEST"; then
        ok "AGENTS.md already contains NeuroMem block — skipping"
      else
        # Back up existing file then append neuromem section
        cp "$AGENTS_DEST" "${AGENTS_DEST}.neuromem-backup"
        ok "Backed up existing AGENTS.md → AGENTS.md.neuromem-backup"
        {
          echo ""
          echo "$NEUROMEM_MARKER"
          echo "<!-- Added by NeuroMem installer. Remove this section to uninstall. -->"
          echo ""
          cat "$AGENTS_SRC"
        } >> "$AGENTS_DEST"
        ok "NeuroMem section appended to existing AGENTS.md"
      fi
    else
      # No existing file — create fresh with marker
      {
        echo "$NEUROMEM_MARKER"
        echo "<!-- Added by NeuroMem installer. Remove this section to uninstall. -->"
        echo ""
        cat "$AGENTS_SRC"
      } > "$AGENTS_DEST"
      ok "AGENTS.md created in $(pwd)"
    fi
  fi

  ok "OpenCode MCP server registered → $OC_CONFIG"
  CONNECTED+=("OpenCode")
}

# ── Cursor ────────────────────────────────────────────────────────
install_cursor() {
  echo ""
  info "Setting up Cursor..."

  CURSOR_SRC="$PROJECT_DIR/neuromem-cursorrules.txt"
  CURSOR_DEST="$(pwd)/.cursorrules"

  if [[ ! -f "$CURSOR_SRC" ]]; then
    warn "neuromem-cursorrules.txt not found in project — skipping"
    SKIPPED+=("Cursor (missing source file)")
    return
  fi

  if [[ -f "$CURSOR_DEST" ]]; then
    warn ".cursorrules already exists in $(pwd)"
    read -rp "  Overwrite? [y/N]: " overwrite
    if [[ "$overwrite" =~ ^[Yy]$ ]]; then
      cp "$CURSOR_SRC" "$CURSOR_DEST"
      ok ".cursorrules updated in $(pwd)"
    else
      warn "Skipped — existing .cursorrules left intact"
      SKIPPED+=("Cursor (skipped by user)")
      return
    fi
  else
    cp "$CURSOR_SRC" "$CURSOR_DEST"
    ok ".cursorrules installed in $(pwd)"
  fi

  # Cursor also supports MCP via ~/.cursor/mcp.json
  CURSOR_MCP="${HOME}/.cursor/mcp.json"
  if [[ -d "${HOME}/.cursor" ]]; then
    MCP_ENTRY=$(cat <<EOF
{
  "url": "${NEUROMEM_SSE_URL}"
}
EOF
)
    _patch_json_mcp "$CURSOR_MCP" "neuromem" "$MCP_ENTRY" "mcpServers"
    ok "MCP server registered → $CURSOR_MCP"
  fi

  CONNECTED+=("Cursor")
}

# ── GitHub Copilot ───────────────────────────────────────────────
install_copilot() {
  echo ""
  info "Setting up GitHub Copilot..."

  NEUROMEM_MARKER="<!-- NeuroMem Memory Directive -->"
  COPILOT_INSTRUCTIONS_DIR="$(pwd)/.github"
  COPILOT_INSTRUCTIONS="${COPILOT_INSTRUCTIONS_DIR}/copilot-instructions.md"
  COPILOT_BACKUP="${COPILOT_INSTRUCTIONS}.neuromem-backup"

  # 1. Write .github/copilot-instructions.md (memory directive for Copilot Chat)
  mkdir -p "$COPILOT_INSTRUCTIONS_DIR"

  DIRECTIVE=$(cat "$PROJECT_DIR/neuromem-AGENTS.md" 2>/dev/null || echo "")
  if [[ -z "$DIRECTIVE" ]]; then
    warn "neuromem-AGENTS.md not found — skipping copilot-instructions.md"
  else
    if [[ -f "$COPILOT_INSTRUCTIONS" ]]; then
      if grep -qF "$NEUROMEM_MARKER" "$COPILOT_INSTRUCTIONS"; then
        ok "copilot-instructions.md already contains NeuroMem block — skipping"
      else
        cp "$COPILOT_INSTRUCTIONS" "$COPILOT_BACKUP"
        ok "Backed up existing copilot-instructions.md → copilot-instructions.md.neuromem-backup"
        {
          echo ""
          echo "$NEUROMEM_MARKER"
          echo ""
          echo "$DIRECTIVE"
        } >> "$COPILOT_INSTRUCTIONS"
        ok "NeuroMem section appended to copilot-instructions.md"
      fi
    else
      {
        echo "$NEUROMEM_MARKER"
        echo ""
        echo "$DIRECTIVE"
      } > "$COPILOT_INSTRUCTIONS"
      ok "copilot-instructions.md created → $COPILOT_INSTRUCTIONS"
    fi
  fi

  # 2. Register MCP server in VS Code settings
  #    Copilot reads MCP servers from two places (we do both):
  #      a) Workspace:  .vscode/mcp.json           (project-scoped)
  #      b) Global:     VS Code User settings.json  (all projects)

  MCP_ENTRY=$(cat <<EOF
{
  "type": "sse",
  "url": "${NEUROMEM_SSE_URL}"
}
EOF
)

  # a) Workspace .vscode/mcp.json
  VSCODE_DIR="$(pwd)/.vscode"
  VSCODE_MCP="${VSCODE_DIR}/mcp.json"
  mkdir -p "$VSCODE_DIR"
  _patch_json_mcp "$VSCODE_MCP" "neuromem" "$MCP_ENTRY" "servers"
  ok "MCP server registered → $VSCODE_MCP (workspace)"

  # b) Global VS Code settings.json
  if [[ "$OSTYPE" == "darwin"* ]]; then
    VSCODE_SETTINGS="${HOME}/Library/Application Support/Code/User/settings.json"
  else
    VSCODE_SETTINGS="${HOME}/.config/Code/User/settings.json"
  fi

  if [[ -d "$(dirname "$VSCODE_SETTINGS")" ]]; then
    # VS Code settings use a nested path: mcp.servers.neuromem
    if [[ "$HAS_JQ" == "true" ]]; then
      local current="{}"
      [[ -f "$VSCODE_SETTINGS" ]] && current=$(cat "$VSCODE_SETTINGS")
      echo "$current" | jq \
        --arg name "neuromem" \
        --argjson val "$MCP_ENTRY" \
        '.mcp.servers[$name] = $val' \
        > "${VSCODE_SETTINGS}.tmp" && mv "${VSCODE_SETTINGS}.tmp" "$VSCODE_SETTINGS"
      ok "MCP server registered → $VSCODE_SETTINGS (global)"
    else
      warn "jq not found — add this manually to $VSCODE_SETTINGS:"
      echo ""
      echo -e "  ${YELLOW}\"mcp\": { \"servers\": { \"neuromem\": ${MCP_ENTRY} } }${RESET}"
      echo ""
    fi
  else
    warn "VS Code global settings not found — workspace .vscode/mcp.json only"
  fi

  CONNECTED+=("GitHub Copilot")
}

# ── JSON patcher helper ───────────────────────────────────────────
# Adds/updates a key inside a nested JSON object (creates file if missing)
# Usage: _patch_json_mcp <file> <server-name> <entry-json> [<parent-key>]
_patch_json_mcp() {
  local file="$1"
  local server_name="$2"
  local entry_json="$3"
  local parent="${4:-mcpServers}"

  if [[ "$HAS_JQ" == "true" ]]; then
    local current="{}"
    [[ -f "$file" ]] && current=$(cat "$file")
    echo "$current" | jq \
      --arg key "$parent" \
      --arg name "$server_name" \
      --argjson val "$entry_json" \
      '.[$key] = ((.[$key] // {}) + {($name): $val})' \
      > "${file}.tmp" && mv "${file}.tmp" "$file"
    ok "Patched $file (jq)"
  else
    # jq not available — append a comment and manual instruction
    warn "jq not found — cannot auto-patch $file"
    echo ""
    echo -e "  ${YELLOW}Add this manually to ${file} under \"${parent}\":${RESET}"
    echo ""
    echo -e "  \"${server_name}\": ${entry_json}"
    echo ""
  fi
}

# ── Run installs ──────────────────────────────────────────────────
if [[ "$TOOLS" == "all" ]]; then
  DETECTED=($(detect_tools))
  if [[ ${#DETECTED[@]} -eq 0 ]]; then
    warn "No supported AI tools auto-detected."
    warn "You can run with --tools claude-code,opencode,cursor to force install."
  else
    info "Auto-detected: ${DETECTED[*]}"
    for tool in "${DETECTED[@]}"; do
      case "$tool" in
        claude-code) install_claude_code ;;
        opencode)    install_opencode ;;
        cursor)      install_cursor ;;
        copilot)     install_copilot ;;
      esac
    done
  fi
else
  IFS=',' read -ra TOOL_LIST <<< "$TOOLS"
  for tool in "${TOOL_LIST[@]}"; do
    tool=$(echo "$tool" | tr -d ' ')
    case "$tool" in
      claude-code) install_claude_code ;;
      opencode)    install_opencode ;;
      cursor)      install_cursor ;;
      copilot)     install_copilot ;;
      *) warn "Unknown tool: $tool (valid: claude-code, opencode, cursor, copilot)" ;;
    esac
  done
fi

# ─────────────────────────────────────────────────────────────────
# 5. SUMMARY
# ─────────────────────────────────────────────────────────────────
hdr "5/5  Summary"
echo ""

echo -e "  ${BOLD}NeuroMem server${RESET}"
echo -e "  URL:       ${NEUROMEM_URL}"
echo -e "  MCP/SSE:   ${NEUROMEM_SSE_URL}"
echo -e "  Web UI:    ${NEUROMEM_URL}  (open in browser)"
echo -e "  Agent ID:  ${AGENT_ID}"
echo ""

if [[ ${#CONNECTED[@]} -gt 0 ]]; then
  echo -e "  ${GREEN}${BOLD}Connected tools:${RESET}"
  for t in "${CONNECTED[@]}"; do
    echo -e "  ${GREEN}  ✔${RESET}  $t"
  done
fi

if [[ ${#SKIPPED[@]} -gt 0 ]]; then
  echo ""
  echo -e "  ${YELLOW}${BOLD}Skipped:${RESET}"
  for t in "${SKIPPED[@]}"; do
    echo -e "  ${YELLOW}  ⚠${RESET}  $t"
  done
fi

echo ""
echo -e "  ${BOLD}Useful commands:${RESET}"
echo -e "  make status    → check container health"
echo -e "  make logs      → follow server logs"
echo -e "  make backup    → back up all memory data"
echo -e "  make reset     → wipe all data and start fresh"
echo ""
echo -e "  ${BOLD}To connect a tool manually:${RESET}"
echo -e "  Claude Code   →  cp -r skills/memory-orchestrate ~/.claude/skills/"
echo -e "                   claude mcp add neuromem --transport sse ${NEUROMEM_SSE_URL}"
echo -e "                   (also patch ~/.claude/CLAUDE.md with the memory directive)"
echo -e "  OpenCode      →  add to ~/.config/opencode/config.json under \"mcp\""
echo -e "                   cp neuromem-AGENTS.md ./AGENTS.md"
echo -e "  Cursor        →  cp neuromem-cursorrules.txt .cursorrules"
echo -e "                   add to ~/.cursor/mcp.json under \"mcpServers\""
echo -e "  Copilot       →  add to .vscode/mcp.json under \"servers\""
echo -e "                   append neuromem-AGENTS.md to .github/copilot-instructions.md"
echo -e "  Any harness   →  paste neuromem-memory-pack-README.md for all formats"
echo ""
echo -e "${GREEN}${BOLD}  ✔ NeuroMem install complete!${RESET}"
echo ""
