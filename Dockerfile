FROM oven/bun:1-slim AS deps
WORKDIR /app
COPY package.json bun.lockb* ./
RUN bun install --frozen-lockfile

FROM oven/bun:1-slim AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
EXPOSE 8080
USER bun
CMD ["bun", "run", "src/index.ts"]
