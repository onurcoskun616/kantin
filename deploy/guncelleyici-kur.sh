#!/usr/bin/env bash
#
# "GUNCELLE" DUGMESINI ETKINLESTIRIR — sunucuda BIR KEZ calistirilir.
#
#   sudo bash guncelleyici-kur.sh
#
# Ya da dogrudan, kurulum yapilmadan once bile:
#   curl -fsSL https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/guncelleyici-kur.sh -o /tmp/g.sh
#   sudo bash /tmp/g.sh
#
# Ne yapar?
#   Host uzerine iki systemd birimi kurar:
#     kantin-guncelle.path    -> paylasimli klasordeki istek dosyasini izler
#     kantin-guncelle.service -> dosya olusunca kur.sh'i calistirir
#
# NEDEN BOYLE?
#   Uygulamanin kendi kendini guncellemesi icin konteynere Docker soketi
#   verilmesi gerekirdi. Docker soketi host uzerinde ROOT YETKISINE DENKTIR:
#   uygulamada bulunacak herhangi bir acik, o anda sunucunun tamamini ele
#   gecirmeye donusur. Bu yol ise konteynere hicbir yetki vermez; uygulama
#   yalnizca bir dosya yazabilir, host da o dosyayi gorunce SABIT bir komut
#   calistirir. Uygulamadaki bir acik, calistirilacak komutu DEGISTIREMEZ.
#
# ISTEMIYORSANIZ KURMAYIN: bu betik calistirilmazsa dugme "guncelleyici
# kurulu degil" der ve guncelleme yalnizca SSH ile yapilir. Sistemin geri
# kalani etkilenmez.
#
# Geri almak icin:
#   sudo systemctl disable --now kantin-guncelle.path
#   sudo rm /etc/systemd/system/kantin-guncelle.path
#   sudo rm /etc/systemd/system/kantin-guncelle.service
#   sudo rm /usr/local/sbin/kantin-guncelle.sh
#   sudo systemctl daemon-reload
set -euo pipefail

DIZIN="${KANTIN_DIR:-/opt/kantin-uygulama}"
KONTROL="$DIZIN/kontrol"
UYGULAMA_UID="${KANTIN_APP_UID:-1000}"
KOSUCU="/usr/local/sbin/kantin-guncelle.sh"
KOSUCU_URL="${KANTIN_KOSUCU_URL:-https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/kantin-guncelle.sh}"

bilgi() { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$1"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$1"; }
hata()  { printf '\n  \033[31m✗ %s\033[0m\n\n' "$1" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || hata "Bu betik root ile calismali: sudo bash guncelleyici-kur.sh"
command -v systemctl >/dev/null 2>&1 || hata "systemd bulunamadi; bu sunucuda bu yontem kullanilamaz."
[ -d "$DIZIN" ] || hata "$DIZIN yok. Once kur.sh ile kurulumu yapin."
command -v curl >/dev/null 2>&1 || hata "curl bulunamadi."

bilgi "1/4  Paylasimli klasor"
mkdir -p "$KONTROL"
# Konteyner (node, uid 1000) buraya YAZABILMELI; baskalari yazamamali
chown "$UYGULAMA_UID:$UYGULAMA_UID" "$KONTROL"
chmod 750 "$KONTROL"
ok "$KONTROL hazir (uid $UYGULAMA_UID yazabilir)"

bilgi "2/4  Kosucu betik"
# Once yerel kopya; yoksa depodan indiririz. Boylece bu betik kur.sh'tan
# ONCE de calistirilabilir ve "once hangisini calistiracagim" sorusu
# ortadan kalkar.
KAYNAK="$DIZIN/kaynak/deploy/kantin-guncelle.sh"
if [ -f "$KAYNAK" ]; then
  install -m 0755 -o root -g root "$KAYNAK" "$KOSUCU"
  ok "$KOSUCU kuruldu (yerel kaynaktan)"
else
  GECICI="$(mktemp /tmp/kantin-kosucu-XXXXXX.sh)"
  curl -fsSL "$KOSUCU_URL" -o "$GECICI" \
    || hata "Kosucu betik indirilemedi: $KOSUCU_URL"
  # Indirilen dosya gercekten beklenen betik mi? Yarim inen ya da vekil
  # sunucunun dondurdugu bir HTML sayfasi sessizce kurulmamali.
  grep -q 'GUNCELLEME KOSUCUSU' "$GECICI" \
    || { rm -f "$GECICI"; hata "Indirilen dosya beklenen betik degil. Once kur.sh calistirin."; }
  install -m 0755 -o root -g root "$GECICI" "$KOSUCU"
  rm -f "$GECICI"
  ok "$KOSUCU kuruldu (depodan indirildi)"
fi

bilgi "3/4  systemd birimleri"
cat > /etc/systemd/system/kantin-guncelle.service <<UNIT
[Unit]
Description=Topkapi Kantin - guncelleme kosucusu
Documentation=https://github.com/onurcoskun616/kantin

[Service]
Type=oneshot
ExecStart=$KOSUCU
Environment=KANTIN_DIR=$DIZIN
Environment=KANTIN_APP_UID=$UYGULAMA_UID
# Guncelleme docker gerektirdigi icin tam yetkiyle calisir; ama
# CALISTIRDIGI KOMUT SABITTIR (yukaridaki kosucu betik). Istek dosyasinin
# icerigi hicbir zaman calistirilmaz.
TimeoutStartSec=1800
UNIT

cat > /etc/systemd/system/kantin-guncelle.path <<UNIT
[Unit]
Description=Topkapi Kantin - guncelleme istegini izler

[Path]
PathExists=$KONTROL/guncelleme-istegi.json
Unit=kantin-guncelle.service

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable --now kantin-guncelle.path
ok "kantin-guncelle.path etkin"

bilgi "4/4  Isaret dosyasi"
# Uygulama bu dosyaya bakarak dugmeyi gosterip gostermeyecegine karar verir
printf '{"kurulduAt":"%s","kosucu":"%s"}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$KOSUCU" \
  > "$KONTROL/guncelleyici-kurulu.json"
chown "$UYGULAMA_UID:$UYGULAMA_UID" "$KONTROL/guncelleyici-kurulu.json"
chmod 644 "$KONTROL/guncelleyici-kurulu.json"
ok "Isaret dosyasi yazildi"

printf '\n\033[1;32m✓ Guncelle dugmesi etkinlestirildi.\033[0m\n\n'

# Konteyner kontrol klasorunu goruyor mu? Gormuyorsa compose tanimi eskidir
# ve kur.sh'in bir kez daha calismasi gerekir.
if docker inspect topkapi-kantin >/dev/null 2>&1 \
   && docker exec topkapi-kantin test -w /app/kontrol 2>/dev/null; then
  echo "  Konteyner kontrol klasorunu goruyor ve yazabiliyor."
  echo "  Hemen kullanabilirsiniz: Yonetim -> Sistem Durumu -> Surum -> 'Simdi Guncelle'"
else
  echo "  SON ADIM: kur.sh'i BIR KEZ calistirin. Konteynerin yeni kontrol"
  echo "  klasorunu gorebilmesi icin yeniden olusturulmasi gerekiyor:"
  echo
  echo "    curl -fsSL https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/kur.sh -o /tmp/kur.sh"
  echo "    sudo bash /tmp/kur.sh"
  echo
  echo "  Sonra: Yonetim -> Sistem Durumu -> Surum -> 'Simdi Guncelle'"
fi
echo
echo "  Gunluk : journalctl -u kantin-guncelle.service -n 100"
echo "  Cikti  : $KONTROL/guncelleme.log"
echo
