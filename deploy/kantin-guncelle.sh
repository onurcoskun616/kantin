#!/usr/bin/env bash
#
# GUNCELLEME KOSUCUSU — host tarafinda, systemd tarafindan calistirilir.
#
# Uygulama (konteyner) yalnizca bir ISTEK DOSYASI yazabilir. Bu betik host
# uzerinde root olarak calisir, dosyayi gorur ve kur.sh'i baslatir.
#
# GUVENLIK — burasi guven sinirini gecen yerdir, dikkatli okunmali:
#
#   * Istek dosyasinin ICERIGI HICBIR ZAMAN calistirilmaz, bir komuta
#     gecirilmez ya da eval edilmez. Yalnizca gunluge yazilir, o da
#     sadelestirilerek. Konteyner "guncelleme istiyorum" diyebilir;
#     "sunu calistir" DIYEMEZ.
#   * Calistirilan komut sabittir: bu depodan inen kur.sh. Uygulamada
#     bulunacak bir acik, calistirilacak KOMUTU degistiremez -- yalnizca
#     guncellemenin ZAMANINI etkileyebilir.
#   * Ard arda tetiklenmeye karsi asgari aralik vardir.
#
# Kurulum: deploy/guncelleyici-kur.sh
set -uo pipefail

DIZIN="${KANTIN_DIR:-/opt/kantin-uygulama}"
KONTROL="$DIZIN/kontrol"
ISTEK="$KONTROL/guncelleme-istegi.json"
DURUM="$KONTROL/guncelleme-durum.json"
GUNLUK="$KONTROL/guncelleme.log"
KILIT="$KONTROL/.guncelleme.kilit"
ASGARI_ARALIK="${KANTIN_UPDATE_MIN_INTERVAL:-60}"   # saniye
BETIK_URL="${KANTIN_KURULUM_URL:-https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/kur.sh}"

# Konteynerin okuyabilmesi icin uygulama kullanicisinin uid'i (node = 1000)
UYGULAMA_UID="${KANTIN_APP_UID:-1000}"

durum_yaz() {
  # $1 durum, $2 mesaj
  local simdi; simdi="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf '{"durum":"%s","mesaj":"%s","zaman":"%s"}\n' \
    "$1" "$(printf '%s' "$2" | tr -d '"\\' | cut -c1-300)" "$simdi" > "$DURUM"
  chown "$UYGULAMA_UID" "$DURUM" 2>/dev/null || true
  chmod 644 "$DURUM" 2>/dev/null || true
}

mkdir -p "$KONTROL"
[ -f "$ISTEK" ] || exit 0

# Istegi HEMEN sil: betik ne olursa olsun tekrar tetiklenmesin
ISTEK_OZET="$(head -c 400 "$ISTEK" 2>/dev/null | tr -d '\000-\037' | tr -d '"\\')"
rm -f "$ISTEK"

# Ayni anda ikinci kosu olmasin
exec 9>"$KILIT"
if ! flock -n 9; then
  durum_yaz "calisiyor" "Zaten suren bir guncelleme var."
  exit 0
fi

# Asgari aralik: dugmeye ust uste basilirsa sunucu surekli yeniden kurulmasin
if [ -f "$DURUM" ]; then
  ONCEKI="$(stat -c %Y "$DURUM" 2>/dev/null || echo 0)"
  SIMDI_SN="$(date +%s)"
  if [ $((SIMDI_SN - ONCEKI)) -lt "$ASGARI_ARALIK" ]; then
    durum_yaz "reddedildi" "Cok sik istek. En az ${ASGARI_ARALIK} saniye bekleyin."
    exit 0
  fi
fi

{
  echo "════════════════════════════════════════════════════════"
  echo "Guncelleme baslatildi: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "Istek (sadelestirilmis, YALNIZCA kayit icin): $ISTEK_OZET"
  echo "════════════════════════════════════════════════════════"
} > "$GUNLUK"
chown "$UYGULAMA_UID" "$GUNLUK" 2>/dev/null || true
chmod 644 "$GUNLUK" 2>/dev/null || true

durum_yaz "calisiyor" "Kurulum betigi indiriliyor..."

GECICI="$(mktemp /tmp/kantin-kur-XXXXXX.sh)"
if ! curl -fsSL "$BETIK_URL" -o "$GECICI" 2>>"$GUNLUK"; then
  rm -f "$GECICI"
  durum_yaz "hata" "Kurulum betigi indirilemedi (internet erisimi?)."
  echo "HATA: kur.sh indirilemedi" >> "$GUNLUK"
  exit 1
fi

durum_yaz "calisiyor" "Guncelleme calisiyor. Sistem birkac saniye erisilemeyebilir."

if bash "$GECICI" >>"$GUNLUK" 2>&1; then
  durum_yaz "tamam" "Guncelleme tamamlandi."
else
  durum_yaz "hata" "Guncelleme basarisiz oldu. Gunluge bakin: $GUNLUK"
fi
rm -f "$GECICI"
chown "$UYGULAMA_UID" "$GUNLUK" 2>/dev/null || true
