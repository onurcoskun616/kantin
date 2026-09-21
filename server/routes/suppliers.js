import { Router } from '../lib/router.js';
import { all, get, insert, run } from '../db.js';
import { notFound, conflict, badRequest } from '../lib/http.js';
import {
  requireWrite, campusFilter, assertCampusAccess, allowedCampusIds, seesAllCampuses,
} from '../lib/auth.js';
import { campusBalances, sumBalances, ledger } from '../lib/cari.js';
import { logAudit } from '../lib/audit.js';
import { str, num, bool, date, today } from '../lib/validate.js';

export const supplierRoutes = new Router();

/**
 * Tedarikci listesi.
 *
 * `campusId` verilirse her satira O KAMPUSUN bakiyesi eklenir. Tedarikci
 * karti tum kampuslerde ortaktir ama hesabi degildir: listede gorunen borc
 * her zaman tek bir kampusun borcudur, yoksa "kime ne kadar borcluyuz"
 * sorusu bes kampusun toplamini verir ve hicbir kampus icin dogru olmaz.
 */
supplierRoutes.get('/', async (ctx) => {
  const where = ['1 = 1'];
  const params = [];
  if (ctx.query.search) { where.push('s.name LIKE ?'); params.push(`%${ctx.query.search}%`); }
  if (ctx.query.onlyActive !== '0') where.push('s.is_active = 1');

  const kapsam = resolveScope(ctx);
  if (!kapsam.campusId) {
    return {
      scope: kapsam,
      items: all(`SELECT s.* FROM suppliers s WHERE ${where.join(' AND ')} ORDER BY s.name COLLATE NOCASE`, params),
    };
  }

  const k = kapsam.campusId;
  const items = all(
    `SELECT s.*,
            COALESCE((SELECT SUM(p.gross_total) FROM purchases p
                       WHERE p.supplier_id = s.id AND p.campus_id = ? AND p.status <> 'IPTAL'), 0) AS campus_purchase,
            COALESCE((SELECT SUM(r.gross_total) FROM supplier_returns r
                       WHERE r.supplier_id = s.id AND r.campus_id = ?), 0) AS campus_return,
            COALESCE((SELECT SUM(o.amount) FROM supplier_payments o
                       WHERE o.supplier_id = s.id AND o.campus_id = ?), 0) AS campus_paid,
            (SELECT MAX(p.document_date) FROM purchases p
              WHERE p.supplier_id = s.id AND p.campus_id = ? AND p.status <> 'IPTAL') AS campus_last_purchase
       FROM suppliers s
      WHERE ${where.join(' AND ')}
      ORDER BY s.name COLLATE NOCASE`,
    [k, k, k, k, ...params]
  );
  const yuvarla = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    scope: kapsam,
    items: items.map((r) => ({
      ...r,
      campus_debt: yuvarla(r.campus_purchase - r.campus_return - r.campus_paid),
    })),
  };
});

/**
 * Istegin hangi kampusu kastettigini belirler.
 *
 * Kampus bagimli kullanici icin her zaman kendi kampusudur; tum kampusleri
 * goren roller `campusId` vermezse bes kampusun TOPLAMI (grup gorunumu)
 * dondurulur.
 */
function resolveScope(ctx) {
  const istenen = ctx.query.campusId ? Number(ctx.query.campusId) : null;
  if (istenen) {
    const id = assertCampusAccess(ctx.user, istenen);
    const kampus = get('SELECT name FROM campuses WHERE id = ?', [id]);
    if (!kampus) throw notFound('Kampus bulunamadi.');
    return { campusId: id, campusName: kampus.name };
  }
  const izinli = allowedCampusIds(ctx.user);
  if (izinli && izinli.length === 1) {
    const kampus = get('SELECT name FROM campuses WHERE id = ?', [izinli[0]]);
    return { campusId: izinli[0], campusName: kampus?.name || '' };
  }
  return { campusId: null, campusName: 'Tüm kampüsler' };
}

/**
 * Tedarikci cari hesabi.
 *
 * `campusId` verilirse YALNIZCA o kampusun hesabi; verilmezse (ve kullanici
 * tum kampusleri goruyorsa) grup toplami dondurulur. Her iki durumda da
 * `campusBalances` ile kampus kampus dokum verilir: ayni firmanin Esenyurt'ta
 * borcu, Corlu'da alacagi olabilir ve tek bir rakam bunu gizler.
 *
 * DIKKAT — bakiye artik listelenen belgelerden DEGIL, dogrudan veritabani
 * toplamindan hesaplanir. Eskiden son 100 belge toplaniyordu; 101. belgeden
 * sonra bakiye sessizce yanlis cikardi.
 */
supplierRoutes.get('/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const supplier = get('SELECT * FROM suppliers WHERE id = ?', [id]);
  if (!supplier) throw notFound('Tedarikci bulunamadi.');

  const kapsam = resolveScope(ctx);
  const izinli = allowedCampusIds(ctx.user);
  const f = campusFilter(ctx.user, 'p.campus_id', kapsam.campusId);

  const purchases = all(
    `SELECT p.*, k.name AS campus_name FROM purchases p
       JOIN campuses k ON k.id = p.campus_id
      WHERE p.supplier_id = ? AND p.status <> 'IPTAL' ${f.clause}
      ORDER BY p.document_date DESC, p.id DESC LIMIT 100`,
    [id, ...f.params]
  );
  // Odemeler de kampus filtresine TABIDIR: filtrelenmezse bir kampusun
  // yoneticisi diger kampuslerin odemelerini gorur ve kendi bakiyesi
  // odenmis gibi dusuk cikardi.
  const payments = all(
    `SELECT o.*, k.name AS campus_name FROM supplier_payments o
       LEFT JOIN campuses k ON k.id = o.campus_id
      WHERE o.supplier_id = ? ${f.clause.replace('p.campus_id', 'o.campus_id')}
      ORDER BY o.payment_date DESC, o.id DESC LIMIT 100`,
    [id, ...f.params]
  );
  // Iadeler borcu azaltir: mal geri gittigi icin tedarikci alacaklandirir
  const returns = all(
    `SELECT r.*, k.name AS campus_name FROM supplier_returns r
       JOIN campuses k ON k.id = r.campus_id
      WHERE r.supplier_id = ? ${f.clause.replace('p.campus_id', 'r.campus_id')}
      ORDER BY r.return_date DESC, r.id DESC LIMIT 100`,
    [id, ...f.params]
  );

  const kampusHesaplari = campusBalances(id, izinli);
  const kapsamdaki = kapsam.campusId
    ? kampusHesaplari.filter((r) => r.campusId === kapsam.campusId)
    : kampusHesaplari;

  return {
    ...supplier,
    scope: kapsam,
    campusBalances: kampusHesaplari,
    ledger: ledger(id, kapsam.campusId, izinli),
    purchases,
    payments,
    returns,
    // Kampussuz kalmis eski odemeler hicbir kampusun bakiyesine girmez; bu
    // yuzden gorunur olmalari gerekir. Yalnizca TUM kampusleri goren roller
    // listeler: odemenin hangi kampuse ait oldugunu bilmeyen bir kampus
    // yoneticisi, baska kampusun odemesini kendi hesabina cekebilirdi.
    unassignedPayments: seesAllCampuses(ctx.user) ? all(
      'SELECT * FROM supplier_payments WHERE supplier_id = ? AND campus_id IS NULL ORDER BY payment_date DESC', [id]
    ) : [],
    balance: sumBalances(kapsamdaki),
  };
});

supplierRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user, 'suppliers');
  const d = parse(ctx.body);
  assertTaxNoFree(d.taxNo, null);
  const id = insert(
    `INSERT INTO suppliers (name, tax_office, tax_no, phone, email, address, note, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [d.name, d.taxOffice, d.taxNo, d.phone, d.email, d.address, d.note, d.isActive ? 1 : 0]
  );
  logAudit({ user: ctx.user, action: 'CREATE', entity: 'suppliers', entityId: id, detail: d, ip: ctx.ip });
  return get('SELECT * FROM suppliers WHERE id = ?', [id]);
});

supplierRoutes.put('/:id', async (ctx) => {
  requireWrite(ctx.user, 'suppliers');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM suppliers WHERE id = ?', [id])) throw notFound('Tedarikci bulunamadi.');
  const d = parse(ctx.body);
  assertTaxNoFree(d.taxNo, id);
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
  requireWrite(ctx.user, 'suppliers');
  const supplierId = Number(ctx.params.id);
  if (!get('SELECT id FROM suppliers WHERE id = ?', [supplierId])) throw notFound('Tedarikci bulunamadi.');
  // ZORUNLU: odeme HANGI KAMPUSUN borcunu kapatiyor? Kampussuz bir odeme
  // hicbir kampusun bakiyesini duzeltmez, yalnizca kasadan para eksiltir.
  if (!ctx.body.campusId) {
    throw badRequest(
      'Odemenin hangi kampus adina yapildigi secilmelidir: cari hesap kampus bazlidir.'
    );
  }
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const amount = num(ctx.body.amount, 'Tutar', { required: true, min: 0.01 });
  const paymentDate = date(ctx.body.paymentDate, 'Odeme tarihi', { def: today() });
  const method = str(ctx.body.method, 'Odeme sekli', { max: 30 }) || 'NAKIT';

  // Belgeye baglanan odeme: belge ayni tedarikcinin ve AYNI kampusun olmali,
  // yoksa odeme baska bir kampusun borcuna sayilirdi.
  const purchaseId = ctx.body.purchaseId ? Number(ctx.body.purchaseId) : null;
  if (purchaseId) {
    const belge = get('SELECT supplier_id, campus_id FROM purchases WHERE id = ?', [purchaseId]);
    if (!belge) throw notFound('Odemenin baglanacagi alim belgesi bulunamadi.');
    if (belge.supplier_id !== supplierId) throw badRequest('Secilen belge bu tedarikciye ait degil.');
    if (belge.campus_id !== campusId) throw badRequest('Secilen belge baska bir kampuse ait.');
  }

  const id = insert(
    `INSERT INTO supplier_payments (supplier_id, campus_id, purchase_id, amount, payment_date, method, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [supplierId, campusId, purchaseId, amount, paymentDate, method,
     str(ctx.body.note, 'Aciklama', { max: 300 }), ctx.user.id]
  );
  logAudit({
    user: ctx.user, action: 'CREATE', entity: 'supplier_payments', entityId: id, campusId,
    detail: { supplierId, amount, paymentDate }, ip: ctx.ip,
  });
  return get('SELECT * FROM supplier_payments WHERE id = ?', [id]);
});

/**
 * Bir odemenin kampusunu atar / duzeltir.
 *
 * Iki durumda gerekir: (1) eski surumden gelen kampussuz odemeler -- hicbir
 * kampusun bakiyesine girmedikleri icin once atanmalari gerekir; (2) yanlis
 * kampus secilerek girilmis bir odeme -- iki kampusun bakiyesi birden
 * yanlistir ve silmek yerine duzeltilmelidir.
 *
 * Odemenin TUTARI burada degismez: tutar duzeltmesi ayri bir karardir ve
 * denetim izi birakmasi gerekir.
 */
supplierRoutes.put('/:id/payments/:paymentId/campus', async (ctx) => {
  requireWrite(ctx.user, 'suppliers');
  const supplierId = Number(ctx.params.id);
  const paymentId = Number(ctx.params.paymentId);
  const odeme = get('SELECT * FROM supplier_payments WHERE id = ? AND supplier_id = ?', [paymentId, supplierId]);
  if (!odeme) throw notFound('Odeme bulunamadi.');

  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  // Kampusu degisen odeme, belgeye bagliysa o bagi kaybeder: belge eski
  // kampusundedir ve odeme artik baska bir kampusun borcunu kapatir.
  const belgeKopuyor = odeme.purchase_id && odeme.campus_id !== campusId;
  run(
    `UPDATE supplier_payments SET campus_id = ?, purchase_id = ? WHERE id = ?`,
    [campusId, belgeKopuyor ? null : odeme.purchase_id, paymentId]
  );
  logAudit({
    user: ctx.user, action: 'UPDATE', entity: 'supplier_payments', entityId: paymentId, campusId,
    detail: { oncekiKampus: odeme.campus_id, yeniKampus: campusId, tutar: odeme.amount }, ip: ctx.ip,
  });
  return get('SELECT * FROM supplier_payments WHERE id = ?', [paymentId]);
});

/**
 * Ayni vergi numarasi iki tedarikciye verilemez.
 *
 * Mukerrer tedarikci karti sessiz bir hatadir: fatura bazen birine bazen
 * otekine yazilir, tedarikci borcu ikiye bolunur ve hicbiri dogru cikmaz.
 * e-Fatura eslestirmesi de VKN uzerinden yapildigi icin hangi kartin
 * secilecegi belirsizlesir.
 */
function assertTaxNoFree(taxNo, selfId) {
  const clean = String(taxNo || '').trim();
  if (!clean) return;
  const rows = all('SELECT id, name FROM suppliers WHERE REPLACE(TRIM(tax_no), \' \', \'\') = ?', [clean]);
  const hit = rows.find((r) => r.id !== selfId);
  if (hit) {
    throw conflict(`VKN ${clean} numarali "${hit.name}" firmasi zaten tanimlidir (#${hit.id}).`);
  }
}

/** VKN 10, TCKN 11 hanedir; arada bosluk/tire olabilir, temizleriz. */
function parseTaxNo(value) {
  const raw = str(value, 'Vergi/TC no', { required: true, max: 20 });
  const clean = String(raw).replace(/[\s-.]/g, '');
  if (!/^\d{10}$|^\d{11}$/.test(clean)) {
    throw badRequest(
      `Vergi numarasi 10 haneli (VKN) veya 11 haneli (TCKN) olmalidir. Girilen: "${raw}"`
    );
  }
  return clean;
}

function parse(body) {
  return {
    name: str(body.name, 'Tedarikci adi', { required: true, max: 200 }),
    taxOffice: str(body.taxOffice, 'Vergi dairesi', { max: 100 }),
    // ZORUNLU: fatura eslestirmesi ve mukerrer kayit engeli buna dayanir
    taxNo: parseTaxNo(body.taxNo),
    phone: str(body.phone, 'Telefon', { max: 40 }),
    email: str(body.email, 'E-posta', { max: 160 }),
    address: str(body.address, 'Adres', { max: 500 }),
    note: str(body.note, 'Not', { max: 500 }),
    isActive: bool(body.isActive, true),
  };
}
