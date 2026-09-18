#!/usr/bin/env bash
# Kurulum sonrasi saglik kontrolu.
#
# Kurulumun gercekten dogru oldugunu tek komutla gosterir. Sunucuda:
#   sudo /opt/kantin/scripts/kontrol.sh
#
# Cikis kodu 0 ise her sey yolunda, 1 ise duzeltilmesi gereken bir sey var.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
APP_USER="${APP_USER:-kantin}"
PORT_DEFAULT=3000

PASS=0
FAIL=0
WARN=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      → %s\n' "$2"; FAIL=$((FAIL+1)); }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      → %s\n' "$2"; WARN=$((WARN+1)); }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# .env degerini okur (satir ici yorum KESMEDEN, uygulamanin gordugu gibi)
env_get() {
  [ -f "$ENV_FILE" ] || return 1
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

head_ "1. Ayar dosyasi (.env)"
if [ ! -f "$ENV_FILE" ]; then
  bad ".env bulunamadi: $ENV_FILE" "cp .env.example .env ile olusturun"
else
  ok ".env mevcut"

  PERM="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || echo '?')"
  if [ "$PERM" = "600" ]; then ok ".env izinleri 600 (yalnizca sahibi okuyabilir)"
  else warn ".env izinleri $PERM" "sudo chmod 600 $ENV_FILE"; fi

  # En sik kurulum hatasi: satir ici yorum
  if grep -nE '^[A-Z_]+=.*[[:space:]]#' "$ENV_FILE" >/dev/null 2>&1; then
    bad ".env icinde satir ici yorum var" \
        "$(grep -nE '^[A-Z_]+=.*[[:space:]]#' "$ENV_FILE" | head -3 | tr '\n' ' ') — aciklamayi kendi satirina alin"
  else
    ok ".env icinde satir ici yorum yok"
  fi

  SECRET="$(env_get SESSION_SECRET || true)"
  if [ -z "$SECRET" ]; then bad "SESSION_SECRET bos"
  elif [ "${#SECRET}" -lt 32 ]; then bad "SESSION_SECRET cok kisa (${#SECRET} karakter)" "en az 32 karakter olmali"
  elif [[ "$SECRET" == degistirin-* || "$SECRET" == gelistirme-* ]]; then
    bad "SESSION_SECRET varsayilan degerde birakilmis" \
        "node -e \"console.log(require('crypto').randomBytes(48).toString('hex'))\""
  else ok "SESSION_SECRET ayarlanmis (${#SECRET} karakter)"; fi

  HOST_VAL="$(env_get HOST || true)"
  if [ "$HOST_VAL" = "127.0.0.1" ]; then ok "HOST=127.0.0.1 (uygulama dogrudan internete acik degil)"
  else warn "HOST=$HOST_VAL" "sunucuda 127.0.0.1 olmali, nginx onunde dursun"; fi

  ADMIN_PW="$(env_get ADMIN_PASSWORD || true)"
  if [ "$ADMIN_PW" = "Kantin2026!" ]; then
    warn "ADMIN_PASSWORD ornek dosyadaki deger" "ilk giristen sonra arayuzden degistirdiyseniz sorun yok"
  fi
fi

head_ "2. Dizinler ve izinler"
DB_PATH_VAL="$(env_get DB_PATH || echo './data/kantin.db')"
ATT_DIR_VAL="$(env_get ATTACHMENTS_DIR || echo './data/ekler')"
DB_ABS="$(cd "$ROOT" && readlink -f "$DB_PATH_VAL" 2>/dev/null || echo "$ROOT/data/kantin.db")"
ATT_ABS="$(cd "$ROOT" && readlink -f "$ATT_DIR_VAL" 2>/dev/null || echo "$ROOT/data/ekler")"

if [ -f "$DB_ABS" ]; then ok "Veritabani var: $DB_ABS ($(du -h "$DB_ABS" | cut -f1))"
else bad "Veritabani yok: $DB_ABS" "sudo -u $APP_USER node $ROOT/server/seed.js --bos"; fi

if [ -d "$ATT_ABS" ]; then
  ok "Fatura eki dizini var: $ATT_ABS ($(find "$ATT_ABS" -type f 2>/dev/null | wc -l) dosya)"
else
  warn "Fatura eki dizini henuz yok: $ATT_ABS" "ilk fatura eklendiginde kendiliginden olusur"
fi

if [ -d "$ROOT/backups" ]; then ok "Yedek dizini var: $ROOT/backups"
else bad "Yedek dizini yok: $ROOT/backups" "sudo -u $APP_USER mkdir -p $ROOT/backups"; fi

if id "$APP_USER" >/dev/null 2>&1; then
  OWNER="$(stat -c '%U' "$ROOT/data" 2>/dev/null || echo '?')"
  if [ "$OWNER" = "$APP_USER" ]; then ok "data/ dizini $APP_USER kullanicisinin"
  else bad "data/ dizini sahibi: $OWNER" "sudo chown -R $APP_USER:$APP_USER $ROOT"; fi
else
  warn "'$APP_USER' kullanicisi yok" "gelistirme makinesinde normaldir"
fi

head_ "3. Servis"
if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files kantin.service >/dev/null 2>&1; then
  if systemctl is-active --quiet kantin; then ok "kantin servisi calisiyor"
  else bad "kantin servisi calismiyor" "sudo journalctl -u kantin -n 50"; fi
  if systemctl is-enabled --quiet kantin; then ok "kantin servisi acilista basliyor"
  else warn "kantin servisi acilista baslamayacak" "sudo systemctl enable kantin"; fi
else
  warn "kantin.service kurulu degil" "sudo cp $ROOT/deploy/kantin.service /etc/systemd/system/"
fi

head_ "4. Uygulama yaniti"
PORT_VAL="$(env_get PORT || echo $PORT_DEFAULT)"
HEALTH="$(curl -fsS --max-time 5 "http://127.0.0.1:${PORT_VAL:-$PORT_DEFAULT}/api/health" 2>/dev/null || true)"
if [ -n "$HEALTH" ]; then ok "Saglik ucu yanit veriyor: $HEALTH"
else bad "http://127.0.0.1:${PORT_VAL:-$PORT_DEFAULT}/api/health yanit vermiyor" "servis calisiyor mu?"; fi

head_ "5. Yedekleme"
if [ -f /etc/cron.d/kantin-yedek ]; then ok "Yedekleme cron kaydi kurulu"
else bad "Yedekleme cron kaydi yok" "sudo cp $ROOT/deploy/kantin-yedek.cron /etc/cron.d/kantin-yedek"; fi

LAST_DB="$(ls -1t "$ROOT"/backups/kantin-*.db.gz 2>/dev/null | head -1 || true)"
LAST_FILES="$(ls -1t "$ROOT"/backups/ekler-*.tar.gz 2>/dev/null | head -1 || true)"
if [ -n "$LAST_DB" ]; then
  AGE_H=$(( ( $(date +%s) - $(stat -c %Y "$LAST_DB") ) / 3600 ))
  if [ "$AGE_H" -le 48 ]; then ok "Son veritabani yedegi $AGE_H saat once"
  else warn "Son veritabani yedegi $AGE_H saat once" "cron calisiyor mu? /var/log/kantin-yedek.log"; fi
else
  bad "Hic veritabani yedegi yok" "sudo -u $APP_USER $ROOT/scripts/yedekle.sh"
fi

if [ -n "$LAST_FILES" ]; then
  ok "Fatura ekleri yedegi var: $(basename "$LAST_FILES")"
elif [ -d "$ATT_ABS" ] && [ -n "$(ls -A "$ATT_ABS" 2>/dev/null)" ]; then
  bad "Fatura eki var ama yedegi yok" "yedekle.sh guncel mi? ekler-*.tar.gz uretmeli"
else
  ok "Fatura eki yok, yedeklenecek dosya da yok"
fi

head_ "6. Guvenlik duvari ve HTTPS"
if command -v ufw >/dev/null 2>&1; then
  if ufw status 2>/dev/null | grep -q "Status: active"; then
    ok "ufw etkin"
    if ufw status 2>/dev/null | grep -qE "^${PORT_VAL:-$PORT_DEFAULT}[/ ]"; then
      bad "Uygulama portu ${PORT_VAL:-$PORT_DEFAULT} disariya acik" "sudo ufw delete allow ${PORT_VAL:-$PORT_DEFAULT}"
    else
      ok "Uygulama portu disariya kapali"
    fi
  else
    warn "ufw etkin degil" "sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable"
  fi
else
  warn "ufw kurulu degil"
fi

if command -v nginx >/dev/null 2>&1; then
  if nginx -t >/dev/null 2>&1; then ok "nginx yapilandirmasi gecerli"
  else bad "nginx yapilandirmasinda hata" "sudo nginx -t"; fi
else
  warn "nginx kurulu degil"
fi

CERT_DIR=/etc/letsencrypt/live
if [ -d "$CERT_DIR" ] && [ -n "$(ls -A "$CERT_DIR" 2>/dev/null)" ]; then
  for d in "$CERT_DIR"/*/; do
    [ -f "$d/cert.pem" ] || continue
    END="$(openssl x509 -enddate -noout -in "$d/cert.pem" 2>/dev/null | cut -d= -f2)"
    DAYS=$(( ( $(date -d "$END" +%s) - $(date +%s) ) / 86400 ))
    if [ "$DAYS" -gt 20 ]; then ok "HTTPS sertifikasi $DAYS gun gecerli ($(basename "$d"))"
    else bad "HTTPS sertifikasi $DAYS gun sonra doluyor" "sudo certbot renew"; fi
  done
else
  warn "Let's Encrypt sertifikasi bulunamadi" "sudo certbot --nginx -d <alan-adiniz>"
fi

head_ "7. Saat dilimi"
TZ_NOW="$(timedatectl show -p Timezone --value 2>/dev/null || echo '?')"
if [ "$TZ_NOW" = "Europe/Istanbul" ]; then ok "Saat dilimi Europe/Istanbul"
else warn "Saat dilimi: $TZ_NOW" "sudo timedatectl set-timezone Europe/Istanbul"; fi

printf '\n\033[1mOzet:\033[0m %s gecti, %s uyari, %s sorun\n\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
