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

# Trust AWS RDS TLS cert chain for Prisma/pg operations (runtime + one-off ECS tasks).
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && curl -fsSL -o /etc/ssl/certs/aws-rds-global-bundle.pem \
    https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem \
  && chmod 644 /etc/ssl/certs/aws-rds-global-bundle.pem \
  && apt-get clean \
  && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production
ENV PORT=3000
ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/aws-rds-global-bundle.pem
WORKDIR /app/services/api
EXPOSE 3000

COPY scripts/docker/docker-entrypoint-database-url.sh /usr/local/bin/docker-entrypoint-database-url.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint-database-url.sh && chmod +x /usr/local/bin/docker-entrypoint-database-url.sh
USER node
ENTRYPOINT ["/usr/local/bin/docker-entrypoint-database-url.sh"]

# server.ts: loadConfig reads repo-root .env in dev — in ECS inject env via task definition / secrets (no .env in image)
CMD ["node", "dist/server.js"]
