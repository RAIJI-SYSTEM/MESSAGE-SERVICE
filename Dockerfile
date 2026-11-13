FROM oven/bun:1.4.2-alpine

WORKDIR /app

# Dependências primeiro (cache de camada enquanto o lockfile não mudar)
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src

ENV NODE_ENV=production \
    PORT=3000

USER bun
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=5s --retries=10 --start-period=20s \
  CMD ["bun", "-e", "const r = await fetch('http://localhost:' + (Bun.env.PORT ?? 3000) + '/health'); process.exit(r.ok ? 0 : 1)"]

CMD ["bun", "src/server.ts"]
