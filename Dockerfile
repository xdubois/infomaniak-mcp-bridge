# syntax=docker/dockerfile:1
# Multi-stage: compile with the dev toolchain, ship only dist + production node_modules
# (which include the official @infomaniak/mcp-server-* packages the bridge spawns).
FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# Container defaults: behind a reverse proxy / ingress, SQLite on a volume. Everything else comes from the env.
ENV PORT=3000 TRUST_PROXY=true SQLITE_PATH=/data/bridge.sqlite
RUN mkdir -p /data && chown node:node /data
VOLUME /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Node 24 ships node:sqlite without the experimental warning (the npm scripts keep the flag for Node 22 dev).
# The upstream servers are child processes: with plain `docker run` add --init so they are reaped if the
# bridge dies; Kubernetes tears the whole container down, so nothing extra is needed there.
CMD ["node", "dist/main.js"]
