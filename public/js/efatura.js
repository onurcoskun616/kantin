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
// Koli fiyati stok birimine BOLUNURKEN dort hane yetmez: 290,909 / 24 =
// 12,12120833... dort haneye kirpilinca 720 adette bir kurus kayboluyor ve
// belge toplami faturanin odenecek tutarini tutmuyordu. Faturalarin kendisi
// de birim fiyati uc-alti haneyle yaziyor.
const round6 = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

/* ------------------------------ Okuma ------------------------------- */
/**
 * XML dosyasini DOGRU KODLAMAYLA metne cevirir.
 *
 * `file.text()` dosyayi her zaman UTF-8 sayar. Turkiye'de kullanilan
 * ticari programlarin (LOGO vb.) urettigi dosyalar ise cogu zaman
 * iso-8859-9 (Turkce Latin-5) kodludur: UTF-8 diye okunursa "LİEVİTO"
 * yerine bozuk karakterler gelir, urun adlari eslesmez ve tedarikci
 * unvani okunamaz. Bu yuzden once XML bildirimindeki encoding'e bakariz.
 */
export async function xmlMetniOku(file) {
  const buf = await file.arrayBuffer();
  // Bildirim ASCII'dir; ilk 200 bayti latin1 okumak her kodlamada guvenli
  const bas = new TextDecoder('latin1').decode(buf.slice(0, 200));
  const bildirilen = (bas.match(/encoding\s*=\s*["']([\w-]+)["']/i)?.[1] || 'utf-8').toLowerCase();
  const kodlama = { 'iso-8859-9': 'iso-8859-9', 'windows-1254': 'windows-1254', 'iso-8859-1': 'iso-8859-1' }[bildirilen]
    || 'utf-8';
  try {
    return new TextDecoder(kodlama).decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf);
  }
}

/* ------------------------------ Çözümleme --------------------------- */
/**
 * Dosya XML degilse ne oldugunu soyler; XML'e benziyorsa null doner.
 *
 * Sahada en sik yapilan hata dosyanin YANLIS KOPYASINI indirmek: entegratör
 * ekraninda "indir" bazen zip, bazen goruntuleme kopyasi (HTML/PDF) verir.
 * "Gecersiz XML" demek kullaniciyi cikmaza sokuyordu; ne indirdigini
 * soylersek dogrusunu bulabiliyor.
 */
function dosyaTuru(metin) {
  const bas = metin.slice(0, 400).trimStart();
  if (bas.startsWith('PK')) {
    return 'Bu dosya bir ZIP arşivi. İçindeki XML dosyasını çıkarıp (sağ tık → '
      + 'Tümünü ayıkla) öyle yükleyin.';
  }
  if (bas.startsWith('%PDF')) {
    return 'Bu dosya faturanın PDF kopyası. Satırların okunabilmesi için '
      + 'entegratörden faturanın XML dosyasını indirin.';
  }
  if (/^<!doctype\s+html/i.test(bas) || /^<html[\s>]/i.test(bas)) {
    return 'Bu dosya faturanın görüntüleme (HTML) kopyası. Satırların okunabilmesi '
      + 'için entegratörden faturanın XML dosyasını indirin.';
  }
  if (!bas.startsWith('<')) {
    // Or. dosya aktarim programlarinin urettigi "dosya adi listesi" metni
    const ilk = metin.trim().split(/\r?\n/)[0]?.slice(0, 120) || '';
    return 'Bu dosya XML değil; içeriği düz metin görünüyor'
      + (ilk ? ` ("${ilk}")` : '')
      + '. e-Fatura XML dosyasının kendisini seçin.';
  }
  return null;
}

/**
 * Belgenin icinden faturayi cikarir.
 *
 * Fatura her zaman kokte durmaz: bazi entegratorler zarfin icine koyar,
 * bazilari CDATA blogu olarak gomer, e-Fatura zarflarinda ise ek olarak
 * base64 kodlanmis halde tasinir (EmbeddedDocumentBinaryObject).
 */
function faturayiBul(doc, hamMetin) {
  const kokte = doc.documentElement;
  if (kokte?.localName === 'Invoice') return kokte;

  const icinde = [...doc.getElementsByTagName('*')].find((n) => n.localName === 'Invoice');
  if (icinde) return icinde;

  // CDATA / metin icine gomulmus UBL
  const govde = doc.documentElement?.textContent || '';
  for (const kaynak of [govde, hamMetin]) {
    const bas = kaynak.search(/<(\w+:)?Invoice[\s>]/);
    if (bas < 0) continue;
    const ic = new DOMParser().parseFromString(kaynak.slice(bas), 'application/xml');
    if (ic.querySelector('parsererror')) continue;
    if (ic.documentElement?.localName === 'Invoice') return ic.documentElement;
  }

  // Zarfa base64 olarak eklenmis fatura
  for (const n of doc.getElementsByTagName('*')) {
    const t = (n.textContent || '').trim();
    if (t.length < 200 || !/^[A-Za-z0-9+/\s]+={0,2}$/.test(t)) continue;
    let cozulmus = '';
    try { cozulmus = atob(t.replace(/\s+/g, '')); } catch { continue; }
    if (!/<(\w+:)?Invoice[\s>]/.test(cozulmus.slice(0, 2000))) continue;
    const ic = new DOMParser().parseFromString(cozulmus, 'application/xml');
    if (!ic.querySelector('parsererror') && ic.documentElement?.localName === 'Invoice') {
      return ic.documentElement;
    }
  }
  return null;
}

/**
 * XML metnini okunabilir bir fatura nesnesine çevirir.
 * Hata durumunda açıklayıcı bir Error fırlatır.
 */
export function parseEFatura(xmlText) {
  const clean = String(xmlText).replace(/^\ufeff/, '');

  // XML'e hic benzemeyen dosyayi once ayikla: kullaniciya "gecersiz XML"
  // demek yerine ELINDEKININ NE OLDUGUNU soyleriz. Entegratorler faturayi
  // sik sik zip icinde ya da goruntuleme kopyasi (HTML/PDF) olarak verir.
  const tur = dosyaTuru(clean);
  if (tur) throw new Error(tur);

  const doc = new DOMParser().parseFromString(clean, 'application/xml');
  if (doc.querySelector('parsererror')) {
    throw new Error('Dosya geçerli bir XML değil. e-Fatura/e-Arşiv XML dosyasını seçtiğinizden emin olun.');
  }

  // LOGO/Tiger gibi ticari programlar faturayi UBL yerine KENDI transfer
  // bicimlerinde verir (<PURCHASE_INVOICES><INVOICE DBOP="INS">). Icinde
  // ayni bilgiler vardir; okumamak icin bir sebep yok.
  if (logoFaturaMi(doc)) return tamamla(logodanOku(doc));

  const inv = faturayiBul(doc, clean);
  if (!inv) {
    // Kok etiketi SOYLE: "fatura degil" demek yetmiyor, kullanici elindeki
    // dosyanin ne oldugunu bilmeden dogrusunu indiremiyor.
    const kok = doc.documentElement?.localName || '?';
    const bilinen = {
      DespatchAdvice: 'Bu bir e-İrsaliye (sevk irsaliyesi). Mal girişi için faturanın kendisi gerekiyor.',
      ApplicationResponse: 'Bu bir uygulama yanıtı (kabul/ret bildirimi); fatura değil.',
      ReceiptAdvice: 'Bu bir irsaliye yanıtı; fatura değil.',
      CreditNote: 'Bu bir iade faturası (CreditNote). İade için "Tedarikçiye İade" ekranını kullanın.',
      EArsivRapor: 'Bu bir e-Arşiv raporu; tek bir fatura değil.',
    }[kok];
    throw new Error(
      `Bu XML bir fatura (Invoice) belgesi değil — dosyanın kök etiketi "${kok}". `
      + (bilinen ? `${bilinen} ` : '')
      + 'Entegratör ekranından faturanın UBL/XML dosyasını indirip yükleyin.'
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
      // KDV MATRAHI: iskontolarin dusulmus hali. Belge iskontosunun
      // satirlara ISLENMIS olup olmadigini anlamanin en guvenilir yolu
      // budur (bkz. tamamla).
      taxExclusive: number(at(inv, 'LegalMonetaryTotal'), 'TaxExclusiveAmount'),
    },
    warnings: [],
  };
  return tamamla(invoice);
}

/**
 * Okunan faturayi tamamlar: toplam kontrolleri, belge iskontosunun
 * satirlara dagitilmasi ve uyarilar. UBL de LOGO da buradan gecer.
 */
function tamamla(invoice) {
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

  // Faturanin yazdigi mal bedeli (LineExtensionAmount) satirlarin
  // ISKONTOSUZ toplami da olabilir: bazi entegratorler iskontoyu ayri
  // AllowanceCharge olarak verip satira liste bedelini yaziyor. Ikisini
  // de dogru sayariz, yoksa kusursuz bir faturada bos yere uyari cikar.
  const listeToplami = round2(invoice.lines.reduce((s, l) => s + (l.listTotal ?? l.netTotal), 0));
  if (invoice.declared.lineTotal !== null
      && Math.abs(invoice.declared.lineTotal - computedNet) > 0.05
      && Math.abs(invoice.declared.lineTotal - listeToplami) > 0.05) {
    invoice.warnings.push(
      `Satır toplamı (${computedNet.toFixed(2)}) faturanın yazdığı mal bedeliyle `
      + `(${invoice.declared.lineTotal.toFixed(2)}) uyuşmuyor. Satırları kontrol edin.`
    );
  }

  // BELGE GENELI ISKONTO SATIRLARA ISLENMIS MI?
  //
  // UBL'de LegalMonetaryTotal/AllowanceTotalAmount bazen belge duzeyinde
  // AYRICA dusulecek bir iskontodur, bazen de satirlardaki iskontolarin
  // TOPLAMIDIR. Ikisi ayirt edilmezse ayni iskonto iki kez dusulur.
  //
  // Sahadan ornek (SZE2026000044998): her satirda %5,66 ve %10 iskonto
  // vardi, toplamlari 1.062,00 TL; fatura bunu AllowanceTotalAmount'a da
  // yazmisti. Ikinci kez dagitilinca satirlardaki iskonto %15,09 yerine
  // %30,19 goruntu, belge toplami 5.973,88 yerine 4.911,88 cikti ve
  // "KDV farkli" diye ayrica uyari verdi. Stok maliyeti %18 eksik
  // kaydedilecekti.
  //
  // HAKEM: faturanin kendi yazdigi KDV matrahi (TaxExclusiveAmount).
  // Satirlarin neti zaten matrahi tutuyorsa dusulecek bir sey kalmamis
  // demektir.
  const matrah = invoice.declared.taxExclusive;
  const zatenIslenmis = matrah !== null && Math.abs(computedNet - matrah) <= 0.05;

  if (invoice.declared.allowanceTotal > 0 && computedNet > 0 && !zatenIslenmis) {
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

  // Son soz faturanin KDV matrahinindir: tum iskontolar islendikten sonra
  // hala tutmuyorsa GERCEK bir sapma vardir ve kullanici gormelidir.
  if (matrah !== null && Math.abs(netSonrasi - matrah) > 0.05) {
    invoice.warnings.push(
      `Hesaplanan mal bedeli (${netSonrasi.toFixed(2)}) faturanın KDV matrahından `
      + `(${matrah.toFixed(2)}) farklı. Satır tutarlarını kontrol edin.`
    );
  }

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

/* --------------------- LOGO / Tiger transfer XML -------------------- */
/**
 * LOGO ailesi programlar (Tiger, Go, j-Guar) faturayi UBL yerine kendi
 * transfer bicimlerinde disari verir:
 *
 *   <PURCHASE_INVOICES><INVOICE DBOP="INS"> ... <TRANSACTIONS>
 *
 * Icinde bizim istedigimiz her sey var: satici unvani ve VKN/TCKN, belge
 * numarasi, ETTN (GUID), satirlar, miktar, fiyat, KDV. Kullanici bu
 * dosyayi tedarikcisinden boyle aliyor; "UBL degil" deyip geri cevirmek
 * faturayi elle girmek demek. Okumamak icin bir sebep yok.
 *
 * Dikkat: LOGO dosyalari genelde iso-8859-9 (Turkce Latin-5) kodludur;
 * metin cozumlemesi XML bildirimine bakar (bkz. pages/purchases.js).
 */
const LOGO_KOKLERI = new Set(['PURCHASE_INVOICES', 'SALES_INVOICES', 'INVOICES']);

function logoFaturaMi(doc) {
  const kok = doc.documentElement;
  if (!kok) return false;
  if (LOGO_KOKLERI.has(kok.localName)) return Boolean(kok.getElementsByTagName('TRANSACTIONS').length);
  return kok.localName === 'INVOICE' && Boolean(kok.getElementsByTagName('TRANSACTIONS').length);
}

/** "13.09.2026" -> "2026-09-13". Zaten ISO ise oldugu gibi birakir. */
function logoTarih(t) {
  const s = String(t || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})$/);
  if (!m) return '';
  return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}

/**
 * LOGO satir tipleri. Malzeme disindaki satirlar urun degildir:
 *   0 Malzeme · 1 Promosyon · 2 Indirim · 3 Masraf · 4 Hizmet
 * Indirim ve masraf belge duzeyinde toplanir (UBL'deki AllowanceTotal /
 * ChargeTotal karsiligi). Taninmayan bir tip gelirse satir olarak
 * GOSTERILIR: sessizce dusurmek, belge toplaminin faturayi tutmamasina ve
 * sebebinin anlasilmamasina yol acar.
 */
function logodanOku(doc) {
  const kok = doc.documentElement;
  const inv = kok.localName === 'INVOICE' ? kok : kok.getElementsByTagName('INVOICE')[0];
  if (!inv) throw new Error('LOGO transfer dosyasında <INVOICE> bölümü bulunamadı.');

  const alan = (ad) => {
    // Ayni ad birden fazla kez gecebiliyor (or. ADD_DISCOUNTS): ilk DOLU olani
    for (const n of inv.children) {
      if (n.localName === ad && n.textContent.trim()) return n.textContent.trim();
    }
    return '';
  };
  const sayi = (ad) => {
    const t = alan(ad);
    if (!t) return null;
    const v = Number(t.replace(/\s/g, ''));
    return Number.isFinite(v) ? v : null;
  };

  // LOGO'da INDIRIM/MASRAF satirlari AYRI birer TRANSACTION'dir ve ait
  // olduklari kalemin HEMEN ARDINDAN gelirler. Sahadaki fatura: her
  // kalemin pesinden iki indirim satiri (%54,03 ve %48,70) geliyordu.
  // Bunlar belge geneli iskonto sanilirsa satirlar iskontosuz kaliyor ve
  // belge toplami 190.277 TL cikiyordu — faturanin kendisi 74.878 TL.
  // Stok maliyeti iki bucuk katina cikardi.
  //
  // Bu yuzden indirim/masraf ONCEKI SATIRA yazilir. Hicbir kalemden once
  // gelen bir indirim varsa (belge geneli indirim) belge duzeyinde kalir.
  const lines = [];
  let iskonto = 0;
  let masraf = 0;
  let satirIskontosuVar = false;

  for (const t of inv.getElementsByTagName('TRANSACTION')) {
    const tip = text(t, 'TYPE');
    const tutar = Math.abs(number(t, 'TOTAL') ?? 0);
    const sonSatir = lines[lines.length - 1];

    if (tip === '2' || tip === '3') {
      if (!sonSatir) { if (tip === '2') iskonto += tutar; else masraf += tutar; continue; }
      if (tip === '2') { sonSatir.__iskonto += tutar; satirIskontosuVar = true; } else sonSatir.__masraf += tutar;
      continue;
    }

    const miktar = number(t, 'QUANTITY') ?? 0;
    const fiyat = number(t, 'PRICE') ?? 0;
    const brut = number(t, 'TOTAL') ?? round2(miktar * fiyat);
    const ad = text(t, 'MASTER_DEF') || text(t, 'MASTER_CODE');
    // Kodlarin tamami eslestirmede kullanilir. Satici kendi kodunu
    // MASTER_CODE_SELLERS'a, barkodu ise cogu zaman MASTER_CODE_BUYERS /
    // PROCEDUCER_CODE alanina yazar.
    const kodlar = ['MASTER_CODE_SELLERS', 'ITEM_SUPPLIERCODE', 'PROCEDUCER_CODE',
      'MASTER_CODE_BUYERS', 'ITEM_CUSTOMERCODE']
      .map((k) => text(t, k)).filter(Boolean);
    const kendiKodu = text(t, 'MASTER_CODE');
    if (kendiKodu && kendiKodu !== ad) kodlar.push(kendiKodu);
    const barkod = kodlar.find((c) => /^\d{8}$|^\d{12,14}$/.test(c)) || null;

    lines.push({
      lineNo: text(t, 'InvoiceLineID'),
      name: ad,
      quantity: round4(miktar),
      unitCode: text(t, 'UNIT_CODE') || text(t, 'GLOBAL_CODE'),
      unitPrice: round4(fiyat),
      discountPct: 0,
      vatRate: number(t, 'VAT_RATE') ?? 0,
      netTotal: round2(brut),
      vatTotal: 0,
      grossTotal: 0,
      codes: [...new Set(kodlar)],
      barcode: barkod,
      supplierCode: kodlar[0] || null,
      note: text(t, 'DESCRIPTION'),
      mismatch: null,
      // Gecici alanlar: asagida satir kapatilirken kullanilir
      __brut: round2(brut),
      __iskonto: 0,
      __masraf: 0,
      __matrah: number(t, 'VAT_BASE'),
      __kdvTutar: number(t, 'VAT_AMOUNT'),
    });
  }

  for (const l of lines) {
    const hesaplanan = round2(l.__brut - l.__iskonto + l.__masraf);
    // VAT_BASE faturanin KENDI beyan ettigi matrahtir; indirimler dusulmus
    // halidir. Hesabimizla tutuyorsa onu kullaniriz: belge toplami o zaman
    // faturayi KURUSU KURUSUNA tutar.
    const net = l.__matrah !== null && Math.abs(l.__matrah - hesaplanan) <= Math.max(0.05, hesaplanan * 0.002)
      ? round2(l.__matrah)
      : hesaplanan;
    l.netTotal = net;
    l.discountPct = l.__brut > 0 && net < l.__brut ? round4((1 - net / l.__brut) * 100) : 0;
    // KDV'de de faturanin kendi rakamini tercih ederiz; ancak bizim
    // hesabimizla tutuyorsa. Tutmuyorsa satirda KDV disi bir vergi
    // (OTV vb.) olabilir, o zaman kendi hesabimiz daha dogrudur.
    const kdvHesap = round2((net * l.vatRate) / 100);
    l.vatTotal = l.__kdvTutar !== null && Math.abs(l.__kdvTutar - kdvHesap) <= Math.max(0.02, kdvHesap * 0.002)
      ? round2(l.__kdvTutar)
      : kdvHesap;
    l.grossTotal = round2(net + l.vatTotal);
    delete l.__brut; delete l.__iskonto; delete l.__masraf; delete l.__matrah; delete l.__kdvTutar;
  }

  // Beyan edilen mal bedeli: KDV dokumundeki matrahlarin toplami en
  // guvenilir kaynaktir. Yoksa odenecek tutardan KDV dusulur.
  let matrah = null;
  const dokum = [...inv.getElementsByTagName('TaxableAmount')]
    .map((n) => Number(n.textContent.trim()))
    .filter((v) => Number.isFinite(v));
  if (dokum.length) matrah = round2(dokum.reduce((a, b) => a + b, 0));

  const kdv = sayi('TOTAL_VAT');
  // TOTAL_NET LOGO'da KDV DAHIL genel toplamdir (TC_NET ile aynidir)
  const odenecek = sayi('TC_NET') ?? sayi('TOTAL_NET');
  if (matrah === null && odenecek !== null && kdv !== null) matrah = round2(odenecek - kdv);

  const paraBirimi = (alan('TRCURR_GLOBAL_CODE') || 'TRY').toUpperCase();

  return {
    uuid: alan('GUID'),
    documentNo: alan('NUMBER') || alan('DOC_NUMBER'),
    issueDate: logoTarih(alan('DATE') || alan('DOC_DATE')),
    dueDate: logoTarih(alan('DUE_DATE') || alan('PAYMENT_DATE')),
    // LOGO "TRL" yazar; uygulamanin her yerinde TRY kullaniliyor
    currency: paraBirimi === 'TRL' ? 'TRY' : paraBirimi,
    profile: alan('ProfileID'),
    invoiceType: alan('EINVOICE_TYPE'),
    supplier: {
      taxNo: alan('SENDER_TCKVKN') || alan('SND_TAXNR'),
      name: alan('SENDER_DEF'),
      taxOffice: alan('SND_TAXOFFICE'),
    },
    lines,
    declared: {
      lineTotal: matrah,
      taxTotal: kdv,
      payable: odenecek,
      // ADD_DISCOUNTS cogu dosyada SATIR iskontolarinin toplamidir; satirlara
      // zaten islendiyse belge duzeyinde ikinci kez dusulmemeli.
      allowanceTotal: satirIskontosuVar ? round2(iskonto) : round2((sayi('ADD_DISCOUNTS') ?? 0) + iskonto),
      chargeTotal: round2(masraf),
    },
    kaynak: 'LOGO',
    warnings: [],
  };
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
    // Iskonto ONCESI tutar. Bazi tedarikciler satirin
    // LineExtensionAmount alanina iskontolu, bazilari iskontosuz tutari
    // yaziyor; hangisi oldugunu anlamak icin ikisini de elde tutariz.
    listTotal: gross,
    discountPct,
    vatRate,
    netTotal,
    vatTotal,
    grossTotal: round2(netTotal + vatTotal),
    // Ürün eşlemesi için kullanılabilecek TÜM kodlar, UBL öncelik sırasıyla.
    // ManufacturersItemIdentification uzun süre okunmuyordu; Türkiye'deki
    // e-faturaların çoğunda GERÇEK BARKOD (GTIN) orada duruyor.
    codes: itemCodes(item),
    // Ürün kartının barkod alanına yalnızca BARKOD GÖRÜNÜMLÜ bir kod yazılır.
    barcode: gtinOf(item),
    // Tedarikçinin kendi stok kodu: eşleştirme bundan öğrenilir. Barkod
    // değildir, ürün kartına yazılmaz.
    supplierCode: text(at(item, 'SellersItemIdentification'), 'ID')
      || text(at(item, 'BuyersItemIdentification'), 'ID') || null,
    note: text(item, 'Description'),
    mismatch: null,
  };

  // Satırın kendi yazdığı mal bedeliyle bizim hesabımız tutuyor mu?
  //
  // İKİ YAZIM DA GEÇERLİ sayılır: UBL'de satırın LineExtensionAmount'ı
  // iskonto SONRASI olmalıdır, ama Türkiye'deki entegratörlerin bir kısmı
  // oraya iskonto ÖNCESİ tutarı yazıp iskontoyu ayrı AllowanceCharge
  // olarak veriyor. İkisini de doğru kabul etmezsek, kusursuz bir fatura
  // "satır tutarı uyuşmuyor" diye yedi satır uyarı üretiyordu.
  if (lineExtension !== null
      && Math.abs(lineExtension - netTotal) > 0.02
      && Math.abs(lineExtension - gross) > 0.02) {
    line.mismatch = `Faturada ${lineExtension.toFixed(2)} yazıyor, hesaplanan ${netTotal.toFixed(2)}`;
  }
  return line;
}

/**
 * Satırdaki bütün ürün kodları, UBL'nin anlam sırasıyla.
 *
 * Standard  : GTIN (UBL tanımı gereği barkod)
 * Manufacturers : üreticinin kodu — TR faturalarında çoğunlukla GTIN
 * Sellers   : tedarikçinin kendi stok kodu (or. "130302")
 * Buyers    : bizim kodumuz
 */
function itemCodes(item) {
  return [
    text(at(item, 'StandardItemIdentification'), 'ID'),
    text(at(item, 'ManufacturersItemIdentification'), 'ID'),
    text(at(item, 'SellersItemIdentification'), 'ID'),
    text(at(item, 'BuyersItemIdentification'), 'ID'),
  ].filter(Boolean);
}

/**
 * Ürün kartına yazılabilecek GERÇEK barkod.
 *
 * Tedarikçinin iç stok kodunu ("130302") barkod alanına yazmak iki şeyi
 * bozar: (1) raftaki ürün okutulduğunda eşleşmez, (2) barkod alanı TEKİLDİR
 * ve başka bir tedarikçi aynı kısa kodu kullandığında ikinci ürün hiç
 * açılamaz. Bu yüzden yalnızca GTIN görünümlü (8/12/13/14 hane, tamamı
 * rakam) bir kod barkod sayılır; yoksa alan BOŞ bırakılır.
 */
function gtinOf(item) {
  return itemCodes(item).find((c) => /^\d{8}$|^\d{12,14}$/.test(c.trim())) || null;
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
    // Faturanin birimi ile urun kartinin birimi ayni mi?
    //
    // Toptancilar faturayi KOLI/PAKET (PK) uzerinden keser: "30 PK ×
    // 454,57". Urun karti ADET tutuyorsa ve cevrim carpani 1 ise stoga
    // 30 ADET girer — oysa gerceginde 30 koli, yani belki 720 adet
    // girmistir. Sayimda kocaman bir fark cikar ve nereden geldigi
    // anlasilmaz. Bu yuzden uyusmazligi ISARETLERIZ; carpan verilmisse
    // (cevrildi) is zaten cozulmustur, uyarmayiz.
    const faturaBirimi = unitFromCode(line.unitCode);
    const kartBirimi = product && product.unit ? String(product.unit).toUpperCase() : null;
    return {
      ...line,
      product,
      matchedBy: how,
      aliasFactor: factor,
      convertedByFactor: cevrildi,
      sourceUnit: faturaBirimi,
      unitMismatch: Boolean(product && !cevrildi && faturaBirimi && kartBirimi
        && faturaBirimi !== kartBirimi),
      productUnit: kartBirimi,
      quantity: cevrildi ? round4(line.quantity * factor) : line.quantity,
      unitPrice: cevrildi ? round6(line.unitPrice / factor) : line.unitPrice,
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
  // NPL/NMP: "kac paket/koli" anlamindadir. ERBAK-Uludag gibi toptancilar
  // LOGO dosyalarinda koli miktarini bu kodla yazar; ADET sayilirsa stoga
  // 30 adet girer, oysa 30 koli gelmistir.
  NPL: 'PAKET', NMP: 'PAKET', PK2: 'PAKET',
  BX: 'KUTU', XBX: 'KUTU', CT: 'KUTU', CS: 'KUTU',
  PR: 'PORSIYON',
};

export function unitFromCode(code) {
  if (!code) return null;
  return BIRIM_KODLARI[String(code).trim().toUpperCase()] || null;
}
