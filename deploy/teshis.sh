#!/usr/bin/env bash
#
# TOPKAPI KANTIN — erisim teshisi
#
# "Site acilmiyor" durumunda sebebi bulur. TAMAMEN SALT OKUNURDUR:
# hicbir dosyayi, konteyneri veya yapilandirmayi degistirmez.
#
# Kullanim:
#   sudo bash teshis.sh

set -uo pipefail

ALAN="${KANTIN_DOMAIN:-kantin.topkapikoleji.org}"
HEDEF="${KANTIN_CONTAINER:-topkapi-kantin}"
CADDY="${CADDY_CONTAINER:-topkapi-qr-caddy-1}"
AG="${CADDY_NETWORK:-topkapi-qr_default}"

bilgi() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
uyari() { printf '  \033[33m!\033[0m %s\n' "$1"; }
kotu()  { printf '  \033[31m✗\033[0m %s\n' "$1"; }

bilgi "1  Kantin konteyneri"
if docker inspect "$HEDEF" >/dev/null 2>&1; then
  DURUM="$(docker inspect "$HEDEF" --format '{{.State.Status}} ({{if .State.Health}}{{.State.Health.Status}}{{else}}saglik yok{{end}})')"
  ok "Var: $DURUM"
else
  kotu "'$HEDEF' konteyneri YOK — once kur.sh calistirin"
  exit 1
fi

bilgi "2  Caddy kantin'e ulasabiliyor mu?"
if docker exec "$CADDY" wget -q -O- --timeout=5 "http://$HEDEF:3000/api/health" 2>/dev/null; then
  printf '\n'; ok "Caddy ic agdan kantin'e ulasiyor"
else
  kotu "Caddy '$HEDEF:3000' adresine ULASAMIYOR"
  printf '     Aglar — caddy: %s\n' "$(docker inspect "$CADDY" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
  printf '     Aglar — kantin: %s\n' "$(docker inspect "$HEDEF" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}')"
fi

bilgi "3  Caddyfile'da blok var mi?"
if docker exec "$CADDY" grep -q "$ALAN" /etc/caddy/Caddyfile 2>/dev/null; then
  ok "'$ALAN' Caddyfile'da tanimli"
else
  kotu "'$ALAN' Caddyfile'da YOK — caddy-ekle.sh calistirin"
fi

bilgi "4  DNS (sunucudan)"
IP_SUNUCU="$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo '?')"
IP_ALAN="$(getent hosts "$ALAN" 2>/dev/null | awk '{print $1}' | head -1)"
printf '  Sunucunun dis IP'"'"'si : %s\n' "$IP_SUNUCU"
printf '  %s -> %s\n' "$ALAN" "${IP_ALAN:-cozumlenmiyor}"
if [ -n "$IP_ALAN" ] && [ "$IP_ALAN" = "$IP_SUNUCU" ]; then
  ok "DNS dogru sunucuya isaret ediyor"
elif [ -z "$IP_ALAN" ]; then
  kotu "DNS cozumlenmiyor"
else
  case "$IP_ALAN" in
    104.21.*|172.67.*|104.1[6-9].*|104.2[0-9].*|172.6[4-6].*)
      kotu "Cloudflare PROXY ACIK (turuncu bulut) — Let's Encrypt sunucuya ulasamaz" ;;
    *) uyari "DNS baska bir IP'ye gidiyor" ;;
  esac
fi

bilgi "5  CAA kaydi (sertifika verenleri kisitliyor mu?)"
CAA="$(curl -s --max-time 10 -H 'accept: application/dns-json' \
  "https://dns.google/resolve?name=topkapikoleji.org&type=CAA" 2>/dev/null)"
if printf '%s' "$CAA" | grep -q '"Answer"'; then
  printf '%s' "$CAA" | grep -o '"data":"[^"]*"' | sed 's/^/     /'
  if printf '%s' "$CAA" | grep -qi 'letsencrypt'; then
    ok "letsencrypt.org izinli"
  else
    kotu "CAA kaydi var ama letsencrypt.org YOK — sertifika alinamaz"
    printf '     Cozum: Cloudflare DNS'"'"'te CAA kaydina letsencrypt.org ekleyin\n'
    printf '     veya CAA kaydini kaldirin.\n'
  fi
else
  ok "CAA kaydi yok (her CA sertifika verebilir)"
fi

bilgi "6  Port 80 disaridan erisilebiliyor mu? (ACME bunu kullanir)"
if curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$ALAN/" 2>/dev/null | grep -qE '^(200|301|302|308)$'; then
  ok "Port 80 yanit veriyor"
else
  uyari "Port 80'den yanit alinamadi (kod: $(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://$ALAN/" 2>/dev/null))"
fi

bilgi "7  CADDY GUNLUGU — sertifika kayitlari"
printf '  (en onemli bolum burasi)\n\n'
docker logs --tail 400 "$CADDY" 2>&1 \
  | grep -iE "kantin|acme|certificate|obtain|challenge|error|rate limit" \
  | tail -30 | sed 's/^/  /'

bilgi "8  Sertifika dosyasi olustu mu?"
SERT="$(docker exec "$CADDY" find /data -name "*${ALAN}*" 2>/dev/null | head -5)"
if [ -n "$SERT" ]; then
  ok "Sertifika dosyalari var:"
  printf '%s\n' "$SERT" | sed 's/^/     /'
else
  kotu "'$ALAN' icin sertifika dosyasi YOK — alinamadi"
fi

bilgi "Ozet"
printf '  7. bolumdeki gunluk satirlarini paylasin; sebep orada yaziyor.\n\n'
