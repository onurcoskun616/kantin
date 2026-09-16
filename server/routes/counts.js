/**
 * SAYIM (envanter) modulu - sistemin denetim cekirdegi.
 *
 * Mantik:
 *   Donem ornek satisi = (kayitlara gore olmasi gereken stok) - (fiilen sayilan stok)
 *   Beklenen ciro       = SUM(ornek satis x satis fiyati)
 *   Fark                = Gerceklesen ciro (gunluk ciro girisleri) - Beklenen ciro
 *
 * Fark eksi ise kantinde kayit disi cikis (kayip/kacak/eksik ciro beyani) vardir.
 * Fire, ikram ve transferler ayri kaydedildigi icin bu farka karismaz.
 */
import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, badRequest, conflict, sendCsv, toCsv } from '../lib/http.js';
import { requireWrite, assertCampusAccess, campusFilter, requireRole } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, date, arr, today } from '../lib/validate.js';
import { stockSnapshot, addMovement } from '../lib/stock.js';
import { round2, netFromGross, pctOf } from '../lib/money.js';

export const countRoutes = new Router();

/* ----------------------------- Listeleme --------------------------- */
countRoutes.get('/', async (ctx) => {
  const f = campusFilter(ctx.user, 'c.campus_id', ctx.query.campusId);
  const items = all(
    `SELECT c.*, k.name AS campus_name, u.full_name AS created_by_name, fu.full_name AS finalized_by_name,
            (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = c.id) AS line_count
       FROM counts c
       JOIN campuses k ON k.id = c.campus_id
       LEFT JOIN users u  ON u.id = c.created_by
       LEFT JOIN users fu ON fu.id = c.finalized_by
      WHERE 1 = 1 ${f.clause}
      ORDER BY c.count_date DESC, c.id DESC LIMIT ?`,
    [...f.params, Number(ctx.query.limit || 100)]
  );
  return { items: items.map(withVariance) };
});

/* ------------------------ Yeni sayim (taslak) ---------------------- */
countRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user);
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const countDate = date(ctx.body.countDate, 'Sayim tarihi', { def: today() });
  const note = str(ctx.body.note, 'Aciklama', { max: 500 });

  if (countDate > today()) throw badRequest('Gelecek tarihli sayim olusturulamaz.');

  const openDraft = get("SELECT id FROM counts WHERE campus_id = ? AND status = 'TASLAK'", [campusId]);
  if (openDraft) throw conflict(`Bu kampusta acik bir sayim taslagi var (#${openDraft.id}). Once onu tamamlayin veya silin.`);

  const last = lastFinalizedCount(campusId);
  if (last && countDate <= last.count_date) {
    throw badRequest(`Son kesinlesmis sayim ${last.count_date} tarihli. Sayim tarihi bundan sonra olmalidir.`);
  }
  const periodStart = last ? addDays(last.count_date, 1) : null;

  const countId = tx(() => {
    const id = insert(
      'INSERT INTO counts (campus_id, count_date, period_start, status, note, created_by) VALUES (?, ?, ?, ?, ?, ?)',
      [campusId, countDate, periodStart, 'TASLAK', note, ctx.user.id]
    );
    // Sayim fisini urunlerle onceden doldur
    for (const p of stockSnapshot(campusId, { untilDate: countDate })) {
      insert(
        `INSERT INTO count_lines (count_id, product_id, expected_qty, counted_qty, diff_qty, sold_qty,
                                  purchase_price, sale_price, vat_rate)
         VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)`,
        [id, p.product_id, p.stock_qty, p.purchase_price, p.sale_price, p.vat_rate]
      );
    }
    return id;
  });

  logAudit({ user: ctx.user, action: 'CREATE', entity: 'counts', entityId: countId, campusId, detail: { countDate }, ip: ctx.ip });
  return loadCount(countId);
});

/* --------------------------- Sayim detayi -------------------------- */
countRoutes.get('/:id', async (ctx) => {
  const data = loadCount(Number(ctx.params.id));
  assertCampusAccess(ctx.user, data.campus_id);
  if (ctx.query.format === 'csv') {
    return sendCsv(ctx.res, `sayim-${data.id}.csv`, toCsv(data.lines, [
      { label: 'Barkod', key: 'barcode' },
      { label: 'Ürün', key: 'product_name' },
      { label: 'Birim', key: 'unit' },
      { label: 'Olması Gereken', value: (r) => tr(r.expected_qty) },
      { label: 'Sayılan', value: (r) => tr(r.counted_qty) },
      { label: 'Fark', value: (r) => tr(r.diff_qty) },
      { label: 'Dönem Satışı', value: (r) => tr(r.sold_qty) },
      { label: 'Satış Fiyatı', value: (r) => tr(r.sale_price) },
      { label: 'Satış Tutarı', value: (r) => tr(r.sales_value) },
      { label: 'Maliyet', value: (r) => tr(r.cost_value) },
    ]));
  }
  return data;
});

/* ----------------------- Sayilan miktar girisi --------------------- */
countRoutes.put('/:id/lines', async (ctx) => {
  requireWrite(ctx.user);
  const countId = Number(ctx.params.id);
  const header = get('SELECT * FROM counts WHERE id = ?', [countId]);
  if (!header) throw notFound('Sayim bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  if (header.status === 'KESINLESMIS') throw conflict('Kesinlesmis sayim degistirilemez.');

  const lines = arr(ctx.body.lines, 'Satirlar', { required: true, min: 1 });
  let updated = 0;
  tx(() => {
    for (const [i, raw] of lines.entries()) {
      const productId = int(raw.productId, `Satir ${i + 1} urun`, { required: true });
      const countedQty = num(raw.countedQty, `Satir ${i + 1} sayilan`, { required: true, min: 0 });
      const existing = get('SELECT * FROM count_lines WHERE count_id = ? AND product_id = ?', [countId, productId]);
      if (existing) {
        run('UPDATE count_lines SET counted_qty = ?, diff_qty = ? WHERE id = ?',
          [countedQty, round2(countedQty - existing.expected_qty), existing.id]);
      } else {
        // Sayim acildiktan sonra eklenmis urun
        const snap = stockSnapshot(header.campus_id, { untilDate: header.count_date })
          .find((p) => p.product_id === productId);
        if (!snap) throw badRequest(`Satir ${i + 1}: urun bulunamadi.`);
        insert(
          `INSERT INTO count_lines (count_id, product_id, expected_qty, counted_qty, diff_qty, sold_qty,
                                    purchase_price, sale_price, vat_rate)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [countId, productId, snap.stock_qty, countedQty, round2(countedQty - snap.stock_qty),
           snap.purchase_price, snap.sale_price, snap.vat_rate]
        );
      }
      updated += 1;
    }
  });
  return { ok: true, updated };
});

/* ----------------------------- Kesinlestir -------------------------- */
countRoutes.post('/:id/finalize', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI');
  const countId = Number(ctx.params.id);
  const header = get('SELECT * FROM counts WHERE id = ?', [countId]);
  if (!header) throw notFound('Sayim bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  if (header.status === 'KESINLESMIS') throw conflict('Sayim zaten kesinlesmis.');

  const result = tx(() => {
    const lines = all('SELECT * FROM count_lines WHERE count_id = ?', [countId]);
    // Olmasi gereken stoklari kesinlestirme aninda yeniden hesapla
    const snap = new Map(stockSnapshot(header.campus_id, { untilDate: header.count_date, onlyActive: false })
      .map((p) => [p.product_id, p]));

    let expectedRevenue = 0;
    let cogsTotal = 0;

    for (const line of lines) {
      const s = snap.get(line.product_id);
      const expected = round2(s ? s.stock_qty : line.expected_qty);
      const counted = round2(line.counted_qty);
      const diff = round2(counted - expected);
      const sold = round2(expected - counted);
      const salesValue = round2(sold * line.sale_price);
      const costValue = round2(sold * line.purchase_price);

      run(
        `UPDATE count_lines SET expected_qty = ?, diff_qty = ?, sold_qty = ?, sales_value = ?, cost_value = ?
          WHERE id = ?`,
        [expected, diff, sold, salesValue, costValue, line.id]
      );
      expectedRevenue += salesValue;
      cogsTotal += costValue;

      if (diff !== 0) {
        addMovement({
          campusId: header.campus_id,
          productId: line.product_id,
          type: diff < 0 ? 'SATIS' : 'SAYIM_FAZLA',
          quantity: diff,
          unitCost: line.purchase_price,
          date: header.count_date,
          refType: 'count',
          refId: countId,
          note: diff < 0 ? 'Sayim ile hesaplanan donem satisi' : 'Sayimda fazla cikan',
          userId: ctx.user.id,
        });
      }
    }

    const actualRevenue = periodRevenue(header.campus_id, header.period_start, header.count_date);
    run(
      `UPDATE counts SET status = 'KESINLESMIS', finalized_by = ?, finalized_at = datetime('now'),
              expected_revenue = ?, actual_revenue = ?, cogs_total = ? WHERE id = ?`,
      [ctx.user.id, round2(expectedRevenue), round2(actualRevenue), round2(cogsTotal), countId]
    );
    return { expectedRevenue: round2(expectedRevenue), actualRevenue: round2(actualRevenue), cogsTotal: round2(cogsTotal) };
  });

  logAudit({ user: ctx.user, action: 'FINALIZE', entity: 'counts', entityId: countId, campusId: header.campus_id, detail: result, ip: ctx.ip });
  return loadCount(countId);
});

/* ------------------------------ Silme ------------------------------ */
countRoutes.delete('/:id', async (ctx) => {
  requireWrite(ctx.user);
  const countId = Number(ctx.params.id);
  const header = get('SELECT * FROM counts WHERE id = ?', [countId]);
  if (!header) throw notFound('Sayim bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  if (header.status === 'KESINLESMIS') throw conflict('Kesinlesmis sayim silinemez.');
  run('DELETE FROM counts WHERE id = ?', [countId]);
  logAudit({ user: ctx.user, action: 'DELETE', entity: 'counts', entityId: countId, campusId: header.campus_id, ip: ctx.ip });
  return { ok: true };
});

/* ------------------------- Mutabakat raporu ------------------------ */
countRoutes.get('/:id/reconciliation', async (ctx) => {
  const countId = Number(ctx.params.id);
  const data = loadCount(countId);
  assertCampusAccess(ctx.user, data.campus_id);

  const from = data.period_start || firstMovementDate(data.campus_id) || data.count_date;
  const to = data.count_date;

  const revenue = get(
    `SELECT COALESCE(SUM(total_amount), 0) AS total,
            COALESCE(SUM(cash_amount), 0)  AS cash,
            COALESCE(SUM(card_amount), 0)  AS card,
            COALESCE(SUM(credit_amount), 0) AS credit,
            COUNT(*) AS day_count,
            COALESCE(SUM(is_school_day), 0) AS school_days
       FROM daily_revenues WHERE campus_id = ? AND revenue_date BETWEEN ? AND ?`,
    [data.campus_id, from, to]
  );

  const purchases = get(
    `SELECT COALESCE(SUM(net_total), 0) AS net, COALESCE(SUM(gross_total), 0) AS gross, COUNT(*) AS doc_count
       FROM purchases WHERE campus_id = ? AND status <> 'IPTAL' AND document_date BETWEEN ? AND ?`,
    [data.campus_id, from, to]
  );

  const waste = get(
    `SELECT COALESCE(SUM(quantity * unit_cost), 0) AS cost, COUNT(*) AS record_count
       FROM waste_records WHERE campus_id = ? AND waste_date BETWEEN ? AND ?`,
    [data.campus_id, from, to]
  );

  const campus = get('SELECT * FROM campuses WHERE id = ?', [data.campus_id]);

  const expectedRevenue = data.status === 'KESINLESMIS'
    ? data.expected_revenue
    : round2(data.lines.reduce((s, l) => s + (l.expected_qty - l.counted_qty) * l.sale_price, 0));
  const cogs = data.status === 'KESINLESMIS'
    ? data.cogs_total
    : round2(data.lines.reduce((s, l) => s + (l.expected_qty - l.counted_qty) * l.purchase_price, 0));

  const actualRevenue = round2(revenue.total);
  const difference = round2(actualRevenue - expectedRevenue);
  const actualNet = round2(netFromGross(actualRevenue, weightedVat(data.lines)));
  const grossProfit = round2(actualNet - cogs);

  // En buyuk sapmaya sahip satirlar (denetim odagi)
  const topVariances = [...data.lines]
    .filter((l) => l.diff_qty !== 0)
    .map((l) => ({ ...l, variance_value: round2(l.diff_qty * l.sale_price) }))
    .sort((a, b) => Math.abs(b.variance_value) - Math.abs(a.variance_value))
    .slice(0, 20);

  return {
    count: { id: data.id, campusId: data.campus_id, campusName: data.campus_name, countDate: data.count_date, periodStart: data.period_start, status: data.status },
    period: { from, to, dayCount: revenue.day_count, schoolDays: revenue.school_days },
    revenue: {
      expected: expectedRevenue,
      actual: actualRevenue,
      difference,
      differencePct: pctOf(difference, expectedRevenue),
      cash: round2(revenue.cash),
      card: round2(revenue.card),
      credit: round2(revenue.credit),
    },
    profitability: {
      cogs,
      actualNet,
      grossProfit,
      grossMarginPct: pctOf(grossProfit, actualNet),
      theoreticalProfit: round2(data.lines.reduce(
        (s, l) => s + (l.expected_qty - l.counted_qty) * (netFromGross(l.sale_price, l.vat_rate) - l.purchase_price), 0
      )),
    },
    purchases: { netTotal: round2(purchases.net), grossTotal: round2(purchases.gross), documentCount: purchases.doc_count },
    waste: { costValue: round2(waste.cost), recordCount: waste.record_count },
    perStudent: campus.student_count > 0
      ? {
          studentCount: campus.student_count,
          revenuePerStudent: round2(actualRevenue / campus.student_count),
          dailyRevenuePerStudent: revenue.school_days > 0
            ? round2(actualRevenue / campus.student_count / revenue.school_days) : null,
        }
      : null,
    schoolShare: campus.rent_share_pct > 0
      ? { pct: campus.rent_share_pct, amount: round2(actualRevenue * campus.rent_share_pct / 100) }
      : null,
    topVariances,
    soldItems: [...data.lines]
      .filter((l) => l.expected_qty - l.counted_qty > 0)
      .map((l) => ({ ...l, sold: round2(l.expected_qty - l.counted_qty) }))
      .sort((a, b) => b.sold * b.sale_price - a.sold * a.sale_price)
      .slice(0, 30),
  };
});

/* ----------------------------- yardimcilar ------------------------- */
function loadCount(countId) {
  const header = get(
    `SELECT c.*, k.name AS campus_name, u.full_name AS created_by_name, fu.full_name AS finalized_by_name
       FROM counts c JOIN campuses k ON k.id = c.campus_id
       LEFT JOIN users u ON u.id = c.created_by LEFT JOIN users fu ON fu.id = c.finalized_by
      WHERE c.id = ?`, [countId]
  );
  if (!header) throw notFound('Sayim bulunamadi.');
  const lines = all(
    `SELECT l.*, p.name AS product_name, p.barcode, p.unit, cat.name AS category_name
       FROM count_lines l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN categories cat ON cat.id = p.category_id
      WHERE l.count_id = ? ORDER BY cat.sort_order, p.name COLLATE NOCASE`, [countId]
  );
  return withVariance({ ...header, lines });
}

function withVariance(row) {
  const difference = round2((row.actual_revenue || 0) - (row.expected_revenue || 0));
  return { ...row, difference, difference_pct: pctOf(difference, row.expected_revenue || 0) };
}

export function lastFinalizedCount(campusId, beforeDate = null) {
  const params = [campusId];
  let sql = "SELECT * FROM counts WHERE campus_id = ? AND status = 'KESINLESMIS'";
  if (beforeDate) { sql += ' AND count_date < ?'; params.push(beforeDate); }
  sql += ' ORDER BY count_date DESC, id DESC LIMIT 1';
  return get(sql, params);
}

function periodRevenue(campusId, from, to) {
  const params = [campusId, to];
  let sql = 'SELECT COALESCE(SUM(total_amount), 0) AS total FROM daily_revenues WHERE campus_id = ? AND revenue_date <= ?';
  if (from) { sql += ' AND revenue_date >= ?'; params.push(from); }
  return get(sql, params).total;
}

function firstMovementDate(campusId) {
  return get('SELECT MIN(movement_date) AS d FROM stock_movements WHERE campus_id = ?', [campusId])?.d || null;
}

/** Satirlarin satis tutarina gore agirlikli ortalama KDV orani. */
function weightedVat(lines) {
  let value = 0;
  let weighted = 0;
  for (const l of lines) {
    const v = Math.abs((l.expected_qty - l.counted_qty) * l.sale_price);
    value += v;
    weighted += v * l.vat_rate;
  }
  return value > 0 ? weighted / value : 10;
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const tr = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
