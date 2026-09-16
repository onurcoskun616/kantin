# Harici bagimlilik olmadigi icin tek asamali, kucuk bir imaj yeterli.
FROM node:22-alpine

WORKDIR /app

COPY package.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

RUN mkdir -p /app/data /app/backups && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/kantin.db

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
