#!/usr/bin/env bash
# Veritabaninin tutarli bir yedegini alir (sunucu calisirken de guvenlidir).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB="${DB_PATH:-$ROOT/data/kantin.db}"
# Fatura ekleri veritabaninda DEGIL, diskte durur: veritabani yedegi tek
# basina yeterli degildir, ekler de alinmalidir.
FILES="${ATTACHMENTS_DIR:-$ROOT/data/ekler}"
DEST="${BACKUP_DIR:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
KEEP="${BACKUP_KEEP:-30}"

if [ ! -f "$DB" ]; then
  echo "Veritabani bulunamadi: $DB" >&2
  exit 1
fi

mkdir -p "$DEST"
OUT="$DEST/kantin-$STAMP.db"

node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.argv[1], { readOnly: true });
db.exec(\"VACUUM INTO '\" + process.argv[2].replace(/'/g, \"''\") + \"'\");
db.close();
" "$DB" "$OUT" 2>/dev/null

gzip -f "$OUT"
echo "Veritabani yedegi: $OUT.gz ($(du -h "$OUT.gz" | cut -f1))"

# Fatura ekleri (PDF / foto / e-Fatura XML)
if [ -d "$FILES" ] && [ -n "$(ls -A "$FILES" 2>/dev/null)" ]; then
  FILES_OUT="$DEST/ekler-$STAMP.tar.gz"
  tar -czf "$FILES_OUT" -C "$(dirname "$FILES")" "$(basename "$FILES")"
  echo "Fatura ekleri yedegi: $FILES_OUT ($(du -h "$FILES_OUT" | cut -f1))"
else
  echo "Fatura eki yok, atlandi: $FILES"
fi

# Eski yedekleri temizle
ls -1t "$DEST"/kantin-*.db.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "$DEST"/ekler-*.tar.gz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "Son $KEEP yedek saklaniyor."
