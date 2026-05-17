FROM node:24.15-alpine AS build

ARG BUN_VERSION=1.3.14

WORKDIR /app

RUN npm install -g bun@${BUN_VERSION}

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY asconfig.json ./
COPY index.html ./
COPY postcss.config.js ./
COPY tsconfig.json ./
COPY vite.config.ts ./
COPY public ./public
COPY src ./src

RUN bun run build

FROM caddy:2.9-alpine

COPY Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv

EXPOSE 8080