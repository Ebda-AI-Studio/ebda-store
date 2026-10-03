# Ebda API - Production Dockerfile
FROM node:20-alpine AS base

# Install ALL dependencies for building
FROM base AS deps
WORKDIR /app

# Copy workspace package files
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/

# Install all dependencies (including dev for building)
RUN npm ci

# Production dependencies only
FROM base AS prod-deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/database/package.json ./packages/database/
COPY packages/shared/package.json ./packages/shared/

RUN npm ci --omit=dev

# Build the application
FROM base AS builder
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate Prisma client
RUN npm run db:generate

# Build packages and API
RUN npm run build -w packages/shared
RUN npm run build -w apps/api

# Production image
FROM base AS runner
WORKDIR /app

ENV NODE_ENV=production

# Create non-root user
RUN addgroup --system --gid 1001 nodejs
RUN adduser --system --uid 1001 expressjs

# Copy built assets and production-only dependencies
COPY --from=builder /app/apps/api/dist ./dist
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=builder /app/packages/database/prisma ./prisma
COPY --from=builder /app/apps/api/package.json ./

USER expressjs

EXPOSE 4000

ENV PORT=4000
ENV API_HOST=0.0.0.0

CMD ["node", "dist/index.js"]
