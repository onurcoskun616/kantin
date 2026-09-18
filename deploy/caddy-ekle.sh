#!/usr/bin/env bash
#
# TOPKAPI KANTIN — Caddy'ye site blogu ekler
#
# Caddyfile'i elle duzenlemek risklidir: hatali bir blok reload sirasinda
# SADECE kantin'i degil MEVCUT SITELERINIZI de dusurur. Bu betik o adimi
# geri alinabilir hale getirir:
#
#   1. Caddyfile'in tarihli yedegini alir
#   2. Blogu ekler (zaten varsa dokunmaz)
#   3. 'caddy validate' calistirir  -> BASARISIZSA yedekten geri doner
#   4. 'caddy reload' calistirir    -> BASARISIZSA yedekten geri doner ve
#                                      eski yapilandirmayi geri yukler
#   5. Sertifika alinana kadar adresi yoklar
#
# Kullanim:
#   sudo bash caddy-ekle.sh
#
# Geri almak icin:
#   sudo bash caddy-ekle.sh --kaldir

set -uo pipefail

CADDY_KONTEYNER="${CADDY_CONTAINER:-topkapi-qr-caddy-1}"
CADDYFILE="${CADDYFILE:-/root/topkapi-qr/deploy/Caddyfile}"
KONTEYNER_ICI="${CADDYFILE_IN_CONTAINER:-/etc/caddy/Caddyfile}"
ALAN="${KANTIN_DOMAIN:-kantin.topkapikoleji.org}"
HEDEF="${KANTIN_CONTAINER:-topkapi-kantin}"
AG="${CADDY_NETWORK:-topkapi-qr_default}"

bilgi() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
uyari() { printf '  \033[33m!\033[0m %s\n' "$1"; }
hata()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || hata "root ile calismali: sudo bash caddy-ekle.sh"
[ -f "$CADDYFILE" ] || hata "Caddyfile bulunamadi: $CADDYFILE"
docker inspect "$CADDY_KONTEYNER" >/dev/null 2>&1 \
  || hata "Caddy konteyneri bulunamadi: $CADDY_KONTEYNER"

YEDEK="${CADDYFILE}.yedek-$(date +%Y%m%d-%H%M%S)"

geri_al() {
  cp "$YEDEK" "$CADDYFILE"
  docker exec "$CADDY_KONTEYNER" caddy reload --config "$KONTEYNER_ICI" >/dev/null 2>&1
  uyari "Caddyfile yedekten geri yuklendi: $YEDEK"
}

# ----------------------------- kaldirma --------------------------------
if [ "${1:-}" = "--kaldir" ]; then
  bilgi "Kantin blogu kaldiriliyor"
  cp "$CADDYFILE" "$YEDEK"
  ok "Yedek alindi: $YEDEK"
  # Blogu basindaki yorum satiriyla birlikte siler
  awk -v alan="$ALAN" '
    $0 ~ "^# Kantin Yonetim Sistemi" { atla=1; next }
    $0 ~ "^"alan" \\{" { atla=1; derinlik=1; next }
    atla && /\{/ { derinlik++ }
    atla && /\}/ { derinlik--; if (derinlik<=0) { atla=0 }; next }
    !atla { print }
  ' "$YEDEK" > "$CADDYFILE"

  if docker exec "$CADDY_KONTEYNER" caddy validate --config "$KONTEYNER_ICI" >/dev/null 2>&1; then
    docker exec "$CADDY_KONTEYNER" caddy reload --config "$KONTEYNER_ICI" && ok "Blok kaldirildi ve Caddy yeniden yuklendi"
  else
    geri_al
    hata "Kaldirma sonrasi dogrulama basarisiz oldu, degisiklik geri alindi."
  fi
  exit 0
fi

# ------------------------------ ekleme ---------------------------------
bilgi "1/5  Hazirlik"
if ! docker inspect "$HEDEF" >/dev/null 2>&1; then
  hata "'$HEDEF' konteyneri calismiyor. Once kur.sh ile kurulumu tamamlayin."
fi
ok "Kantin konteyneri calisiyor: $HEDEF"

# Ikisi ayni agda mi? Degilse Caddy adiyla bulamaz.
if docker inspect "$HEDEF" --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}' \
     | grep -qw "$AG"; then
  ok "Kantin '$AG' aginda"
else
  hata "'$HEDEF' '$AG' aginda degil. Caddy ona ulasamaz."
fi

cp "$CADDYFILE" "$YEDEK"
ok "Yedek alindi: $YEDEK"

bilgi "2/5  Blok"
if grep -qF "$ALAN" "$CADDYFILE"; then
  uyari "'$ALAN' zaten Caddyfile'da tanimli, yeniden eklenmedi"
else
  # Mevcut dosyanin uslubuyla ayni: security_headers parcacigi + gzip
  {
    printf '\n'
    printf '# Kantin Yonetim Sistemi (Node app, %s aginda; container: %s:3000)\n' "$AG" "$HEDEF"
    printf '%s {\n' "$ALAN"
    printf '    import security_headers\n'
    printf '    encode gzip\n'
    printf '    request_body {\n'
    printf '        max_size 12MB\n'
    printf '    }\n'
    printf '    reverse_proxy %s:3000\n' "$HEDEF"
    printf '}\n'
  } >> "$CADDYFILE"
  ok "Blok dosyanin sonuna eklendi"
fi

bilgi "3/5  Dogrulama"
if DOGRULAMA="$(docker exec "$CADDY_KONTEYNER" caddy validate --config "$KONTEYNER_ICI" 2>&1)"; then
  ok "Yapilandirma gecerli"
else
  printf '%s\n' "$DOGRULAMA" | tail -15
  geri_al
  hata "Dogrulama basarisiz. Hicbir sey degismedi, mevcut siteleriniz etkilenmedi."
fi

bilgi "4/5  Yeniden yukleme"
if YUKLEME="$(docker exec "$CADDY_KONTEYNER" caddy reload --config "$KONTEYNER_ICI" 2>&1)"; then
  ok "Caddy yeniden yuklendi (kesintisiz)"
else
  printf '%s\n' "$YUKLEME" | tail -15
  geri_al
  hata "Yeniden yukleme basarisiz. Eski yapilandirma geri yuklendi."
fi

bilgi "5/5  Sertifika ve erisim"
printf '  Caddy sertifikayi Let'"'"'s Encrypt'"'"'ten aliyor, birkac saniye surebilir'
DURUM=""
for i in $(seq 1 30); do
  DURUM="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "https://$ALAN/api/health" 2>/dev/null || true)"
  [ "$DURUM" = "200" ] && break
  printf '.'
  sleep 3
done
printf '\n'

if [ "$DURUM" = "200" ]; then
  ok "https://$ALAN acildi ve yanit veriyor"
else
  uyari "https://$ALAN henuz yanit vermiyor (son durum: ${DURUM:-yok})"
  printf '     Sertifika birkac dakika surebilir. Kontrol:\n'
  printf '       docker logs --tail 30 %s\n' "$CADDY_KONTEYNER"
  printf '     DNS sunucuya yonleniyor mu ve Cloudflare GRI BULUT mu?\n'
fi

bilgi "Mevcut siteler"
printf '  Diger siteleriniz de calisiyor mu, simdi tarayicidan kontrol edin.\n'
printf '  Sorun varsa tek komutla geri alin:\n'
printf '    sudo bash %s --kaldir\n' "$0"
printf '  Yedek dosyasi: %s\n\n' "$YEDEK"
