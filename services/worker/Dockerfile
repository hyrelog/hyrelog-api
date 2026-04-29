# HyreLog Worker — production image
# Worker imports @prisma/client from ../../api/node_modules/.prisma/client (see services/worker/src/lib/regionRouter.ts)
# so the image MUST include a generated Prisma client under services/api/node_modules/...
#
# Build (from hyrelog-api repo root):
#   docker build -f services/worker/Dockerfile -t hyrelog-worker:latest .

FROM node:20-bookworm-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
COPY services/api/package.json services/api/
COPY services/worker/package.json services/worker/
RUN npm ci --workspace=services/api --workspace=services/worker

# Prisma (shared schema with API)
COPY services/api/prisma services/api/prisma
COPY services/api/prisma.config.ts services/api/
COPY services/api/tsconfig.json services/api/
COPY services/worker services/worker
# Root tsconfig is extended by services/worker/tsconfig.json
COPY tsconfig.json ./

ENV DATABASE_URL="postgresql://build:build@127.0.0.1:5432/hyrelog_build?schema=public"
RUN npm run prisma:generate --workspace=services/api
RUN npm run build --workspace=services/worker
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
WORKDIR /app
COPY --from=build /app /app
WORKDIR /app/services/worker

ENV NODE_ENV=production

COPY scripts/docker/docker-entrypoint-database-url.sh /usr/local/bin/docker-entrypoint-database-url.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint-database-url.sh && chmod +x /usr/local/bin/docker-entrypoint-database-url.sh
ENTRYPOINT ["/usr/local/bin/docker-entrypoint-database-url.sh"]

# Optional: pass a job name (see worker src) for one-off tasks; else full background loop
CMD ["node", "dist/index.js"]
