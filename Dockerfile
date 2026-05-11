FROM node:20-alpine

# No OS-level dependencies needed — ZIP extraction uses Node's built-in zlib.

WORKDIR /app

COPY package.json ./
COPY proxy.js index.html ./
COPY config.example.json ./
COPY lib/ ./lib/

# Config is provided at runtime via a bind mount to /app/config.json.
# If none is mounted, the app starts in first-run mode with defaults
# and the settings page must be used to configure it.

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://localhost:8080/healthz', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"

CMD ["node", "proxy.js"]
