# Harici bagimlilik olmadigi icin tek asamali, kucuk bir imaj yeterli.
FROM node:22-alpine

# Yedekleme betigi bash kullaniyor (BASH_SOURCE, pipefail); alpine'da
# varsayilan olarak yok. Konteyner icinden yedek alabilmek icin ekliyoruz:
#   docker exec topkapi-kantin /app/scripts/yedekle.sh
RUN apk add --no-cache bash

WORKDIR /app

COPY package.json ./
# Surum damgasi: kur.sh derlemeden once yazar. Yoksa imaj yine kurulur,
# uygulama "surum bilinmiyor" der (gelistirme ortaminda normaldir).
COPY surum.json ./
COPY server ./server
COPY public ./public
COPY scripts ./scripts

# data/ekler: faturalarin PDF/XML dosyalari. data/ ile ayni birimde durur ki
# tek volume ile hem veritabani hem ekler kalici olsun.
RUN mkdir -p /app/data/ekler /app/backups && chown -R node:node /app

USER node

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/kantin.db \
    ATTACHMENTS_DIR=/app/data/ekler

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
