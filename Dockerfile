FROM scratch AS source-audit
# ローカル検証で、実際のビルド材料に秘密情報がないか確認する専用段。
COPY . /context/

FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

FROM node:22-bookworm-slim AS migration
WORKDIR /app
COPY deploy/migration/package.json deploy/migration/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY db/design/integrated.prisma ./db/design/integrated.prisma
COPY db/design/migrations ./db/design/migrations
COPY deploy/migrate.mjs deploy/schema-hash.mjs deploy/prisma-public.config.ts ./deploy/
COPY examples/mysql/public-api-settings.ts examples/mysql/public-database.ts examples/mysql/secret-files.ts ./examples/mysql/
COPY lib/siteflow/proxy-origins.ts ./lib/siteflow/
RUN node node_modules/prisma/build/index.js generate --schema db/design/integrated.prisma
USER node
CMD ["node", "deploy/migrate.mjs"]

# ローカルでLinuxの配信スクリプトを検証する段階。公開runnerには含めない。
FROM node:22-bookworm-slim AS deploy-check
RUN apt-get update && apt-get install -y --no-install-recommends bash curl jq util-linux iproute2 ca-certificates unzip && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY deploy ./deploy
COPY tests/deploy.test.mjs ./tests/deploy.test.mjs
CMD ["node", "--test", "tests/deploy.test.mjs"]

FROM node:22-bookworm-slim AS runner-base
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    HOSTNAME=0.0.0.0 \
    PORT=3000
COPY --from=builder --chown=node:node /app/.next/standalone ./
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/public ./public
# 現在のCIの「node --test tests/domain.test.mjs」を維持する。
COPY --from=builder --chown=node:node /app/tests/domain.test.mjs ./tests/domain.test.mjs
COPY --from=builder --chown=node:node /app/lib/siteflow/domain.ts ./lib/siteflow/domain.ts
USER node
EXPOSE 3000
CMD ["node", "server.js"]

FROM deploy-check AS proxy-check
RUN apt-get update && apt-get install -y --no-install-recommends nginx openssl && rm -rf /var/lib/apt/lists/*
COPY --from=runner-base /app /runtime
COPY tests/deploy-proxy-check.mjs ./tests/deploy-proxy-check.mjs
CMD ["node", "tests/deploy-proxy-check.mjs"]

# target省略時は必ずアプリを生成し、検証サーバーを公開しない。
FROM runner-base AS runner
