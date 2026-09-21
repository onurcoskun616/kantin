/**
 * Stok defteri (ledger) yardimcilari.
 *
 * Mevcut stok hicbir yerde "guncel miktar" olarak tutulmaz; her zaman
 * stock_movements tablosundaki isaretli hareketlerin toplamidir. Boylece
 * her rakamin arkasinda izlenebilir bir belge bulunur.
 */
import { all, get, insert } from '../db.js';

export function addMovement({
  campusId, productId, type, quantity, unitCost = 0, date,
  refType = null, refId = null, note = null, userId = null,
}) {
  return insert(
    `INSERT INTO stock_movements
       (campus_id, product_id, movement_type, quantity, unit_cost, movement_date, ref_type, ref_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [campusId, productId, type, quantity, unitCost, date, refType, refId, note, userId]
  );
}

/** Bir kampus-urun ikilisinin (opsiyonel tarihe kadar) stok miktari. */
export function stockOf(campusId, productId, untilDate = null) {
  const params = [campusId, productId];
  let sql = 'SELECT COALESCE(SUM(quantity), 0) AS qty FROM stock_movements WHERE campus_id = ? AND product_id = ?';
  if (untilDate) { sql += ' AND movement_date <= ?'; params.push(untilDate); }
  return get(sql, params)?.qty ?? 0;
}

/**
 * Kampustaki tum urunlerin stok durumu + fiyat/kar bilgisi.
 * campus_products tablosundaki kampus ozel fiyatlari onceliklidir.
 */
/**
 * Kampustaki urunlerin stok durumu.
 *
 * URETILEN urunler (tost, cay, pogaca) varsayilan olarak haric tutulur:
 * bunlar raftan sayilamadigi icin defter miktarlari anlamsizdir. Donem
 * satislari sayim ekranindaki "uretim satisi" bolumunden girilir.
 *
 * HAMMADDE urunleri (ekmek, kasar) dahildir: raftan/dolaptan sayilirlar.
 * Tuketimleri recete uzerinden hesaplanip sayim farkindan dusulur.
 */
/**
 * Kampuse en son MAL GIRISI yapilan fiyati veren alt sorgu.
 *
 * Alis fiyati artik urun kartinda ELLE tutulmaz; kampusun kendi giris
 * hareketlerinden gelir (4. ve 7. madde). Ayni urun Esenyurt'a baska,
 * Corlu'ya baska fiyata gelebilir ve stok degeri buna gore olusmalidir.
 *
 * Yalnizca gercek GIRIS hareketleri sayilir:
 *   ALIS   - fatura/irsaliye ile mal girisi
 *   ACILIS - acilis stogu girisi (elle yapilan ilk tanim)
 * Fire, satis, sayim farki ve transfer bir fiyat BEYANI degildir; onlar
 * mevcut maliyeti tasir, belirlemez. Iptal edilen belgenin hareketi
 * silindigi icin buraya hic dusmez.
 *
 * `dateFilter` verilirse (gecmise donuk stok degeri) o tarihten sonraki
 * girisler sayilmaz: 3 ay onceki stok, 3 ay onceki maliyetle degerlenir.
 */
export function lastPurchaseSql(dateFilter = '') {
  return `
  SELECT m.product_id, m.unit_cost, m.movement_date
    FROM stock_movements m
    JOIN (
      SELECT product_id, MAX(movement_date || '-' || printf('%012d', id)) AS en_son
        FROM stock_movements
       WHERE campus_id = ? AND movement_type IN ('ALIS','ACILIS') AND unit_cost > 0
             ${dateFilter}
       GROUP BY product_id
    ) x ON x.product_id = m.product_id
       AND x.en_son = m.movement_date || '-' || printf('%012d', m.id)`;
}

/**
 * Belirli bir TARIHTE gecerli satis fiyatini veren alt sorgu (9. madde).
 *
 * Once o kampuse ozel fiyat listesine, yoksa katalog listesine bakilir;
 * ikisinde de kayit yoksa eski sutunlara (campus_products.sale_price /
 * products.sale_price) duseriz. Boylece fiyat listesi hic kullanilmayan
 * bir kurulumda davranis degismez.
 *
 * `?` sirasi: campusId, tarih, tarih  (kullanan sorgu bu sirayi baglamali)
 */
export function salePriceSql() {
  return `
  COALESCE(
    (SELECT pp.sale_price FROM product_prices pp
      WHERE pp.product_id = p.id AND pp.campus_id = ? AND pp.effective_from <= ?
      ORDER BY pp.effective_from DESC, pp.id DESC LIMIT 1),
    (SELECT pp.sale_price FROM product_prices pp
      WHERE pp.product_id = p.id AND pp.campus_id IS NULL AND pp.effective_from <= ?
      ORDER BY pp.effective_from DESC, pp.id DESC LIMIT 1),
    cp.sale_price,
    p.sale_price
  )`;
}

/** Bugunun tarihi (yerel), ISO. */
export function bugun() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export function stockSnapshot(campusId, {
  untilDate = null, onlyActive = true, search = null, categoryId = null, includeProduced = false,
} = {}) {
  const params = [campusId];
  let movFilter = '';
  if (untilDate) { movFilter = 'AND m.movement_date <= ?'; params.push(untilDate); }
  // Gecmise donuk bakilirken o gunun fiyati gecerlidir
  const fiyatTarihi = untilDate || bugun();

  const where = ['1 = 1'];
  const tail = [];
  if (onlyActive) where.push('p.is_active = 1');
  if (!includeProduced) where.push("p.product_type IN ('SATIN_ALINAN','HAMMADDE')");
  if (search) { where.push('(p.name LIKE ? OR p.barcode LIKE ?)'); tail.push(`%${search}%`, `%${search}%`); }
  if (categoryId) { where.push('p.category_id = ?'); tail.push(Number(categoryId)); }

  return all(
    `SELECT
        p.id                                      AS product_id,
        p.barcode,
        p.name,
        p.unit,
        p.vat_rate,
        p.max_price,
        p.meb_approved,
        p.product_type,
        c.name                                    AS category_name,
        -- ALIS FIYATI ONCE KAMPUSUN KENDI GIRISINDEN gelir: bu kampuse en son
        -- hangi fiyatla mal girdiyse maliyet odur. Ayni urun Esenyurt'a baska,
        -- Corlu'ya baska fiyata gelebilir. Hic giris yoksa katalogdaki
        -- baslangic degerine duseriz.
        COALESCE(lp.unit_cost, cp.purchase_price, p.purchase_price) AS purchase_price,
        lp.unit_cost                              AS last_purchase_price,
        lp.movement_date                          AS last_purchase_date,
        -- Satis fiyati da TARIHE BAGLI: gecmise donuk stok degeri o gunun
        -- fiyatiyla hesaplanir, ileri tarihli fiyat gunu gelince devreye girer.
        ${salePriceSql()}                         AS sale_price,
        COALESCE(cp.critical_stock, p.critical_stock) AS critical_stock,
        COALESCE(s.qty, 0)                        AS stock_qty
      FROM products p
      LEFT JOIN categories c        ON c.id = p.category_id
      LEFT JOIN campus_products cp  ON cp.product_id = p.id AND cp.campus_id = ?
      LEFT JOIN (
        SELECT m.product_id, SUM(m.quantity) AS qty
          FROM stock_movements m
         WHERE m.campus_id = ? ${movFilter}
         GROUP BY m.product_id
      ) s ON s.product_id = p.id
      LEFT JOIN (${lastPurchaseSql(movFilter.replace(/m\./g, ''))}) lp ON lp.product_id = p.id
     WHERE ${where.join(' AND ')}
     ORDER BY p.name COLLATE NOCASE`,
    // Sirasi: (satis fiyati) campus_id + tarih + tarih, cp.campus_id,
    //         (stok toplami) campus_id + untilDate,
    //         (son alis) campus_id + untilDate, sonra WHERE parametreleri
    [campusId, fiyatTarihi, fiyatTarihi, params[0], ...params, ...params, ...tail]
  );
}



/**
 * Kampus icin gecerli fiyatlar.
 *
 * Alis fiyati kampusun KENDI son mal girisinden gelir (bkz. stockSnapshot);
 * satis fiyati kampus ozel fiyat varsa ondan, yoksa katalogdan.
 */
export function effectivePrices(campusId, productId, onDate = null) {
  const tarih = onDate || bugun();
  return get(
    `SELECT COALESCE(lp.unit_cost, cp.purchase_price, p.purchase_price) AS purchase_price,
            lp.unit_cost AS last_purchase_price,
            lp.movement_date AS last_purchase_date,
            ${salePriceSql()} AS sale_price,
            p.vat_rate
       FROM products p
       LEFT JOIN campus_products cp ON cp.product_id = p.id AND cp.campus_id = ?
       LEFT JOIN (${lastPurchaseSql()}) lp ON lp.product_id = p.id
      WHERE p.id = ?`,
    [campusId, tarih, tarih, campusId, campusId, productId]
  );
}

/** Belirli bir urunun hareket dokumu. */
export function movementLedger(campusId, productId, { from = null, to = null, limit = 500 } = {}) {
  const params = [campusId, productId];
  let sql = `SELECT m.*, u.full_name AS created_by_name
               FROM stock_movements m
               LEFT JOIN users u ON u.id = m.created_by
              WHERE m.campus_id = ? AND m.product_id = ?`;
  if (from) { sql += ' AND m.movement_date >= ?'; params.push(from); }
  if (to) { sql += ' AND m.movement_date <= ?'; params.push(to); }
  sql += ' ORDER BY m.movement_date DESC, m.id DESC LIMIT ?';
  params.push(Number(limit));
  return all(sql, params);
}

/** Kampusun toplam stok degeri (maliyet ve satis fiyati uzerinden). */
export function stockValue(campusId, untilDate = null) {
  const rows = stockSnapshot(campusId, { untilDate });
  let costValue = 0;
  let saleValue = 0;
  let criticalCount = 0;
  let negativeCount = 0;
  for (const r of rows) {
    costValue += r.stock_qty * r.purchase_price;
    saleValue += r.stock_qty * r.sale_price;
    if (r.critical_stock > 0 && r.stock_qty <= r.critical_stock) criticalCount += 1;
    if (r.stock_qty < 0) negativeCount += 1;
  }
  return {
    productCount: rows.length,
    costValue: Math.round(costValue * 100) / 100,
    saleValue: Math.round(saleValue * 100) / 100,
    criticalCount,
    negativeCount,
  };
}
