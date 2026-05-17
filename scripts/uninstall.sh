#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────
# NeuroMem — Uninstall Script
#
# Usage:
#   bash scripts/uninstall.sh [--tools <list>] [--wipe-data] [--stop-docker] [--help]
#
# Options:
#   --tools         Comma-separated tools to disconnect.
#                   Options: claude-code, opencode, cursor, all
#                   Default: all
#   --wipe-data     Also destroy Docker volumes (deletes ALL memory data)
#   --stop-docker   Stop the Docker stack (default: leave it running)
#   --help          Show this message
#
# What this script does:
#   1. Removes the neuromem.skill from Claude Code skills folder
#   2. Removes the neuromem MCP server entry from Claude Code config
#   3. Removes the neuromem MCP server entry from OpenCode config
#   4. Removes the neuromem MCP server entry from Cursor config
#   5. Strips the NeuroMem section from AGENTS.md (restores backup if available)
#   6. Removes .cursorrules if it was installed by NeuroMem
#   7. Optionally stops Docker and/or wipes all memory data volumes
#
# Nothing is deleted without confirmation when --wipe-data is passed.
# All other removals are non-destructive (config keys, file sections).
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
TOOLS="all"
WIPE_DATA=false
STOP_DOCKER=false
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── Arg parsing ──────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --tools)       TOOLS="$2"; shift 2 ;;
    --wipe-data)   WIPE_DATA=true; shift ;;
    --stop-docker) STOP_DOCKER=true; shift ;;
    --help|-h)
      sed -n '/^# Usage:/,/^# ──/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) err "Unknown option: $1"; exit 1 ;;
  esac
done

# ── Helpers ───────────────────────────────────────────────────────
HAS_JQ=false
command -v jq &>/dev/null && HAS_JQ=true

should_remove() {
  local tool="$1"
  [[ "$TOOLS" == "all" ]] || echo "$TOOLS" | tr ',' '\n' | grep -qx "$tool"
}

# Remove a key from a JSON file using jq
# Usage: _remove_json_key <file> <parent-key> <entry-name>
_remove_json_key() {
  local file="$1"
  local parent="$2"
  local name="$3"

  [[ ! -f "$file" ]] && return 0

  if [[ "$HAS_JQ" == "true" ]]; then
    jq --arg key "$parent" --arg name "$name" \
      'if .[$key] then .[$key] |= del(.[$name]) else . end' \
      "$file" > "${file}.tmp" && mv "${file}.tmp" "$file"
    ok "Removed '$name' from $file"
  else
    warn "jq not found — manually remove the '$name' entry from $file under '$parent'"
  fi
}

# ─────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}🧠  NeuroMem Uninstaller${RESET}"
echo    "────────────────────────────────────────"
echo -e "  ${YELLOW}This will disconnect NeuroMem from your AI tools.${RESET}"
echo -e "  Your memory data will ${BOLD}NOT${RESET} be deleted unless you pass --wipe-data."
echo ""
read -rp "  Continue? [y/N]: " confirm
[[ "$confirm" =~ ^[Yy]$ ]] || { echo "  Aborted."; exit 0; }

REMOVED=()
SKIPPED=()

# ─────────────────────────────────────────────────────────────────
# CLAUDE CODE
# ─────────────────────────────────────────────────────────────────
remove_claude_code() {
  hdr "Claude Code"

  # 1. Remove bundled skill file
  SKILL_DIR="${HOME}/.claude/skills"
  SKILL_FILE="${SKILL_DIR}/neuromem.skill"
  if [[ -f "$SKILL_FILE" ]]; then
    rm "$SKILL_FILE"
    ok "Removed skill → $SKILL_FILE"
  else
    warn "neuromem.skill not found at $SKILL_FILE — already removed?"
  fi

  # Remove the 9 granular skills
  GRANULAR_SKILLS=(
    memory-orchestrate
    memory-session-start
    memory-continuous
    memory-recall
    memory-write
    memory-forget
    memory-reflect
    memory-session-end
    memory-consolidate
  )
  local removed_count=0
  for skill in "${GRANULAR_SKILLS[@]}"; do
    skill_dir="${SKILL_DIR}/${skill}"
    if [[ -d "$skill_dir" ]]; then
      rm -rf "$skill_dir"
      removed_count=$((removed_count + 1))
    fi
  done
  if [[ $removed_count -gt 0 ]]; then
    ok "$removed_count granular skills removed from $SKILL_DIR/"
  else
    warn "No granular skills found in $SKILL_DIR/ — already removed?"
  fi

  # 2. Remove MCP server entry
  # Try CLI first
  if command -v claude &>/dev/null; then
    if claude mcp remove neuromem 2>/dev/null; then
      ok "MCP server removed via 'claude mcp remove'"
    else
      # Fall back to JSON patch
      _remove_json_key "${HOME}/.claude.json" "mcpServers" "neuromem"
    fi
  else
    _remove_json_key "${HOME}/.claude.json" "mcpServers" "neuromem"
  fi

  REMOVED+=("Claude Code")
}

# ─────────────────────────────────────────────────────────────────
# OPENCODE
# ─────────────────────────────────────────────────────────────────
remove_opencode() {
  hdr "OpenCode"

  # 1. Remove MCP server entry from config
  OC_CONFIG="${HOME}/.config/opencode/config.json"
  if [[ -f "$OC_CONFIG" ]]; then
    _remove_json_key "$OC_CONFIG" "mcp" "neuromem"
  else
    warn "OpenCode config not found at $OC_CONFIG — skipping"
  fi

  # 2. Handle AGENTS.md
  AGENTS_FILE="$(pwd)/AGENTS.md"
  AGENTS_BACKUP="$(pwd)/AGENTS.md.neuromem-backup"
  NEUROMEM_MARKER="# --- NeuroMem Memory Directive ---"

  if [[ -f "$AGENTS_FILE" ]]; then
    if grep -qF "$NEUROMEM_MARKER" "$AGENTS_FILE"; then
      if [[ -f "$AGENTS_BACKUP" ]]; then
        # Restore from backup
        mv "$AGENTS_BACKUP" "$AGENTS_FILE"
        ok "AGENTS.md restored from backup"
      else
        # Strip the neuromem section (from marker to end of file)
        # Works whether neuromem was appended or was the whole file
        local tmp
        tmp=$(mktemp)
        awk "/$NEUROMEM_MARKER/{found=1} !found{print}" "$AGENTS_FILE" > "$tmp"

        if [[ -s "$tmp" ]]; then
          # Content before marker exists — keep it (trim trailing blank lines)
          awk 'NF{last=NR} {lines[NR]=$0} END{for(i=1;i<=last;i++) print lines[i]}' "$tmp" > "$AGENTS_FILE"
          ok "NeuroMem section stripped from AGENTS.md"
        else
          # File was created entirely by neuromem — remove it
          rm "$AGENTS_FILE"
          ok "AGENTS.md removed (was created by NeuroMem installer)"
        fi
        rm -f "$tmp"
      fi
    else
      warn "No NeuroMem section found in AGENTS.md — skipping"
    fi
  else
    warn "AGENTS.md not found in $(pwd) — skipping"
  fi

  REMOVED+=("OpenCode")
}

# ─────────────────────────────────────────────────────────────────
# CURSOR
# ─────────────────────────────────────────────────────────────────
remove_cursor() {
  hdr "Cursor"

  # 1. Remove .cursorrules if it belongs to neuromem
  CURSOR_RULES="$(pwd)/.cursorrules"
  CURSOR_SRC="$PROJECT_DIR/neuromem-cursorrules.txt"

  if [[ -f "$CURSOR_RULES" ]]; then
    # Check if it's ours by looking for a neuromem fingerprint
    if grep -qiF "neuromem" "$CURSOR_RULES" 2>/dev/null; then
      rm "$CURSOR_RULES"
      ok ".cursorrules removed from $(pwd)"
    else
      warn ".cursorrules exists but doesn't appear to be NeuroMem's — leaving it intact"
      SKIPPED+=("Cursor .cursorrules (not ours)")
    fi
  else
    warn ".cursorrules not found in $(pwd) — already removed?"
  fi

  # 2. Remove MCP server entry from Cursor config
  CURSOR_MCP="${HOME}/.cursor/mcp.json"
  if [[ -f "$CURSOR_MCP" ]]; then
    _remove_json_key "$CURSOR_MCP" "mcpServers" "neuromem"
  else
    warn "Cursor MCP config not found at $CURSOR_MCP — skipping"
  fi

  REMOVED+=("Cursor")
}

# ─────────────────────────────────────────────────────────────────
# GITHUB COPILOT
# ─────────────────────────────────────────────────────────────────
remove_copilot() {
  hdr "GitHub Copilot"

  NEUROMEM_MARKER="<!-- NeuroMem Memory Directive -->"
  COPILOT_INSTRUCTIONS="$(pwd)/.github/copilot-instructions.md"
  COPILOT_BACKUP="${COPILOT_INSTRUCTIONS}.neuromem-backup"

  # 1. Handle copilot-instructions.md
  if [[ -f "$COPILOT_INSTRUCTIONS" ]]; then
    if grep -qF "$NEUROMEM_MARKER" "$COPILOT_INSTRUCTIONS"; then
      if [[ -f "$COPILOT_BACKUP" ]]; then
        mv "$COPILOT_BACKUP" "$COPILOT_INSTRUCTIONS"
        ok "copilot-instructions.md restored from backup"
      else
        local tmp
        tmp=$(mktemp)
        awk "/$NEUROMEM_MARKER/{found=1} !found{print}" "$COPILOT_INSTRUCTIONS" > "$tmp"
        if [[ -s "$tmp" ]]; then
          awk 'NF{last=NR} {lines[NR]=$0} END{for(i=1;i<=last;i++) print lines[i]}' "$tmp" > "$COPILOT_INSTRUCTIONS"
          ok "NeuroMem section stripped from copilot-instructions.md"
        else
          rm "$COPILOT_INSTRUCTIONS"
          ok "copilot-instructions.md removed (was created by NeuroMem installer)"
        fi
        rm -f "$tmp"
      fi
    else
      warn "No NeuroMem section found in copilot-instructions.md — skipping"
    fi
  else
    warn "copilot-instructions.md not found in $(pwd)/.github/ — skipping"
  fi

  # 2. Remove from workspace .vscode/mcp.json
  VSCODE_MCP="$(pwd)/.vscode/mcp.json"
  if [[ -f "$VSCODE_MCP" ]]; then
    _remove_json_key "$VSCODE_MCP" "servers" "neuromem"
  else
    warn ".vscode/mcp.json not found — skipping workspace config"
  fi

  # 3. Remove from global VS Code settings.json
  if [[ "$OSTYPE" == "darwin"* ]]; then
    VSCODE_SETTINGS="${HOME}/Library/Application Support/Code/User/settings.json"
  else
    VSCODE_SETTINGS="${HOME}/.config/Code/User/settings.json"
  fi

  if [[ -f "$VSCODE_SETTINGS" ]]; then
    if [[ "$HAS_JQ" == "true" ]]; then
      jq 'if .mcp.servers then del(.mcp.servers.neuromem) else . end' \
        "$VSCODE_SETTINGS" > "${VSCODE_SETTINGS}.tmp" \
        && mv "${VSCODE_SETTINGS}.tmp" "$VSCODE_SETTINGS"
      ok "Removed neuromem from VS Code global settings"
    else
      warn "jq not found — manually remove 'neuromem' from $VSCODE_SETTINGS under mcp.servers"
    fi
  else
    warn "VS Code global settings not found — skipping"
  fi

  REMOVED+=("GitHub Copilot")
}

# ─────────────────────────────────────────────────────────────────
# Run removals
# ─────────────────────────────────────────────────────────────────
if [[ "$TOOLS" == "all" ]]; then
  remove_claude_code
  remove_opencode
  remove_cursor
  remove_copilot
else
  IFS=',' read -ra TOOL_LIST <<< "$TOOLS"
  for tool in "${TOOL_LIST[@]}"; do
    tool=$(echo "$tool" | tr -d ' ')
    case "$tool" in
      claude-code) remove_claude_code ;;
      opencode)    remove_opencode ;;
      cursor)      remove_cursor ;;
      copilot)     remove_copilot ;;
      *) warn "Unknown tool: $tool (valid: claude-code, opencode, cursor, copilot)" ;;
    esac
  done
fi

# ─────────────────────────────────────────────────────────────────
# DOCKER STACK
# ─────────────────────────────────────────────────────────────────
hdr "Docker stack"

COMPOSE="docker compose"
command -v docker &>/dev/null || { warn "Docker not found — skipping"; COMPOSE=""; }

if [[ -n "$COMPOSE" ]]; then
  if [[ "$WIPE_DATA" == "true" ]]; then
    echo ""
    echo -e "  ${RED}${BOLD}⚠  WARNING: --wipe-data will permanently delete ALL memory data.${RESET}"
    echo -e "  ${RED}   This includes every episodic, semantic, procedural, and working memory.${RESET}"
    echo -e "  ${RED}   This cannot be undone (unless you have a backup from 'make backup').${RESET}"
    echo ""
    read -rp "  Type 'delete my memories' to confirm: " wipe_confirm
    if [[ "$wipe_confirm" == "delete my memories" ]]; then
      cd "$PROJECT_DIR"
      $COMPOSE down -v
      ok "Docker stack stopped and all volumes wiped"
    else
      warn "Confirmation did not match — volumes left intact"
      $COMPOSE down 2>/dev/null && ok "Docker stack stopped (volumes preserved)" || true
    fi
  elif [[ "$STOP_DOCKER" == "true" ]]; then
    cd "$PROJECT_DIR"
    $COMPOSE down 2>/dev/null && ok "Docker stack stopped (volumes preserved)" || true
  else
    warn "Docker stack left running (use --stop-docker to stop, --wipe-data to delete data)"
  fi
fi

# ─────────────────────────────────────────────────────────────────
# SUMMARY
# ─────────────────────────────────────────────────────────────────
hdr "Summary"
echo ""

if [[ ${#REMOVED[@]} -gt 0 ]]; then
  echo -e "  ${GREEN}${BOLD}Disconnected:${RESET}"
  for t in "${REMOVED[@]}"; do
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
echo -e "  ${BOLD}Memory data:${RESET}"
if [[ "$WIPE_DATA" == "true" ]]; then
  echo -e "  ${RED}  Deleted (volumes wiped)${RESET}"
else
  echo -e "  ${GREEN}  Preserved${RESET} — run with --wipe-data to delete"
fi

echo ""
echo -e "  ${BOLD}To reinstall at any time:${RESET}"
echo -e "  bash scripts/install.sh"
echo -e "  make install"
echo ""
echo -e "${GREEN}${BOLD}  ✔ NeuroMem uninstall complete.${RESET}"
echo ""
