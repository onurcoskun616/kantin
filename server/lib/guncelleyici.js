/**
 * GUNCELLE DUGMESI — uygulama tarafi
 *
 * Uygulama guncellemeyi KENDI CALISTIRMAZ. Yapabildigi tek sey paylasimli
 * bir klasore ISTEK DOSYASI yazmaktir; host uzerindeki systemd birimi o
 * dosyayi gorup SABIT bir komut (deploy/kur.sh) calistirir.
 *
 * Neden bu kadar dolayli?
 *   Konteynerin kendi imajini yeniden kurabilmesi icin Docker soketine
 *   erismesi gerekirdi. Docker soketi host uzerinde root yetkisine denktir:
 *   uygulamada bulunacak herhangi bir acik, o anda sunucunun tamamini ele
 *   gecirmeye donusurdu. Bu yolda uygulamanin yetkisi "bir dosya yazmak"
 *   ile sinirlidir; CALISTIRILACAK KOMUTU etkileyemez, yalnizca
 *   guncellemenin ZAMANINI etkiler.
 *
 * Kurulum istege baglidir (deploy/guncelleyici-kur.sh). Kurulmamissa
 * `kuruluMu()` false doner ve arayuz dugme yerine komutu gosterir.
 */
import fs from 'node:fs';
import path from 'node:path';

const KONTROL = process.env.KANTIN_CONTROL_DIR || '/app/kontrol';
const ISARET  = () => path.join(KONTROL, 'guncelleyici-kurulu.json');
const ISTEK   = () => path.join(KONTROL, 'guncelleme-istegi.json');
const DURUM   = () => path.join(KONTROL, 'guncelleme-durum.json');
const GUNLUK  = () => path.join(KONTROL, 'guncelleme.log');

const GUNLUK_SON_BAYT = 8000;

/** Host tarafindaki guncelleyici kurulu mu? */
export function kuruluMu() {
  try {
    return fs.existsSync(ISARET()) && fs.existsSync(KONTROL);
  } catch {
    return false;
  }
}

/** Klasor yazilabilir mi? (kurulu ama izinler bozuksa dugme calismaz) */
function yazilabilirMi() {
  try {
    fs.accessSync(KONTROL, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Guncelleme istegi birakir.
 *
 * Dosyanin ICERIGI host tarafinda hicbir zaman calistirilmaz; yalnizca
 * "kim istedi" kaydi icin yazilir ve orada da sadelestirilir.
 */
export function istekBirak(kullanici) {
  if (!kuruluMu()) {
    return {
      ok: false,
      kod: 'KURULU_DEGIL',
      mesaj: 'Güncelleyici bu sunucuda kurulu değil. Sunucuda bir kez '
        + '"sudo bash /opt/kantin-uygulama/kaynak/deploy/guncelleyici-kur.sh" çalıştırın.',
    };
  }
  if (!yazilabilirMi()) {
    return {
      ok: false,
      kod: 'YAZILAMIYOR',
      mesaj: 'Güncelleme klasörüne yazılamıyor. Klasör izinlerini kontrol edin '
        + `(${KONTROL}).`,
    };
  }
  // Suren bir guncelleme varsa ikincisini birakmayiz
  const suren = durumOku();
  if (suren?.durum === 'calisiyor') {
    return { ok: false, kod: 'ZATEN_CALISIYOR', mesaj: 'Zaten süren bir güncelleme var.', durum: suren };
  }

  const govde = {
    isteyen: String(kullanici?.fullName || '').slice(0, 100),
    eposta: String(kullanici?.email || '').slice(0, 160),
    zaman: new Date().toISOString(),
  };
  // Once gecici dosyaya yazip yeniden adlandiririz: systemd yarim yazilmis
  // bir dosyayi gorup erken tetiklenmesin.
  const gecici = `${ISTEK()}.yaziliyor`;
  fs.writeFileSync(gecici, JSON.stringify(govde), { mode: 0o644 });
  fs.renameSync(gecici, ISTEK());
  return { ok: true, mesaj: 'Güncelleme başlatıldı.', istek: govde };
}

/** Host'un yazdigi son durum. */
export function durumOku() {
  try {
    return JSON.parse(fs.readFileSync(DURUM(), 'utf8'));
  } catch {
    return null;
  }
}

/** Guncelleme ciktisinin SONU (uzun olabilir, tamamini tasimayiz). */
export function gunlukOku() {
  try {
    const { size } = fs.statSync(GUNLUK());
    const bastan = Math.max(0, size - GUNLUK_SON_BAYT);
    const fd = fs.openSync(GUNLUK(), 'r');
    try {
      const tampon = Buffer.alloc(size - bastan);
      fs.readSync(fd, tampon, 0, tampon.length, bastan);
      return (bastan > 0 ? '...\n' : '') + tampon.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

/** Arayuzun dugmeyi gosterip gostermeyecegine karar vermesi icin. */
export function guncellemeDurumu() {
  return {
    kurulu: kuruluMu(),
    yazilabilir: kuruluMu() && yazilabilirMi(),
    // Istek dosyasi duruyorsa host henuz almamis demektir
    beklemede: (() => { try { return fs.existsSync(ISTEK()); } catch { return false; } })(),
    son: durumOku(),
    gunluk: gunlukOku(),
  };
}
