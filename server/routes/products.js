import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, conflict, badRequest, sendCsv, toCsv } from '../lib/http.js';
import { requireWrite, requireRole, assertCampusAccess, seesAllCampuses } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, bool, date, today, oneOf } from '../lib/validate.js';
import { productProfit, round2 } from '../lib/money.js';
import { lastPurchaseSql, salePriceSql } from '../lib/stock.js';
import { normalizeTr, trFold, trFoldSql } from '../lib/metin.js';

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
  // Turkce harf ve buyuk/kucuk harf farki aramayi bozmasin: iki taraf da
  // ayni kurala indirgenir (bkz. lib/metin.js trFold).
  if (search) {
    where.push(`(${trFoldSql('p.name')} LIKE ? OR ${trFoldSql("COALESCE(p.barcode, '')")} LIKE ?)`);
    const q = `%${trFold(search)}%`;
    params.push(q, q);
  }
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
      { label: 'Alış (KDV dahil)', value: (r) => fmt(r.effective_purchase_price) },
      { label: 'Satış (KDV dahil)', value: (r) => fmt(r.effective_sale_price) },
      { label: 'KDV %', key: 'vat_rate' },
      { label: 'Birim Kâr', value: (r) => fmt(r.profit.unitProfit) },
      { label: 'Kâr Marjı %', value: (r) => fmt(r.profit.marginPct) },
      { label: 'Maliyet Üzeri Kâr %', value: (r) => fmt(r.profit.markupPct) },
    ]));
  }
  return { items };
});

/* ================= TEDARIKCI URUN ESLESTIRMELERI ================== */
/**
 * Ogrenilen takma adi kaydeder (ya da mevcut olani gunceller).
 *
 * Ayni tedarikci + ayni kod/ad ikinci bir urune baglanamaz (benzersiz
 * indeks). Kullanici eslestirmeyi degistirmek isterse yeni urun yazilir,
 * eski kayit uzerine gecer.
 *
 * SATICI KODU GUVENILMEZ OLABILIR. Sahadan gelen ornek: bir toptanci
 * ayni faturada "ÇİKOLATALI SÜT" ve "ÇİLEKLİ SÜT" kalemlerinin ikisine
 * de SellersItemIdentification olarak "15" yazmisti; baska bir kalemde
 * de onceki faturada baska bir urune yazdigi "4" kodu vardi. Kodla
 * bulunan satirin ADI uzerine yazilmaya calisilinca benzersiz indeks
 * patliyor ve KULLANICI BELGEYI HIC KAYDEDEMIYORDU (sunucu hatasi).
 *
 * Bu yuzden kural sudur:
 *   - Once ADA bakilir: kullanicinin gordugu ve eslestirdigi sey odur.
 *   - Kod baska bir satirda BASKA bir urune bagliysa o kod ISPATLI
 *     BICIMDE belirsizdir: hicbir satirda tutulmaz (oradan da silinir),
 *     boylece sonraki faturalarda yanlis urunu getirmez. Ad eslesmesi
 *     calismaya devam eder.
 *   - Ayni urunun yalnizca kodla ogrenilmis satiri varsa, kod ad
 *     satirina tasinir ve tekrar eden satir silinir.
 *
 * @returns yazilan satir, ya da eslestirilecek bir sey yoksa null
 */
export function learnAlias({ productId, supplierId = null, sourceCode = null, sourceName = null, factor = 1, userId = null }) {
  const kod = String(sourceCode || '').trim() || null;
  const ad = String(sourceName || '').trim() || null;
  const adNorm = ad ? normalizeTr(ad) : null;
  // Ne kod ne ad varsa ogrenecek bir sey yok
  if (!kod && !adNorm) return null;

  // Kod ve ad AYRI AYRI aranir: ikisi ayri satirlara denk gelebilir ve
  // birini digerinin uzerine yazmak benzersiz indeksi patlatir.
  const kapsam = supplierId ? 'supplier_id = ?' : 'supplier_id IS NULL';
  const kapsamParam = supplierId ? [supplierId] : [];
  const kodSatiri = kod
    ? get(`SELECT * FROM product_aliases WHERE ${kapsam} AND source_code = ? LIMIT 1`, [...kapsamParam, kod])
    : null;
  const adSatiri = adNorm
    ? get(`SELECT * FROM product_aliases WHERE ${kapsam} AND source_name_norm = ? LIMIT 1`, [...kapsamParam, adNorm])
    : null;

  // Hedef satir: once ad, yoksa adi bos olan (ya da ayni adi tasiyan) kod
  // satiri. Kod satirinin BASKA bir adi varsa ona dokunmayiz.
  let hedef = null;
  if (adSatiri) hedef = adSatiri;
  else if (kodSatiri && (!kodSatiri.source_name_norm || kodSatiri.source_name_norm === adNorm)) hedef = kodSatiri;

  let kodYazilabilir = Boolean(kod);
  if (kod && kodSatiri && (!hedef || kodSatiri.id !== hedef.id)) {
    if (kodSatiri.product_id === productId && !kodSatiri.source_name_norm) {
      // Ayni urunun yalnizca kodla ogrenilmis satiri: ad satirinda
      // birlestir, tekrar eden satiri sil.
      run('DELETE FROM product_aliases WHERE id = ?', [kodSatiri.id]);
    } else {
      // Ayni kod baska bir urune/ada bagli: kod belirsizdir. Oradan da
      // sokulur ki sonraki faturalarda yanlis urunu getirmesin.
      run('UPDATE product_aliases SET source_code = NULL WHERE id = ?', [kodSatiri.id]);
      kodYazilabilir = false;
    }
  }

  if (hedef) {
    // COALESCE: yazilamayan kod satirin ESKI kodunu silmemeli. Once
    // ogrenilmis saglam bir kod, bu faturadaki belirsiz kod yuzunden
    // kaybolmasin.
    run(
      `UPDATE product_aliases
          SET product_id = ?, source_code = COALESCE(?, source_code),
              source_name = COALESCE(?, source_name), source_name_norm = COALESCE(?, source_name_norm),
              factor = ?, use_count = use_count + 1, last_used_at = datetime('now')
        WHERE id = ?`,
      [productId, kodYazilabilir ? kod : null, ad, adNorm, factor, hedef.id]
    );
    return get('SELECT * FROM product_aliases WHERE id = ?', [hedef.id]);
  }

  const id = insert(
    `INSERT INTO product_aliases (product_id, supplier_id, source_code, source_name, source_name_norm,
                                  factor, use_count, last_used_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, 1, datetime('now'), ?)`,
    [productId, supplierId, kodYazilabilir ? kod : null, ad, adNorm, factor, userId]
  );
  return get('SELECT * FROM product_aliases WHERE id = ?', [id]);
}

/**
 * Eslestirme listesi. Fatura aktariminda tarayiciya verilir; tedarikci
 * secildiginde o tedarikcinin kayitlari + genel kayitlar gelir.
 */
productRoutes.get('/aliases', async (ctx) => {
  const supplierId = ctx.query.supplierId ? Number(ctx.query.supplierId) : null;
  const where = [];
  const params = [];
  if (supplierId) { where.push('(a.supplier_id = ? OR a.supplier_id IS NULL)'); params.push(supplierId); }
  if (ctx.query.productId) { where.push('a.product_id = ?'); params.push(Number(ctx.query.productId)); }
  if (ctx.query.search) {
    where.push(`(${trFoldSql("COALESCE(a.source_name, '')")} LIKE ? OR ${trFoldSql("COALESCE(a.source_code, '')")} LIKE ? OR ${trFoldSql('p.name')} LIKE ?)`);
    const q = `%${trFold(ctx.query.search)}%`;
    params.push(q, q, q);
  }

  const items = all(
    `SELECT a.*, p.name AS product_name, p.unit AS product_unit, p.barcode AS product_barcode,
            s.name AS supplier_name, u.full_name AS created_by_name
       FROM product_aliases a
       JOIN products p ON p.id = a.product_id
       LEFT JOIN suppliers s ON s.id = a.supplier_id
       LEFT JOIN users u ON u.id = a.created_by
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY s.name COLLATE NOCASE, a.source_name COLLATE NOCASE
      LIMIT 2000`,
    params
  );
  return { items };
});

/** Elle eslestirme tanimlar (ya da duzeltir). */
productRoutes.post('/aliases', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const productId = int(ctx.body.productId, 'Urun', { required: true });
  if (!get('SELECT id FROM products WHERE id = ?', [productId])) throw notFound('Urun bulunamadi.');
  const supplierId = ctx.body.supplierId ? int(ctx.body.supplierId, 'Tedarikci') : null;
  if (supplierId && !get('SELECT id FROM suppliers WHERE id = ?', [supplierId])) {
    throw notFound('Tedarikci bulunamadi.');
  }
  const sourceName = str(ctx.body.sourceName, 'Faturadaki ad', { max: 300 });
  const sourceCode = str(ctx.body.sourceCode, 'Satici urun kodu', { max: 60 });
  if (!sourceName && !sourceCode) throw badRequest('Faturadaki ad ya da satici urun kodu girmelisiniz.');
  const factor = num(ctx.body.factor, 'Cevrim carpani', { min: 0.0001, max: 100000, def: 1 }) ?? 1;

  const row = learnAlias({ productId, supplierId, sourceCode, sourceName, factor, userId: ctx.user.id });
  logAudit({
    user: ctx.user, action: 'CREATE', entity: 'product_aliases', entityId: row.id,
    detail: { productId, supplierId, sourceName, sourceCode, factor }, ip: ctx.ip,
  });
  return row;
});

/** Cevrim carpanini gunceller (koli -> adet gibi). */
productRoutes.put('/aliases/:id', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const row = get('SELECT * FROM product_aliases WHERE id = ?', [Number(ctx.params.id)]);
  if (!row) throw notFound('Eslestirme bulunamadi.');
  const productId = ctx.body.productId ? int(ctx.body.productId, 'Urun') : row.product_id;
  if (!get('SELECT id FROM products WHERE id = ?', [productId])) throw badRequest('Urun bulunamadi.');
  const factor = num(ctx.body.factor, 'Cevrim carpani', { min: 0.0001, max: 100000, def: row.factor }) ?? row.factor;

  run('UPDATE product_aliases SET product_id = ?, factor = ? WHERE id = ?', [productId, factor, row.id]);
  logAudit({
    user: ctx.user, action: 'UPDATE', entity: 'product_aliases', entityId: row.id,
    detail: { onceki: { productId: row.product_id, factor: row.factor }, yeni: { productId, factor } }, ip: ctx.ip,
  });
  return get('SELECT * FROM product_aliases WHERE id = ?', [row.id]);
});

/**
 * Eslestirmeyi siler.
 *
 * Gecmis belgeler etkilenmez: eslestirme yalnizca YENI faturalar okunurken
 * kullanilir, kaydedilmis satirlar zaten urune baglidir.
 */
productRoutes.delete('/aliases/:id', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const row = get('SELECT * FROM product_aliases WHERE id = ?', [Number(ctx.params.id)]);
  if (!row) throw notFound('Eslestirme bulunamadi.');
  run('DELETE FROM product_aliases WHERE id = ?', [row.id]);
  logAudit({
    user: ctx.user, action: 'DELETE', entity: 'product_aliases', entityId: row.id,
    detail: { productId: row.product_id, supplierId: row.supplier_id, sourceName: row.source_name }, ip: ctx.ip,
  });
  return { ok: true };
});

/**
 * MUKERRER ADAYLARI: adi sadelestirildiginde ayni cikan kartlar.
 *
 * Kullanici 213 kart icinde mukerrerleri goz ile aramasin diye katalog
 * ekraninda bir panelde listelenir.
 */
/**
 * Urun adinin AMBALAJ/GRAMAJ'dan arindirilmis cekirdegi.
 *
 * Mukerrerlerin bir kismi birebir ayni ad DEGILDIR; ayni urun baska
 * yazilmistir. Sahadan ornekler:
 *
 *   "ÇİLEKLİ SÜT"                 / "SÜT ÇİLEKLİ 180 ML"      (kelime sirasi)
 *   "CRAX PL ACI BAHARATLI 50GX20KL" / "CRAX ACI BAHARATLI 50GX20 KL"
 *   "DUCAT PREMİUM SICAK ÇİKOLATA*10" / "Ducat Sıcak Çikolata 10 Lu"
 *
 * Birebir karsilastirma bunlari kacirir. Bu yuzden rakam iceren her
 * jeton (gramaj, adet, ambalaj) ve bilinen ambalaj ekleri atilir, kalan
 * kelimeler KUMEYE cevrilir: sira onemini yitirir.
 *
 * Sonuc KESIN DEGIL, ADAYDIR: ayni cekirdege sahip iki kart gercekten
 * farkli gramaj da olabilir ("MADEN SUYU 20CL" / "25CL"). Bu yuzden
 * arayuzde ayri bir baslik altinda "kontrol edin" diye gosterilir.
 */
const AMBALAJ_EKLERI = new Set([
  'kl', 'tv', 'dp', 'lu', 'no', 'yeni', 'diz', 'bs', 'tyn', 'pet', 'pl',
  'adet', 'kutu', 'paket', 'ad', 'gr', 'g', 'ml', 'cl', 'lt', 'kg', 'cc',
]);

function urunCekirdegi(ad) {
  const kelimeler = normalizeTr(ad).split(' ')
    .filter((w) => w.length > 1 && !/\d/.test(w) && !AMBALAJ_EKLERI.has(w));
  const benzersiz = [...new Set(kelimeler)].sort();
  // TEK kelimelik cekirdek fazla genistir ("Tost", "Çay"): gercekten
  // farkli urunleri ayni gruba atar. En az iki kelime arariz.
  return benzersiz.length >= 2 ? benzersiz.join(' ') : '';
}

productRoutes.get('/mukerrerler', async () => {
  const rows = all('SELECT id, name, unit, barcode, is_active FROM products');

  // Ayni urun BIRDEN FAZLA KAMPUSTE de iki kart altinda duruyor olabilir.
  // Kartlar global oldugu icin birlestirme hepsini birlikte duzeltir; hangi
  // kampuslerde stok tuttugu panelde gorulsun diye kampus dagilimi da gelir.
  const kampusDagilimi = new Map();
  for (const r of all(
    `SELECT m.product_id, k.name AS kampus, ROUND(SUM(m.quantity), 3) AS qty
       FROM stock_movements m JOIN campuses k ON k.id = m.campus_id
      GROUP BY m.product_id, m.campus_id
     HAVING ROUND(SUM(m.quantity), 3) <> 0
      ORDER BY k.name`
  )) {
    if (!kampusDagilimi.has(r.product_id)) kampusDagilimi.set(r.product_id, []);
    kampusDagilimi.get(r.product_id).push({ kampus: r.kampus, stok: r.qty });
  }

  const kartlar = rows.map((r) => ({
    ...r,
    stok: urunStogu(r.id),
    kampuslar: kampusDagilimi.get(r.id) || [],
    norm: normalizeTr(r.name),
  }));

  const topla = (anahtarFn) => {
    const grup = new Map();
    for (const k of kartlar) {
      const a = anahtarFn(k);
      if (!a) continue;
      if (!grup.has(a)) grup.set(a, []);
      grup.get(a).push(k);
    }
    return grup;
  };

  // 1) Birebir ayni ad — kesin mukerrer
  const items = [];
  const birebirAdlar = new Set();
  for (const [anahtar, grup] of topla((k) => k.norm)) {
    if (grup.length < 2) continue;
    birebirAdlar.add(anahtar);
    items.push({ anahtar, kartlar: grup.sort((a, b) => b.stok - a.stok) });
  }

  // 2) Ayni cekirdek, FARKLI yazim — aday
  const benzerler = [];
  for (const [anahtar, grup] of topla((k) => urunCekirdegi(k.name))) {
    if (grup.length < 2) continue;
    // Hepsi ayni adi tasiyorsa bu zaten birinci listede
    if (new Set(grup.map((k) => k.norm)).size < 2) continue;
    benzerler.push({ anahtar, kartlar: grup.sort((a, b) => b.stok - a.stok) });
  }

  const stokluOnce = (a, b) => {
    const s = (g) => g.kartlar.filter((k) => k.stok > 0).length;
    return (s(b) - s(a)) || (b.kartlar.length - a.kartlar.length);
  };
  items.sort(stokluOnce);
  benzerler.sort(stokluOnce);
  return { items, benzerler };
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
/* ===================== MUKERRER KART BIRLESTIRME ==================== */
/**
 * AYNI URUN ICIN ACILMIS IKINCI KART BIRLESTIRILIR.
 *
 * Sahadan gelen durum: Istanbul OSB katalogunda 15 urun adi birden fazla
 * kartta duruyordu; besinde IKI KARTTA BIRDEN stok vardi (ornegin
 * "GUZELPINAR 0.5 CC PET SU" 6912 + 2016). Sebebi, faturadaki ad tam
 * eslesmeyince yeni kart acilmasi. Sonuc: stok ikiye bolunuyor, sayim
 * mutabakati tutmuyor, karlilik yanlis cikiyor.
 *
 * Kartlari elle silmek mumkun degil: ikisinin de gecmisi (fatura satirlari,
 * stok hareketleri, sayimlar) var ve silme kisitli. Bu yuzden TASIYARAK
 * birlestirir: kaynak kartin her kaydi hedef karta baglanir, bosalan kart
 * silinir.
 *
 * Yetki: veri girisini yapan roller de duzeltebilsin diye ON MUHASEBE ve
 * KAMPUS YONETICISI de dahildir (hatayi yapan duzeltsin). Islem geri
 * alinamaz; bu yuzden once onizleme verilir ve her birlestirme denetim
 * izine tam dokumuyle yazilir.
 */
const TASINAN_TABLOLAR = [
  // [tablo, sutun, cakisma anahtari, cakismada TOPLANACAK sutunlar,
  //  birim cevriminde CARPILACAK (miktar), BOLUNECEK (birim fiyat)]
  //
  // Tutar sutunlari (net_total, sales_value...) BILEREK disaridadir:
  // miktar N ile carpilip birim fiyat N'e bolununce tutar degismez.
  ['stock_movements', 'product_id', null, null, ['quantity'], ['unit_cost']],
  ['purchase_lines', 'product_id', null, null, ['quantity'], ['unit_price']],
  ['supplier_return_lines', 'product_id', null, null, ['quantity'], ['unit_price']],
  ['waste_records', 'product_id', null, null, ['quantity'], ['unit_cost']],
  ['transfer_lines', 'product_id', null, null, ['quantity'], ['unit_cost']],
  ['price_history', 'product_id', null, null, [], ['old_purchase', 'new_purchase', 'old_sale', 'new_sale']],
  ['purchase_unmatched_lines', 'resolved_product_id', null, null, [], []],
  // Cevrim carpani "1 fatura birimi = kac STOK birimi" demektir; stok
  // birimi N kat kuculurse carpan da N katina cikar.
  ['product_aliases', 'product_id', null, null, ['factor'], []],
  ['campus_products', 'product_id', 'campus_id', null,
    ['critical_stock'], ['purchase_price', 'sale_price']],
  ['product_prices', 'product_id', 'effective_from', null, [], ['sale_price']],
  ['count_lines', 'product_id', 'count_id',
    ['expected_qty', 'counted_qty', 'diff_qty', 'recipe_qty', 'sold_qty', 'sales_value', 'cost_value'],
    ['expected_qty', 'counted_qty', 'diff_qty', 'recipe_qty', 'sold_qty'], ['purchase_price', 'sale_price']],
  ['production_sales', 'product_id', 'count_id', ['quantity', 'sales_value', 'cost_value'],
    ['quantity'], ['purchase_price', 'sale_price']],
  ['recipe_items', 'ingredient_id', 'recipe_id', ['quantity'], ['quantity'], []],
  // yield_quantity = bir recete kac BIRIM urun uretir; birim kuculurse artar
  ['recipes', 'product_id', null, null, ['yield_quantity'], []],
];

/**
 * BIR URUNUN TUM KAYITLARINI BASKA BIRIME CEVIRIR.
 *
 * Kart "PAKET" tutuyorken stoga 72 yazilmissa ve bir kolide 24 adet
 * varsa, ADET'e gecince bu 1728 olmalidir. Miktarlar carpanla CARPILIR,
 * birim fiyatlar BOLUNUR; tutarlar oldugu gibi kalir (ikisi birbirini
 * goturur). Kritik stok seviyesi de miktardir, o da carpilir.
 *
 * Boyle bir cevrim olmadan "PAKET" kartla "ADET" kart birlestirilirse
 * 72 + 36 = 108 gibi anlamsiz bir stok cikar.
 */
function birimCevir(urunId, carpan) {
  if (!(carpan > 0) || carpan === 1) return;
  for (const [tablo, sutun, , , carpilan, bolunen] of TASINAN_TABLOLAR) {
    // Miktar 3, birim fiyat 6 haneye yuvarlanir: 2 hane olsa 24'e bolunen
    // bir birim fiyatta kurus kaybi tutari bozardi.
    const set = [
      ...carpilan.map((c) => `${c} = ROUND(${c} * ?, 3)`),
      ...bolunen.map((c) => `${c} = ROUND(${c} / ?, 6)`),
    ];
    if (!set.length) continue;
    run(`UPDATE ${tablo} SET ${set.join(', ')} WHERE ${sutun} = ?`,
      [...carpilan.map(() => carpan), ...bolunen.map(() => carpan), urunId]);
  }
  // max_price resmi tarifedeki TAVAN BIRIM fiyattir; 0 ise 0 kalir
  run('UPDATE products SET purchase_price = ROUND(purchase_price / ?, 6), '
    + 'sale_price = ROUND(sale_price / ?, 6), max_price = ROUND(max_price / ?, 6), '
    + 'critical_stock = ROUND(critical_stock * ?, 3) '
    + 'WHERE id = ?', [carpan, carpan, carpan, carpan, urunId]);
}

/** Bir urunun TUM kampuslardaki stok bakiyesi (birlestirme onizlemesi icin). */
function urunStogu(urunId) {
  return round2(
    get('SELECT COALESCE(SUM(quantity), 0) AS q FROM stock_movements WHERE product_id = ?', [urunId])?.q ?? 0
  );
}

const BIRIMLER = ['ADET', 'KG', 'LT', 'PAKET', 'KUTU', 'PORSIYON'];

/** Icinde tek tek adet bulunan, yani ADET'e cevrilmesi gereken birimler. */
const AMBALAJ_BIRIMLERI = new Set(['PAKET', 'KUTU']);

/**
 * URUN ADINDAN AMBALAJ ADEDI IPUCU CIKARIR.
 *
 * Kullaniciya "1 PAKET = kac ADET?" diye sorarken bos bir kutu
 * gostermek yerine addaki rakami onerir. Sahadan:
 *
 *   "DUCAT SICAK ÇİKOLATA*10"        -> 10
 *   "Ducat Sıcak Çikolata 10 Lu"     -> 10
 *   "CRAX ACI BAHARATLI 50GX20KL"    -> 20   (50 g degil, 20 koli adedi)
 *   "SÜT 180 ML"                     -> (yok)
 *
 * IPUCUDUR, karar degil: arayuzde onay istenir.
 */
function adAdetIpucu(ad) {
  const t = normalizeTr(String(ad || '').replace(/\*/g, ' x '));
  const bulunan = new Set();
  for (const m of t.matchAll(/x\s*(\d{1,3})/g)) bulunan.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*l[uiy]\b/g)) bulunan.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*adet/g)) bulunan.add(Number(m[1]));
  return [...bulunan].filter((n) => n >= 2 && n <= 500).sort((a, b) => a - b);
}

/**
 * Birlestirmede kullanilacak birim ve cevrim carpanlarini okur/dogrular.
 *
 * Stok sayimi ADET uzerinden yapildigi icin birlesen kartin birimi de
 * ADET olmalidir. Kartlardan biri PAKET/KUTU tutuyorsa miktarlar oldugu
 * gibi toplanamaz: "1 PAKET = kac ADET" bilgisi SART. Bu bilgi
 * gelmediyse islem HIC yapilmaz -- yanlis toplamak, hic toplamamaktan
 * kotudur.
 */
function cevrimOku(body, hedef, kaynak) {
  const hedefBirim = oneOf(body.hedefBirim, 'Birlesince birim', BIRIMLER,
    { def: hedef.unit || 'ADET' });
  const hedefCarpan = num(body.hedefCarpan, `1 ${hedef.unit} = kac ${hedefBirim}`,
    { min: 0.000001, def: 1 });
  const kaynakCarpan = num(body.kaynakCarpan, `1 ${kaynak.unit} = kac ${hedefBirim}`,
    { min: 0.000001, def: 1 });

  for (const [kart, carpan] of [[hedef, hedefCarpan], [kaynak, kaynakCarpan]]) {
    if ((kart.unit || '') !== hedefBirim && carpan === 1) {
      throw badRequest(
        `"${kart.name}" kartinin birimi ${kart.unit}, birlesince ${hedefBirim} olacak. `
        + `Miktarlarin dogru toplanmasi icin 1 ${kart.unit} = kac ${hedefBirim} oldugunu girin.`
      );
    }
  }
  return { hedefBirim, hedefCarpan, kaynakCarpan };
}

/** Birlestirmede tasinacak kayitlari sayar; hem onizleme hem denetim icin. */
function birlestirmeDokumu(kaynakId) {
  const d = {};
  for (const [tablo, sutun] of TASINAN_TABLOLAR) {
    const n = get(`SELECT COUNT(*) AS n FROM ${tablo} WHERE ${sutun} = ?`, [kaynakId])?.n ?? 0;
    if (n) d[tablo] = n;
  }
  return d;
}

/** Iki kartin birlestirilmesine engel var mi? */
function birlestirmeEngeli(hedef, kaynak) {
  if (hedef.id === kaynak.id) return 'Bir kart kendisiyle birlestirilemez.';
  // recipes.product_id TEKILDIR: iki recete tek urunde bulusamaz
  const hr = get('SELECT id FROM recipes WHERE product_id = ?', [hedef.id]);
  const kr = get('SELECT id FROM recipes WHERE product_id = ?', [kaynak.id]);
  if (hr && kr) {
    return 'Her iki urunun de recetesi var. Once birini (Urunler -> Recete) silin, sonra birlestirin.';
  }
  return null;
}

/** Birlestirme onizlemesi: ne tasinacak, neye dikkat edilmeli. */
productRoutes.get('/:id/birlestirme-onizleme', async (ctx) => {
  requireWrite(ctx.user, 'products');
  const hedef = get('SELECT * FROM products WHERE id = ?', [Number(ctx.params.id)]);
  const kaynak = get('SELECT * FROM products WHERE id = ?', [Number(ctx.query.kaynakId)]);
  if (!hedef || !kaynak) throw notFound('Urun bulunamadi.');

  const birimlerFarkli = (hedef.unit || '') !== (kaynak.unit || '');
  const uyarilar = [];
  if (birimlerFarkli) {
    uyarilar.push(
      `Birimler FARKLI: "${hedef.name}" ${hedef.unit}, "${kaynak.name}" ${kaynak.unit}. `
      + 'Stok ADET uzerinden tutuldugu icin asagida birlesik birimi secin ve '
      + 'cevrim adedini (1 PAKET = kac ADET) girin; miktarlar cevrilerek toplanir.'
    );
  }
  if (hedef.vat_rate !== kaynak.vat_rate) {
    uyarilar.push(`KDV oranlari farkli (%${hedef.vat_rate} / %${kaynak.vat_rate}). Hedef kartin orani gecerli olacak.`);
  }
  if (kaynak.barcode && hedef.barcode && kaynak.barcode !== hedef.barcode) {
    uyarilar.push(`Iki kartin da barkodu var; "${kaynak.barcode}" silinecek, "${hedef.barcode}" kalacak.`);
  }
  const kart = (u) => ({
    id: u.id, name: u.name, unit: u.unit, barcode: u.barcode, stok: urunStogu(u.id),
    adAdedi: adAdetIpucu(u.name),
  });
  return {
    hedef: kart(hedef),
    kaynak: kart(kaynak),
    birimler: BIRIMLER,
    // Sayim ADET ile yapiliyor: biri ADET ise onda birlesmek dogrudur,
    // ikisi de ambalaj birimiyse yine ADET onerilir.
    onerilenBirim: hedef.unit === 'ADET' || kaynak.unit === 'ADET' ? 'ADET'
      : (AMBALAJ_BIRIMLERI.has(hedef.unit) && AMBALAJ_BIRIMLERI.has(kaynak.unit) ? 'ADET' : hedef.unit),
    cevrimGerekli: birimlerFarkli,
    tasinacak: birlestirmeDokumu(kaynak.id),
    engel: birlestirmeEngeli(hedef, kaynak),
    uyarilar,
  };
});

/**
 * Kaynak karti hedef kartin icine tasir ve siler.
 *
 * Cakisma kurali: ayni anahtari (ayni kampus / ayni sayim / ayni recete)
 * iki kart da tasiyorsa, MIKTAR ICEREN tablolarda degerler TOPLANIR
 * (ayni urun iki kartta sayildiysa gercek miktar ikisinin toplamidir),
 * fiyat/tanim tablolarinda HEDEFIN degeri korunur.
 */
productRoutes.post('/:id/birlestir', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK', 'MUHASEBE', 'KAMPUS_YONETICISI');
  const hedefId = Number(ctx.params.id);
  const kaynakId = int(ctx.body.kaynakId, 'Birlestirilecek urun', { required: true });
  const hedef = get('SELECT * FROM products WHERE id = ?', [hedefId]);
  const kaynak = get('SELECT * FROM products WHERE id = ?', [kaynakId]);
  if (!hedef || !kaynak) throw notFound('Urun bulunamadi.');

  const engel = birlestirmeEngeli(hedef, kaynak);
  if (engel) throw conflict(engel);

  const { hedefBirim, hedefCarpan, kaynakCarpan } = cevrimOku(ctx.body, hedef, kaynak);
  const dokum = birlestirmeDokumu(kaynakId);
  const stokOnce = { hedef: urunStogu(hedefId), kaynak: urunStogu(kaynakId) };

  tx(() => {
    // Cevrim TASIMADAN ONCE yapilir: kayitlar henuz kendi kartindadir.
    birimCevir(hedefId, hedefCarpan);
    birimCevir(kaynakId, kaynakCarpan);

    for (const [tablo, sutun, anahtar, toplanan] of TASINAN_TABLOLAR) {
      if (!anahtar) {
        run(`UPDATE ${tablo} SET ${sutun} = ? WHERE ${sutun} = ?`, [hedefId, kaynakId]);
        continue;
      }
      // Cakisanlari once hallet: ayni anahtarda hedefin de kaydi var mi?
      const cakisan = all(
        `SELECT k.* FROM ${tablo} k
          WHERE k.${sutun} = ?
            AND EXISTS (SELECT 1 FROM ${tablo} h WHERE h.${sutun} = ? AND h.${anahtar} = k.${anahtar})`,
        [kaynakId, hedefId]
      );
      for (const satir of cakisan) {
        if (toplanan) {
          // Ayni urun iki kart altinda sayilmis: gercek miktar toplamdir
          const set = toplanan.map((c) => `${c} = ${c} + ?`).join(', ');
          run(`UPDATE ${tablo} SET ${set} WHERE ${sutun} = ? AND ${anahtar} = ?`,
            [...toplanan.map((c) => satir[c] ?? 0), hedefId, satir[anahtar]]);
        }
        run(`DELETE FROM ${tablo} WHERE ${sutun} = ? AND ${anahtar} = ?`, [kaynakId, satir[anahtar]]);
      }
      run(`UPDATE ${tablo} SET ${sutun} = ? WHERE ${sutun} = ?`, [hedefId, kaynakId]);
    }

    // Barkod TEKILDIR: kaynaginki hedefte bos yer varsa tasinir, yoksa gider
    if (kaynak.barcode && !hedef.barcode) {
      run('UPDATE products SET barcode = NULL WHERE id = ?', [kaynakId]);
      run('UPDATE products SET barcode = ? WHERE id = ?', [kaynak.barcode, hedefId]);
    }
    run('UPDATE products SET unit = ? WHERE id = ?', [hedefBirim, hedefId]);
    run('DELETE FROM products WHERE id = ?', [kaynakId]);
  });

  const stokSonra = urunStogu(hedefId);
  logAudit({
    user: ctx.user, action: 'MERGE', entity: 'products', entityId: hedefId,
    detail: {
      islem: 'mukerrer-kart-birlestirildi',
      kalan: { id: hedef.id, ad: hedef.name, birim: hedefBirim, eskiBirim: hedef.unit, carpan: hedefCarpan },
      silinen: {
        id: kaynak.id, ad: kaynak.name, birim: kaynak.unit, carpan: kaynakCarpan,
        barkod: kaynak.barcode || undefined,
      },
      stok: { hedefOnce: stokOnce.hedef, kaynakOnce: stokOnce.kaynak, sonra: stokSonra },
      tasinanKayitlar: dokum,
    },
    ip: ctx.ip,
  });
  return {
    ok: true,
    hedef: get('SELECT * FROM products WHERE id = ?', [hedefId]),
    tasinan: dokum,
    stok: { ...stokOnce, sonra: stokSonra },
    birim: hedefBirim,
  };
});

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
