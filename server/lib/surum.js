/**
 * SURUM BILGISI ve GUNCELLEME KONTROLU
 *
 * Konteynerin icinde `.git` yoktur (bkz. .dockerignore), bu yuzden hangi
 * commit'ten derlendigini `kur.sh` derleme oncesi `surum.json`a yazar.
 * Burasi o dosyayi okur ve GitHub'daki dal ile karsilastirir.
 *
 * NEDEN YALNIZCA BILDIRIM?
 * Uygulamanin kendini guncelleyebilmesi icin konteynere Docker soketi
 * verilmesi gerekirdi; bu, uygulamadaki herhangi bir acigi sunucunun
 * tamamini ele gecirmeye cevirir. Bu yuzden sistem yalnizca "yeni surum
 * var" der; guncellemeyi yonetici SSH uzerinden kur.sh ile yapar.
 */
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../config.js';

const DEPO = process.env.KANTIN_REPO_SLUG || 'onurcoskun616/kantin';
// Testte yerel bir taklit sunucuya yonlendirilebilsin diye disaridan verilebilir
const API = (process.env.KANTIN_GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const ONBELLEK_MS = 15 * 60 * 1000;   // GitHub API: saatte 60 istek (IP basina)
const ZAMAN_ASIMI_MS = 6000;

let onbellek = null;   // { at, veri }

/** Imaja damgalanan surum. Okunamazsa "bilinmiyor" doner. */
export function calisanSurum() {
  try {
    const ham = fs.readFileSync(path.join(ROOT, 'surum.json'), 'utf8');
    const s = JSON.parse(ham);
    // Damgalanmamis imaj (gelistirme ortami) bos commit tasir
    return { ...s, bilinmiyor: !s.commit };
  } catch {
    return { commit: '', short: 'bilinmiyor', subject: null, bilinmiyor: true };
  }
}

/**
 * GitHub'daki dal, calisan surumden kac commit ileride?
 *
 * Basarisizlik (internet yok, API limiti, depo erisilemez) HATA DEGILDIR:
 * `kontrolEdilemedi` ile doneriz ve ekran bunu soyler. Guncelleme kontrolu
 * calismiyor diye Sistem Durumu ekrani bozulmamalidir.
 */
export async function guncellemeVarMi({ tazele = false } = {}) {
  if (!tazele && onbellek && Date.now() - onbellek.at < ONBELLEK_MS) return onbellek.veri;

  const surum = calisanSurum();
  if (surum.bilinmiyor) {
    return { surum, kontrolEdilemedi: 'Çalışan sürüm bilinmiyor (imaj kur.sh ile derlenmemiş).' };
  }

  const dal = surum.branch || 'main';
  const veri = await karsilastir(surum, dal);
  onbellek = { at: Date.now(), veri };
  return veri;
}

async function karsilastir(surum, dal) {
  const kesici = new AbortController();
  const sayac = setTimeout(() => kesici.abort(), ZAMAN_ASIMI_MS);
  try {
    const res = await fetch(
      `${API}/repos/${DEPO}/compare/${surum.commit}...${dal}`,
      {
        signal: kesici.signal,
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'topkapi-kantin' },
      }
    );
    // 403 her zaman "istek siniri" demek DEGILDIR: sunucunun cikis trafigi
    // engelliyse ya da araya bir vekil giriyorsa da 403 doner. Gercek limit
    // basligindan anlasilir; yanlis tesis kullaniciyi bosuna bekletir.
    if (res.status === 429
      || (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0')) {
      return { surum, kontrolEdilemedi: 'GitHub istek sınırına takıldı. Bir süre sonra tekrar deneyin.' };
    }
    if (res.status === 403) {
      return {
        surum,
        kontrolEdilemedi: 'GitHub erişimi reddedildi (403). Sunucunun dışarı internet erişimi '
          + 'engelleniyor olabilir.',
      };
    }
    if (res.status === 404) {
      return { surum, kontrolEdilemedi: 'Depo ya da sürüm GitHub\'da bulunamadı (404).' };
    }
    if (!res.ok) {
      return { surum, kontrolEdilemedi: `GitHub yanıt vermedi (${res.status}).` };
    }
    const d = await res.json();
    const gerideMi = Number(d.ahead_by || 0);
    return {
      surum,
      dal,
      gerideCommit: gerideMi,
      guncel: gerideMi === 0,
      // En yeni degisiklik en ustte olsun
      bekleyenler: (d.commits || []).slice(-25).reverse().map((c) => ({
        short: String(c.sha || '').slice(0, 7),
        subject: (c.commit?.message || '').split('\n')[0],
        date: c.commit?.committer?.date || null,
      })),
      kontrolZamani: new Date().toISOString(),
    };
  } catch (err) {
    return {
      surum,
      kontrolEdilemedi: err.name === 'AbortError'
        ? 'GitHub zamanında yanıt vermedi.'
        : 'GitHub\'a ulaşılamadı (sunucunun dış internet erişimi olmayabilir).',
    };
  } finally {
    clearTimeout(sayac);
  }
}
