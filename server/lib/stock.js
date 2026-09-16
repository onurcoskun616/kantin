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
 */
export function stockSnapshot(campusId, {
  untilDate = null, onlyActive = true, search = null, categoryId = null, includeProduced = false,
} = {}) {
  const params = [campusId];
  let movFilter = '';
  if (untilDate) { movFilter = 'AND m.movement_date <= ?'; params.push(untilDate); }

  const where = ['1 = 1'];
  const tail = [];
  if (onlyActive) where.push('p.is_active = 1');
  if (!includeProduced) where.push("p.product_type = 'SATIN_ALINAN'");
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
        COALESCE(cp.purchase_price, p.purchase_price) AS purchase_price,
        COALESCE(cp.sale_price,     p.sale_price)     AS sale_price,
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
     WHERE ${where.join(' AND ')}
     ORDER BY p.name COLLATE NOCASE`,
    [params[0], ...params, ...tail]
  );
}

/** Kampus icin gecerli fiyatlari dondurur (kampus ozel fiyat varsa o kullanilir). */
export function effectivePrices(campusId, productId) {
  return get(
    `SELECT COALESCE(cp.purchase_price, p.purchase_price) AS purchase_price,
            COALESCE(cp.sale_price,     p.sale_price)     AS sale_price,
            p.vat_rate
       FROM products p
       LEFT JOIN campus_products cp ON cp.product_id = p.id AND cp.campus_id = ?
      WHERE p.id = ?`,
    [campusId, productId]
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
