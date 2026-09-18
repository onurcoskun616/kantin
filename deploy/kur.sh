#!/usr/bin/env bash
#
# TOPKAPI KANTIN — mevcut Docker + Caddy sunucusuna kurulum
#
# Tek komutla calisir; nano ya da cok satirli yapistirma gerektirmez.
# Terminaller cok satirli yapistirmayi bozabildigi icin kurulumu tek bir
# betige topladik.
#
# Kullanim:
#   sudo bash kur.sh
#   sudo ADMIN_EMAIL=mudur@topkapikoleji.org ADMIN_PASSWORD='Parola123!' bash kur.sh
#
# Bu betik NE YAPMAZ:
#   - Host'a paket kurmaz (apt install yok)
#   - ufw kurallarina dokunmaz
#   - Caddyfile'i DEGISTIRMEZ (sonunda eklenecek blogu yazar, uygulamayi
#     size birakir; yanlis bir reload mevcut sitelerinizi dusurebilir)
#   - Mevcut konteynerlere dokunmaz
#
# Tekrar tekrar calistirilabilir: var olan .env'i ASLA uzerine yazmaz.

set -euo pipefail

DIZIN="${KANTIN_DIR:-/opt/kantin-uygulama}"
DEPO="${KANTIN_REPO:-https://github.com/onurcoskun616/kantin.git}"
DAL="${KANTIN_BRANCH:-main}"
AG="${CADDY_NETWORK:-topkapi-qr_default}"
ALAN="${KANTIN_DOMAIN:-kantin.topkapikoleji.org}"
KONTEYNER="topkapi-kantin"

bilgi() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
uyari() { printf '  \033[33m!\033[0m %s\n' "$1"; }
hata()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || hata "Bu betik root ile calismali: sudo bash kur.sh"

bilgi "1/6  Ortam kontrolu"
command -v docker >/dev/null 2>&1 || hata "docker bulunamadi."
docker compose version >/dev/null 2>&1 || hata "'docker compose' bulunamadi."
ok "docker ve docker compose var"

if docker network inspect "$AG" >/dev/null 2>&1; then
  ok "Caddy agi bulundu: $AG"
else
  hata "'$AG' agi yok. Dogru adi soyle ogrenin:
     docker network ls
   sonra betigi soyle calistirin:
     sudo CADDY_NETWORK=<ag-adi> bash kur.sh"
fi

bilgi "2/6  Kod"
mkdir -p "$DIZIN"
if [ -d "$DIZIN/kaynak/.git" ]; then
  git -C "$DIZIN/kaynak" fetch --quiet origin "$DAL"
  git -C "$DIZIN/kaynak" checkout --quiet "$DAL"
  git -C "$DIZIN/kaynak" reset --hard --quiet "origin/$DAL"
  ok "Kod guncellendi ($DAL)"
else
  rm -rf "$DIZIN/kaynak"
  git clone --quiet -b "$DAL" "$DEPO" "$DIZIN/kaynak"
  ok "Kod indirildi ($DAL)"
fi

cp "$DIZIN/kaynak/deploy/compose-kantin.yml" "$DIZIN/docker-compose.yml"
# Ag adi betige verilenle ayni olsun
sed -i "s|^    name: .*|    name: $AG|" "$DIZIN/docker-compose.yml"
mkdir -p "$DIZIN/backups"
ok "docker-compose.yml hazir (ag: $AG)"

bilgi "3/6  Ayarlar (.env)"
# Konteyner calisirken .env kaybolmus olabilir (or. dizin yanlislikla silindi).
# Bu durumda YENI anahtar uretmek yanlis olur: calisan konteynerdeki degerleri
# geri kurtaririz, boylece acik oturumlar ve yonetici parolasi degismez.
KURTARILAN=""
if [ ! -f "$DIZIN/.env" ] && docker inspect "$KONTEYNER" >/dev/null 2>&1; then
  KURTARILAN="$(docker inspect "$KONTEYNER" \
    --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null \
    | grep -E '^(SESSION_SECRET|ADMIN_EMAIL|ADMIN_PASSWORD|ADMIN_NAME)=' || true)"
  printf '%s' "$KURTARILAN" | grep -q '^SESSION_SECRET=' || KURTARILAN=""
fi

if [ -f "$DIZIN/.env" ]; then
  ok ".env zaten var, dokunulmadi"
  uyari "Degistirmek isterseniz: nano $DIZIN/.env  (sonra betigi tekrar calistirin)"
elif [ -n "$KURTARILAN" ]; then
  umask 077
  printf '%s\n' "$KURTARILAN" > "$DIZIN/.env"
  chmod 600 "$DIZIN/.env"
  ok ".env calisan konteynerden geri kurtarildi (izin 600)"
  ok "Mevcut oturum anahtari ve yonetici parolasi korundu"
else
  GIZLI="$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  E_POSTA="${ADMIN_EMAIL:-mudur@topkapikoleji.org}"
  if [ -n "${ADMIN_PASSWORD:-}" ]; then
    PAROLA="$ADMIN_PASSWORD"
    URETILDI=0
  else
    PAROLA="$(head -c 12 /dev/urandom | od -An -tx1 | tr -d ' \n')Aa1!"
    URETILDI=1
  fi

  # Satir ici yorum YOK: hem systemd hem uygulama '#' sonrasini degerin
  # parcasi sayar ve sunucu baslamaz.
  umask 077
  cat > "$DIZIN/.env" <<EOF
SESSION_SECRET=$GIZLI
ADMIN_EMAIL=$E_POSTA
ADMIN_PASSWORD=$PAROLA
ADMIN_NAME=Sistem Yoneticisi
EOF
  chmod 600 "$DIZIN/.env"
  ok ".env olusturuldu (izin 600)"
  ok "Oturum anahtari uretildi (96 karakter)"
  if [ "$URETILDI" -eq 1 ]; then
    printf '\n  \033[1;33mBASLANGIC PAROLASI (bir yere kaydedin):\033[0m\n'
    printf '    E-posta: %s\n    Parola : %s\n' "$E_POSTA" "$PAROLA"
    printf '  \033[33mIlk giristen sonra arayuzden degistirin.\033[0m\n'
  fi
fi

bilgi "4/6  Imaj ve konteyner"
cd "$DIZIN"
docker compose up -d --build
ok "Konteyner ayakta"

bilgi "5/6  Saglik kontrolu"
SAGLIK=""
for i in $(seq 1 20); do
  if SAGLIK="$(docker exec "$KONTEYNER" node -e \
      "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null)"; then
    [ -n "$SAGLIK" ] && break
  fi
  sleep 2
done

if [ -n "$SAGLIK" ]; then
  ok "Uygulama yanit veriyor: $SAGLIK"
else
  printf '\n'
  docker compose logs --tail 30
  hata "Uygulama yanit vermiyor. Yukaridaki gunluge bakin.
   En sik sebep: .env icinde satir ici yorum."
fi

bilgi "6/7  Otomatik yedekleme"
# Fatura dosyalari veritabaninin ICINDE DEGIL: yedek betigi ikisini de alir.
CRON=/etc/cron.d/kantin-yedek
if [ -f "$CRON" ]; then
  ok "Yedekleme cron kaydi zaten var: $CRON"
else
  cat > "$CRON" <<CRONEOF
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=""
0 2 * * * root docker exec $KONTEYNER /app/scripts/yedekle.sh >> /var/log/kantin-yedek.log 2>&1
CRONEOF
  chmod 644 "$CRON"
  ok "Her gece 02:00'de yedek alinacak: $CRON"
fi

# Ilk yedegi hemen al ki calistigini simdi gorelim
if docker exec "$KONTEYNER" /app/scripts/yedekle.sh >/dev/null 2>&1; then
  ADET="$(ls -1 "$DIZIN/backups" 2>/dev/null | wc -l)"
  ok "Ilk yedek alindi ($DIZIN/backups, $ADET dosya)"
  uyari "Yedekleri sunucu DISINA da kopyalayin; sunucu cokerse buradaki de gider"
else
  uyari "Yedek alinamadi. Elle deneyin: docker exec $KONTEYNER /app/scripts/yedekle.sh"
fi

bilgi "7/7  Son adim — Caddy kurali (ELLE)"
cat <<EOF
  Kantin calisiyor ama disaridan erisim icin Caddy'ye tek blok eklemek
  gerekiyor. Bunu BILEREK otomatik yapmiyoruz: hatali bir reload mevcut
  sitelerinizi de dusurebilir.

  KOLAY YOL — bunu yapan betik hazir (yedek alir, dogrular, sorun cikarsa
  geri doner):
     curl -fsSL https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/caddy-ekle.sh -o /tmp/caddy-ekle.sh
     sudo bash /tmp/caddy-ekle.sh

  ELLE YAPMAK ISTERSENIZ:

  1) Yedek alin:
     cp /root/topkapi-qr/deploy/Caddyfile /root/topkapi-qr/deploy/Caddyfile.yedek

  2) Dosyanin SONUNA su blogu ekleyin:

# Kantin Yonetim Sistemi (Node app, $AG aginda; container: $KONTEYNER:3000)
$ALAN {
    import security_headers
    encode gzip
    request_body {
        max_size 12MB
    }
    reverse_proxy $KONTEYNER:3000
}

  3) ONCE dogrulayin (hicbir seyi degistirmez):
     docker exec topkapi-qr-caddy-1 caddy validate --config /etc/caddy/Caddyfile

  4) 'Valid configuration' gorduyseniz yukleyin:
     docker exec topkapi-qr-caddy-1 caddy reload --config /etc/caddy/Caddyfile

  5) https://$ALAN adresini acin ve MEVCUT sitelerinizin de
     calistigini kontrol edin.

EOF

bilgi "Ozet"
docker compose ps
printf '\n  Gunlukler : docker compose -f %s/docker-compose.yml logs -f\n' "$DIZIN"
printf '  Yedek al  : docker exec %s /app/scripts/yedekle.sh\n' "$KONTEYNER"
printf '  Ayarlar   : %s/.env\n\n' "$DIZIN"
