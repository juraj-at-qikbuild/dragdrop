# Blava City game server. Build context is the repo root (fly.toml sets dockerfile = "server/Dockerfile")
# because the server bundles the shared simulation from src/shared and loads public/data/bratislava.json.

FROM node:22-bookworm-slim AS build
# toolchain for native modules (better-sqlite3) in case no prebuilt binary matches
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
WORKDIR /app
COPY tsconfig.json ./
COPY src/shared ./src/shared
COPY server ./server
WORKDIR /app/server
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=8080 \
    MAP_PATH=/app/data/bratislava.json \
    DB_PATH=/data/blava.db
WORKDIR /app
COPY --from=build /app/server/node_modules ./node_modules
COPY --from=build /app/server/dist ./dist
COPY --from=build /app/server/package.json ./package.json
COPY public/data/bratislava.json ./data/bratislava.json
EXPOSE 8080
CMD ["node", "dist/index.js"]
