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

CMD ["node", "proxy.js"]
