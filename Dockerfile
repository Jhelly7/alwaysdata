FROM node:20-alpine

# cloudflared — necessário para o streamvault-proxy
RUN apk add --no-cache curl && \
    curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 \
      -o /usr/local/bin/cloudflared && \
    chmod +x /usr/local/bin/cloudflared

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY . .
RUN chmod +x start.sh

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:${PORT:-10000}/health || exit 1

CMD ["node", "index.js"]