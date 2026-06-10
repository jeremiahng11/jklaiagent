# syntax=docker/dockerfile:1

# --- Stage 1: install all deps & build the React app ---
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY . .
RUN npm run build
# Best-effort: pre-download the local embeddings model into ./.models so the
# runtime image needs no network for RAG. NON-FATAL — if the download is blocked
# or slow during the build, we just skip it (the model downloads at runtime on
# first use, or falls back to keyword recall). Always create the dir so the
# later COPY of ./.models succeeds either way.
RUN mkdir -p .models && (node -e "import('./server/embeddings.js').then(m=>m.warmEmbeddings()).then(n=>console.log('[build] embeddings cached, dim',n)).catch(e=>console.warn('[build] embeddings prefetch skipped (will download at runtime):', e && e.message))" || true)

# --- Stage 2: production-only deps ---
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# --- Stage 3: minimal runtime image ---
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node --from=build /app/.models ./.models
COPY --chown=node:node server ./server
COPY --chown=node:node package.json ./

USER node
EXPOSE 3000

# Liveness: the login page is always public and cheap.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
