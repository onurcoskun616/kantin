/**
 * Para, KDV ve karlilik hesaplari.
 *
 * Kabuller:
 *   - purchase_price : tedarikciden alis, KDV HARIC (fatura satir tutari)
 *   - sale_price     : ogrenciye satis, KDV DAHIL (raf etiketi)
 *   - Karlilik her zaman KDV HARIC netler uzerinden hesaplanir; aksi halde
 *     KDV devlet parasi oldugu icin kar yapay olarak yuksek cikar.
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
 * @param {number} purchasePrice KDV haric alis
 * @param {number} salePrice     KDV dahil satis
 * @param {number} vatRate       Satis KDV orani (%)
 */
export function productProfit(purchasePrice, salePrice, vatRate) {
  const purchaseNet = round4(Number(purchasePrice) || 0);
  const saleGross = round4(Number(salePrice) || 0);
  const saleNet = netFromGross(saleGross, vatRate);
  const vatAmount = round4(saleGross - saleNet);
  const unitProfit = round4(saleNet - purchaseNet);

  // Kar marji: karin satis netine orani (satistan ne kadari kar kaliyor)
  const marginPct = saleNet > 0 ? round2((unitProfit / saleNet) * 100) : 0;
  // Karlilik/markup: karin maliyete orani (maliyetin uzerine ne kadar koyuldu)
  const markupPct = purchaseNet > 0 ? round2((unitProfit / purchaseNet) * 100) : 0;

  return {
    purchaseNet: round2(purchaseNet),
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
