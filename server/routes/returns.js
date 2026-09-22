/**
 * TEDARIKCIYE IADE
 *
 * Fire ile karistirilmamalidir:
 *   FIRE  -> mal bizde bozuldu/kirildi; maliyeti kantin uzerinde kalir,
 *            fire raporuna girer.
 *   IADE  -> mal tedarikciye geri gonderildi; tedarikci alacaklandirir,
 *            maliyeti kantin uzerinde kalmaz, cari hesaptan dusulur.
 *
 * Her ikisi de stoktan ayni yonde duser; fark maliyetin kime yazildigidir.
 * Bu ayrim yapilmazsa iade edilen mal, satilmis gibi beklenen ciroya girer
 * veya fire maliyeti oldugundan yuksek gorunur.
 */
import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, badRequest, conflict } from '../lib/http.js';
import { requireWrite, assertCampusAccess, campusFilter } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, date, arr, today, oneOf } from '../lib/validate.js';
import { purchaseLineTotals, round2, netFromGross } from '../lib/money.js';
import { addMovement, stockOf, effectivePrices } from '../lib/stock.js';
import { assertNotLocked } from './stock.js';

export const returnRoutes = new Router();

export const RETURN_REASONS = ['BOZUK', 'SKT', 'YANLIS_URUN', 'FAZLA_GONDERIM', 'HASARLI', 'DIGER'];

/* ---------------------------- Listeleme ---------------------------- */
returnRoutes.get('/', async (ctx) => {
  const f = campusFilter(ctx.user, 'r.campus_id', ctx.query.campusId);
  const params = [...f.params];
  let extra = '';
  if (ctx.query.from) { extra += ' AND r.return_date >= ?'; params.push(ctx.query.from); }
  if (ctx.query.to) { extra += ' AND r.return_date <= ?'; params.push(ctx.query.to); }
  if (ctx.query.supplierId) { extra += ' AND r.supplier_id = ?'; params.push(Number(ctx.query.supplierId)); }

  const items = all(
    `SELECT r.*, s.name AS supplier_name, k.name AS campus_name, u.full_name AS created_by_name,
            p.document_no AS purchase_document_no,
            (SELECT COUNT(*) FROM supplier_return_lines l WHERE l.return_id = r.id) AS line_count
       FROM supplier_returns r
       JOIN suppliers s ON s.id = r.supplier_id
       JOIN campuses  k ON k.id = r.campus_id
       LEFT JOIN users u     ON u.id = r.created_by
       LEFT JOIN purchases p ON p.id = r.purchase_id
      WHERE 1 = 1 ${f.clause} ${extra}
      ORDER BY r.return_date DESC, r.id DESC
      LIMIT ?`,
    [...params, Number(ctx.query.limit || 200)]
  );

  const byReason = all(
    `SELECT r.reason, COUNT(*) AS document_count, SUM(r.gross_total) AS total
       FROM supplier_returns r WHERE 1 = 1 ${f.clause} ${extra}
      GROUP BY r.reason ORDER BY total DESC`,
    params
  ).map((r) => ({ ...r, total: round2(r.total) }));

  return {
    items,
    summary: {
      documentCount: items.length,
      netTotal: round2(items.reduce((s, r) => s + r.net_total, 0)),
      grossTotal: round2(items.reduce((s, r) => s + r.gross_total, 0)),
    },
    byReason,
  };
});

/* ------------------------------ Detay ------------------------------ */
returnRoutes.get('/:id', async (ctx) => {
  const header = get(
    `SELECT r.*, s.name AS supplier_name, k.name AS campus_name,
            u.full_name AS created_by_name, p.document_no AS purchase_document_no
       FROM supplier_returns r
       JOIN suppliers s ON s.id = r.supplier_id
       JOIN campuses  k ON k.id = r.campus_id
       LEFT JOIN users u     ON u.id = r.created_by
       LEFT JOIN purchases p ON p.id = r.purchase_id
      WHERE r.id = ?`,
    [Number(ctx.params.id)]
  );
  if (!header) throw notFound('Iade belgesi bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);

  const lines = all(
    `SELECT l.*, pr.name AS product_name, pr.barcode, pr.unit
       FROM supplier_return_lines l JOIN products pr ON pr.id = l.product_id
      WHERE l.return_id = ? ORDER BY l.id`,
    [header.id]
  );
  return { ...header, lines };
});

/* --------------------------- Yeni iade ----------------------------- */
returnRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user, 'returns');
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const supplierId = int(ctx.body.supplierId, 'Tedarikci', { required: true });
  if (!get('SELECT id FROM suppliers WHERE id = ?', [supplierId])) throw badRequest('Tedarikci bulunamadi.');

  const returnDate = date(ctx.body.returnDate, 'Iade tarihi', { def: today() });
  if (returnDate > today()) throw badRequest('Gelecek tarihli iade girilemez.');
  const reason = oneOf(ctx.body.reason, 'Iade nedeni', RETURN_REASONS, { required: true });
  const documentNo = str(ctx.body.documentNo, 'Iade irsaliye no', { max: 60 });
  const note = str(ctx.body.note, 'Aciklama', { max: 500 });
  const lines = arr(ctx.body.lines, 'Satirlar', { required: true, min: 1 });

  // Kesinlesmis sayim donemine geriye donuk iade girilemez
  assertNotLocked(campusId, returnDate);

  const purchaseId = int(ctx.body.purchaseId, 'Alim belgesi', { def: null });
  if (purchaseId) {
    const purchase = get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
    if (!purchase) throw badRequest('Secilen alim belgesi bulunamadi.');
    if (purchase.campus_id !== campusId) throw badRequest('Alim belgesi baska bir kampuse ait.');
    if (purchase.supplier_id !== supplierId) throw badRequest('Alim belgesi baska bir tedarikciye ait.');
    if (purchase.status === 'IPTAL') throw badRequest('Iptal edilmis alim belgesine iade girilemez.');
  }

  // Ayni tedarikci + iade irsaliye no ikinci kez girilmesin
  if (documentNo) {
    const dup = get(
      'SELECT id FROM supplier_returns WHERE supplier_id = ? AND document_no = ? AND campus_id = ?',
      [supplierId, documentNo, campusId]
    );
    if (dup) throw conflict(`Bu iade irsaliye no (${documentNo}) bu tedarikci icin zaten kayitli. Belge #${dup.id}`);
  }

  const prepared = lines.map((raw, i) => {
    const productId = int(raw.productId, `Satir ${i + 1} urun`, { required: true });
    const product = get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) throw badRequest(`Satir ${i + 1}: urun bulunamadi.`);
    if (product.product_type === 'URETILEN') {
      throw badRequest(`Satir ${i + 1}: "${product.name}" kantinde uretilen bir urun, tedarikciye iade edilemez.`);
    }
    const quantity = num(raw.quantity, `Satir ${i + 1} miktar`, { required: true, min: 0.001 });
    const prices = effectivePrices(campusId, productId);
    const vatRate = num(raw.vatRate, `Satir ${i + 1} KDV`, { min: 0, max: 100, def: product.vat_rate }) ?? product.vat_rate;
    // IADE BELGESI FATURA GIBIDIR: birim fiyati KDV HARIC tasir, KDV ayri
    // satirda gorunur. Stok maliyeti (purchase_price) ise KDV DAHIL
    // tutuldugu icin varsayilan deger netlestirilmeden konulursa uzerine
    // ikinci kez KDV eklenir ve iade tutari sisirdi.
    const varsayilan = round2(netFromGross(prices.purchase_price, vatRate));
    const unitPrice = num(raw.unitPrice, `Satir ${i + 1} birim fiyat`, { min: 0, def: varsayilan })
      ?? varsayilan;
    const totals = purchaseLineTotals({ quantity, unitPrice, vatRate });
    return { product, productId, quantity, unitPrice, vatRate, ...totals };
  });

  const netTotal = round2(prepared.reduce((s, l) => s + l.netTotal, 0));
  const vatTotal = round2(prepared.reduce((s, l) => s + l.vatTotal, 0));
  const grossTotal = round2(netTotal + vatTotal);

  // Stokta olmayan mal iade edilemez; engellemek yerine uyariyoruz cunku
  // defter ile raf arasinda sayim oncesi fark olmasi normaldir.
  const stockWarnings = prepared
    .map((l) => ({ name: l.product.name, quantity: l.quantity, stock: round2(stockOf(campusId, l.productId)) }))
    .filter((w) => w.quantity > w.stock);

  const returnId = tx(() => {
    const id = insert(
      `INSERT INTO supplier_returns (campus_id, supplier_id, purchase_id, document_no, return_date, reason,
                                     net_total, vat_total, gross_total, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [campusId, supplierId, purchaseId, documentNo, returnDate, reason,
       netTotal, vatTotal, grossTotal, note, ctx.user.id]
    );
    for (const l of prepared) {
      insert(
        `INSERT INTO supplier_return_lines (return_id, product_id, quantity, unit_price, vat_rate,
                                            net_total, vat_total, gross_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, l.productId, l.quantity, l.unitPrice, l.vatRate, l.netTotal, l.vatTotal, l.grossTotal]
      );
      addMovement({
        campusId, productId: l.productId, type: 'IADE', quantity: -l.quantity,
        // Stok maliyeti KDV DAHIL tutulur (bkz. server/lib/money.js)
        unitCost: l.quantity > 0 ? round2(l.grossTotal / l.quantity) : 0,
        date: returnDate,
        refType: 'return', refId: id, note: `Tedarikciye iade - ${reason}`, userId: ctx.user.id,
      });
    }
    return id;
  });

  logAudit({
    user: ctx.user, action: 'CREATE', entity: 'supplier_returns', entityId: returnId, campusId,
    detail: { supplierId, documentNo, reason, grossTotal, lineCount: prepared.length }, ip: ctx.ip,
  });
  return { id: returnId, netTotal, vatTotal, grossTotal, stockWarnings };
});

/* ------------------------------ Silme ------------------------------ */
returnRoutes.delete('/:id', async (ctx) => {
  requireWrite(ctx.user, 'returns');
  const header = get('SELECT * FROM supplier_returns WHERE id = ?', [Number(ctx.params.id)]);
  if (!header) throw notFound('Iade belgesi bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);

  const laterCount = get(
    `SELECT id, count_date FROM counts
      WHERE campus_id = ? AND status = 'KESINLESMIS' AND count_type = 'DONEM' AND count_date >= ? LIMIT 1`,
    [header.campus_id, header.return_date]
  );
  if (laterCount) {
    throw conflict(`Bu belge ${laterCount.count_date} tarihli kesinlesmis sayima dahil oldugu icin silinemez.`);
  }

  tx(() => {
    run("DELETE FROM stock_movements WHERE ref_type = 'return' AND ref_id = ?", [header.id]);
    run('DELETE FROM supplier_returns WHERE id = ?', [header.id]);
  });
  logAudit({
    user: ctx.user, action: 'DELETE', entity: 'supplier_returns', entityId: header.id,
    campusId: header.campus_id, detail: { grossTotal: header.gross_total }, ip: ctx.ip,
  });
  return { ok: true };
});
