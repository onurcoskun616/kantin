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
