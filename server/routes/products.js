import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, conflict, badRequest, sendCsv, toCsv } from '../lib/http.js';
import { requireWrite, assertCampusAccess, seesAllCampuses } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, bool, date, today, oneOf } from '../lib/validate.js';
import { productProfit } from '../lib/money.js';
import { lastPurchaseSql, salePriceSql } from '../lib/stock.js';

export const productRoutes = new Router();

/* --------------------------- Kategoriler --------------------------- */
productRoutes.get('/categories', async () => ({
  items: all('SELECT * FROM categories ORDER BY sort_order, name COLLATE NOCASE'),
}));

productRoutes.post('/categories', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const name = str(ctx.body.name, 'Kategori adi', { required: true, max: 80 });
  if (get('SELECT id FROM categories WHERE name = ?', [name])) throw conflict('Bu kategori zaten var.');
  const id = insert('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [
    name, int(ctx.body.sortOrder, 'Sira', { def: 0 }) ?? 0,
  ]);
  logAudit({ user: ctx.user, action: 'CREATE', entity: 'categories', entityId: id, detail: { name }, ip: ctx.ip });
  return get('SELECT * FROM categories WHERE id = ?', [id]);
});

productRoutes.put('/categories/:id', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM categories WHERE id = ?', [id])) throw notFound('Kategori bulunamadi.');
  const name = str(ctx.body.name, 'Kategori adi', { required: true, max: 80 });
  run('UPDATE categories SET name = ?, sort_order = ?, is_active = ? WHERE id = ?', [
    name, int(ctx.body.sortOrder, 'Sira', { def: 0 }) ?? 0, bool(ctx.body.isActive, true) ? 1 : 0, id,
  ]);
  logAudit({ user: ctx.user, action: 'UPDATE', entity: 'categories', entityId: id, ip: ctx.ip });
  return get('SELECT * FROM categories WHERE id = ?', [id]);
});

/* ----------------------------- Urunler ----------------------------- */
productRoutes.get('/', async (ctx) => {
  const { search, categoryId, onlyActive, campusId } = ctx.query;
  const where = ['1 = 1'];
  const params = [];
  if (search) { where.push('(p.name LIKE ? OR p.barcode LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  if (categoryId) { where.push('p.category_id = ?'); params.push(Number(categoryId)); }
  if (onlyActive !== '0') where.push('p.is_active = 1');

  const cId = campusId ? assertCampusAccess(ctx.user, campusId) : (ctx.user.campusId || null);

  // Alis fiyati urun kartindan DEGIL, kampusun kendi son mal girisinden gelir
  // (4. ve 7. madde). Kampus secili degilse katalogdaki baslangic degeri kalir.
  const rows = all(
    `SELECT p.*, c.name AS category_name,
            cp.purchase_price AS campus_purchase_price,
            cp.sale_price     AS campus_sale_price,
            cp.critical_stock AS campus_critical_stock,
            lp.unit_cost      AS last_purchase_price,
            lp.movement_date  AS last_purchase_date,
            ${salePriceSql()} AS resolved_sale_price,
            (SELECT MIN(pp.effective_from) FROM product_prices pp
              WHERE pp.product_id = p.id AND pp.effective_from > ?
                AND (pp.campus_id = ? OR pp.campus_id IS NULL)) AS next_price_date
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN campus_products cp ON cp.product_id = p.id AND cp.campus_id = ?
       LEFT JOIN (${lastPurchaseSql()}) lp ON lp.product_id = p.id
      WHERE ${where.join(' AND ')}
      ORDER BY p.name COLLATE NOCASE`,
    [cId ?? 0, today(), today(), today(), cId ?? 0, cId ?? 0, cId ?? 0, ...params]
  );

  const items = rows.map((r) => decorate(r));
  if (ctx.query.format === 'csv') {
    return sendCsv(ctx.res, 'urunler.csv', toCsv(items, [
      { label: 'Barkod', key: 'barcode' },
      { label: 'Ürün', key: 'name' },
      { label: 'Kategori', key: 'category_name' },
      { label: 'Birim', key: 'unit' },
      { label: 'Alış (KDV hariç)', value: (r) => fmt(r.effective_purchase_price) },
      { label: 'Satış (KDV dahil)', value: (r) => fmt(r.effective_sale_price) },
      { label: 'KDV %', key: 'vat_rate' },
      { label: 'Birim Kâr', value: (r) => fmt(r.profit.unitProfit) },
      { label: 'Kâr Marjı %', value: (r) => fmt(r.profit.marginPct) },
      { label: 'Maliyet Üzeri Kâr %', value: (r) => fmt(r.profit.markupPct) },
    ]));
  }
  return { items };
});

productRoutes.get('/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const row = get(
    `SELECT p.*, c.name AS category_name FROM products p
      LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = ?`, [id]
  );
  if (!row) throw notFound('Urun bulunamadi.');
  const campusPrices = all(
    `SELECT cp.*, k.name AS campus_name FROM campus_products cp
       JOIN campuses k ON k.id = cp.campus_id WHERE cp.product_id = ? ORDER BY k.name`, [id]
  );
  const history = all(
    `SELECT ph.*, u.full_name AS changed_by_name FROM price_history ph
       LEFT JOIN users u ON u.id = ph.changed_by
      WHERE ph.product_id = ? ORDER BY ph.id DESC LIMIT 50`, [id]
  );
  return { ...decorate(row), campusPrices, priceHistory: history };
});

productRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const data = parseProduct(ctx.body);
  if (data.barcode && get('SELECT id FROM products WHERE barcode = ?', [data.barcode])) {
    throw conflict('Bu barkod baska bir urunde kayitli.');
  }
  const id = insert(
    `INSERT INTO products (barcode, name, category_id, unit, product_type, purchase_price, sale_price, vat_rate,
                           critical_stock, meb_approved, max_price, track_expiry, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.barcode, data.name, data.categoryId, data.unit, data.productType, data.purchasePrice, data.salePrice,
     data.vatRate, data.criticalStock, data.mebApproved ? 1 : 0, data.maxPrice,
     data.trackExpiry ? 1 : 0, data.isActive ? 1 : 0]
  );
  insert(
    `INSERT INTO price_history (product_id, campus_id, old_purchase, new_purchase, old_sale, new_sale, effective_date, changed_by)
     VALUES (?, NULL, NULL, ?, NULL, ?, ?, ?)`,
    [id, data.purchasePrice, data.salePrice, today(), ctx.user.id]
  );
  // Satis fiyati TARIHLI listeye de yazilir (9. madde)
  setDatedPrice({
    productId: id, salePrice: data.salePrice,
    effectiveFrom: date(ctx.body.effectiveDate, 'Gecerlilik tarihi', { def: today() }),
    note: 'Urun tanimi', userId: ctx.user.id,
  });
  logAudit({ user: ctx.user, action: 'CREATE', entity: 'products', entityId: id, detail: data, ip: ctx.ip });
  return get('SELECT * FROM products WHERE id = ?', [id]);
});

productRoutes.put('/:id', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const id = Number(ctx.params.id);
  const existing = get('SELECT * FROM products WHERE id = ?', [id]);
  if (!existing) throw notFound('Urun bulunamadi.');
  const data = parseProduct(ctx.body, existing);
  if (data.barcode) {
    const dup = get('SELECT id FROM products WHERE barcode = ? AND id <> ?', [data.barcode, id]);
    if (dup) throw conflict('Bu barkod baska bir urunde kayitli.');
  }
  tx(() => {
    run(
      `UPDATE products SET barcode = ?, name = ?, category_id = ?, unit = ?, product_type = ?,
              purchase_price = ?, sale_price = ?, vat_rate = ?, critical_stock = ?, meb_approved = ?,
              max_price = ?, track_expiry = ?, is_active = ?, updated_at = datetime('now')
        WHERE id = ?`,
      [data.barcode, data.name, data.categoryId, data.unit, data.productType, data.purchasePrice, data.salePrice,
       data.vatRate, data.criticalStock, data.mebApproved ? 1 : 0, data.maxPrice,
       data.trackExpiry ? 1 : 0, data.isActive ? 1 : 0, id]
    );
    const gecerlilik = date(ctx.body.effectiveDate, 'Gecerlilik tarihi', { def: today() }) || today();
    if (existing.purchase_price !== data.purchasePrice || existing.sale_price !== data.salePrice) {
      insert(
        `INSERT INTO price_history (product_id, campus_id, old_purchase, new_purchase, old_sale, new_sale, effective_date, changed_by)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
        [id, existing.purchase_price, data.purchasePrice, existing.sale_price, data.salePrice,
         gecerlilik, ctx.user.id]
      );
    }
    // Satis fiyati TARIHLI listeye yazilir. Ileri tarihliyse sutun degismez;
    // bu yuzden UPDATE'in yazdigi degeri geri almamiz gerekebilir.
    if (existing.sale_price !== data.salePrice || gecerlilik !== today()) {
      if (gecerlilik > today()) {
        run('UPDATE products SET sale_price = ? WHERE id = ?', [existing.sale_price, id]);
      }
      setDatedPrice({
        productId: id, salePrice: data.salePrice, effectiveFrom: gecerlilik,
        note: gecerlilik > today() ? 'Ileri tarihli fiyat' : null, userId: ctx.user.id,
      });
    }
  });
  logAudit({ user: ctx.user, action: 'UPDATE', entity: 'products', entityId: id, detail: data, ip: ctx.ip });
  return get('SELECT * FROM products WHERE id = ?', [id]);
});

productRoutes.delete('/:id', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM products WHERE id = ?', [id])) throw notFound('Urun bulunamadi.');
  // Hareket gormus urunler silinmez, pasife alinir (izlenebilirlik korunur)
  run('UPDATE products SET is_active = 0 WHERE id = ?', [id]);
  logAudit({ user: ctx.user, action: 'DEACTIVATE', entity: 'products', entityId: id, ip: ctx.ip });
  return { ok: true };
});

/* ------------------- Kampus bazli fiyat istisnasi ------------------- */
productRoutes.put('/:id/campus-price/:campusId', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const productId = Number(ctx.params.id);
  const campusId = assertCampusAccess(ctx.user, ctx.params.campusId);
  const product = get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw notFound('Urun bulunamadi.');

  // Kampus alis fiyati da artik arayuzden gelmiyor; gonderilmediyse mevcut
  // deger korunur (sessizce silinmesin). Gecerli fiyat zaten o kampusun
  // kendi son mal girisinden hesaplaniyor.
  const mevcutKampus = get(
    'SELECT * FROM campus_products WHERE campus_id = ? AND product_id = ?', [campusId, productId]
  );
  const purchasePrice = num(ctx.body.purchasePrice, 'Alis fiyati',
    { min: 0, def: mevcutKampus?.purchase_price ?? null });
  const salePrice = num(ctx.body.salePrice, 'Satis fiyati', { min: 0, def: null });
  const criticalStock = num(ctx.body.criticalStock, 'Kritik stok', { min: 0, def: null });
  const existing = get('SELECT * FROM campus_products WHERE campus_id = ? AND product_id = ?', [campusId, productId]);

  run(
    `INSERT INTO campus_products (campus_id, product_id, purchase_price, sale_price, critical_stock, is_active)
     VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(campus_id, product_id) DO UPDATE SET
       purchase_price = excluded.purchase_price,
       sale_price     = excluded.sale_price,
       critical_stock = excluded.critical_stock`,
    [campusId, productId, purchasePrice, salePrice, criticalStock]
  );
  insert(
    `INSERT INTO price_history (product_id, campus_id, old_purchase, new_purchase, old_sale, new_sale, effective_date, changed_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [productId, campusId, existing?.purchase_price ?? null, purchasePrice,
     existing?.sale_price ?? null, salePrice, today(), ctx.user.id]
  );
  if (salePrice !== null && salePrice !== undefined) {
    setDatedPrice({
      productId, campusId, salePrice,
      effectiveFrom: date(ctx.body.effectiveDate, 'Gecerlilik tarihi', { def: today() }),
      note: 'Kampus fiyati', userId: ctx.user.id,
    });
  }
  logAudit({
    user: ctx.user, action: 'UPDATE', entity: 'campus_products', entityId: productId, campusId,
    detail: { purchasePrice, salePrice, criticalStock }, ip: ctx.ip,
  });
  return get('SELECT * FROM campus_products WHERE campus_id = ? AND product_id = ?', [campusId, productId]);
});

/* -------------------------- Toplu iceri alma ------------------------ */
productRoutes.post('/bulk-import', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const rows = Array.isArray(ctx.body.items) ? ctx.body.items : null;
  if (!rows || !rows.length) throw badRequest('Iceri aktarilacak satir bulunamadi.');
  if (rows.length > 5000) throw badRequest('Tek seferde en fazla 5000 satir aktarilabilir.');

  const result = { created: 0, updated: 0, categoriesCreated: 0, errors: [] };
  tx(() => {
    // Kategori adlarini id'ye cevir; olmayan kategoriyi olustur
    const categories = new Map(
      all('SELECT id, name FROM categories').map((c) => [c.name.toLocaleLowerCase('tr'), c.id])
    );
    const resolveCategory = (raw) => {
      const name = str(raw.categoryName, 'Kategori', { max: 80 });
      if (!name) return int(raw.categoryId, 'Kategori', { def: null });
      const key = name.toLocaleLowerCase('tr');
      if (categories.has(key)) return categories.get(key);
      const id = insert('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, categories.size]);
      categories.set(key, id);
      result.categoriesCreated += 1;
      return id;
    };

    rows.forEach((raw, idx) => {
      try {
        // Eslestirmeyi once yapariz: mevcut urunun alis fiyati, Excel'de
        // sutun bos birakilmissa korunsun (bkz. parseProduct).
        const gecici = { ...raw, categoryId: resolveCategory(raw) };
        const existing = str(gecici.barcode, 'Barkod', { max: 64 })
          ? get('SELECT * FROM products WHERE barcode = ?', [str(gecici.barcode, 'Barkod', { max: 64 })])
          : get('SELECT * FROM products WHERE barcode IS NULL AND lower(name) = lower(?)',
            [str(gecici.name, 'Urun adi', { required: true, max: 200 })]);
        const data = parseProduct(gecici, existing);

        if (existing) {
          run(
            `UPDATE products SET name = ?, category_id = ?, unit = ?, product_type = ?, purchase_price = ?,
                    sale_price = ?, vat_rate = ?, critical_stock = ?, max_price = ?, is_active = 1,
                    updated_at = datetime('now')
              WHERE id = ?`,
            [data.name, data.categoryId, data.unit, data.productType, data.purchasePrice, data.salePrice,
             data.vatRate, data.criticalStock, data.maxPrice, existing.id]
          );
          if (existing.purchase_price !== data.purchasePrice || existing.sale_price !== data.salePrice) {
            insert(
              `INSERT INTO price_history (product_id, campus_id, old_purchase, new_purchase, old_sale, new_sale, effective_date, changed_by)
               VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
              [existing.id, existing.purchase_price, data.purchasePrice,
               existing.sale_price, data.salePrice, today(), ctx.user.id]
            );
          }
          // Satis fiyati TARIHLI listeye de yazilir; yoksa toplu yuklemeyle
          // degisen fiyatin ne zamandan gecerli oldugu kayitsiz kalirdi.
          setDatedPrice({
            productId: existing.id, salePrice: data.salePrice,
            effectiveFrom: today(), note: 'Excel ile toplu yukleme', userId: ctx.user.id,
          });
          result.updated += 1;
        } else {
          const id = insert(
            `INSERT INTO products (barcode, name, category_id, unit, product_type, purchase_price, sale_price,
                                   vat_rate, critical_stock, max_price)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [data.barcode, data.name, data.categoryId, data.unit, data.productType, data.purchasePrice,
             data.salePrice, data.vatRate, data.criticalStock, data.maxPrice]
          );
          insert(
            `INSERT INTO price_history (product_id, campus_id, old_purchase, new_purchase, old_sale, new_sale, effective_date, changed_by)
             VALUES (?, NULL, NULL, ?, NULL, ?, ?, ?)`,
            [id, data.purchasePrice, data.salePrice, today(), ctx.user.id]
          );
          setDatedPrice({
            productId: id, salePrice: data.salePrice,
            effectiveFrom: today(), note: 'Excel ile toplu yukleme', userId: ctx.user.id,
          });
          result.created += 1;
        }
      } catch (err) {
        result.errors.push({ row: raw.__row ?? idx + 1, name: raw.name ?? '', message: err.message });
      }
    });
  });
  logAudit({
    user: ctx.user, action: 'BULK_IMPORT', entity: 'products',
    detail: { created: result.created, updated: result.updated, errors: result.errors.length }, ip: ctx.ip,
  });
  return result;
});

/* --------------------- Tarih bazli satis fiyati -------------------- */
/**
 * Fiyat listesine bir satir yazar ve GEREKIYORSA sutundaki degeri tazeler.
 *
 * `products.sale_price` (ve campus_products.sale_price) artik bir ONBELLEKtir:
 * "bugun gecerli fiyat". Ileri tarihli bir fiyat girildiginde sutun
 * DEGISMEZ - gunu gelince tarih cozumlemesi zaten onu dondurur.
 *
 * @returns yazilan satir
 */
function setDatedPrice({ productId, campusId = null, salePrice, effectiveFrom, note = null, userId }) {
  const tarih = effectiveFrom || today();
  // Ayni gune ikinci kez fiyat girilirse sonuncusu gecerlidir
  run(
    campusId === null
      ? 'DELETE FROM product_prices WHERE product_id = ? AND campus_id IS NULL AND effective_from = ?'
      : 'DELETE FROM product_prices WHERE product_id = ? AND campus_id = ? AND effective_from = ?',
    campusId === null ? [productId, tarih] : [productId, campusId, tarih]
  );
  const id = insert(
    `INSERT INTO product_prices (product_id, campus_id, sale_price, effective_from, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [productId, campusId, salePrice, tarih, note, userId]
  );

  // Gecmis ya da bugun tarihliyse onbellek sutunu da guncellenir; ileri
  // tarihliyse dokunulmaz (bugunun fiyati henuz degismedi).
  if (tarih <= today()) {
    if (campusId === null) {
      run("UPDATE products SET sale_price = ?, updated_at = datetime('now') WHERE id = ?", [salePrice, productId]);
    } else {
      run(
        `INSERT INTO campus_products (campus_id, product_id, sale_price, is_active)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(campus_id, product_id) DO UPDATE SET sale_price = excluded.sale_price`,
        [campusId, productId, salePrice]
      );
    }
  }
  return get('SELECT * FROM product_prices WHERE id = ?', [id]);
}

/** Bir urunun fiyat listesi (kampus ve katalog satirlari birlikte). */
productRoutes.get('/:id/prices', async (ctx) => {
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM products WHERE id = ?', [id])) throw notFound('Urun bulunamadi.');
  const items = all(
    `SELECT pp.*, k.name AS campus_name, u.full_name AS created_by_name
       FROM product_prices pp
       LEFT JOIN campuses k ON k.id = pp.campus_id
       LEFT JOIN users u ON u.id = pp.created_by
      WHERE pp.product_id = ?
      ORDER BY pp.effective_from DESC, pp.id DESC`, [id]
  );
  const bugun = today();
  return {
    items: items.map((r) => ({ ...r, is_future: r.effective_from > bugun })),
    today: bugun,
  };
});

/** Yeni (ileri tarihli olabilen) satis fiyati tanimlar. */
productRoutes.post('/:id/prices', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM products WHERE id = ?', [id])) throw notFound('Urun bulunamadi.');
  const salePrice = num(ctx.body.salePrice, 'Satis fiyati', { required: true, min: 0, max: 1e6 });
  const effectiveFrom = date(ctx.body.effectiveFrom, 'Gecerlilik tarihi', { def: today() }) || today();
  const campusId = ctx.body.campusId ? assertCampusAccess(ctx.user, ctx.body.campusId) : null;
  const note = str(ctx.body.note, 'Aciklama', { max: 200 });

  const row = setDatedPrice({
    productId: id, campusId, salePrice, effectiveFrom, note, userId: ctx.user.id,
  });
  logAudit({
    user: ctx.user, action: 'UPDATE', entity: 'product_prices', entityId: row.id, campusId,
    detail: { productId: id, salePrice, effectiveFrom, note: note || undefined }, ip: ctx.ip,
  });
  return row;
});

/**
 * Bir fiyat satirini siler.
 *
 * Yalnizca ILERI TARIHLI satirlar silinebilir: gecmiste uygulanmis bir fiyat
 * o donemin karliligini aciklar, silinmesi gecmisi degistirir.
 */
productRoutes.delete('/:id/prices/:priceId', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const row = get('SELECT * FROM product_prices WHERE id = ? AND product_id = ?',
    [Number(ctx.params.priceId), Number(ctx.params.id)]);
  if (!row) throw notFound('Fiyat kaydi bulunamadi.');
  if (row.effective_from <= today()) {
    throw conflict('Yururluge girmis bir fiyat silinemez; yeni bir fiyat tanimlayin.');
  }
  run('DELETE FROM product_prices WHERE id = ?', [row.id]);
  logAudit({
    user: ctx.user, action: 'DELETE', entity: 'product_prices', entityId: row.id,
    campusId: row.campus_id, detail: { productId: row.product_id, salePrice: row.sale_price, effectiveFrom: row.effective_from }, ip: ctx.ip,
  });
  return { ok: true };
});

/* ----------------------------- yardimci ---------------------------- */
/**
 * @param body    istek govdesi
 * @param existing guncelleme ise mevcut kayit
 *
 * ALIS FIYATI artik arayuzden GONDERILMIYOR (4. madde): faturadan ve acilis
 * stogundan olusuyor. Govdede yoksa MEVCUT DEGER KORUNUR - yoksa her urun
 * duzenlemesi alis fiyatini sifirlardi. Excel ice aktarma ve fatura
 * uzerinden urun acma hala deger gonderebilir; oralarda bu bir GIRISTIR.
 */
function parseProduct(body, existing = null) {
  const alisVarsayilan = existing ? existing.purchase_price : 0;
  return {
    barcode: str(body.barcode, 'Barkod', { max: 64 }),
    name: str(body.name, 'Urun adi', { required: true, max: 200 }),
    categoryId: int(body.categoryId, 'Kategori', { def: null }),
    unit: str(body.unit, 'Birim', { max: 20 }) || 'ADET',
    productType: oneOf(body.productType, 'Urun tipi', ['SATIN_ALINAN', 'HAMMADDE', 'URETILEN'], { def: 'SATIN_ALINAN' }),
    purchasePrice: num(body.purchasePrice, 'Alis fiyati', { min: 0, max: 1e6, def: alisVarsayilan }) ?? alisVarsayilan,
    salePrice: num(body.salePrice, 'Satis fiyati', { min: 0, max: 1e6, def: 0 }) ?? 0,
    vatRate: num(body.vatRate, 'KDV orani', { min: 0, max: 100, def: 10 }) ?? 10,
    criticalStock: num(body.criticalStock, 'Kritik stok', { min: 0, def: 0 }) ?? 0,
    mebApproved: bool(body.mebApproved, true),
    maxPrice: num(body.maxPrice, 'Tavan fiyat', { min: 0, def: 0 }) ?? 0,
    trackExpiry: bool(body.trackExpiry, false),
    isActive: bool(body.isActive, true),
  };
}

/**
 * Bir urun satirina gecerli fiyatlari ve karliligi ekler.
 *
 * ALIS FIYATI SIRASI (4. ve 7. madde):
 *   1. Kampusun kendi son mal girisi (fatura ya da acilis stogu)  -> ALIM
 *   2. Kampus ozel tanimi (eski kurulumlardan kalma)              -> KAMPUS
 *   3. Urun kartindaki baslangic degeri                           -> KATALOG
 * Kaynak `purchase_price_source` ile birlikte donulur; arayuz fiyatin
 * nereden geldigini kullaniciya soyleyebilsin diye.
 */
export function decorate(row) {
  let purchase = row.last_purchase_price;
  let source = 'ALIM';
  if (purchase === null || purchase === undefined) {
    purchase = row.campus_purchase_price;
    source = 'KAMPUS';
  }
  if (purchase === null || purchase === undefined) {
    purchase = row.purchase_price;
    source = 'KATALOG';
  }
  // Satis fiyati TARIHE BAGLI cozulur (9. madde); liste disi cagrilarda
  // (or. tekil urun detayi) eski sutunlara duseriz.
  const sale = row.resolved_sale_price ?? row.campus_sale_price ?? row.sale_price;
  const profit = productProfit(purchase, sale, row.vat_rate);
  return {
    ...row,
    effective_purchase_price: purchase,
    purchase_price_source: source,
    effective_sale_price: sale,
    profit,
    over_max_price: row.max_price > 0 && sale > row.max_price,
  };
}

const fmt = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
