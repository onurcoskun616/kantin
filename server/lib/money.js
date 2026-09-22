/**
 * Para, KDV ve karlilik hesaplari.
 *
 * Kabuller:
 *   - purchase_price : tedarikciden alis, KDV DAHIL (faturada odenen tutar)
 *   - sale_price     : ogrenciye satis, KDV DAHIL (raf etiketi)
 *   - Karlilik KDV DAHIL tutarlar uzerinden hesaplanir.
 *
 * NEDEN KDV DAHIL? (bu bir muhasebe kararidir, keyfi degil)
 *
 * Alis KDV'si beyannamede INDIRILMIYOR: odenen KDV gercekten kasadan
 * cikiyor ve geri gelmiyor. Boyle bir isletme icin KDV bir maliyettir,
 * devlete emanet bir tutar degildir. Bu yuzden stok degeri, satilan malin
 * maliyeti ve kar marji KDV dahil tutarlarla hesaplanir.
 *
 * IKI TARAF DA AYNI OLMAK ZORUNDA. Alisi KDV dahil alip satisi KDV haric
 * netlestirmek, KDV'yi iki kez aleyhe saymak olurdu: hem gelirden dusulur
 * hem maliyete eklenir. Kar bu yuzden "KDV dahil satis - KDV dahil alis"
 * olarak hesaplanir; isletmenin kasasinda kalan gercek fark budur.
 *
 * Alis KDV'sini INDIREN bir isletmeye gecilirse bu dosyadaki kabul ve
 * `netFromGross` kullanimlari birlikte degistirilmelidir.
 */

/** Kurus hassasiyetinde yuvarlama (yuzen nokta hatalarini temizler). */
export function round2(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function round4(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 10000) / 10000;
}

/** KDV dahil tutardan KDV haric net tutari cikarir. */
export function netFromGross(gross, vatRate) {
  const rate = Number(vatRate) || 0;
  return round4(Number(gross || 0) / (1 + rate / 100));
}

/** KDV haric tutara KDV ekler. */
export function grossFromNet(net, vatRate) {
  const rate = Number(vatRate) || 0;
  return round4(Number(net || 0) * (1 + rate / 100));
}

/**
 * Bir urunun birim karlilik metriklerini hesaplar.
 *
 * Iki taraf da KDV DAHIL: kar, kasada kalan gercek farktir.
 *
 * @param {number} purchasePrice KDV DAHIL alis
 * @param {number} salePrice     KDV DAHIL satis
 * @param {number} vatRate       Satis KDV orani (%) -- yalnizca bilgi amacli
 *                               KDV tutarini gostermek icin kullanilir
 */
export function productProfit(purchasePrice, salePrice, vatRate) {
  const purchaseGross = round4(Number(purchasePrice) || 0);
  const saleGross = round4(Number(salePrice) || 0);
  // Satisin icindeki KDV: karin parcasidir (indirilmedigi icin), ama
  // "raf fiyatinin ne kadari KDV" sorusu icin ayrica gosterilir.
  const saleNet = netFromGross(saleGross, vatRate);
  const vatAmount = round4(saleGross - saleNet);
  const unitProfit = round4(saleGross - purchaseGross);

  // Kar marji: karin SATIS FIYATINA orani (raf fiyatindan ne kadari kar)
  const marginPct = saleGross > 0 ? round2((unitProfit / saleGross) * 100) : 0;
  // Karlilik/markup: karin maliyete orani (maliyetin uzerine ne kadar koyuldu)
  const markupPct = purchaseGross > 0 ? round2((unitProfit / purchaseGross) * 100) : 0;

  return {
    // Eski ad korunuyor (cagiranlar cok); artik KDV DAHIL alisi tasiyor.
    purchaseNet: round2(purchaseGross),
    purchaseGross: round2(purchaseGross),
    saleGross: round2(saleGross),
    saleNet: round2(saleNet),
    vatAmount: round2(vatAmount),
    unitProfit: round2(unitProfit),
    marginPct,
    markupPct,
  };
}

/** Bir alim satirinin net/KDV/brut tutarlarini hesaplar. */
export function purchaseLineTotals({ quantity, unitPrice, vatRate, discountPct = 0 }) {
  const qty = Number(quantity) || 0;
  const price = Number(unitPrice) || 0;
  const disc = Number(discountPct) || 0;
  const netTotal = round2(qty * price * (1 - disc / 100));
  const vatTotal = round2(netTotal * ((Number(vatRate) || 0) / 100));
  return { netTotal, vatTotal, grossTotal: round2(netTotal + vatTotal) };
}

/** Yuzde degisim; payda 0 ise null doner. */
export function pctOf(part, whole) {
  const w = Number(whole) || 0;
  if (w === 0) return null;
  return round2((Number(part) / w) * 100);
}

/* ------------------------- Tutarin yaziyla yazimi ------------------- */
const BIRLER = ['', 'Bir', 'İki', 'Üç', 'Dört', 'Beş', 'Altı', 'Yedi', 'Sekiz', 'Dokuz'];
const ONLAR = ['', 'On', 'Yirmi', 'Otuz', 'Kırk', 'Elli', 'Altmış', 'Yetmiş', 'Seksen', 'Doksan'];
const BASAMAK = ['', 'Bin', 'Milyon', 'Milyar'];

function ucBasamak(n) {
  const yuz = Math.floor(n / 100);
  const on = Math.floor((n % 100) / 10);
  const bir = n % 10;
  let out = '';
  if (yuz > 0) out += (yuz === 1 ? 'Yüz' : `${BIRLER[yuz]}Yüz`);
  if (on > 0) out += ONLAR[on];
  if (bir > 0) out += BIRLER[bir];
  return out;
}

/**
 * Tutari Turkce yaziyla dondurur: 1234.56 -> "BinİkiYüzOtuzDörtTLElliAltıKr"
 *
 * Mali belgelerde tutarin yaziyla da yazilmasi, rakamin sonradan
 * degistirilmesini zorlastirir. Teslim fisinde bu yuzden kullanilir.
 */
export function amountInWords(amount) {
  const value = Math.abs(Math.round((Number(amount) || 0) * 100));
  const lira = Math.floor(value / 100);
  const kurus = value % 100;

  let out = '';
  if (lira === 0) {
    out = 'Sıfır';
  } else {
    const gruplar = [];
    let kalan = lira;
    while (kalan > 0) {
      gruplar.push(kalan % 1000);
      kalan = Math.floor(kalan / 1000);
    }
    for (let i = gruplar.length - 1; i >= 0; i -= 1) {
      const grup = gruplar[i];
      if (grup === 0) continue;
      // "BirBin" degil "Bin" denir
      if (i === 1 && grup === 1) out += 'Bin';
      else out += ucBasamak(grup) + BASAMAK[i];
    }
  }

  out += ' TL';
  if (kurus > 0) out += ` ${ucBasamak(kurus)} Kr`;
  return out;
}
