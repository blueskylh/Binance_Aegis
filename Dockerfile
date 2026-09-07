# Aegis — risk firewall for Binance Agent OS
# Multi-stage: compile with devDependencies, ship a runtime with zero deps.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.json ./
RUN npm install --no-audit --no-fund
COPY src ./src
COPY test ./test
# self-audit tests assert the shipped policies enable every mandatory guard,
# so the build stage needs them too.
COPY policies ./policies
RUN npm run build && node --test "dist/test/**/*.test.js"

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production AEGIS_HOME=/data
# Aegis has zero runtime dependencies, so only the compiled output is copied.
COPY --from=build /app/dist/src ./dist/src
COPY policies ./policies
COPY skill ./skill
COPY package.json README.md LICENSE ./
RUN mkdir -p /data && addgroup -S aegis && adduser -S aegis -G aegis && chown -R aegis:aegis /data /app
USER aegis
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD node dist/src/cli/main.js ledger verify --json > /dev/null || exit 1
ENTRYPOINT ["node", "dist/src/cli/main.js"]
CMD ["demo"]
