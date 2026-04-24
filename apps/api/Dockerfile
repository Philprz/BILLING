FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache openssl

# ── Install deps (workspace-aware) ────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/database/package.json ./packages/database/
COPY apps/api/package.json            ./apps/api/
RUN npm ci --workspace=packages/database --workspace=apps/api --ignore-scripts

# ── Build ─────────────────────────────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages/database ./packages/database
COPY apps/api          ./apps/api
RUN npm run build -w packages/database
RUN npm run build -w apps/api

# ── Production image ──────────────────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/database/package.json ./packages/database/
COPY apps/api/package.json            ./apps/api/
RUN npm ci --workspace=packages/database --workspace=apps/api \
        --omit=dev --ignore-scripts

COPY --from=build /app/packages/database/dist ./packages/database/dist
COPY --from=build /app/packages/database/prisma ./packages/database/prisma
COPY --from=build /app/apps/api/dist           ./apps/api/dist

# Generate Prisma client in production image
RUN npx --yes prisma generate --schema=packages/database/prisma/schema.prisma

EXPOSE 3001
CMD ["node", "apps/api/dist/index.js"]
