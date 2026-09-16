import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, badRequest, sendCsv, toCsv, conflict } from '../lib/http.js';
import { requireWrite, assertCampusAccess, campusFilter } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, date, arr, today, oneOf } from '../lib/validate.js';
import { stockSnapshot, movementLedger, addMovement, effectivePrices, stockValue } from '../lib/stock.js';
import { productProfit, round2 } from '../lib/money.js';

export const stockRoutes = new Router();

/* ------------------------- Stok durumu ---------------------------- */
stockRoutes.get('/', async (ctx) => {
  const campusId = assertCampusAccess(ctx.user, ctx.query.campusId);
  const rows = stockSnapshot(campusId, {
    untilDate: ctx.query.date || null,
    onlyActive: ctx.query.onlyActive !== '0',
    search: ctx.query.search || null,
    categoryId: ctx.query.categoryId || null,
  }).map((r) => {
    const profit = productProfit(r.purchase_price, r.sale_price, r.vat_rate);
    return {
      ...r,
      profit,
      stock_cost_value: round2(r.stock_qty * r.purchase_price),
      stock_sale_value: round2(r.stock_qty * r.sale_price),
      is_critical: r.critical_stock > 0 && r.stock_qty <= r.critical_stock,
    };
  });

  const filtered = ctx.query.onlyCritical === '1' ? rows.filter((r) => r.is_critical) : rows;

  if (ctx.query.format === 'csv') {
    return sendCsv(ctx.res, 'stok-durumu.csv', toCsv(filtered, [
      { label: 'Barkod', key: 'barcode' },
      { label: 'Ürün', key: 'name' },
      { label: 'Kategori', key: 'category_name' },
      { label: 'Birim', key: 'unit' },
      { label: 'Stok', value: (r) => tr(r.stock_qty) },
      { label: 'Kritik Seviye', value: (r) => tr(r.critical_stock) },
      { label: 'Alış', value: (r) => tr(r.purchase_price) },
      { label: 'Satış', value: (r) => tr(r.sale_price) },
      { label: 'Birim Kâr', value: (r) => tr(r.profit.unitProfit) },
      { label: 'Kâr Marjı %', value: (r) => tr(r.profit.marginPct) },
      { label: 'Stok Maliyeti', value: (r) => tr(r.stock_cost_value) },
    ]));
  }

  return {
    items: filtered,
    summary: stockValue(campusId, ctx.query.date || null),
  };
});

stockRoutes.get('/movements', async (ctx) => {
  const campusId = assertCampusAccess(ctx.user, ctx.query.campusId);
  const productId = int(ctx.query.productId, 'Urun', { required: true });
  return {
    items: movementLedger(campusId, productId, {
      from: ctx.query.from || null,
      to: ctx.query.to || null,
      limit: Number(ctx.query.limit || 300),
    }),
  };
});

/* ---------------------- Acilis stogu girisi ----------------------- */
stockRoutes.post('/opening', async (ctx) => {
  requireWrite(ctx.user);
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const openingDate = date(ctx.body.date, 'Acilis tarihi', { def: today() });
  const lines = arr(ctx.body.lines, 'Satirlar', { required: true, min: 1 });

  const count = tx(() => {
    let n = 0;
    for (const [i, raw] of lines.entries()) {
      const productId = int(raw.productId, `Satir ${i + 1} urun`, { required: true });
      const quantity = num(raw.quantity, `Satir ${i + 1} miktar`, { required: true, min: 0 });
      if (quantity === 0) continue;
      const prices = effectivePrices(campusId, productId);
      if (!prices) throw badRequest(`Satir ${i + 1}: urun bulunamadi.`);
      addMovement({
        campusId, productId, type: 'ACILIS', quantity, unitCost: prices.purchase_price,
        date: openingDate, refType: 'opening', note: 'Acilis stogu', userId: ctx.user.id,
      });
      n += 1;
    }
    return n;
  });

  logAudit({ user: ctx.user, action: 'OPENING_STOCK', entity: 'stock_movements', campusId, detail: { count, openingDate }, ip: ctx.ip });
  return { ok: true, count };
});

/* ------------------ Excel'den toplu acilis stogu ------------------- */
/**
 * Sablondaki "Acilis Stogu" sekmesini iceri alir.
 * Urun barkod ile, barkod yoksa ad ile; kampus ise kodu ile eslestirilir.
 * Boylece kullanici id bilmek zorunda kalmaz.
 */
stockRoutes.post('/opening-import', async (ctx) => {
  requireWrite(ctx.user);
  const openingDate = date(ctx.body.date, 'Acilis tarihi', { def: today() });
  const items = arr(ctx.body.items, 'Satirlar', { required: true, min: 1 });
  if (items.length > 5000) throw badRequest('Tek seferde en fazla 5000 satir aktarilabilir.');

  const campuses = new Map(
    all('SELECT id, code, name FROM campuses').map((c) => [c.code.toLocaleUpperCase('tr'), c])
  );
  const result = { imported: 0, skipped: 0, errors: [], byCampus: {} };

  tx(() => {
    for (const [i, raw] of items.entries()) {
      const rowNo = raw.__row ?? i + 1;
      try {
        const code = str(raw.campusCode, `Satir ${rowNo} kampus kodu`, { required: true, max: 20 }).toLocaleUpperCase('tr');
        const campus = campuses.get(code);
        if (!campus) throw badRequest(`"${code}" kodlu kampus bulunamadi.`);
        assertCampusAccess(ctx.user, campus.id);

        const barcode = str(raw.barcode, 'Barkod', { max: 64 });
        const name = str(raw.productName, 'Urun adi', { max: 200 });
        const product = barcode
          ? get('SELECT * FROM products WHERE barcode = ?', [barcode])
          : (name ? get('SELECT * FROM products WHERE lower(name) = lower(?)', [name]) : null);
        if (!product) throw badRequest(`Urun bulunamadi (${barcode || name || '-'}). Once urun listesini yukleyin.`);

        const quantity = num(raw.quantity, `Satir ${rowNo} miktar`, { required: true, min: 0 });
        if (quantity === 0) { result.skipped += 1; continue; }

        assertNotLocked(campus.id, openingDate);

        const prices = effectivePrices(campus.id, product.id);
        addMovement({
          campusId: campus.id, productId: product.id, type: 'ACILIS', quantity,
          unitCost: prices?.purchase_price ?? product.purchase_price, date: openingDate,
          refType: 'opening', note: 'Excel ile acilis stogu', userId: ctx.user.id,
        });
        result.imported += 1;
        result.byCampus[campus.name] = (result.byCampus[campus.name] || 0) + 1;
      } catch (err) {
        result.errors.push({ row: rowNo, message: err.message });
      }
    }
  });

  logAudit({
    user: ctx.user, action: 'OPENING_STOCK', entity: 'stock_movements',
    detail: { imported: result.imported, errors: result.errors.length, openingDate }, ip: ctx.ip,
  });
  return result;
});

/* ----------------------------- Fire ------------------------------- */
export const wasteRoutes = new Router();

wasteRoutes.get('/', async (ctx) => {
  const f = campusFilter(ctx.user, 'w.campus_id', ctx.query.campusId);
  const params = [...f.params];
  let extra = '';
  if (ctx.query.from) { extra += ' AND w.waste_date >= ?'; params.push(ctx.query.from); }
  if (ctx.query.to) { extra += ' AND w.waste_date <= ?'; params.push(ctx.query.to); }

  const items = all(
    `SELECT w.*, p.name AS product_name, p.unit, k.name AS campus_name, u.full_name AS created_by_name,
            (w.quantity * w.unit_cost) AS cost_value
       FROM waste_records w
       JOIN products p ON p.id = w.product_id
       JOIN campuses k ON k.id = w.campus_id
       LEFT JOIN users u ON u.id = w.created_by
      WHERE 1 = 1 ${f.clause} ${extra}
      ORDER BY w.waste_date DESC, w.id DESC LIMIT ?`,
    [...params, Number(ctx.query.limit || 200)]
  );
  return { items, totalCost: round2(items.reduce((s, r) => s + r.cost_value, 0)) };
});

wasteRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user);
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const productId = int(ctx.body.productId, 'Urun', { required: true });
  const quantity = num(ctx.body.quantity, 'Miktar', { required: true, min: 0.001 });
  const reason = oneOf(ctx.body.reason, 'Fire nedeni', ['SKT', 'KIRILMA', 'BOZULMA', 'IKRAM', 'PERSONEL', 'DIGER'], { required: true });
  const wasteDate = date(ctx.body.wasteDate, 'Fire tarihi', { def: today() });
  const note = str(ctx.body.note, 'Aciklama', { max: 300 });

  const prices = effectivePrices(campusId, productId);
  if (!prices) throw badRequest('Urun bulunamadi.');
  assertNotLocked(campusId, wasteDate);

  const id = tx(() => {
    const wid = insert(
      `INSERT INTO waste_records (campus_id, product_id, quantity, reason, waste_date, unit_cost, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [campusId, productId, quantity, reason, wasteDate, prices.purchase_price, note, ctx.user.id]
    );
    addMovement({
      campusId, productId, type: 'FIRE', quantity: -quantity, unitCost: prices.purchase_price,
      date: wasteDate, refType: 'waste', refId: wid, note: `${reason}${note ? ' - ' + note : ''}`, userId: ctx.user.id,
    });
    return wid;
  });

  logAudit({ user: ctx.user, action: 'CREATE', entity: 'waste_records', entityId: id, campusId, detail: { productId, quantity, reason }, ip: ctx.ip });
  return get('SELECT * FROM waste_records WHERE id = ?', [id]);
});

/* --------------------------- Transfer ----------------------------- */
export const transferRoutes = new Router();

transferRoutes.get('/', async (ctx) => {
  const params = [];
  let clause = '';
  if (ctx.user.campusId && !['ADMIN', 'GENEL_MUDURLUK', 'DENETCI'].includes(ctx.user.role)) {
    clause = ' AND (t.from_campus_id = ? OR t.to_campus_id = ?)';
    params.push(ctx.user.campusId, ctx.user.campusId);
  }
  const items = all(
    `SELECT t.*, f.name AS from_campus_name, d.name AS to_campus_name, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM transfer_lines l WHERE l.transfer_id = t.id) AS line_count
       FROM transfers t
       JOIN campuses f ON f.id = t.from_campus_id
       JOIN campuses d ON d.id = t.to_campus_id
       LEFT JOIN users u ON u.id = t.created_by
      WHERE 1 = 1 ${clause}
      ORDER BY t.transfer_date DESC, t.id DESC LIMIT ?`,
    [...params, Number(ctx.query.limit || 100)]
  );
  return { items };
});

transferRoutes.get('/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const header = get(
    `SELECT t.*, f.name AS from_campus_name, d.name AS to_campus_name FROM transfers t
       JOIN campuses f ON f.id = t.from_campus_id JOIN campuses d ON d.id = t.to_campus_id WHERE t.id = ?`, [id]
  );
  if (!header) throw notFound('Transfer bulunamadi.');
  const lines = all(
    `SELECT l.*, p.name AS product_name, p.unit FROM transfer_lines l
       JOIN products p ON p.id = l.product_id WHERE l.transfer_id = ? ORDER BY l.id`, [id]
  );
  return { ...header, lines };
});

transferRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user);
  const fromCampusId = assertCampusAccess(ctx.user, ctx.body.fromCampusId);
  const toCampusId = int(ctx.body.toCampusId, 'Hedef kampus', { required: true });
  if (fromCampusId === toCampusId) throw badRequest('Kaynak ve hedef kampus ayni olamaz.');
  if (!get('SELECT id FROM campuses WHERE id = ?', [toCampusId])) throw badRequest('Hedef kampus bulunamadi.');

  const transferDate = date(ctx.body.transferDate, 'Transfer tarihi', { def: today() });
  const lines = arr(ctx.body.lines, 'Satirlar', { required: true, min: 1 });
  assertNotLocked(fromCampusId, transferDate);
  assertNotLocked(toCampusId, transferDate);

  const id = tx(() => {
    const tid = insert(
      'INSERT INTO transfers (from_campus_id, to_campus_id, transfer_date, note, created_by) VALUES (?, ?, ?, ?, ?)',
      [fromCampusId, toCampusId, transferDate, str(ctx.body.note, 'Aciklama', { max: 300 }), ctx.user.id]
    );
    for (const [i, raw] of lines.entries()) {
      const productId = int(raw.productId, `Satir ${i + 1} urun`, { required: true });
      const quantity = num(raw.quantity, `Satir ${i + 1} miktar`, { required: true, min: 0.001 });
      const prices = effectivePrices(fromCampusId, productId);
      if (!prices) throw badRequest(`Satir ${i + 1}: urun bulunamadi.`);
      insert('INSERT INTO transfer_lines (transfer_id, product_id, quantity, unit_cost) VALUES (?, ?, ?, ?)',
        [tid, productId, quantity, prices.purchase_price]);
      addMovement({ campusId: fromCampusId, productId, type: 'TRANSFER_CIKIS', quantity: -quantity,
        unitCost: prices.purchase_price, date: transferDate, refType: 'transfer', refId: tid, userId: ctx.user.id });
      addMovement({ campusId: toCampusId, productId, type: 'TRANSFER_GIRIS', quantity,
        unitCost: prices.purchase_price, date: transferDate, refType: 'transfer', refId: tid, userId: ctx.user.id });
    }
    return tid;
  });

  logAudit({ user: ctx.user, action: 'CREATE', entity: 'transfers', entityId: id, campusId: fromCampusId,
    detail: { toCampusId, transferDate, lineCount: lines.length }, ip: ctx.ip });
  return { id };
});

/**
 * Kesinlesmis bir sayimdan onceki tarihe geriye donuk hareket girilmesini engeller.
 * Aksi halde gecmis donem mutabakati sessizce bozulur.
 */
export function assertNotLocked(campusId, movementDate) {
  const locked = get(
    "SELECT count_date FROM counts WHERE campus_id = ? AND status = 'KESINLESMIS' AND count_date >= ? ORDER BY count_date LIMIT 1",
    [campusId, movementDate]
  );
  if (locked) {
    throw conflict(`${locked.count_date} tarihli kesinlesmis sayim var. Bu tarihten onceye kayit giremezsiniz.`);
  }
}

const tr = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
