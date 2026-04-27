# HyreLog API — production image
# Build (from hyrelog-api repo root):
#   docker build -f services/api/Dockerfile -t hyrelog-api:latest .
#
# Node 20 matches root "engines" in package.json.
FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/api/package.json services/api/
RUN npm ci --workspace=services/api

COPY services/api/prisma services/api/prisma
COPY services/api/prisma.config.ts services/api/
COPY services/api/src services/api/src
COPY services/api/tsconfig.json services/api/
COPY tsconfig.json ./

# Prisma config requires a URL string at generate time; no live DB connection.
ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/hyrelog_build?schema=public"
RUN npm run prisma:generate --workspace=services/api
RUN npm run build --workspace=services/api

# Drop devDependencies for a smaller runtime layer
RUN npm prune --omit=dev

# --- runtime: reuse pruned /app (hoisted node_modules + services/api/dist) ---
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

COPY --from=build /app /app

ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app/services/api
EXPOSE 3000

# server.ts: loadConfig reads repo-root .env in dev — in ECS inject env via task definition / secrets (no .env in image)
CMD ["node", "dist/server.js"]
