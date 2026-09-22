/**
 * e-FATURA / e-ARŞİV XML OKUYUCU (UBL-TR 1.2)
 *
 * Tarayıcıda çalışır, harici kütüphane kullanmaz — tarayıcının kendi
 * `DOMParser`'ı yeterlidir. Excel okuyucusu (`xlsx.js`) ile aynı yaklaşım:
 * dosya sunucuya gitmeden önce okunur, kullanıcı ekranda kontrol eder,
 * onaylayınca kaydedilir.
 *
 * Neden ad alanı (namespace) ile uğraşmıyoruz?
 * Farklı entegratörler aynı etiketi `cbc:`, `ns2:` ya da öneksiz yazabiliyor.
 * Bu yüzden her arama `localName` üzerinden yapılır; önek ne olursa olsun
 * çalışır.
 *
 * ÖNEMLİ — birim fiyat KDV HARİÇ okunur (`cac:Price/cbc:PriceAmount`).
 * Uygulamanın alım satırı da KDV hariç birim fiyat beklediği için ikisi
 * birebir örtüşür.
 */
// Faturadaki ad ile katalogdaki ad Türkçe karakterlerde ayrışabiliyor
// (entegratörler çoğu zaman "CIKOLATALI GOFRET" yazıyor). Ortak
// sadeleştirme ikisini de ASCII'ye indirir.
import { normalizeTr as normalize } from './ui.js';

/* ----------------------------- XML gezinme -------------------------- */
/** Çocuklar arasında verilen adı taşıyanları döndürür (ad alanı fark etmez). */
function kids(node, name) {
  if (!node) return [];
  return [...node.children].filter((c) => c.localName === name);
}

/** İlk eşleşen çocuk. */
function kid(node, name) {
  return kids(node, name)[0] || null;
}

/** `a > b > c` yolunu izler. */
function at(node, ...names) {
  let cur = node;
  for (const n of names) {
    cur = kid(cur, n);
    if (!cur) return null;
  }
  return cur;
}

/** Yolun metin değeri. */
function text(node, ...names) {
  const n = names.length ? at(node, ...names) : node;
  return n ? n.textContent.trim() : '';
}

/** Yolun sayı değeri. XML her zaman nokta ayraçlıdır. */
function number(node, ...names) {
  const t = text(node, ...names);
  if (!t) return null;
  const v = Number(t.replace(/\s/g, ''));
  return Number.isFinite(v) ? v : null;
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000;

/* ------------------------------ Çözümleme --------------------------- */
/**
 * XML metnini okunabilir bir fatura nesnesine çevirir.
 * Hata durumunda açıklayıcı bir Error fırlatır.
 */
export function parseEFatura(xmlText) {
  const clean = String(xmlText).replace(/^﻿/, '');
  const doc = new DOMParser().parseFromString(clean, 'application/xml');

  if (doc.querySelector('parsererror')) {
    throw new Error('Dosya geçerli bir XML değil. e-Fatura/e-Arşiv XML dosyasını seçtiğinizden emin olun.');
  }

  // Bazı entegratörler faturayı bir zarfın içine koyar; kökte bulamazsak ara.
  let inv = doc.documentElement;
  if (inv.localName !== 'Invoice') {
    inv = [...doc.getElementsByTagName('*')].find((n) => n.localName === 'Invoice') || null;
  }
  if (!inv) {
    throw new Error(
      'Bu XML bir fatura (Invoice) belgesi değil. İrsaliye (DespatchAdvice) veya '
      + 'uygulama yanıtı (ApplicationResponse) dosyası yüklenmiş olabilir.'
    );
  }

  const supplierParty = at(inv, 'AccountingSupplierParty', 'Party');

  const invoice = {
    uuid: text(inv, 'UUID'),
    documentNo: text(inv, 'ID'),
    issueDate: text(inv, 'IssueDate'),
    dueDate: text(inv, 'DueDate') || text(at(inv, 'PaymentMeans'), 'PaymentDueDate') || '',
    currency: text(inv, 'DocumentCurrencyCode') || 'TRY',
    profile: text(inv, 'ProfileID'),
    invoiceType: text(inv, 'InvoiceTypeCode'),
    supplier: readParty(supplierParty),
    lines: kids(inv, 'InvoiceLine').map(readLine),
    // Faturanın kendi beyan ettiği toplamlar — satırlarla karşılaştırırız
    declared: {
      lineTotal: number(at(inv, 'LegalMonetaryTotal'), 'LineExtensionAmount'),
      taxTotal: number(at(inv, 'TaxTotal'), 'TaxAmount'),
      payable: number(at(inv, 'LegalMonetaryTotal'), 'PayableAmount'),
      // BELGE GENELI iskonto ve masraf. Satır iskontosundan ayrıdır: satır
      // fiyatlarına yansımaz, yalnızca ödenecek tutarı değiştirir. Okunmazsa
      // maliyet olduğundan yüksek kaydedilir.
      allowanceTotal: number(at(inv, 'LegalMonetaryTotal'), 'AllowanceTotalAmount') ?? 0,
      chargeTotal: number(at(inv, 'LegalMonetaryTotal'), 'ChargeTotalAmount') ?? 0,
    },
    warnings: [],
  };

  if (!invoice.lines.length) throw new Error('Faturada hiç ürün satırı (InvoiceLine) bulunamadı.');

  if (invoice.currency !== 'TRY') {
    invoice.warnings.push(
      `Fatura para birimi ${invoice.currency}. Tutarlar TL'ye çevrilmeden aktarılır; kontrol edin.`
    );
  }

  // Satırlardan hesapladığımız toplam ile faturanın yazdığı toplam tutuyor mu?
  const computedNet = round2(invoice.lines.reduce((s, l) => s + l.netTotal, 0));
  const computedVat = round2(invoice.lines.reduce((s, l) => s + l.vatTotal, 0));
  invoice.computed = { netTotal: computedNet, vatTotal: computedVat, grossTotal: round2(computedNet + computedVat) };

  if (invoice.declared.lineTotal !== null && Math.abs(invoice.declared.lineTotal - computedNet) > 0.05) {
    invoice.warnings.push(
      `Satır toplamı (${computedNet.toFixed(2)}) faturanın yazdığı mal bedeliyle `
      + `(${invoice.declared.lineTotal.toFixed(2)}) uyuşmuyor. Satırları kontrol edin.`
    );
  }
  // Belge geneli iskonto varsa satırlara DAĞITILIR: gerçekten ödenen tutar
  // budur ve stok maliyeti buna göre oluşmalıdır. Dağıtım satırların mal
  // bedeline orantılıdır; kuruş farkı son satırda kapatılır.
  if (invoice.declared.allowanceTotal > 0 && computedNet > 0) {
    const kalanOran = (computedNet - invoice.declared.allowanceTotal) / computedNet;
    if (kalanOran > 0 && kalanOran < 1) {
      for (const l of invoice.lines) {
        const eskiNet = l.netTotal;
        // Mevcut satır iskontosunun üzerine belge iskontosu eklenir
        l.discountPct = round4(100 - (100 - l.discountPct) * kalanOran);
        l.netTotal = round2(eskiNet * kalanOran);
        l.vatTotal = round2(l.netTotal * (l.vatRate / 100));
        l.grossTotal = round2(l.netTotal + l.vatTotal);
        l.documentDiscount = true;
      }
      invoice.warnings.push(
        `Faturada ${invoice.declared.allowanceTotal.toFixed(2)} TL belge geneli iskonto var. `
        + 'Satırlara mal bedeline orantılı dağıtıldı; iskonto sütununda bunu göreceksiniz. '
        + 'Tedarikçi farklı dağıtmış olabilir, satır tutarlarını kontrol edin.'
      );
    }
  }
  if (invoice.declared.chargeTotal > 0) {
    invoice.warnings.push(
      `Faturada ${invoice.declared.chargeTotal.toFixed(2)} TL belge geneli masraf var (nakliye, ambalaj vb.). `
      + 'Bu tutar satırlara DAĞITILMADI: ürün maliyetine eklenip eklenmeyeceği sizin kararınız. '
      + 'Eklemek isterseniz satır fiyatlarını elle artırın.'
    );
  }

  // Satır toplamları yukarıda değişmiş olabilir; kontroller güncel değerlerle
  const netSonrasi = round2(invoice.lines.reduce((s, l) => s + l.netTotal, 0));
  const kdvSonrasi = round2(invoice.lines.reduce((s, l) => s + l.vatTotal, 0));
  invoice.computed = { netTotal: netSonrasi, vatTotal: kdvSonrasi, grossTotal: round2(netSonrasi + kdvSonrasi) };

  // Belge iskontosu KDV'yi de düşürür: karşılaştırma DAĞITIM SONRASI
  // değerle yapılmalı, yoksa iskontolu her faturada boş yere uyarı çıkar.
  if (invoice.declared.taxTotal !== null && Math.abs(invoice.declared.taxTotal - kdvSonrasi) > 0.05) {
    invoice.warnings.push(
      `Hesaplanan KDV (${kdvSonrasi.toFixed(2)}) faturanın yazdığı KDV'den `
      + `(${invoice.declared.taxTotal.toFixed(2)}) farklı. Faturada KDV dışı vergi (ÖTV vb.) olabilir.`
    );
  }
  return invoice;
}

/** Tedarikçi kimliği: VKN/TCKN, unvan, vergi dairesi. */
function readParty(party) {
  if (!party) return { taxNo: '', name: '', taxOffice: '' };
  const ids = kids(party, 'PartyIdentification').map((n) => ({
    scheme: (kid(n, 'ID')?.getAttribute('schemeID') || '').toUpperCase(),
    value: text(n, 'ID'),
  }));
  const vkn = ids.find((i) => i.scheme === 'VKN' || i.scheme === 'TCKN') || ids[0];
  return {
    taxNo: vkn?.value || '',
    name: text(at(party, 'PartyName'), 'Name') || text(at(party, 'Person'), 'FirstName'),
    taxOffice: text(at(party, 'PartyTaxScheme', 'TaxScheme'), 'Name'),
  };
}

/**
 * Bir fatura satırını uygulamanın alım satırı biçimine çevirir.
 *
 * UBL'de birim fiyat iskonto ÖNCESİDİR; iskonto ayrı bir AllowanceCharge
 * olarak verilir. Uygulama ise (miktar, birim fiyat, iskonto %) ile çalışır,
 * bu yüzden iskonto oranı tutardan geri hesaplanır.
 */
function readLine(node) {
  const qtyNode = kid(node, 'InvoicedQuantity');
  const quantity = number(node, 'InvoicedQuantity') ?? 0;
  const unitCode = qtyNode?.getAttribute('unitCode') || '';
  const item = kid(node, 'Item');

  const unitPrice = number(at(node, 'Price'), 'PriceAmount') ?? 0;
  const lineExtension = number(node, 'LineExtensionAmount');

  // İskonto: ChargeIndicator=false olan AllowanceCharge kalemleri
  let discountAmount = 0;
  let multiplier = null;
  for (const ac of kids(node, 'AllowanceCharge')) {
    if (text(ac, 'ChargeIndicator').toLowerCase() !== 'false') continue;
    discountAmount += number(ac, 'Amount') ?? 0;
    const m = number(ac, 'MultiplierFactorNumeric');
    if (m !== null) multiplier = m;
  }

  const gross = round2(quantity * unitPrice);
  let discountPct = 0;
  if (discountAmount > 0 && gross > 0) {
    discountPct = round4((discountAmount / gross) * 100);
  } else if (multiplier !== null && multiplier > 0) {
    // Bazı entegratörler oranı 0,10 bazıları 10 olarak yazar
    discountPct = multiplier <= 1 ? round4(multiplier * 100) : round4(multiplier);
  }

  const netTotal = round2(gross * (1 - discountPct / 100));
  const vatRate = readVatRate(node);
  const vatTotal = round2(netTotal * (vatRate / 100));

  const line = {
    lineNo: text(node, 'ID'),
    name: text(item, 'Name'),
    quantity: round4(quantity),
    unitCode,
    unitPrice: round4(unitPrice),
    discountPct,
    vatRate,
    netTotal,
    vatTotal,
    grossTotal: round2(netTotal + vatTotal),
    // Ürün eşlemesi için kullanılabilecek kodlar: barkod, tedarikçi kodu, bizim kodumuz
    codes: [
      text(at(item, 'StandardItemIdentification'), 'ID'),
      text(at(item, 'SellersItemIdentification'), 'ID'),
      text(at(item, 'BuyersItemIdentification'), 'ID'),
    ].filter(Boolean),
    note: text(item, 'Description'),
    mismatch: null,
  };

  // Satırın kendi yazdığı mal bedeliyle bizim hesabımız tutuyor mu?
  if (lineExtension !== null && Math.abs(lineExtension - netTotal) > 0.02) {
    line.mismatch = `Faturada ${lineExtension.toFixed(2)} yazıyor, hesaplanan ${netTotal.toFixed(2)}`;
  }
  return line;
}

/**
 * KDV oranını bulur. Faturada birden fazla vergi olabilir (KDV + ÖTV);
 * KDV kodu 0015'tir. Bulamazsak ilk orana düşeriz.
 */
function readVatRate(node) {
  const subtotals = kids(at(node, 'TaxTotal'), 'TaxSubtotal');
  let fallback = null;
  for (const st of subtotals) {
    const scheme = at(st, 'TaxCategory', 'TaxScheme');
    const code = text(scheme, 'TaxTypeCode') || text(scheme, 'ID');
    const name = text(scheme, 'Name').toUpperCase();
    const percent = number(st, 'Percent');
    if (percent === null) continue;
    if (code === '0015' || name.includes('KDV') || name.includes('GERCEK USULDE KATMA')) return percent;
    if (fallback === null) fallback = percent;
  }
  return fallback ?? 0;
}

/* --------------------------- Eşleştirme ----------------------------- */

/**
 * Fatura satırlarını sistemdeki ürünlerle eşler.
 *
 * SIRA ÖNEMLİ — en güvenilirden en zayıfa:
 *   1. Öğrenilmiş eşleştirme, satıcı ürün koduyla    (kesin)
 *   2. Öğrenilmiş eşleştirme, faturadaki adla        (kesin)
 *   3. Barkod                                        (kesin)
 *   4. Ürün adı birebir                              (güçlü)
 *   5. Ad içerme, TEK aday varsa                     (zayıf — kullanıcı görür)
 *
 * Öğrenilmiş eşleştirmeler (`aliases`) önce gelir, çünkü bir insan onları
 * bir kez bakıp onaylamıştır: "bu tedarikçinin KUTU AYRAN dediği şey bizim
 * Ayran 200 ml ürünümüz". Tahmine dayalı yöntemler bunun önüne geçmemeli.
 *
 * @param aliases [{ product_id, supplier_id, source_code, source_name_norm, factor }]
 *        Tedarikçiye ait VE genel (supplier_id null) kayıtlar birlikte verilir.
 */
export function matchProducts(lines, products, aliases = []) {
  const byId = new Map(products.map((p) => [p.id, p]));
  const byCode = new Map();
  const byName = new Map();
  for (const p of products) {
    if (p.barcode) byCode.set(String(p.barcode).trim(), p);
    byName.set(normalize(p.name), p);
  }

  // Tedarikçiye özel kayıt, genel kaydı EZER: aynı ad iki yerde varsa
  // tedarikçinin kendi tanımı daha doğrudur.
  const aliasByCode = new Map();
  const aliasByName = new Map();
  const sirali = [...aliases].sort((a, b) => (a.supplier_id ? 1 : 0) - (b.supplier_id ? 1 : 0));
  for (const a of sirali) {
    if (!byId.has(a.product_id)) continue;          // silinmiş ürüne bağlı kayıt
    if (a.source_code) aliasByCode.set(String(a.source_code).trim(), a);
    if (a.source_name_norm) aliasByName.set(a.source_name_norm, a);
  }

  return lines.map((line) => {
    let product = null;
    let how = null;
    let alias = null;

    for (const code of line.codes) {
      const hit = aliasByCode.get(String(code).trim());
      if (hit) { alias = hit; product = byId.get(hit.product_id); how = 'öğrenilmiş kod'; break; }
    }
    if (!product) {
      const hit = aliasByName.get(normalize(line.name));
      if (hit) { alias = hit; product = byId.get(hit.product_id); how = 'öğrenilmiş ad'; }
    }
    if (!product) {
      for (const code of line.codes) {
        const hit = byCode.get(String(code).trim());
        if (hit) { product = hit; how = 'barkod'; break; }
      }
    }
    if (!product) {
      const hit = byName.get(normalize(line.name));
      if (hit) { product = hit; how = 'ad'; }
    }
    if (!product) {
      const needle = normalize(line.name);
      if (needle.length >= 4) {
        const partial = products.filter((p) => {
          const n = normalize(p.name);
          return n.includes(needle) || needle.includes(n);
        });
        // Tek bir aday varsa güvenle eşleriz; birden fazlaysa kullanıcı seçsin
        if (partial.length === 1) { product = partial[0]; how = 'benzer ad'; }
      }
    }

    // Çevrim çarpanı: tedarikçi koli satıyorsa 1 fatura birimi N stok birimi.
    // Miktar çarpılır, birim fiyat bölünür — tutar değişmez.
    const factor = alias && alias.factor > 0 ? Number(alias.factor) : 1;
    const cevrildi = factor !== 1;
    return {
      ...line,
      product,
      matchedBy: how,
      aliasFactor: factor,
      convertedByFactor: cevrildi,
      quantity: cevrildi ? round4(line.quantity * factor) : line.quantity,
      unitPrice: cevrildi ? round4(line.unitPrice / factor) : line.unitPrice,
      // Faturadaki hâli gösterim ve denetim için saklanır
      sourceQuantity: line.quantity,
      sourceUnitPrice: line.unitPrice,
    };
  });
}

/**
 * Tedarikçiyi VKN üzerinden, olmazsa unvandan bulur.
 *
 * VKN karşılaştırmasında rakam dışındaki her şey atılır: fatura "1234567890"
 * yazarken kart "123 456 78 90" ya da "1234567890 " tutuyor olabilir.
 * Sunucudaki mükerrer VKN kontrolü de aynı şeyi yapar; ikisi ayrışırsa
 * eşleşme "tedarikçi bulunamadı" der, kullanıcı yeni kart açmaya kalkar ve
 * bu kez "bu VKN zaten tanımlı" hatası alır — çıkışsız bir döngü.
 */
const sadeceRakam = (v) => String(v || '').replace(/\D/g, '');

export function matchSupplier(party, suppliers) {
  const taxNo = sadeceRakam(party.taxNo);
  if (taxNo) {
    const hit = suppliers.find((s) => sadeceRakam(s.tax_no) === taxNo);
    if (hit) return { supplier: hit, matchedBy: 'VKN' };
  }
  const name = normalize(party.name);
  if (name) {
    const hit = suppliers.find((s) => normalize(s.name) === name);
    if (hit) return { supplier: hit, matchedBy: 'unvan' };
  }
  return { supplier: null, matchedBy: null };
}

/* --------------------------- Birim kodları --------------------------- */
/**
 * UBL-TR birim kodunu uygulamanın birim listesine çevirir.
 *
 * Faturada birim UN/ECE Recommendation 20 koduyla gelir (`C62` = adet,
 * `KGM` = kilogram...). Eşleşmeyen bir kod için ADET'e düşeriz: yanlış bir
 * birim uydurmaktansa kullanıcının düzeltmesi daha doğrudur.
 */
const BIRIM_KODLARI = {
  C62: 'ADET', H87: 'ADET', EA: 'ADET', NIU: 'ADET', PCE: 'ADET',
  KGM: 'KG', GRM: 'KG', KG: 'KG',
  LTR: 'LT', MLT: 'LT', L: 'LT',
  PK: 'PAKET', XPK: 'PAKET', PA: 'PAKET',
  BX: 'KUTU', XBX: 'KUTU', CT: 'KUTU', CS: 'KUTU',
  PR: 'PORSIYON',
};

export function unitFromCode(code) {
  if (!code) return null;
  return BIRIM_KODLARI[String(code).trim().toUpperCase()] || null;
}
