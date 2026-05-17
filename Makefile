.DEFAULT_GOAL := help

# ─────────────────────────────────────────────────────────────────
# NeuroMem — Makefile
# ─────────────────────────────────────────────────────────────────

.PHONY: help up down build restart logs status \
        dev demo backup reset lint typecheck install uninstall \
        proxy-up proxy-logs

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | \
		awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# ── Docker ───────────────────────────────────────────────────────

up: ## Start all services (build if needed)
	docker compose up -d --build

down: ## Stop all services
	docker compose down

build: ## Rebuild images without starting
	docker compose build

restart: ## Restart all services
	docker compose restart

logs: ## Follow neuromem-server logs
	docker compose logs -f neuromem

status: ## Show container status
	docker ps --filter name=neuromem --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"

build-deploy: ## build and run neuromem-server only (for development)
	docker compose build neuromem
	docker compose up -d neuromem

# ── Development ──────────────────────────────────────────────────

dev: ## Run MCP server in watch mode (tsx)
	npm run dev

demo: ## Run the demo script
	npm run demo

# ── Code quality ─────────────────────────────────────────────────

build-ts: ## Compile TypeScript
	npm run build

typecheck: ## Type-check without emitting
	npx tsc --noEmit

# ── Install & connect ────────────────────────────────────────────

install: ## Install NeuroMem and connect to AI tools (Claude Code, OpenCode, Cursor)
	bash scripts/install.sh

install-claude: ## Connect to Claude Code only
	bash scripts/install.sh --tools claude-code

install-opencode: ## Connect to OpenCode only
	bash scripts/install.sh --tools opencode

install-cursor: ## Connect to Cursor only
	bash scripts/install.sh --tools cursor

install-copilot: ## Connect to GitHub Copilot only
	bash scripts/install.sh --tools copilot

uninstall: ## Disconnect NeuroMem from all AI tools (keeps data)
	bash scripts/uninstall.sh

uninstall-wipe: ## Disconnect and delete ALL memory data (irreversible)
	bash scripts/uninstall.sh --wipe-data --stop-docker

# ── Proxy mode ───────────────────────────────────────────────────

proxy-up: ## Start stack with drop-in LLM proxy enabled (requires PROXY_TARGET_URL)
	PROXY_ENABLED=true docker compose up -d --build

proxy-logs: ## Follow proxy-specific log lines only
	docker compose logs -f neuromem | grep "\[Proxy\]"

# ── Data management ──────────────────────────────────────────────

backup: ## Back up all data volumes to ./backups/
	bash scripts/backup.sh

reset: ## Destroy all volumes and restart fresh
	docker compose down -v
	docker compose up -d --build

