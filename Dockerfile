# ---------- BUILD STAGE ----------
FROM node:24-slim AS build
WORKDIR /app

RUN apt-get update && \
    apt-get install -y python3 make g++ && \
    rm -rf /var/lib/apt/lists/*

RUN printf "ignore-scripts=true\n" > .npmrc

COPY package*.json ./
COPY tsconfig.json ./
COPY src ./src
COPY @types ./@types

RUN npm ci

# run allowed scripts only (better-sqlite3)
RUN npx allow-scripts run

RUN npm run build

RUN npm prune --omit=dev

# ---------- PRODUCTION STAGE ----------
FROM node:24-slim AS production
WORKDIR /app
ENV NODE_ENV=production

RUN mkdir -p /data && chown -R node:node /data

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package*.json ./

USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
