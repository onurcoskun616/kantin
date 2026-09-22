/** Sunucu ile iletisim katmani. */
const TOKEN_KEY = 'kantin_token';

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) {
    if (v) {
      localStorage.setItem(TOKEN_KEY, v);
      // Sunucu tarafi CSV indirmelerinde cerez uzerinden dogrulama yapar
      document.cookie = `kantin_token=${encodeURIComponent(v)}; path=/; max-age=86400; SameSite=Strict`;
    } else {
      localStorage.removeItem(TOKEN_KEY);
      document.cookie = 'kantin_token=; path=/; max-age=0';
    }
  },
  user: null,
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

/*
 * ZAMAN ASIMI ve SURE OLCUMU
 *
 * Eskiden bir istek yanitsiz kalirsa tarayici sonsuza kadar beklerdi:
 * "Kaydediliyor..." yazisi asla degismez, kullanici ne oldugunu bilemez
 * ve cogu zaman ikinci kez kaydeder. Artik her istegin bir suresi var.
 *
 * Sunucu her yanitta `Server-Timing: app;dur=...` gonderiyor. Toplam sure
 * ile sunucunun harcadigi sureyi karsilastirirsak yavasligin NEREDE
 * oldugu belli olur ve hata mesajinda bunu soyleyebiliriz.
 */
const ZAMAN_ASIMI_MS = 25_000;

/*
 * Sayfa kapanirken yarim kalan istekler HATA DEGILDIR.
 *
 * Kullanici baska bir sayfaya gecerken o an suren fetch'ler iptal edilir.
 * Bunlari "sunucuya ulasilamadi" diye gostermek yanlis alarm olur: sunucu
 * ayakta, kullanici yalnizca gezinmis. Sayfa gidiyorsa istegi sessizce
 * askida birakiriz -- zaten hicbir sey cizilmeyecek.
 */
let sayfaKapaniyor = false;
for (const olay of ['pagehide', 'beforeunload']) {
  window.addEventListener(olay, () => { sayfaKapaniyor = true; });
}

/** Son isteklerin sureleri: Sistem Durumu ekrani ve teshis icin. */
export const sonIstekler = [];

function kaydet(method, path, toplamMs, sunucuMs, durum) {
  sonIstekler.push({ method, path, toplamMs, sunucuMs, durum, at: Date.now() });
  if (sonIstekler.length > 50) sonIstekler.shift();
}

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  const t0 = performance.now();
  const kesici = new AbortController();
  // Kesintinin BIZDEN gelip gelmedigini ayirt ederiz: zaman asimi ile
  // sayfa gecisi ayni AbortError'u uretir ama biri hata, oteki degildir.
  let zamanAsti = false;
  const sayac = setTimeout(() => { zamanAsti = true; kesici.abort(); }, ZAMAN_ASIMI_MS);
  let res;
  try {
    res = await fetch(path, {
      method, headers, signal: kesici.signal,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (sayfaKapaniyor) return new Promise(() => {});   // sayfa gidiyor, sessiz kal
    kaydet(method, path, Math.round(performance.now() - t0), null, 'hata');
    if (zamanAsti) {
      throw new ApiError(0,
        `Sunucu ${ZAMAN_ASIMI_MS / 1000} saniye içinde yanıt vermedi. İşlem yarıda kalmış olabilir; `
        + 'tekrar denemeden önce kaydın oluşup oluşmadığını kontrol edin.');
    }
    if (err.name === 'AbortError') return new Promise(() => {});   // baska bir iptal
    throw new ApiError(0, 'Sunucuya ulaşılamadı. İnternet bağlantınızı kontrol edip tekrar deneyin.');
  } finally {
    clearTimeout(sayac);
  }

  const toplamMs = Math.round(performance.now() - t0);
  const sunucuMs = sunucuSuresi(res);
  kaydet(method, path, toplamMs, sunucuMs, res.status);
  // Gecikme belirginse konsola NEREDE gectigini yaz: destek isteyen
  // kullanicidan ekran goruntusu beklemek yerine tek satir yeter.
  if (toplamMs > 2000) {
    console.warn(`[YAVAS] ${method} ${path}: toplam ${toplamMs} ms`
      + (sunucuMs === null ? '' : `, sunucu ${sunucuMs} ms, ağ/vekil ${Math.max(0, toplamMs - sunucuMs)} ms`));
  }

  // Govde AYRI okunur: basarili bir yanitin coz(umlenememesi ile hatali bir
  // yanitin bos govdesi ayni sey degildir.
  //
  // Onceden ikisi de sessizce {} oluyordu. Boyle bir durumda (or. baglanti
  // yanit ortasinda kesilirse) sayfa `data.items.find(...)` gibi bir yerde
  // anlasilmaz bir TypeError ile coküyordu; kullanici ne oldugunu goremiyordu.
  let data = {};
  let cozumlemeHatasi = null;
  try {
    const metin = await res.text();
    if (metin) data = JSON.parse(metin);
  } catch (err) {
    cozumlemeHatasi = err;
  }

  // Giris denemesindeki 401 "oturum doldu" DEGILDIR: sunucunun gercek
  // mesajini ("E-posta veya parola hatali.") oldugu gibi gostermeliyiz.
  // Aksi halde yanlis parola giren kullanici sebebi anlamaz.
  const girisDenemesi = path.startsWith('/api/auth/login');
  if (res.status === 401 && !girisDenemesi) {
    auth.token = null;
    auth.user = null;
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(401, data.error || 'Oturum süresi doldu. Lütfen tekrar giriş yapın.');
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Beklenmeyen hata (${res.status})`, data.details);

  // Basarili gorunen ama okunamayan yanit: yarim kalmis bir aktarim ya da
  // araya giren bir vekil olabilir. Sessizce bos veri dondurmek yerine
  // soyleriz; tekrar denemek cogu zaman yeterlidir.
  if (cozumlemeHatasi) {
    // Sayfa gecisi sirasinda govde yarim kalmis olabilir: bu bir hata
    // degil, kullanicinin gezinmesidir.
    if (sayfaKapaniyor) return new Promise(() => {});
    throw new ApiError(res.status,
      'Sunucudan geçersiz yanıt alındı (bağlantı yarıda kesilmiş olabilir). Lütfen tekrar deneyin.');
  }
  return data;
}

/** Sunucunun bildirdigi isleme suresi (ms) -- yoksa null. */
function sunucuSuresi(res) {
  const h = res.headers.get('Server-Timing');
  if (!h) return null;
  const m = /dur=([\d.]+)/.exec(h);
  return m ? Math.round(Number(m[1])) : null;
}

/** Ham dosya gonderir (JSON'a gomulmeden). Fatura ekleri icin. */
async function upload(path, file, params) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(withQuery(path, { filename: file.name, ...params }), {
    method: 'POST', headers, body: file,
  });
  let data = {};
  let cozumlemeHatasi = null;
  try {
    const metin = await res.text();
    if (metin) data = JSON.parse(metin);
  } catch (err) {
    cozumlemeHatasi = err;
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Yükleme başarısız (${res.status})`, data.details);
  if (cozumlemeHatasi) {
    throw new ApiError(res.status,
      'Dosya gönderildi ama sunucunun yanıtı okunamadı. Belgeyi açıp ekin gerçekten '
      + 'eklendiğini kontrol edin.');
  }
  return data;
}

/** Korumali bir dosyayi indirir; yetki basligi gerektigi icin fetch ile alinir. */
async function fetchBlob(path) {
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Dosya açılamadı (${res.status})`);
  }
  return res.blob();
}

export const api = {
  get: (path, params) => request('GET', withQuery(path, params)),
  upload,
  fetchBlob,
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  // DELETE govde tasiyabilir: geri alinamaz silmeler gerekce ve dogrulama
  // ister (or. teslim fisi silerken belge numarasinin elle yazilmasi).
  del: (path, body) => request('DELETE', path, body),
  /** CSV indirmesini yeni sekmede acar. */
  download(path, params) {
    window.open(withQuery(path, { ...params, format: 'csv' }), '_blank');
  },
};

function withQuery(path, params) {
  if (!params) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}
