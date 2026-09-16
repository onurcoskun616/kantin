import { Router } from '../lib/router.js';
import { all, get, insert, run } from '../db.js';
import { notFound } from '../lib/http.js';
import { requireWrite, campusFilter, assertCampusAccess } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, bool, date, today } from '../lib/validate.js';

export const supplierRoutes = new Router();

supplierRoutes.get('/', async (ctx) => {
  const where = ['1 = 1'];
  const params = [];
  if (ctx.query.search) { where.push('name LIKE ?'); params.push(`%${ctx.query.search}%`); }
  if (ctx.query.onlyActive !== '0') where.push('is_active = 1');
  return { items: all(`SELECT * FROM suppliers WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE`, params) };
});

supplierRoutes.get('/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const supplier = get('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!supplier) throw notFound('Tedarikci bulunamadi.');

  const f = campusFilter(ctx.user, 'p.campus_id');
  const purchases = all(
    `SELECT p.*, k.name AS campus_name FROM purchases p
       JOIN campuses k ON k.id = p.campus_id
      WHERE p.supplier_id = ? AND p.status <> 'IPTAL' ${f.clause}
      ORDER BY p.document_date DESC, p.id DESC LIMIT 100`,
    [id, ...f.params]
  );
  const payments = all(
    'SELECT * FROM supplier_payments WHERE supplier_id = ? ORDER BY payment_date DESC, id DESC LIMIT 100', [id]
  );
  const totalPurchase = purchases.reduce((s, p) => s + p.gross_total, 0);
  const totalPaid = payments.reduce((s, p) => s + p.amount, 0);

  return {
    ...supplier,
    purchases,
    payments,
    balance: {
      totalPurchase: Math.round(totalPurchase * 100) / 100,
      totalPaid: Math.round(totalPaid * 100) / 100,
      debt: Math.round((totalPurchase - totalPaid) * 100) / 100,
    },
  };
});

supplierRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user);
  const d = parse(ctx.body);
  const id = insert(
    `INSERT INTO suppliers (name, tax_office, tax_no, phone, email, address, note, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.name, d.taxOffice, d.taxNo, d.phone, d.email, d.address, d.note, d.isActive ? 1 : 0]
  );
  logAudit({ user: ctx.user, action: 'CREATE', entity: 'suppliers', entityId: id, detail: d, ip: ctx.ip });
  return get('SELECT * FROM suppliers WHERE id = ?', [id]);
});

supplierRoutes.put('/:id', async (ctx) => {
  requireWrite(ctx.user);
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM suppliers WHERE id = ?', [id])) throw notFound('Tedarikci bulunamadi.');
  const d = parse(ctx.body);
  run(
    `UPDATE suppliers SET name = ?, tax_office = ?, tax_no = ?, phone = ?, email = ?, address = ?, note = ?, is_active = ?
      WHERE id = ?`,
    [d.name, d.taxOffice, d.taxNo, d.phone, d.email, d.address, d.note, d.isActive ? 1 : 0, id]
  );
  logAudit({ user: ctx.user, action: 'UPDATE', entity: 'suppliers', entityId: id, detail: d, ip: ctx.ip });
  return get('SELECT * FROM suppliers WHERE id = ?', [id]);
});

/* --------------------------- Odemeler ----------------------------- */
supplierRoutes.post('/:id/payments', async (ctx) => {
  requireWrite(ctx.user);
  const supplierId = Number(ctx.params.id);
  if (!get('SELECT id FROM suppliers WHERE id = ?', [supplierId])) throw notFound('Tedarikci bulunamadi.');
  const campusId = ctx.body.campusId ? assertCampusAccess(ctx.user, ctx.body.campusId) : null;
  const amount = num(ctx.body.amount, 'Tutar', { required: true, min: 0.01 });
  const paymentDate = date(ctx.body.paymentDate, 'Odeme tarihi', { def: today() });
  const method = str(ctx.body.method, 'Odeme sekli', { max: 30 }) || 'NAKIT';

  const id = insert(
    `INSERT INTO supplier_payments (supplier_id, campus_id, purchase_id, amount, payment_date, method, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [supplierId, campusId, ctx.body.purchaseId || null, amount, paymentDate, method,
     str(ctx.body.note, 'Aciklama', { max: 300 }), ctx.user.id]
  );
  logAudit({
    user: ctx.user, action: 'CREATE', entity: 'supplier_payments', entityId: id, campusId,
    detail: { supplierId, amount, paymentDate }, ip: ctx.ip,
  });
  return get('SELECT * FROM supplier_payments WHERE id = ?', [id]);
});

function parse(body) {
  return {
    name: str(body.name, 'Tedarikci adi', { required: true, max: 200 }),
    taxOffice: str(body.taxOffice, 'Vergi dairesi', { max: 100 }),
    taxNo: str(body.taxNo, 'Vergi/TC no', { max: 20 }),
    phone: str(body.phone, 'Telefon', { max: 40 }),
    email: str(body.email, 'E-posta', { max: 160 }),
    address: str(body.address, 'Adres', { max: 500 }),
    note: str(body.note, 'Not', { max: 500 }),
    isActive: bool(body.isActive, true),
  };
}
