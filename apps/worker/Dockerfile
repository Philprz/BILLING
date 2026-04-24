FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# ── Install deps ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/database/package.json ./packages/database/
COPY apps/worker/package.json        ./apps/worker/
RUN npm ci --workspace=packages/database --workspace=apps/worker --ignore-scripts

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/database ./packages/database
COPY apps/worker       ./apps/worker
RUN npm run build -w packages/database
RUN npm run build -w apps/worker

# ── Production image ──────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/database/package.json ./packages/database/
COPY apps/worker/package.json        ./apps/worker/
RUN npm ci --workspace=packages/database --workspace=apps/worker \
        --omit=dev --ignore-scripts

COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/prisma ./packages/database/prisma
COPY --from=build /app/apps/worker/dist        ./apps/worker/dist

RUN npx --yes prisma generate --schema=packages/database/prisma/schema.prisma

CMD ["node", "apps/worker/dist/index.js"]
