# ─── Server build stage ─────────────────────────────────
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build:server
RUN npm prune --production

# ─── UI build stage ─────────────────────────────────────
FROM node:20-alpine AS ui-builder
WORKDIR /app/ui
COPY ui/package*.json ./
RUN npm ci
COPY ui/ ./
RUN npm run build

# ─── Runtime stage ──────────────────────────────────────
FROM node:20-alpine AS runtime
RUN apk add --no-cache tini curl
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
COPY --from=ui-builder /app/dist/ui ./dist/ui
RUN addgroup -S neuromem && adduser -S neuromem -G neuromem
USER neuromem
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1
CMD ["node", "dist/mcp/server.js"]
