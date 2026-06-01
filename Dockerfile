# syntax=docker/dockerfile:1

# --- Stage 1: install all deps & build TypeScript ---
FROM node:22-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Stage 2: production-only deps ---
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- Stage 3: minimal runtime image ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
# Conversations persist here — mount a volume at this path to keep history.
ENV DATA_DIR=/app/data
WORKDIR /app

# gosu lets the entrypoint drop from root to `node` after fixing volume perms.
RUN apt-get update \
  && apt-get install -y --no-install-recommends gosu \
  && rm -rf /var/lib/apt/lists/*

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Pre-create the data dir owned by the runtime user.
RUN mkdir -p /app/data && chown -R node:node /app/data
VOLUME ["/app/data"]

# We intentionally start as root so the entrypoint can chown a freshly-mounted
# volume, then exec the app as the non-root `node` user via gosu.
EXPOSE 3000

# Lightweight healthcheck hitting the /health route.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "dist/index.js"]
