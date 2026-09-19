/**
 * FATURA KAREKODU (GİB QR) OKUYUCU
 *
 * Kağıt/PDF olarak gelen e-Fatura ve e-Arşiv faturalarının üzerindeki
 * karekodu okur. Harici kütüphane yoktur: tarayıcının kendi `BarcodeDetector`
 * arayüzü kullanılır.
 *
 * ÖNEMLİ — KAREKODDA ÜRÜN SATIRLARI YOKTUR.
 * GİB'in belirlediği içerik yalnızca başlık ve toplamlardır:
 *   satıcı VKN/TCKN, alıcı VKN/TCKN, senaryo, belge no, tarih, ETTN,
 *   mal/hizmet toplamı, KDV oranı başına matrah ve hesaplanan KDV,
 *   vergi dahil tutar, ödenecek tutar.
 * Bu yüzden karekod:
 *   - başlığı (tedarikçi, belge no, tarih) doldurur,
 *   - mükerrer fatura kontrolünü (ETTN) çalıştırır,
 *   - ELLE girilen satırların faturayla tutup tutmadığını denetler.
 * Satırları kendiliğinden dolduramaz; onun için XML gerekir.
 *
 * Tarayıcı desteği: `BarcodeDetector` Chrome, Edge ve Android Chrome'da
 * vardır; Firefox ve Safari'de YOKTUR. Desteklenmeyen tarayıcılarda
 * kullanıcıya karekod metnini yapıştırma yolu açılır (iPhone'da Kamera
 * uygulaması karekodu okuyup metni kopyalayabiliyor).
 */

/* ---------------------------- Sayı / tarih -------------------------- */
/**
 * Karekoddaki tutarı sayıya çevirir.
 * Entegratörler aynı alanı 1180, "1180.00", "1.180,00" ya da "1180,00"
 * yazabiliyor; hepsini kabul ederiz.
 */
export function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined) return null;

  let s = String(value).trim().replace(/\s/g, '').replace(/(TL|TRY|₺)$/i, '');
  if (!s) return null;

  const hasDot = s.includes('.');
  const hasComma = s.includes(',');

  if (hasDot && hasComma) {
    // İkisi de varsa SONDAKİ ondalık ayraçtır, diğeri binlik ayracıdır.
    const dec = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const grp = dec === '.' ? ',' : '.';
    s = s.split(grp).join('').replace(dec, '.');
  } else if (hasComma) {
    // Yalnız virgül: Türkçe ondalık ayracı
    s = s.replace(/,/g, '.');
  } else if (hasDot && (s.match(/\./g) || []).length > 1) {
    // "1.180.500" gibi: birden fazla nokta binlik ayracıdır
    s = s.split('.').join('');
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** `gg.aa.yyyy`, `gg/aa/yyyy` ve `yyyy-aa-gg` biçimlerini ISO'ya çevirir. */
export function parseDate(value) {
  const s = String(value ?? '').trim();
  if (!s) return '';
  let m = /^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = /^(\d{1,2})[-./](\d{1,2})[-./](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return '';
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/* ---------------------------- Çözümleme ----------------------------- */
/** Alan adlarını karşılaştırılabilir hale getirir: küçük harf, yalnız harf/rakam. */
function normKey(k) {
  return String(k).toLocaleLowerCase('tr').replace(/ı/g, 'i').replace(/[^a-z0-9()]/g, '');
}

/** Eş anlamlı alan adlarından ilk dolu olanı döndürür. */
function pick(map, ...names) {
  for (const n of names) {
    const v = map.get(normKey(n));
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return null;
}

/**
 * Karekod metnini okunur bir fatura özetine çevirir.
 *
 * Kabul edilen biçimler:
 *   1. GİB'in standart JSON içeriği (yaygın olan)
 *   2. Sorgulama bağlantısı (URL) — sorgu parametreleri okunur
 *   3. `anahtar=deger|anahtar=deger` gibi ayraçlı düz metin
 *
 * Tanıyamazsa açıklayıcı bir Error fırlatır; ham metin `err.raw` içindedir.
 */
export function parseKarekod(rawText) {
  const raw = String(rawText ?? '').trim();
  if (!raw) throw new Error('Karekod boş okundu.');

  const fields = readFields(raw);
  if (!fields) {
    const err = new Error(
      'Karekod okundu ama içeriği tanınamadı. Bu, fatura karekodu yerine '
      + 'bir kargo/kampanya karekodu olabilir. Okunan metin aşağıda.'
    );
    err.raw = raw;
    throw err;
  }

  const map = new Map();
  for (const [k, v] of Object.entries(fields)) map.set(normKey(k), v);

  const invoice = {
    raw,
    taxNo: String(pick(map, 'vkntckn', 'vkn', 'tckn', 'saticivkntckn', 'saticivkn', 'satici') ?? '').trim(),
    buyerTaxNo: String(pick(map, 'avkntckn', 'alicivkntckn', 'alicivkn', 'alici') ?? '').trim(),
    documentNo: String(pick(map, 'no', 'belgeno', 'faturano', 'belgenumarasi', 'id') ?? '').trim(),
    issueDate: parseDate(pick(map, 'tarih', 'belgetarihi', 'faturatarihi', 'issuedate', 'duzenlemetarihi')),
    uuid: String(pick(map, 'ettn', 'uuid', 'belgeuuid') ?? '').trim(),
    scenario: String(pick(map, 'senaryo', 'profilid') ?? '').trim(),
    docType: String(pick(map, 'tip', 'belgeturu', 'faturatipi', 'belgetipi') ?? '').trim(),
    goodsTotal: parseMoney(pick(map, 'malhizmettoplam', 'malhizmettoplami', 'matrah')),
    discountTotal: parseMoney(pick(map, 'malhizmetindirimtoplam', 'indirimtoplam', 'indirim')),
    taxInclusive: parseMoney(pick(map, 'vergidahil', 'vergilerdahiltoplamtutar', 'vergidahiltoplam')),
    payable: parseMoney(pick(map, 'odenecek', 'odenecektutar', 'odenecektoplam', 'odenecektutari')),
    vatByRate: [],
    warnings: [],
  };

  // KDV kırılımı: kdvmatrah(20) / hesaplanankdv(20) çiftleri.
  // Bazı entegratörler parantezsiz (kdvmatrah20) ya da yüzde işaretli yazıyor.
  const bases = new Map();
  const taxes = new Map();
  for (const [k, v] of map) {
    let m = /^kdvmatrah\(?%?([\d.,]+)\)?$/.exec(k);
    if (m) { bases.set(normRate(m[1]), parseMoney(v)); continue; }
    m = /^hesaplanankdv\(?%?([\d.,]+)\)?$/.exec(k);
    if (m) taxes.set(normRate(m[1]), parseMoney(v));
  }
  for (const rate of [...new Set([...bases.keys(), ...taxes.keys()])].sort((a, b) => a - b)) {
    const base = bases.get(rate) ?? 0;
    const tax = taxes.get(rate) ?? 0;
    // GİB karekodu kullanılmayan oranları da 0 yazar; sıfır satırları göstermeyiz.
    if (base === 0 && tax === 0) continue;
    invoice.vatByRate.push({ rate, base: round2(base), tax: round2(tax) });
  }

  if (!invoice.taxNo && !invoice.uuid && !invoice.documentNo) {
    const err = new Error(
      'Karekod fatura bilgisi içermiyor (VKN, belge no ve ETTN alanlarının üçü de boş).'
    );
    err.raw = raw;
    throw err;
  }

  // Karekodun kendi içinde tutarlı olup olmadığı: matrah + KDV = vergi dahil?
  const sumBase = round2(invoice.vatByRate.reduce((s, r) => s + r.base, 0));
  const sumTax = round2(invoice.vatByRate.reduce((s, r) => s + r.tax, 0));
  invoice.computed = { base: sumBase, tax: sumTax, gross: round2(sumBase + sumTax) };

  if (invoice.goodsTotal !== null && sumBase > 0 && Math.abs(invoice.goodsTotal - sumBase) > 0.05) {
    invoice.warnings.push(
      `Karekodda mal/hizmet toplamı ${invoice.goodsTotal.toFixed(2)} yazıyor ama `
      + `KDV matrahlarının toplamı ${sumBase.toFixed(2)}. Arada iskonto veya KDV dışı `
      + 'vergi (ÖTV vb.) olabilir.'
    );
  }
  if (invoice.payable === null && invoice.taxInclusive !== null) invoice.payable = invoice.taxInclusive;

  return invoice;
}

/** "20", "%20", "20,0" → 20 */
function normRate(s) {
  const n = parseMoney(String(s).replace('%', ''));
  return n === null ? 0 : Math.round(n * 100) / 100;
}

/**
 * Ham metinden alan sözlüğü çıkarır. Tanıyamazsa null döner.
 * Üç biçim denenir: JSON, URL sorgu parametreleri, ayraçlı düz metin.
 */
function readFields(raw) {
  // 1) JSON
  if (/^[[{]/.test(raw)) {
    try {
      const parsed = JSON.parse(raw);
      const obj = Array.isArray(parsed) ? Object.assign({}, ...parsed.filter((x) => x && typeof x === 'object')) : parsed;
      if (obj && typeof obj === 'object' && Object.keys(obj).length) return flatten(obj);
    } catch { /* JSON değilse diğer biçimleri deneriz */ }
  }

  // 2) URL — e-Arşiv sorgulama bağlantıları
  if (/^https?:\/\//i.test(raw)) {
    try {
      const url = new URL(raw);
      const out = {};
      for (const [k, v] of url.searchParams) out[k] = v;
      if (Object.keys(out).length) return out;
    } catch { /* bozuk URL */ }
  }

  // 3) anahtar=deger çiftleri (| ; & veya satır sonu ile ayrılmış)
  if (/[=:]/.test(raw)) {
    const out = {};
    for (const part of raw.split(/[|;&\n\r]+/)) {
      const m = /^\s*([^=:]+)[=:](.*)$/.exec(part);
      if (m) out[m[1].trim()] = m[2].trim();
    }
    if (Object.keys(out).length >= 2) return out;
  }

  return null;
}

/** İç içe nesneleri tek seviyeye indirir (bazı entegratörler gruplu yazıyor). */
function flatten(obj, out = {}) {
  for (const [k, v] of Object.entries(obj)) {
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, out);
    else if (out[k] === undefined) out[k] = v;
  }
  return out;
}

/* ------------------------- Fatura ile karşılaştırma ------------------ */
/**
 * Elle girilen satırları karekodun beyan ettiği tutarlarla karşılaştırır.
 * Asıl fayda budur: yanlış yazılmış bir rakam, aylar sonra sayım farkı
 * olarak karşımıza çıkmadan burada yakalanır.
 *
 * @param invoice parseKarekod çıktısı
 * @param lines   [{ vatRate, net, vat }] — formdaki satırlar
 */
export function compareWithLines(invoice, lines, { tolerance = 0.05 } = {}) {
  const entered = new Map();
  for (const l of lines) {
    const rate = Math.round((Number(l.vatRate) || 0) * 100) / 100;
    const cur = entered.get(rate) || { base: 0, tax: 0 };
    cur.base += Number(l.net) || 0;
    cur.tax += Number(l.vat) || 0;
    entered.set(rate, cur);
  }

  const rates = [...new Set([...invoice.vatByRate.map((r) => r.rate), ...entered.keys()])]
    .sort((a, b) => a - b);

  const rows = [];
  for (const rate of rates) {
    const inv = invoice.vatByRate.find((r) => r.rate === rate) || { base: 0, tax: 0 };
    const ent = entered.get(rate) || { base: 0, tax: 0 };
    rows.push({
      label: `%${rate} matrah`,
      invoice: round2(inv.base), entered: round2(ent.base),
      diff: round2(ent.base - inv.base), ok: Math.abs(ent.base - inv.base) <= tolerance,
    });
    rows.push({
      label: `%${rate} KDV`,
      invoice: round2(inv.tax), entered: round2(ent.tax),
      diff: round2(ent.tax - inv.tax), ok: Math.abs(ent.tax - inv.tax) <= tolerance,
    });
  }

  const entBase = round2([...entered.values()].reduce((s, v) => s + v.base, 0));
  const entTax = round2([...entered.values()].reduce((s, v) => s + v.tax, 0));
  const entGross = round2(entBase + entTax);

  // Ödenecek tutar karekodda varsa onu, yoksa kırılımdan hesaplananı kullanırız.
  const invGross = invoice.payable ?? invoice.computed.gross;
  rows.push({
    label: 'Genel toplam',
    invoice: round2(invGross), entered: entGross,
    diff: round2(entGross - invGross), ok: Math.abs(entGross - invGross) <= tolerance,
    total: true,
  });

  const issues = [];
  for (const r of rows) {
    if (r.ok) continue;
    issues.push(
      `${r.label}: faturada ${r.invoice.toFixed(2)}, girilen ${r.entered.toFixed(2)} `
      + `(fark ${r.diff > 0 ? '+' : ''}${r.diff.toFixed(2)})`
    );
  }

  // Karekodda hiç olmayan bir KDV oranı girildiyse bu tek başına anlamlıdır.
  for (const rate of entered.keys()) {
    if (!invoice.vatByRate.some((r) => r.rate === rate) && (entered.get(rate).base || entered.get(rate).tax)) {
      issues.push(`Faturada %${rate} KDV'li kalem yok ama siz %${rate} ile satır girdiniz.`);
    }
  }

  return { ok: issues.length === 0, rows, issues, enteredGross: entGross, invoiceGross: round2(invGross) };
}

/* ------------------------- Karekod okuma (tarayıcı) ------------------ */
/** Tarayıcı karekod okuyabiliyor mu? */
export function qrSupported() {
  return typeof window !== 'undefined' && typeof window.BarcodeDetector === 'function';
}

let detectorPromise = null;
async function detector() {
  if (!qrSupported()) throw new Error('Bu tarayıcı karekod okumayı desteklemiyor.');
  if (!detectorPromise) {
    detectorPromise = (async () => {
      const formats = await window.BarcodeDetector.getSupportedFormats?.().catch(() => []) ?? [];
      if (formats.length && !formats.includes('qr_code')) {
        throw new Error('Bu tarayıcı karekod (QR) biçimini desteklemiyor.');
      }
      return new window.BarcodeDetector({ formats: ['qr_code'] });
    })().catch((err) => { detectorPromise = null; throw err; });
  }
  return detectorPromise;
}

/** Bir görüntü kaynağından ilk karekodu okur; bulamazsa null döner. */
async function detectOnce(source) {
  const det = await detector();
  const codes = await det.detect(source).catch(() => []);
  const hit = codes.find((c) => c.rawValue && c.rawValue.trim());
  return hit ? hit.rawValue.trim() : null;
}

/**
 * Fotoğraf dosyasından karekod okur.
 *
 * Telefon fotoğrafları büyük olur ve karekod küçük kalır; tek denemede
 * bulunamazsa ölçek değiştirip tekrar deneriz.
 */
export async function readQrFromImageFile(file) {
  if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || '')) {
    throw new Error(
      'PDF dosyasından karekod okunamıyor. PDF\'i açıp karekodun ekran görüntüsünü alın '
      + 'ya da faturanın XML dosyasını kullanın.'
    );
  }

  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('Dosya bir görüntü olarak açılamadı. JPG, PNG veya WEBP seçin.');
  }

  try {
    const direct = await detectOnce(bitmap);
    if (direct) return direct;

    // Ölçek denemeleri: çok büyük fotoğrafı küçült, küçük görüntüyü büyüt
    for (const target of [1600, 2600, bitmap.width * 2]) {
      const scale = target / bitmap.width;
      if (!Number.isFinite(scale) || scale <= 0 || Math.abs(scale - 1) < 0.05) continue;
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      if (w > 6000 || h > 6000) continue;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
      const hit = await detectOnce(canvas);
      if (hit) return hit;
    }
  } finally {
    bitmap.close?.();
  }
  return null;
}

/**
 * Kamerayı açar ve karekod bulunana kadar tarar.
 *
 * Dönen nesne: { promise, stop }
 *   promise -> { text, error }  (text null ise ya durduruldu ya da hata var)
 *   stop()  -> taramayı bitirir, kamerayı KAPATIR
 *
 * Kamera akışı mutlaka kapanmalı: aksi halde telefonda kamera ışığı yanık
 * kalır ve pil biter.
 */
export function scanWithCamera(videoEl) {
  let stream = null;
  let timer = null;
  let done = false;
  let finish;
  const promise = new Promise((resolve) => { finish = resolve; });

  const release = () => {
    clearInterval(timer);
    timer = null;
    for (const t of stream?.getTracks() || []) t.stop();
    stream = null;
    try { videoEl.pause(); } catch { /* zaten duruyor */ }
    videoEl.srcObject = null;
  };

  const settle = (text, error = null) => {
    if (done) return;
    done = true;
    release();
    finish({ text: text || null, error });
  };

  (async () => {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Bu tarayıcıda kamera erişimi yok. Güvenli (https) bir adreste olduğunuzdan emin olun.');
    }
    await detector();   // desteklenmiyorsa kamerayı hiç açmadan haber verelim

    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      audio: false,
    });
    if (done) { for (const t of stream.getTracks()) t.stop(); stream = null; return; }

    videoEl.setAttribute('playsinline', '');
    videoEl.muted = true;
    videoEl.srcObject = stream;
    await videoEl.play().catch(() => {});

    timer = setInterval(async () => {
      if (done || videoEl.readyState < 2) return;
      const hit = await detectOnce(videoEl).catch(() => null);
      if (hit) settle(hit);
    }, 250);
  })().catch((err) => {
    settle(null, err instanceof Error ? err : new Error(String(err)));
  });

  return { promise, stop: () => settle(null) };
}
