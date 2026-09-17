import { Router } from '../lib/router.js';
import { all, get } from '../db.js';
import { sendCsv, toCsv, badRequest } from '../lib/http.js';
import { assertCampusAccess, campusFilter, seesAllCampuses } from '../lib/auth.js';
import { today, monthRange } from '../lib/validate.js';
import { round2, pctOf, netFromGross, productProfit } from '../lib/money.js';
import { stockSnapshot, stockValue } from '../lib/stock.js';

export const reportRoutes = new Router();

/* ------------------------------ Panel ------------------------------ */
reportRoutes.get('/dashboard', async (ctx) => {
  const month = ctx.query.month || today().slice(0, 7);
  const { from, to } = monthRange(month);
  const campuses = seesAllCampuses(ctx.user)
    ? all('SELECT * FROM campuses WHERE is_active = 1 ORDER BY name COLLATE NOCASE')
    : all('SELECT * FROM campuses WHERE id = ?', [ctx.user.campusId ?? 0]);

  const cards = campuses.map((campus) => {
    const rev = get(
      `SELECT COALESCE(SUM(total_amount), 0) AS total, COUNT(*) AS days,
              COALESCE(SUM(is_school_day), 0) AS school_days
         FROM daily_revenues WHERE campus_id = ? AND revenue_date BETWEEN ? AND ?`,
      [campus.id, from, to]
    );
    const purch = get(
      `SELECT COALESCE(SUM(gross_total), 0) AS total FROM purchases
        WHERE campus_id = ? AND status <> 'IPTAL' AND document_date BETWEEN ? AND ?`,
      [campus.id, from, to]
    );
    const wasteRow = get(
      `SELECT COALESCE(SUM(quantity * unit_cost), 0) AS cost FROM waste_records
        WHERE campus_id = ? AND waste_date BETWEEN ? AND ?`, [campus.id, from, to]
    );
    const stock = stockValue(campus.id);
    const lastCount = get(
      `SELECT id, count_date, status, expected_revenue, actual_revenue FROM counts
        WHERE campus_id = ? ORDER BY count_date DESC, id DESC LIMIT 1`, [campus.id]
    );
    const openDraft = get("SELECT id, count_date FROM counts WHERE campus_id = ? AND status = 'TASLAK' LIMIT 1", [campus.id]);
    const missingDays = missingRevenueDays(campus.id, from, minDate(to, today()));

    const difference = lastCount && lastCount.status === 'KESINLESMIS'
      ? round2(lastCount.actual_revenue - lastCount.expected_revenue) : null;

    return {
      campusId: campus.id,
      campusName: campus.name,
      studentCount: campus.student_count,
      revenue: round2(rev.total),
      revenueDays: rev.days,
      schoolDays: rev.school_days,
      dailyAverage: rev.school_days > 0 ? round2(rev.total / rev.school_days) : 0,
      revenuePerStudent: campus.student_count > 0 ? round2(rev.total / campus.student_count) : null,
      purchaseTotal: round2(purch.total),
      wasteCost: round2(wasteRow.cost),
      stock,
      lastCount: lastCount ? { ...lastCount, difference, differencePct: pctOf(difference, lastCount.expected_revenue) } : null,
      openDraftCountId: openDraft?.id ?? null,
      missingRevenueDays: missingDays,
    };
  });

  return {
    month,
    period: { from, to },
    campuses: cards,
    totals: {
      revenue: round2(cards.reduce((s, c) => s + c.revenue, 0)),
      purchaseTotal: round2(cards.reduce((s, c) => s + c.purchaseTotal, 0)),
      wasteCost: round2(cards.reduce((s, c) => s + c.wasteCost, 0)),
      stockCostValue: round2(cards.reduce((s, c) => s + c.stock.costValue, 0)),
      criticalCount: cards.reduce((s, c) => s + c.stock.criticalCount, 0),
      studentCount: cards.reduce((s, c) => s + c.studentCount, 0),
    },
  };
});

/* ---------------------- Urun bazli satis/karlilik ------------------ */
reportRoutes.get('/product-sales', async (ctx) => {
  const f = campusFilter(ctx.user, 'c.campus_id', ctx.query.campusId);
  const { from, to } = rangeOf(ctx.query);

  const rows = all(
    `SELECT p.id AS product_id, p.name AS product_name, p.barcode, p.unit,
            cat.name AS category_name,
            SUM(l.sold_qty)                            AS sold_qty,
            SUM(l.sales_value)                         AS sales_value,
            SUM(l.cost_value)                          AS cost_value,
            AVG(l.sale_price)                          AS avg_sale_price,
            AVG(l.purchase_price)                      AS avg_purchase_price,
            AVG(l.vat_rate)                            AS vat_rate,
            COUNT(DISTINCT c.id)                       AS count_sessions
       FROM count_lines l
       JOIN counts   c   ON c.id = l.count_id AND c.status = 'KESINLESMIS'
       JOIN products p   ON p.id = l.product_id
       LEFT JOIN categories cat ON cat.id = p.category_id
      WHERE c.count_date BETWEEN ? AND ? ${f.clause}
      GROUP BY p.id
      HAVING SUM(l.sold_qty) <> 0
      ORDER BY sales_value DESC`,
    [from, to, ...f.params]
  );

  const items = rows.map((r) => {
    const salesNet = round2(netFromGross(r.sales_value, r.vat_rate));
    const profit = round2(salesNet - r.cost_value);
    return {
      ...r,
      sold_qty: round2(r.sold_qty),
      sales_value: round2(r.sales_value),
      sales_net: salesNet,
      cost_value: round2(r.cost_value),
      profit,
      margin_pct: pctOf(profit, salesNet),
      unit_profit: r.sold_qty ? round2(profit / r.sold_qty) : 0,
      avg_sale_price: round2(r.avg_sale_price),
      avg_purchase_price: round2(r.avg_purchase_price),
    };
  });

  const totals = items.reduce((a, r) => ({
    soldQty: a.soldQty + r.sold_qty,
    salesValue: a.salesValue + r.sales_value,
    salesNet: a.salesNet + r.sales_net,
    costValue: a.costValue + r.cost_value,
    profit: a.profit + r.profit,
  }), { soldQty: 0, salesValue: 0, salesNet: 0, costValue: 0, profit: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  totals.marginPct = pctOf(totals.profit, totals.salesNet);

  if (ctx.query.format === 'csv') {
    return sendCsv(ctx.res, `urun-satis-${from}_${to}.csv`, toCsv(items, [
      { label: 'Barkod', key: 'barcode' },
      { label: 'Ürün', key: 'product_name' },
      { label: 'Kategori', key: 'category_name' },
      { label: 'Satılan Adet', value: (r) => tr(r.sold_qty) },
      { label: 'Ort. Alış', value: (r) => tr(r.avg_purchase_price) },
      { label: 'Ort. Satış', value: (r) => tr(r.avg_sale_price) },
      { label: 'Ciro (KDV dahil)', value: (r) => tr(r.sales_value) },
      { label: 'Ciro (KDV hariç)', value: (r) => tr(r.sales_net) },
      { label: 'Maliyet', value: (r) => tr(r.cost_value) },
      { label: 'Kâr', value: (r) => tr(r.profit) },
      { label: 'Kâr Marjı %', value: (r) => tr(r.margin_pct) },
    ]));
  }
  return { period: { from, to }, items, totals };
});

/* ------------------------- Aylik ciro ozeti ------------------------ */
reportRoutes.get('/monthly', async (ctx) => {
  const f = campusFilter(ctx.user, 'r.campus_id', ctx.query.campusId);
  const { from, to } = rangeOf(ctx.query, 12);

  const revenue = all(
    `SELECT substr(r.revenue_date, 1, 7) AS month, r.campus_id, k.name AS campus_name,
            SUM(r.total_amount) AS revenue, SUM(r.cash_amount) AS cash, SUM(r.card_amount) AS card,
            SUM(r.credit_amount) AS credit, COUNT(*) AS day_count, SUM(r.is_school_day) AS school_days
       FROM daily_revenues r JOIN campuses k ON k.id = r.campus_id
      WHERE r.revenue_date BETWEEN ? AND ? ${f.clause}
      GROUP BY month, r.campus_id ORDER BY month DESC, k.name`,
    [from, to, ...f.params]
  );

  const fc = campusFilter(ctx.user, 'c.campus_id', ctx.query.campusId);
  const counted = all(
    `SELECT substr(c.count_date, 1, 7) AS month, c.campus_id,
            SUM(l.sold_qty) AS sold_qty, SUM(l.sales_value) AS expected_revenue, SUM(l.cost_value) AS cogs
       FROM count_lines l JOIN counts c ON c.id = l.count_id AND c.status = 'KESINLESMIS'
      WHERE c.count_date BETWEEN ? AND ? ${fc.clause}
      GROUP BY month, c.campus_id`,
    [from, to, ...fc.params]
  );
  const countedMap = new Map(counted.map((r) => [`${r.month}|${r.campus_id}`, r]));

  const pc = campusFilter(ctx.user, 'p.campus_id', ctx.query.campusId);
  const purchases = all(
    `SELECT substr(p.document_date, 1, 7) AS month, p.campus_id, SUM(p.gross_total) AS purchase_total
       FROM purchases p WHERE p.status <> 'IPTAL' AND p.document_date BETWEEN ? AND ? ${pc.clause}
      GROUP BY month, p.campus_id`,
    [from, to, ...pc.params]
  );
  const purchaseMap = new Map(purchases.map((r) => [`${r.month}|${r.campus_id}`, r.purchase_total]));

  const items = revenue.map((r) => {
    const key = `${r.month}|${r.campus_id}`;
    const c = countedMap.get(key);
    const expected = c ? round2(c.expected_revenue) : null;
    const difference = expected === null ? null : round2(r.revenue - expected);
    const cogs = c ? round2(c.cogs) : null;
    const salesNet = c && c.expected_revenue ? round2(netFromGross(r.revenue, 10)) : null;
    return {
      month: r.month,
      campusId: r.campus_id,
      campusName: r.campus_name,
      revenue: round2(r.revenue),
      cash: round2(r.cash),
      card: round2(r.card),
      credit: round2(r.credit),
      dayCount: r.day_count,
      schoolDays: r.school_days,
      dailyAverage: r.school_days > 0 ? round2(r.revenue / r.school_days) : 0,
      soldQty: c ? round2(c.sold_qty) : null,
      expectedRevenue: expected,
      difference,
      differencePct: pctOf(difference, expected),
      cogs,
      grossProfit: cogs === null ? null : round2((salesNet ?? 0) - cogs),
      purchaseTotal: round2(purchaseMap.get(key) || 0),
    };
  });

  if (ctx.query.format === 'csv') {
    return sendCsv(ctx.res, 'aylik-ozet.csv', toCsv(items, [
      { label: 'Ay', key: 'month' },
      { label: 'Kampüs', key: 'campusName' },
      { label: 'Ciro', value: (r) => tr(r.revenue) },
      { label: 'Gün Sayısı', key: 'schoolDays' },
      { label: 'Günlük Ortalama', value: (r) => tr(r.dailyAverage) },
      { label: 'Satılan Adet', value: (r) => tr(r.soldQty) },
      { label: 'Beklenen Ciro', value: (r) => tr(r.expectedRevenue) },
      { label: 'Fark', value: (r) => tr(r.difference) },
      { label: 'Fark %', value: (r) => tr(r.differencePct) },
      { label: 'Alım Tutarı', value: (r) => tr(r.purchaseTotal) },
    ]));
  }
  return { period: { from, to }, items };
});

/* ---------------------- Kampus karsilastirmasi --------------------- */
reportRoutes.get('/campus-comparison', async (ctx) => {
  const { from, to } = rangeOf(ctx.query);
  const campuses = seesAllCampuses(ctx.user)
    ? all('SELECT * FROM campuses WHERE is_active = 1 ORDER BY name COLLATE NOCASE')
    : all('SELECT * FROM campuses WHERE id = ?', [ctx.user.campusId ?? 0]);

  const items = campuses.map((k) => {
    const rev = get(
      `SELECT COALESCE(SUM(total_amount), 0) AS total, COALESCE(SUM(is_school_day), 0) AS school_days
         FROM daily_revenues WHERE campus_id = ? AND revenue_date BETWEEN ? AND ?`, [k.id, from, to]
    );
    const cnt = get(
      `SELECT COALESCE(SUM(l.sold_qty), 0) AS sold_qty, COALESCE(SUM(l.sales_value), 0) AS expected,
              COALESCE(SUM(l.cost_value), 0) AS cogs
         FROM count_lines l JOIN counts c ON c.id = l.count_id AND c.status = 'KESINLESMIS'
        WHERE c.campus_id = ? AND c.count_date BETWEEN ? AND ?`, [k.id, from, to]
    );
    const wasteRow = get(
      `SELECT COALESCE(SUM(quantity * unit_cost), 0) AS cost FROM waste_records
        WHERE campus_id = ? AND waste_date BETWEEN ? AND ?`, [k.id, from, to]
    );
    const revenue = round2(rev.total);
    const expected = round2(cnt.expected);
    const difference = expected > 0 ? round2(revenue - expected) : null;
    const salesNet = round2(netFromGross(revenue, 10));
    const grossProfit = cnt.cogs > 0 ? round2(salesNet - cnt.cogs) : null;
    return {
      campusId: k.id,
      campusName: k.name,
      studentCount: k.student_count,
      revenue,
      schoolDays: rev.school_days,
      dailyAverage: rev.school_days > 0 ? round2(revenue / rev.school_days) : 0,
      revenuePerStudent: k.student_count > 0 ? round2(revenue / k.student_count) : null,
      dailyPerStudent: k.student_count > 0 && rev.school_days > 0
        ? round2(revenue / k.student_count / rev.school_days) : null,
      soldQty: round2(cnt.sold_qty),
      expectedRevenue: expected,
      difference,
      differencePct: pctOf(difference, expected),
      cogs: round2(cnt.cogs),
      grossProfit,
      grossMarginPct: pctOf(grossProfit, salesNet),
      wasteCost: round2(wasteRow.cost),
      wastePct: pctOf(wasteRow.cost, revenue),
      schoolShare: k.rent_share_pct > 0 ? round2(revenue * k.rent_share_pct / 100) : null,
    };
  });

  if (ctx.query.format === 'csv') {
    return sendCsv(ctx.res, 'kampus-karsilastirma.csv', toCsv(items, [
      { label: 'Kampüs', key: 'campusName' },
      { label: 'Öğrenci', key: 'studentCount' },
      { label: 'Ciro', value: (r) => tr(r.revenue) },
      { label: 'Günlük Ortalama', value: (r) => tr(r.dailyAverage) },
      { label: 'Öğrenci Başına Ciro', value: (r) => tr(r.revenuePerStudent) },
      { label: 'Satılan Adet', value: (r) => tr(r.soldQty) },
      { label: 'Beklenen Ciro', value: (r) => tr(r.expectedRevenue) },
      { label: 'Fark', value: (r) => tr(r.difference) },
      { label: 'Brüt Kâr', value: (r) => tr(r.grossProfit) },
      { label: 'Kâr Marjı %', value: (r) => tr(r.grossMarginPct) },
      { label: 'Fire Maliyeti', value: (r) => tr(r.wasteCost) },
    ]));
  }
  return { period: { from, to }, items };
});

/* --------------------------- Fiyat denetimi ------------------------ */
reportRoutes.get('/price-control', async (ctx) => {
  const campusId = ctx.query.campusId ? assertCampusAccess(ctx.user, ctx.query.campusId) : (ctx.user.campusId || null);
  const minMargin = Number(ctx.query.minMargin || 20);

  const rows = all(
    `SELECT p.*, c.name AS category_name,
            cp.purchase_price AS campus_purchase_price, cp.sale_price AS campus_sale_price
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN campus_products cp ON cp.product_id = p.id AND cp.campus_id = ?
      WHERE p.is_active = 1 ORDER BY p.name COLLATE NOCASE`,
    [campusId ?? 0]
  );

  const items = rows.map((r) => {
    const purchase = r.campus_purchase_price ?? r.purchase_price;
    const sale = r.campus_sale_price ?? r.sale_price;
    const profit = productProfit(purchase, sale, r.vat_rate);
    const issues = [];
    if (sale <= 0) issues.push('Satis fiyati tanimsiz');
    if (purchase <= 0) issues.push('Alis fiyati tanimsiz');
    if (sale > 0 && purchase > 0 && profit.unitProfit < 0) issues.push('Zararina satis');
    if (sale > 0 && purchase > 0 && profit.marginPct < minMargin && profit.unitProfit >= 0) {
      issues.push(`Kar marji %${minMargin} altinda`);
    }
    if (r.max_price > 0 && sale > r.max_price) issues.push(`Tavan fiyat asimi (tavan: ${r.max_price})`);
    if (!r.meb_approved) issues.push('Yonetmelige uygun degil');
    return { ...r, effective_purchase_price: purchase, effective_sale_price: sale, profit, issues };
  }).filter((r) => r.issues.length > 0);

  return { minMargin, items };
});

/* ---------------------------- Kritik stok -------------------------- */
reportRoutes.get('/critical-stock', async (ctx) => {
  const campuses = seesAllCampuses(ctx.user)
    ? all('SELECT * FROM campuses WHERE is_active = 1 ORDER BY name')
    : all('SELECT * FROM campuses WHERE id = ?', [ctx.user.campusId ?? 0]);

  const items = [];
  for (const k of campuses) {
    for (const p of stockSnapshot(k.id)) {
      if (p.critical_stock > 0 && p.stock_qty <= p.critical_stock) {
        items.push({
          campusId: k.id, campusName: k.name,
          productId: p.product_id, productName: p.name, barcode: p.barcode, unit: p.unit,
          stockQty: round2(p.stock_qty), criticalStock: p.critical_stock,
          suggestedOrder: round2(Math.max(p.critical_stock * 2 - p.stock_qty, 0)),
        });
      }
    }
  }
  items.sort((a, b) => a.stockQty - b.stockQty);
  return { items };
});

/* ------------------------------ Fire ------------------------------- */
reportRoutes.get('/waste', async (ctx) => {
  const f = campusFilter(ctx.user, 'w.campus_id', ctx.query.campusId);
  const { from, to } = rangeOf(ctx.query);

  const byReason = all(
    `SELECT w.reason, SUM(w.quantity) AS qty, SUM(w.quantity * w.unit_cost) AS cost, COUNT(*) AS records
       FROM waste_records w WHERE w.waste_date BETWEEN ? AND ? ${f.clause}
      GROUP BY w.reason ORDER BY cost DESC`, [from, to, ...f.params]
  );
  const byProduct = all(
    `SELECT p.name AS product_name, p.unit, SUM(w.quantity) AS qty, SUM(w.quantity * w.unit_cost) AS cost
       FROM waste_records w JOIN products p ON p.id = w.product_id
      WHERE w.waste_date BETWEEN ? AND ? ${f.clause}
      GROUP BY p.id ORDER BY cost DESC LIMIT 30`, [from, to, ...f.params]
  );
  return {
    period: { from, to },
    byReason: byReason.map((r) => ({ ...r, qty: round2(r.qty), cost: round2(r.cost) })),
    byProduct: byProduct.map((r) => ({ ...r, qty: round2(r.qty), cost: round2(r.cost) })),
    totalCost: round2(byReason.reduce((s, r) => s + r.cost, 0)),
  };
});

/* -------------------------- Tedarikci alimi ------------------------ */
reportRoutes.get('/purchases-by-supplier', async (ctx) => {
  const f = campusFilter(ctx.user, 'p.campus_id', ctx.query.campusId);
  const { from, to } = rangeOf(ctx.query);
  const items = all(
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
            COUNT(DISTINCT p.id) AS document_count,
            SUM(p.net_total) AS net_total, SUM(p.vat_total) AS vat_total, SUM(p.gross_total) AS gross_total
       FROM purchases p JOIN suppliers s ON s.id = p.supplier_id
      WHERE p.status <> 'IPTAL' AND p.document_date BETWEEN ? AND ? ${f.clause}
      GROUP BY s.id ORDER BY gross_total DESC`, [from, to, ...f.params]
  );

  const rf = campusFilter(ctx.user, 'r.campus_id', ctx.query.campusId);
  const returnMap = new Map(all(
    `SELECT r.supplier_id, COUNT(*) AS document_count, SUM(r.gross_total) AS gross_total
       FROM supplier_returns r WHERE r.return_date BETWEEN ? AND ? ${rf.clause}
      GROUP BY r.supplier_id`, [from, to, ...rf.params]
  ).map((r) => [r.supplier_id, r]));

  const decorated = items.map((r) => {
    const ret = returnMap.get(r.supplier_id);
    const returnTotal = round2(ret?.gross_total ?? 0);
    return {
      ...r,
      net_total: round2(r.net_total), vat_total: round2(r.vat_total), gross_total: round2(r.gross_total),
      return_total: returnTotal,
      return_count: ret?.document_count ?? 0,
      net_purchase: round2(r.gross_total - returnTotal),
      return_pct: r.gross_total > 0 ? pctOf(returnTotal, r.gross_total) : null,
    };
  });

  return {
    period: { from, to },
    items: decorated,
    total: round2(items.reduce((s, r) => s + r.gross_total, 0)),
    returnTotal: round2(decorated.reduce((s, r) => s + r.return_total, 0)),
    netTotal: round2(decorated.reduce((s, r) => s + r.net_purchase, 0)),
  };
});

/* ---------------------------- yardimcilar -------------------------- */
function rangeOf(query, defaultMonths = 1) {
  if (query.month) return monthRange(query.month);
  const to = query.to || today();
  let from = query.from;
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - defaultMonths);
    from = d.toISOString().slice(0, 10);
  }
  if (from > to) throw badRequest('Baslangic tarihi bitis tarihinden sonra olamaz.');
  return { from, to };
}

function minDate(a, b) { return a < b ? a : b; }

/** Hafta ici olup ciro girilmemis gunler (veri butunlugu uyarisi). */
function missingRevenueDays(campusId, from, to) {
  const existing = new Set(
    all('SELECT revenue_date FROM daily_revenues WHERE campus_id = ? AND revenue_date BETWEEN ? AND ?', [campusId, from, to])
      .map((r) => r.revenue_date)
  );
  const missing = [];
  let cursor = from;
  while (cursor <= to) {
    const d = new Date(`${cursor}T00:00:00Z`);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6 && !existing.has(cursor)) missing.push(cursor);
    d.setUTCDate(d.getUTCDate() + 1);
    cursor = d.toISOString().slice(0, 10);
  }
  return missing;
}

const tr = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
