/**
 * Demo sunucusu — tarayıcı içinde çalışır.
 *
 * Gerçek sunucudaki API uçlarının aynısını, aynı yanıt biçimleriyle taklit eder;
 * böylece arayüz kodu hiç değişmeden çalışır. Finansal hesaplar gerçek sunucunun
 * `money.js` modülünden aynen kullanılır — demo ile gerçek sistem aynı sonucu verir.
 *
 * Veriler tarayıcıda tutulur: başkalarına ulaşmaz, sunucuya gitmez.
 */
import { buildDemoData, iso, dayOffset, eachDay, isWeekday, round2, demoCode } from './data.js';
import { productProfit, netFromGross, pctOf, purchaseLineTotals, round4, amountInWords } from './money.js';

// Sürüm eki: demo veri şeması değiştiğinde eski kayıt kullanılmasın diye
// artırılır (v5 = alım belgesi ekleri eklendi).
const STORAGE_KEY = 'kantin_demo_db_v5';

/* ---------------------------- Hata türü ---------------------------- */
export class DemoError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new DemoError(400, m);
const notFound = (m = 'Kayıt bulunamadı.') => new DemoError(404, m);
const conflict = (m) => new DemoError(409, m);
const forbidden = (m = 'Bu işlem için yetkiniz yok.') => new DemoError(403, m);

/* ------------------------- Veri ve kalıcılık ----------------------- */
let db = null;
let session = null;

export function loadDb() {
  if (db) return db;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) { db = JSON.parse(raw); return db; }
  } catch { /* depolama kapalı olabilir, demo veriyle devam */ }
  db = buildDemoData();
  persist();
  return db;
}

let persistTimer = null;
function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      // Ek belgelerin icerigi (fatura PDF/XML baytlari) depoya yazilmaz:
      // kotayi doldurur. Kunyesi kalir, icerik oturum boyunca bellektedir.
      localStorage.setItem(STORAGE_KEY, JSON.stringify(db, (key, value) => (key === 'bytes' ? undefined : value)));
    } catch { /* kota dolu olabilir */ }
  }, 250);
}

export function resetDemo() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* yoksay */ }
  db = null;
  session = null;
  loadDb();
}

const nextId = (key) => { db._ids[key] = (db._ids[key] || 0) + 1; return db._ids[key]; };
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const today = () => iso(dayOffset(0));

/* ----------------------------- Yetki ------------------------------- */
const ALL_CAMPUS_ROLES = ['ADMIN', 'GENEL_MUDURLUK', 'MUHASEBE', 'DENETCI'];
const seesAll = (u) => ALL_CAMPUS_ROLES.includes(u.role);

function requireUser() {
  if (!session) throw new DemoError(401, 'Oturum açmanız gerekiyor.');
  return session;
}
function requireWrite() {
  const u = requireUser();
  if (u.role === 'DENETCI') throw forbidden('Denetçi rolü salt okunurdur, kayıt değiştiremez.');
  // Ön muhasebe de salt okunurdur; tek istisnası teslim fişini onaylamaktır
  // ve o uç requireRole ile ayrıca açılır.
  if (u.role === 'MUHASEBE') {
    throw forbidden('Ön muhasebe rolü yalnızca ciro teslim fişini onaylayabilir, başka kayıt değiştiremez.');
  }
  return u;
}
function requireRole(...roles) {
  const u = requireUser();
  if (!roles.includes(u.role)) throw forbidden();
  return u;
}
function campusAccess(campusId) {
  const u = requireUser();
  const id = Number(campusId);
  if (!Number.isInteger(id) || id <= 0) throw bad('Geçerli bir kampüs seçilmelidir.');
  if (!seesAll(u) && u.campus_id !== id) throw forbidden('Yalnızca kendi kampüsünüz için işlem yapabilirsiniz.');
  return id;
}
/** Kullanıcının görebileceği kampüslerle sınırlar. */
function visibleCampusIds(requested) {
  const u = requireUser();
  if (seesAll(u)) {
    if (requested) return [Number(requested)];
    return db.campuses.map((c) => c.id);
  }
  if (requested && Number(requested) !== u.campus_id) throw forbidden('Bu kampüsü görüntüleme yetkiniz yok.');
  return u.campus_id ? [u.campus_id] : [];
}

/* --------------------------- Yardımcılar --------------------------- */
const byId = (list, id) => list.find((r) => r.id === Number(id));
const campusName = (id) => byId(db.campuses, id)?.name ?? '—';
const productById = (id) => byId(db.products, id);
const userName = (id) => byId(db.users, id)?.full_name ?? null;

function effectivePrices(campusId, productId) {
  const p = productById(productId);
  if (!p) return null;
  const cp = db.campus_products.find((r) => r.campus_id === campusId && r.product_id === productId);
  return {
    purchase_price: cp?.purchase_price ?? p.purchase_price,
    sale_price: cp?.sale_price ?? p.sale_price,
    critical_stock: cp?.critical_stock ?? p.critical_stock,
    vat_rate: p.vat_rate,
  };
}

function stockOf(campusId, productId, untilDate = null) {
  return db.movements
    .filter((m) => m.campus_id === campusId && m.product_id === productId
      && (!untilDate || m.movement_date <= untilDate))
    .reduce((s, m) => s + m.quantity, 0);
}

function stockSnapshot(campusId, { untilDate = null, onlyActive = true, includeProduced = false } = {}) {
  const totals = new Map();
  for (const m of db.movements) {
    if (m.campus_id !== campusId) continue;
    if (untilDate && m.movement_date > untilDate) continue;
    totals.set(m.product_id, (totals.get(m.product_id) || 0) + m.quantity);
  }
  return db.products
    .filter((p) => (onlyActive ? p.is_active : true))
    .filter((p) => includeProduced || p.product_type !== 'URETILEN')  // hammadde raftan sayılır
    .map((p) => {
      const prices = effectivePrices(campusId, p.id);
      return {
        product_id: p.id, barcode: p.barcode, name: p.name, unit: p.unit,
        vat_rate: p.vat_rate, max_price: p.max_price, meb_approved: p.meb_approved,
        product_type: p.product_type,
        category_name: byId(db.categories, p.category_id)?.name ?? null,
        purchase_price: prices.purchase_price,
        sale_price: prices.sale_price,
        critical_stock: prices.critical_stock,
        stock_qty: round2(totals.get(p.id) || 0),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
}

function stockValue(campusId, untilDate = null) {
  const rows = stockSnapshot(campusId, { untilDate });
  let costValue = 0; let saleValue = 0; let criticalCount = 0; let negativeCount = 0;
  for (const r of rows) {
    costValue += r.stock_qty * r.purchase_price;
    saleValue += r.stock_qty * r.sale_price;
    if (r.critical_stock > 0 && r.stock_qty <= r.critical_stock) criticalCount += 1;
    if (r.stock_qty < 0) negativeCount += 1;
  }
  return { productCount: rows.length, costValue: round2(costValue), saleValue: round2(saleValue), criticalCount, negativeCount };
}

function lastFinalizedCount(campusId) {
  return db.counts
    .filter((c) => c.campus_id === campusId && c.status === 'KESINLESMIS' && c.count_type === 'DONEM')
    .sort((a, b) => (a.count_date < b.count_date ? 1 : -1))[0] ?? null;
}

/** Kesinleşmiş sayım dönemine geriye dönük kayıt engeli. */
function assertNotLocked(campusId, date) {
  const locked = db.counts
    .filter((c) => c.campus_id === campusId && c.status === 'KESINLESMIS'
      && c.count_type === 'DONEM' && c.count_date >= date)
    .sort((a, b) => (a.count_date < b.count_date ? -1 : 1))[0];
  if (locked) {
    throw conflict(`${locked.count_date} tarihli kesinleşmiş sayım var. Bu tarihten önceye kayıt giremezsiniz.`);
  }
}

function addMovement(m) {
  const row = {
    id: nextId('movement'), unit_cost: 0, ref_type: null, ref_id: null, note: null,
    created_by: session?.id ?? null, created_at: now(), ...m,
  };
  db.movements.push(row);
  return row.id;
}

function logAudit(action, entity, entityId, campusId, detail) {
  db.audit_logs.unshift({
    id: nextId('audit'), user_id: session?.id ?? null, user_email: session?.email ?? null,
    action, entity, entity_id: entityId ?? null, campus_id: campusId ?? null,
    detail: detail ? JSON.stringify(detail) : null, ip: '127.0.0.1 (demo)', created_at: now(),
  });
  persist();
}

function dateRange(query, defaultMonths = 1) {
  if (query.month) return monthRange(query.month);
  const to = query.to || today();
  let from = query.from;
  if (!from) {
    const d = new Date(`${to}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - defaultMonths);
    from = iso(d);
  }
  return { from, to };
}

function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) throw bad('Ay değeri YYYY-AA biçiminde olmalıdır.');
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}

const num = (v, field, { required = false, min = -Infinity, def = null } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (required) throw bad(`"${field}" alanı zorunludur.`);
    return def;
  }
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n)) throw bad(`"${field}" sayısal olmalıdır.`);
  if (n < min) throw bad(`"${field}" en az ${min} olabilir.`);
  return n;
};
const text = (v, field, { required = false } = {}) => {
  const s = v === undefined || v === null ? '' : String(v).trim();
  if (!s && required) throw bad(`"${field}" alanı zorunludur.`);
  return s || null;
};

/* =================================================================== */
/*                            API uçları                               */
/* =================================================================== */
const routes = [];
const route = (method, pattern, handler) => {
  const keys = [];
  const src = pattern.split('/').map((seg) => {
    if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
    return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }).join('/');
  routes.push({ method, regex: new RegExp(`^${src}$`), keys, handler });
};

/* ----------------------------- Oturum ------------------------------ */
route('POST', '/api/auth/login', ({ body }) => {
  const email = String(body.email || '').trim().toLowerCase();
  const user = db.users.find((u) => u.email.toLowerCase() === email);
  if (!user) throw new DemoError(401, 'E-posta veya parola hatalı. Demo hesaplarından birini seçebilirsiniz.');
  if (!user.is_active) throw new DemoError(401, 'Hesabınız pasif durumda.');
  session = user;
  user.last_login_at = now();
  logAudit('LOGIN', 'users', user.id, null);
  return { token: `demo.${user.id}`, expiresAt: null, user: publicUser(user) };
});

route('POST', '/api/auth/logout', () => { session = null; return { ok: true }; });

route('GET', '/api/auth/me', () => {
  const u = requireUser();
  const campuses = u.campus_id
    ? db.campuses.filter((c) => c.id === u.campus_id)
    : db.campuses.filter((c) => c.is_active);
  return {
    user: publicUser(u),
    campuses: campuses.map((c) => ({ id: c.id, code: c.code, name: c.name, student_count: c.student_count })),
  };
});

route('POST', '/api/auth/change-password', () => {
  requireUser();
  throw bad('Demo sürümünde parola değiştirilemez. Gerçek kurulumda bu işlem çalışır.');
});

const publicUser = (u) => ({
  id: u.id, email: u.email, fullName: u.full_name, role: u.role,
  campusId: u.campus_id, lastLoginAt: u.last_login_at ?? null,
});

/* ---------------------------- Kampüsler ---------------------------- */
route('GET', '/api/campuses', () => {
  const u = requireUser();
  const items = seesAll(u) ? db.campuses : db.campuses.filter((c) => c.id === u.campus_id);
  return { items: [...items].sort((a, b) => a.name.localeCompare(b.name, 'tr')) };
});

route('GET', '/api/campuses/:id', ({ params }) => {
  const c = byId(db.campuses, campusAccess(params.id));
  if (!c) throw notFound('Kampüs bulunamadı.');
  return c;
});

route('POST', '/api/campuses', ({ body }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  const data = parseCampus(body);
  if (db.campuses.some((c) => c.code === data.code)) throw conflict('Bu kampüs kodu zaten kayıtlı.');
  const row = { id: nextId('campus'), ...data, created_at: now() };
  db.campuses.push(row);
  logAudit('CREATE', 'campuses', row.id, row.id, data);
  return row;
});

route('PUT', '/api/campuses/:id', ({ params, body }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  const row = byId(db.campuses, params.id);
  if (!row) throw notFound('Kampüs bulunamadı.');
  const data = parseCampus(body);
  if (db.campuses.some((c) => c.code === data.code && c.id !== row.id)) {
    throw conflict('Bu kampüs kodu başka bir kampüse ait.');
  }
  Object.assign(row, data);
  logAudit('UPDATE', 'campuses', row.id, row.id, data);
  persist();
  return row;
});

function parseCampus(body) {
  return {
    code: (text(body.code, 'Kampüs kodu', { required: true }) || '').toLocaleUpperCase('tr'),
    name: text(body.name, 'Kampüs adı', { required: true }),
    address: text(body.address, 'Adres'),
    phone: text(body.phone, 'Telefon'),
    student_count: num(body.studentCount, 'Öğrenci sayısı', { min: 0, def: 0 }) ?? 0,
    rent_share_pct: num(body.rentSharePct, 'Okul pay oranı', { min: 0, def: 0 }) ?? 0,
    is_active: body.isActive === false ? 0 : 1,
  };
}

/* ----------------------------- Ürünler ----------------------------- */
route('GET', '/api/products/categories', () => ({
  items: [...db.categories].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'tr')),
}));

route('POST', '/api/products/categories', ({ body }) => {
  requireWrite();
  const name = text(body.name, 'Kategori adı', { required: true });
  if (db.categories.some((c) => c.name === name)) throw conflict('Bu kategori zaten var.');
  const row = { id: nextId('category'), name, sort_order: db.categories.length, is_active: 1 };
  db.categories.push(row);
  logAudit('CREATE', 'categories', row.id, null, { name });
  return row;
});

route('PUT', '/api/products/categories/:id', ({ params, body }) => {
  requireWrite();
  const row = byId(db.categories, params.id);
  if (!row) throw notFound('Kategori bulunamadı.');
  row.name = text(body.name, 'Kategori adı', { required: true });
  logAudit('UPDATE', 'categories', row.id, null);
  persist();
  return row;
});

route('GET', '/api/products', ({ query }) => {
  const u = requireUser();
  const campusId = query.campusId ? campusAccess(query.campusId) : (u.campus_id || db.campuses[0]?.id);
  const search = (query.search || '').toLocaleLowerCase('tr');

  const items = db.products
    .filter((p) => (query.onlyActive === '0' ? true : p.is_active))
    .filter((p) => !query.categoryId || p.category_id === Number(query.categoryId))
    .filter((p) => !search
      || p.name.toLocaleLowerCase('tr').includes(search)
      || (p.barcode || '').toLocaleLowerCase('tr').includes(search))
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    .map((p) => {
      const cp = db.campus_products.find((r) => r.campus_id === campusId && r.product_id === p.id);
      return decorateProduct({
        ...p,
        category_name: byId(db.categories, p.category_id)?.name ?? null,
        campus_purchase_price: cp?.purchase_price ?? null,
        campus_sale_price: cp?.sale_price ?? null,
        campus_critical_stock: cp?.critical_stock ?? null,
      });
    });
  return { items };
});

function decorateProduct(row) {
  const purchase = row.campus_purchase_price ?? row.purchase_price;
  const sale = row.campus_sale_price ?? row.sale_price;
  return {
    ...row,
    effective_purchase_price: purchase,
    effective_sale_price: sale,
    profit: productProfit(purchase, sale, row.vat_rate),
    over_max_price: row.max_price > 0 && sale > row.max_price,
  };
}

route('POST', '/api/products', ({ body }) => {
  requireWrite();
  const data = parseProduct(body);
  if (data.barcode && db.products.some((p) => p.barcode === data.barcode)) {
    throw conflict('Bu barkod başka bir üründe kayıtlı.');
  }
  const row = { id: nextId('product'), ...data, created_at: now(), updated_at: now() };
  db.products.push(row);
  logAudit('CREATE', 'products', row.id, null, { name: data.name });
  return row;
});

route('PUT', '/api/products/:id', ({ params, body }) => {
  requireWrite();
  const row = byId(db.products, params.id);
  if (!row) throw notFound('Ürün bulunamadı.');
  const data = parseProduct(body);
  if (data.barcode && db.products.some((p) => p.barcode === data.barcode && p.id !== row.id)) {
    throw conflict('Bu barkod başka bir üründe kayıtlı.');
  }
  Object.assign(row, data, { updated_at: now() });
  logAudit('UPDATE', 'products', row.id, null, { name: data.name });
  persist();
  return row;
});

route('DELETE', '/api/products/:id', ({ params }) => {
  requireWrite();
  const row = byId(db.products, params.id);
  if (!row) throw notFound('Ürün bulunamadı.');
  row.is_active = 0;
  logAudit('DEACTIVATE', 'products', row.id, null);
  persist();
  return { ok: true };
});

route('PUT', '/api/products/:id/campus-price/:campusId', ({ params, body }) => {
  requireWrite();
  const productId = Number(params.id);
  const campusId = campusAccess(params.campusId);
  if (!productById(productId)) throw notFound('Ürün bulunamadı.');
  const purchase = num(body.purchasePrice, 'Alış fiyatı', { min: 0, def: null });
  const sale = num(body.salePrice, 'Satış fiyatı', { min: 0, def: null });
  const critical = num(body.criticalStock, 'Kritik stok', { min: 0, def: null });

  let row = db.campus_products.find((r) => r.campus_id === campusId && r.product_id === productId);
  if (!row) {
    row = { campus_id: campusId, product_id: productId, is_active: 1 };
    db.campus_products.push(row);
  }
  Object.assign(row, { purchase_price: purchase, sale_price: sale, critical_stock: critical });
  logAudit('UPDATE', 'campus_products', productId, campusId, { purchase, sale });
  persist();
  return row;
});

function parseProduct(body) {
  return {
    barcode: text(body.barcode, 'Barkod'),
    name: text(body.name, 'Ürün adı', { required: true }),
    category_id: body.categoryId ? Number(body.categoryId) : null,
    unit: text(body.unit, 'Birim') || 'ADET',
    product_type: ['URETILEN', 'HAMMADDE'].includes(body.productType) ? body.productType : 'SATIN_ALINAN',
    purchase_price: num(body.purchasePrice, 'Alış fiyatı', { min: 0, def: 0 }) ?? 0,
    sale_price: num(body.salePrice, 'Satış fiyatı', { min: 0, def: 0 }) ?? 0,
    vat_rate: num(body.vatRate, 'KDV oranı', { min: 0, def: 10 }) ?? 10,
    critical_stock: num(body.criticalStock, 'Kritik stok', { min: 0, def: 0 }) ?? 0,
    meb_approved: body.mebApproved === false ? 0 : 1,
    max_price: num(body.maxPrice, 'Tavan fiyat', { min: 0, def: 0 }) ?? 0,
    track_expiry: body.trackExpiry ? 1 : 0,
    is_active: body.isActive === false ? 0 : 1,
  };
}

route('POST', '/api/products/bulk-import', ({ body }) => {
  requireWrite();
  const rows = Array.isArray(body.items) ? body.items : [];
  if (!rows.length) throw bad('İçeri aktarılacak satır bulunamadı.');
  const result = { created: 0, updated: 0, categoriesCreated: 0, errors: [] };

  rows.forEach((raw, idx) => {
    try {
      let categoryId = raw.categoryId ? Number(raw.categoryId) : null;
      const categoryName = text(raw.categoryName, 'Kategori');
      if (categoryName) {
        const key = categoryName.toLocaleLowerCase('tr');
        let cat = db.categories.find((c) => c.name.toLocaleLowerCase('tr') === key);
        if (!cat) {
          cat = { id: nextId('category'), name: categoryName, sort_order: db.categories.length, is_active: 1 };
          db.categories.push(cat);
          result.categoriesCreated += 1;
        }
        categoryId = cat.id;
      }
      const data = parseProduct({ ...raw, categoryId });
      const existing = data.barcode
        ? db.products.find((p) => p.barcode === data.barcode)
        : db.products.find((p) => !p.barcode && p.name.toLocaleLowerCase('tr') === data.name.toLocaleLowerCase('tr'));

      if (existing) {
        Object.assign(existing, data, { is_active: 1, updated_at: now() });
        result.updated += 1;
      } else {
        db.products.push({ id: nextId('product'), ...data, created_at: now(), updated_at: now() });
        result.created += 1;
      }
    } catch (err) {
      result.errors.push({ row: raw.__row ?? idx + 1, name: raw.name ?? '', message: err.message });
    }
  });
  logAudit('BULK_IMPORT', 'products', null, null, { created: result.created, updated: result.updated });
  return result;
});

/* --------------------------- Tedarikçiler -------------------------- */
route('GET', '/api/suppliers', ({ query }) => {
  requireUser();
  const search = (query.search || '').toLocaleLowerCase('tr');
  return {
    items: db.suppliers
      .filter((s) => (query.onlyActive === '0' ? true : s.is_active))
      .filter((s) => !search || s.name.toLocaleLowerCase('tr').includes(search))
      .sort((a, b) => a.name.localeCompare(b.name, 'tr')),
  };
});

route('GET', '/api/suppliers/:id', ({ params }) => {
  const supplier = byId(db.suppliers, params.id);
  if (!supplier) throw notFound('Tedarikçi bulunamadı.');
  const allowed = visibleCampusIds();
  const purchases = db.purchases
    .filter((p) => p.supplier_id === supplier.id && p.status !== 'IPTAL' && allowed.includes(p.campus_id))
    .map((p) => ({ ...p, campus_name: campusName(p.campus_id) }))
    .sort((a, b) => (a.document_date < b.document_date ? 1 : -1))
    .slice(0, 100);
  const payments = db.supplier_payments
    .filter((p) => p.supplier_id === supplier.id)
    .sort((a, b) => (a.payment_date < b.payment_date ? 1 : -1));
  // İadeler borcu azaltır: mal geri gittiği için tedarikçi alacaklandırır
  const returns = db.supplier_returns
    .filter((r) => r.supplier_id === supplier.id && allowed.includes(r.campus_id))
    .map((r) => ({ ...r, campus_name: campusName(r.campus_id) }))
    .sort((a, b) => (a.return_date < b.return_date ? 1 : -1));

  const totalPurchase = purchases.reduce((s2, p) => s2 + p.gross_total, 0);
  const totalReturn = returns.reduce((s2, r) => s2 + r.gross_total, 0);
  const totalPaid = payments.reduce((s2, p) => s2 + p.amount, 0);
  return {
    ...supplier, purchases, payments, returns,
    balance: {
      totalPurchase: round2(totalPurchase),
      totalReturn: round2(totalReturn),
      netPurchase: round2(totalPurchase - totalReturn),
      totalPaid: round2(totalPaid),
      debt: round2(totalPurchase - totalReturn - totalPaid),
    },
  };
});

route('POST', '/api/suppliers', ({ body }) => {
  requireWrite();
  const row = { id: nextId('supplier'), ...parseSupplier(body), created_at: now() };
  db.suppliers.push(row);
  logAudit('CREATE', 'suppliers', row.id, null, { name: row.name });
  return row;
});

route('PUT', '/api/suppliers/:id', ({ params, body }) => {
  requireWrite();
  const row = byId(db.suppliers, params.id);
  if (!row) throw notFound('Tedarikçi bulunamadı.');
  Object.assign(row, parseSupplier(body));
  logAudit('UPDATE', 'suppliers', row.id, null);
  persist();
  return row;
});

route('POST', '/api/suppliers/:id/payments', ({ params, body }) => {
  requireWrite();
  const supplier = byId(db.suppliers, params.id);
  if (!supplier) throw notFound('Tedarikçi bulunamadı.');
  const row = {
    id: nextId('payment'), supplier_id: supplier.id,
    campus_id: body.campusId ? campusAccess(body.campusId) : null,
    purchase_id: body.purchaseId || null,
    amount: num(body.amount, 'Tutar', { required: true, min: 0.01 }),
    payment_date: body.paymentDate || today(),
    method: text(body.method, 'Ödeme şekli') || 'NAKIT',
    note: text(body.note, 'Açıklama'),
    created_by: session.id, created_at: now(),
  };
  db.supplier_payments.push(row);
  logAudit('CREATE', 'supplier_payments', row.id, row.campus_id, { amount: row.amount });
  return row;
});

function parseSupplier(body) {
  return {
    name: text(body.name, 'Tedarikçi adı', { required: true }),
    tax_office: text(body.taxOffice, 'Vergi dairesi'),
    tax_no: text(body.taxNo, 'Vergi/TC no'),
    phone: text(body.phone, 'Telefon'),
    email: text(body.email, 'E-posta'),
    address: text(body.address, 'Adres'),
    note: text(body.note, 'Not'),
    is_active: body.isActive === false ? 0 : 1,
  };
}

/* ------------------------------ Alımlar ---------------------------- */
route('GET', '/api/purchases', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const items = db.purchases
    .filter((p) => allowed.includes(p.campus_id))
    .filter((p) => !query.from || p.document_date >= query.from)
    .filter((p) => !query.to || p.document_date <= query.to)
    .filter((p) => !query.supplierId || p.supplier_id === Number(query.supplierId))
    .sort((a, b) => (a.document_date < b.document_date ? 1 : a.document_date > b.document_date ? -1 : b.id - a.id))
    .slice(0, Number(query.limit || 200))
    .map((p) => ({
      ...p,
      supplier_name: byId(db.suppliers, p.supplier_id)?.name ?? '—',
      campus_name: campusName(p.campus_id),
      created_by_name: userName(p.created_by),
      line_count: db.purchase_lines.filter((l) => l.purchase_id === p.id).length,
      attachment_count: attachmentsFor(p.id).length,
    }));
  return { items };
});

route('GET', '/api/purchases/:id', ({ params }) => {
  const header = byId(db.purchases, params.id);
  if (!header) throw notFound('Alım belgesi bulunamadı.');
  campusAccess(header.campus_id);
  const lines = db.purchase_lines
    .filter((l) => l.purchase_id === header.id)
    .map((l) => {
      const p = productById(l.product_id);
      return { ...l, product_name: p?.name ?? '—', barcode: p?.barcode ?? null, unit: p?.unit ?? 'ADET' };
    });
  return {
    ...header, lines,
    supplier_name: byId(db.suppliers, header.supplier_id)?.name ?? '—',
    campus_name: campusName(header.campus_id),
    attachments: attachmentsFor(header.id).map(publicAttachment),
  };
});

route('POST', '/api/purchases', ({ body }) => {
  requireWrite();
  const campusId = campusAccess(body.campusId);
  const supplierId = Number(body.supplierId);
  if (!byId(db.suppliers, supplierId)) throw bad('Tedarikçi bulunamadı.');
  const documentNo = text(body.documentNo, 'Belge no');
  const documentDate = body.documentDate || today();
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('En az bir ürün satırı girmelisiniz.');

  if (documentNo) {
    const dup = db.purchases.find((p) => p.supplier_id === supplierId && p.document_no === documentNo
      && p.campus_id === campusId && p.status !== 'IPTAL');
    if (dup) throw conflict(`Bu belge no (${documentNo}) bu tedarikçi için zaten kayıtlı. Belge #${dup.id}`);
  }

  // Aynı e-Fatura ikinci kez aktarılmasın (ETTN tekildir)
  const efaturaUuid = text(body.efaturaUuid, 'e-Fatura ETTN');
  if (efaturaUuid) {
    const dupEf = db.purchases.find((p) => p.efatura_uuid === efaturaUuid);
    if (dupEf) {
      throw conflict(
        `Bu e-Fatura zaten sisteme aktarilmis (Belge #${dupEf.id}${dupEf.document_no ? ' / ' + dupEf.document_no : ''}).`
      );
    }
  }

  const prepared = lines.map((raw, i) => {
    const product = productById(raw.productId);
    if (!product) throw bad(`Satır ${i + 1}: ürün bulunamadı.`);
    const quantity = num(raw.quantity, `Satır ${i + 1} miktar`, { required: true, min: 0.001 });
    const unitPrice = num(raw.unitPrice, `Satır ${i + 1} birim fiyat`, { required: true, min: 0 });
    const vatRate = num(raw.vatRate, 'KDV', { def: product.vat_rate }) ?? product.vat_rate;
    const discountPct = num(raw.discountPct, 'İskonto', { def: 0 }) ?? 0;
    const totals = purchaseLineTotals({ quantity, unitPrice, vatRate, discountPct });
    return {
      product, quantity, unitPrice, vatRate, discountPct, ...totals,
      expiryDate: raw.expiryDate || null,
      effectiveUnitCost: quantity > 0 ? round2(totals.netTotal / quantity) : 0,
    };
  });

  const netTotal = round2(prepared.reduce((s, l) => s + l.netTotal, 0));
  const vatTotal = round2(prepared.reduce((s, l) => s + l.vatTotal, 0));
  const purchase = {
    id: nextId('purchase'), campus_id: campusId, supplier_id: supplierId,
    document_no: documentNo, document_date: documentDate,
    net_total: netTotal, vat_total: vatTotal, gross_total: round2(netTotal + vatTotal),
    paid_amount: 0, due_date: body.dueDate || null, status: 'ONAYLI',
    note: text(body.note, 'Açıklama'), efatura_uuid: efaturaUuid || null,
    created_by: session.id, created_at: now(),
  };
  db.purchases.push(purchase);

  const priceAlerts = [];
  for (const l of prepared) {
    db.purchase_lines.push({
      id: nextId('purchase_line'), purchase_id: purchase.id, product_id: l.product.id,
      quantity: l.quantity, unit_price: l.unitPrice, vat_rate: l.vatRate, discount_pct: l.discountPct,
      net_total: l.netTotal, vat_total: l.vatTotal, gross_total: l.grossTotal, expiry_date: l.expiryDate,
    });
    addMovement({
      campus_id: campusId, product_id: l.product.id, movement_type: 'ALIS', quantity: l.quantity,
      unit_cost: l.effectiveUnitCost, movement_date: documentDate, ref_type: 'purchase', ref_id: purchase.id,
    });
    if (l.product.purchase_price > 0 && l.effectiveUnitCost > l.product.purchase_price * 1.1) {
      priceAlerts.push({
        productName: l.product.name, oldPrice: l.product.purchase_price, newPrice: l.effectiveUnitCost,
        increasePct: round2(((l.effectiveUnitCost - l.product.purchase_price) / l.product.purchase_price) * 100),
      });
    }
    if (round2(l.product.purchase_price) !== l.effectiveUnitCost) {
      l.product.purchase_price = l.effectiveUnitCost;
      l.product.updated_at = now();
    }
  }
  logAudit('CREATE', 'purchases', purchase.id, campusId, { documentNo, grossTotal: purchase.gross_total });
  return { id: purchase.id, netTotal, vatTotal, grossTotal: purchase.gross_total, priceAlerts };
});

/* --------------------- Alım belgesi ekleri ------------------------- */
/**
 * Fatura dosyaları. Demoda dosya sunucuya gitmez: içeriği (bytes) bellekte
 * tutulur, kaydedilen depoya yalnızca künyesi yazılır. Bu yüzden sayfa
 * yenilenince önceden eklenen dosyaların içeriği kaybolur — künyesi kalır.
 * Kurulu sürümde dosyalar okulun kendi sunucusunda `data/ekler` altındadır.
 */
const attachmentsFor = (purchaseId) => db.purchase_attachments.filter((a) => a.purchase_id === Number(purchaseId));

/** Dosya baytlarını dışarı vermeden künyeyi döndürür. */
const publicAttachment = (a) => ({
  id: a.id, file_name: a.file_name, content_type: a.content_type, byte_size: a.byte_size,
  sha256: a.sha256, kind: a.kind, created_at: a.created_at,
  uploaded_by_name: userName(a.uploaded_by),
});

/** İçeriğe bakarak türü belirler — gerçek sunucudaki kontrolün aynısı. */
function detectDemoType(bytes) {
  const head = String.fromCharCode(...bytes.slice(0, 12));
  if (head.startsWith('%PDF-')) return { type: 'application/pdf', ext: '.pdf' };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { type: 'image/jpeg', ext: '.jpg' };
  if (bytes[0] === 0x89 && head.slice(1, 4) === 'PNG') return { type: 'image/png', ext: '.png' };
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') return { type: 'image/webp', ext: '.webp' };
  const text0 = new TextDecoder().decode(bytes.slice(0, 512)).replace(/^﻿/, '').trimStart();
  if (text0.startsWith('<')) return { type: 'application/xml', ext: '.xml' };
  throw bad('Yalnızca PDF, JPG, PNG, WEBP ve XML dosyaları yüklenebilir.');
}

/** Basit ama kararlı bir özet: aynı içerik aynı değeri verir. */
function demoDigest(bytes) {
  let h1 = 0x811c9dc5; let h2 = 0x01000193; let h3 = 0x9e3779b9; let h4 = 0x85ebca6b;
  for (let i = 0; i < bytes.length; i += 1) {
    h1 = Math.imul(h1 ^ bytes[i], 0x01000193) >>> 0;
    h2 = Math.imul(h2 + bytes[i] * (i + 1), 0x85ebca6b) >>> 0;
    h3 = Math.imul(h3 ^ (bytes[i] + i), 0xc2b2ae35) >>> 0;
    h4 = (h4 + Math.imul(bytes[i] + 1, 0x27d4eb2f)) >>> 0;
  }
  const part = (n) => n.toString(16).padStart(8, '0');
  return (part(h1) + part(h2) + part(h3) + part(h4)).repeat(2).slice(0, 64);
}

route('POST', '/api/purchases/:id/attachments', ({ params, query, body }) => {
  requireWrite();
  const header = byId(db.purchases, params.id);
  if (!header) throw notFound('Alım belgesi bulunamadı.');
  campusAccess(header.campus_id);
  if (header.status === 'IPTAL') throw conflict('İptal edilmiş belgeye ek eklenemez.');

  const file = body?.__file;
  if (!file || !file.bytes?.length) throw bad('Boş dosya yüklenemez.');
  if (file.bytes.length > 10 * 1024 * 1024) throw bad('Dosya çok büyük. En fazla 10 MB yüklenebilir.');

  const sig = detectDemoType(file.bytes);
  const sha256 = demoDigest(file.bytes);
  if (attachmentsFor(header.id).some((a) => a.sha256 === sha256)) {
    throw conflict('Bu dosya bu belgeye zaten eklenmiş.');
  }

  const row = {
    id: nextId('attachment'), purchase_id: header.id,
    file_name: String(query.filename || file.name || `belge${sig.ext}`).replace(/[\\/]/g, '_').slice(0, 120),
    content_type: sig.type, byte_size: file.bytes.length, sha256,
    kind: query.kind === 'EFATURA_XML' ? 'EFATURA_XML' : 'BELGE',
    uploaded_by: session.id, created_at: now(),
    bytes: file.bytes,   // yalnızca bellekte; persist sırasında atlanır
  };
  db.purchase_attachments.push(row);
  logAudit('ATTACH', 'purchases', header.id, header.campus_id,
    { fileName: row.file_name, byteSize: row.byte_size, kind: row.kind });
  return { items: attachmentsFor(header.id).map(publicAttachment) };
});

route('GET', '/api/purchases/:id/attachments', ({ params }) => {
  const header = byId(db.purchases, params.id);
  if (!header) throw notFound('Alım belgesi bulunamadı.');
  campusAccess(header.campus_id);
  return { items: attachmentsFor(header.id).map(publicAttachment) };
});

route('GET', '/api/purchases/:id/attachments/:attachmentId', ({ params }) => {
  const header = byId(db.purchases, params.id);
  if (!header) throw notFound('Alım belgesi bulunamadı.');
  campusAccess(header.campus_id);
  const row = attachmentsFor(header.id).find((a) => a.id === Number(params.attachmentId));
  if (!row) throw notFound('Ek belge bulunamadı.');
  if (!row.bytes) {
    throw new DemoError(404,
      'Demoda dosya içerikleri yalnızca açık olduğunuz oturumda saklanır; sayfa yenilendiği için '
      + 'bu dosyanın içeriği kayboldu. Kurulu sürümde dosya okulun sunucusunda kalıcı durur.');
  }
  return { bytes: row.bytes, contentType: row.content_type, fileName: row.file_name };
});

route('DELETE', '/api/purchases/:id/attachments/:attachmentId', ({ params }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  const header = byId(db.purchases, params.id);
  if (!header) throw notFound('Alım belgesi bulunamadı.');
  campusAccess(header.campus_id);
  const row = attachmentsFor(header.id).find((a) => a.id === Number(params.attachmentId));
  if (!row) throw notFound('Ek belge bulunamadı.');

  db.purchase_attachments = db.purchase_attachments.filter((a) => a.id !== row.id);
  logAudit('ATTACHMENT_DELETE', 'purchases', header.id, header.campus_id,
    { fileName: row.file_name, sha256: row.sha256, kind: row.kind });
  return { items: attachmentsFor(header.id).map(publicAttachment) };
});

route('POST', '/api/purchases/:id/cancel', ({ params }) => {
  requireWrite();
  const header = byId(db.purchases, params.id);
  if (!header) throw notFound('Alım belgesi bulunamadı.');
  campusAccess(header.campus_id);
  if (header.status === 'IPTAL') throw conflict('Belge zaten iptal edilmiş.');
  const later = db.counts.find((c) => c.campus_id === header.campus_id && c.status === 'KESINLESMIS'
    && c.count_type === 'DONEM' && c.count_date >= header.document_date);
  if (later) {
    throw conflict(`Bu belge ${later.count_date} tarihli kesinleşmiş sayıma dahil olduğu için iptal edilemez. Düzeltme kaydı giriniz.`);
  }
  const linkedReturn = db.supplier_returns.find((r) => r.purchase_id === header.id);
  if (linkedReturn) {
    throw conflict(`Bu belgeye bağlı bir iade kaydı var (#${linkedReturn.id}). Önce iadeyi silin.`);
  }
  header.status = 'IPTAL';
  db.movements = db.movements.filter((m) => !(m.ref_type === 'purchase' && m.ref_id === header.id));
  logAudit('CANCEL', 'purchases', header.id, header.campus_id);
  return { ok: true };
});

/* ------------------------------- Stok ------------------------------ */
route('GET', '/api/stock', ({ query }) => {
  const campusId = campusAccess(query.campusId);
  const search = (query.search || '').toLocaleLowerCase('tr');
  let items = stockSnapshot(campusId, {
    untilDate: query.date || null,
    onlyActive: query.onlyActive !== '0',
  })
    .filter((r) => !query.categoryId || productById(r.product_id)?.category_id === Number(query.categoryId))
    .filter((r) => !search
      || r.name.toLocaleLowerCase('tr').includes(search)
      || (r.barcode || '').toLocaleLowerCase('tr').includes(search))
    .map((r) => ({
      ...r,
      profit: productProfit(r.purchase_price, r.sale_price, r.vat_rate),
      stock_cost_value: round2(r.stock_qty * r.purchase_price),
      stock_sale_value: round2(r.stock_qty * r.sale_price),
      is_critical: r.critical_stock > 0 && r.stock_qty <= r.critical_stock,
    }));
  if (query.onlyCritical === '1') items = items.filter((r) => r.is_critical);
  return { items, summary: stockValue(campusId, query.date || null) };
});

route('GET', '/api/stock/movements', ({ query }) => {
  const campusId = campusAccess(query.campusId);
  const productId = Number(query.productId);
  const items = db.movements
    .filter((m) => m.campus_id === campusId && m.product_id === productId)
    .filter((m) => !query.from || m.movement_date >= query.from)
    .filter((m) => !query.to || m.movement_date <= query.to)
    .sort((a, b) => (a.movement_date < b.movement_date ? 1 : a.movement_date > b.movement_date ? -1 : b.id - a.id))
    .slice(0, Number(query.limit || 300))
    .map((m) => ({ ...m, created_by_name: userName(m.created_by) }));
  return { items };
});

route('POST', '/api/stock/opening', ({ body }) => {
  requireWrite();
  const campusId = campusAccess(body.campusId);
  const date = body.date || today();
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('En az bir ürün için miktar girin.');
  assertNotLocked(campusId, date);
  let count = 0;
  for (const line of lines) {
    const quantity = num(line.quantity, 'Miktar', { min: 0, def: 0 }) ?? 0;
    if (quantity === 0) continue;
    const prices = effectivePrices(campusId, line.productId);
    if (!prices) throw bad('Ürün bulunamadı.');
    addMovement({
      campus_id: campusId, product_id: Number(line.productId), movement_type: 'ACILIS',
      quantity, unit_cost: prices.purchase_price, movement_date: date,
      ref_type: 'opening', note: 'Açılış stoğu',
    });
    count += 1;
  }
  logAudit('OPENING_STOCK', 'stock_movements', null, campusId, { count, date });
  return { ok: true, count };
});

route('POST', '/api/stock/opening-import', ({ body }) => {
  requireWrite();
  const date = body.date || today();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw bad('İçeri aktarılacak satır bulunamadı.');
  const result = { imported: 0, skipped: 0, errors: [], byCampus: {} };

  items.forEach((raw, i) => {
    const rowNo = raw.__row ?? i + 1;
    try {
      const code = String(raw.campusCode || '').toLocaleUpperCase('tr');
      if (!code) throw bad('Kampüs kodu boş.');
      const campus = db.campuses.find((c) => c.code.toLocaleUpperCase('tr') === code);
      if (!campus) throw bad(`"${code}" kodlu kampüs bulunamadı.`);
      campusAccess(campus.id);

      const barcode = text(raw.barcode, 'Barkod');
      const name = text(raw.productName, 'Ürün adı');
      const product = barcode
        ? db.products.find((p) => p.barcode === barcode)
        : (name ? db.products.find((p) => p.name.toLocaleLowerCase('tr') === name.toLocaleLowerCase('tr')) : null);
      if (!product) throw bad(`Ürün bulunamadı (${barcode || name || '-'}). Önce ürün listesini yükleyin.`);

      const quantity = num(raw.quantity, 'Miktar', { required: true, min: 0 });
      if (quantity === 0) { result.skipped += 1; return; }
      assertNotLocked(campus.id, date);

      const prices = effectivePrices(campus.id, product.id);
      addMovement({
        campus_id: campus.id, product_id: product.id, movement_type: 'ACILIS', quantity,
        unit_cost: prices.purchase_price, movement_date: date,
        ref_type: 'opening', note: 'Excel ile açılış stoğu',
      });
      result.imported += 1;
      result.byCampus[campus.name] = (result.byCampus[campus.name] || 0) + 1;
    } catch (err) {
      result.errors.push({ row: rowNo, message: err.message });
    }
  });
  logAudit('OPENING_STOCK', 'stock_movements', null, null, { imported: result.imported });
  return result;
});

/* ------------------------------- Fire ------------------------------ */
route('GET', '/api/waste', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const items = db.waste
    .filter((w) => allowed.includes(w.campus_id))
    .filter((w) => !query.from || w.waste_date >= query.from)
    .filter((w) => !query.to || w.waste_date <= query.to)
    .sort((a, b) => (a.waste_date < b.waste_date ? 1 : a.waste_date > b.waste_date ? -1 : b.id - a.id))
    .slice(0, Number(query.limit || 200))
    .map((w) => {
      const p = productById(w.product_id);
      return {
        ...w, product_name: p?.name ?? '—', unit: p?.unit ?? 'ADET',
        campus_name: campusName(w.campus_id), created_by_name: userName(w.created_by),
        cost_value: round2(w.quantity * w.unit_cost),
      };
    });
  return { items, totalCost: round2(items.reduce((s, r) => s + r.cost_value, 0)) };
});

route('POST', '/api/waste', ({ body }) => {
  requireWrite();
  const campusId = campusAccess(body.campusId);
  const productId = Number(body.productId);
  const quantity = num(body.quantity, 'Miktar', { required: true, min: 0.001 });
  const reason = String(body.reason || '');
  if (!['SKT', 'KIRILMA', 'BOZULMA', 'IKRAM', 'PERSONEL', 'DIGER'].includes(reason)) {
    throw bad('Geçerli bir fire nedeni seçin.');
  }
  const wasteDate = body.wasteDate || today();
  const prices = effectivePrices(campusId, productId);
  if (!prices) throw bad('Ürün bulunamadı.');
  assertNotLocked(campusId, wasteDate);

  const row = {
    id: nextId('waste'), campus_id: campusId, product_id: productId, quantity,
    reason, waste_date: wasteDate, unit_cost: prices.purchase_price,
    note: text(body.note, 'Açıklama'), created_by: session.id, created_at: now(),
  };
  db.waste.push(row);
  addMovement({
    campus_id: campusId, product_id: productId, movement_type: 'FIRE', quantity: -quantity,
    unit_cost: prices.purchase_price, movement_date: wasteDate,
    ref_type: 'waste', ref_id: row.id, note: reason,
  });
  logAudit('CREATE', 'waste_records', row.id, campusId, { productId, quantity, reason });
  return row;
});

/* ----------------------------- Transfer ---------------------------- */
route('GET', '/api/transfers', ({ query }) => {
  const u = requireUser();
  const items = db.transfers
    .filter((t) => seesAll(u) || t.from_campus_id === u.campus_id || t.to_campus_id === u.campus_id)
    .sort((a, b) => (a.transfer_date < b.transfer_date ? 1 : -1))
    .slice(0, Number(query.limit || 100))
    .map((t) => ({
      ...t,
      from_campus_name: campusName(t.from_campus_id),
      to_campus_name: campusName(t.to_campus_id),
      created_by_name: userName(t.created_by),
      line_count: db.transfer_lines.filter((l) => l.transfer_id === t.id).length,
    }));
  return { items };
});

route('GET', '/api/transfers/:id', ({ params }) => {
  const t = byId(db.transfers, params.id);
  if (!t) throw notFound('Transfer bulunamadı.');
  const lines = db.transfer_lines
    .filter((l) => l.transfer_id === t.id)
    .map((l) => {
      const p = productById(l.product_id);
      return { ...l, product_name: p?.name ?? '—', unit: p?.unit ?? 'ADET' };
    });
  return {
    ...t, lines,
    from_campus_name: campusName(t.from_campus_id),
    to_campus_name: campusName(t.to_campus_id),
  };
});

route('POST', '/api/transfers', ({ body }) => {
  requireWrite();
  const fromCampusId = campusAccess(body.fromCampusId);
  const toCampusId = Number(body.toCampusId);
  if (fromCampusId === toCampusId) throw bad('Kaynak ve hedef kampüs aynı olamaz.');
  if (!byId(db.campuses, toCampusId)) throw bad('Hedef kampüs bulunamadı.');
  const transferDate = body.transferDate || today();
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('En az bir ürün satırı girmelisiniz.');
  assertNotLocked(fromCampusId, transferDate);
  assertNotLocked(toCampusId, transferDate);

  const transfer = {
    id: nextId('transfer'), from_campus_id: fromCampusId, to_campus_id: toCampusId,
    transfer_date: transferDate, note: text(body.note, 'Açıklama'),
    created_by: session.id, created_at: now(),
  };
  db.transfers.push(transfer);

  for (const [i, raw] of lines.entries()) {
    const productId = Number(raw.productId);
    const quantity = num(raw.quantity, `Satır ${i + 1} miktar`, { required: true, min: 0.001 });
    const prices = effectivePrices(fromCampusId, productId);
    if (!prices) throw bad(`Satır ${i + 1}: ürün bulunamadı.`);
    db.transfer_lines.push({
      id: nextId('transfer_line'), transfer_id: transfer.id, product_id: productId,
      quantity, unit_cost: prices.purchase_price,
    });
    addMovement({
      campus_id: fromCampusId, product_id: productId, movement_type: 'TRANSFER_CIKIS',
      quantity: -quantity, unit_cost: prices.purchase_price, movement_date: transferDate,
      ref_type: 'transfer', ref_id: transfer.id,
    });
    addMovement({
      campus_id: toCampusId, product_id: productId, movement_type: 'TRANSFER_GIRIS',
      quantity, unit_cost: prices.purchase_price, movement_date: transferDate,
      ref_type: 'transfer', ref_id: transfer.id,
    });
  }
  logAudit('CREATE', 'transfers', transfer.id, fromCampusId, { toCampusId, lineCount: lines.length });
  return { id: transfer.id };
});

/* ---------------------------- Reçete ------------------------------- */
/** Bir ürünün reçetesini satırlarıyla döndürür; yoksa null. */
function recipeFor(productId) {
  const recipe = db.recipes.find((r) => r.product_id === Number(productId) && r.is_active);
  if (!recipe) return null;
  const items = db.recipe_items
    .filter((ri) => ri.recipe_id === recipe.id)
    .map((ri) => {
      const p = productById(ri.ingredient_id);
      return {
        ...ri,
        ingredient_name: p?.name ?? '—',
        ingredient_unit: p?.unit ?? 'ADET',
        ingredient_type: p?.product_type ?? 'SATIN_ALINAN',
        catalog_purchase_price: p?.purchase_price ?? 0,
      };
    })
    .sort((a, b) => a.ingredient_name.localeCompare(b.ingredient_name, 'tr'));
  return { ...recipe, items };
}

/** Üretilen ürünün 1 adedinin hammadde maliyeti. */
function recipeUnitCost(campusId, productId) {
  const recipe = recipeFor(productId);
  if (!recipe || !recipe.items.length) {
    return { unitCost: productById(productId)?.purchase_price ?? 0, items: [], hasRecipe: false, yield: 1 };
  }
  const items = recipe.items.map((item) => {
    const price = effectivePrices(campusId, item.ingredient_id)?.purchase_price ?? 0;
    const perUnit = round4(item.quantity / recipe.yield_quantity);
    return {
      ...item, unit_price: price, per_unit_quantity: perUnit,
      per_unit_cost: round4(perUnit * price), batch_cost: round2(item.quantity * price),
    };
  });
  return {
    unitCost: round4(items.reduce((s2, i) => s2 + i.per_unit_cost, 0)),
    batchCost: round2(items.reduce((s2, i) => s2 + i.batch_cost, 0)),
    items, hasRecipe: true, yield: recipe.yield_quantity, recipeId: recipe.id,
  };
}

/** Beyan edilen üretim adetlerine göre hammadde tüketimi. */
function recipeConsumption(campusId, productionRows) {
  const consumption = new Map();
  for (const row of productionRows) {
    if (!row.quantity) continue;
    const recipe = recipeFor(row.product_id);
    if (!recipe || !recipe.items.length) continue;
    for (const item of recipe.items) {
      const perUnit = item.quantity / recipe.yield_quantity;
      consumption.set(item.ingredient_id,
        round4((consumption.get(item.ingredient_id) || 0) + perUnit * row.quantity));
    }
  }
  return consumption;
}

route('GET', '/api/recipes', ({ query }) => {
  const u = requireUser();
  const campusId = query.campusId ? campusAccess(query.campusId) : (u.campus_id || db.campuses[0]?.id);

  const items = db.products
    .filter((p) => p.is_active && p.product_type === 'URETILEN')
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    .map((p) => {
      const cost = recipeUnitCost(campusId, p.id);
      const recipe = recipeFor(p.id);
      return {
        ...p,
        category_name: byId(db.categories, p.category_id)?.name ?? null,
        recipe_id: recipe?.id ?? null,
        yield_quantity: recipe?.yield_quantity ?? null,
        item_count: recipe?.items.length ?? 0,
        has_recipe: cost.hasRecipe,
        unit_cost: round2(cost.unitCost),
        estimated_cost: p.purchase_price,
        profit: productProfit(cost.unitCost, p.sale_price, p.vat_rate),
        cost_gap: cost.hasRecipe ? round2(cost.unitCost - p.purchase_price) : null,
      };
    });

  return { campusId, items, withoutRecipe: items.filter((i) => !i.has_recipe).length };
});

route('GET', '/api/recipes/:productId', ({ params, query }) => {
  const u = requireUser();
  const productId = Number(params.productId);
  const product = productById(productId);
  if (!product) throw notFound('Ürün bulunamadı.');
  const campusId = query.campusId ? campusAccess(query.campusId) : (u.campus_id || db.campuses[0]?.id);

  const cost = recipeUnitCost(campusId, productId);
  const recipe = recipeFor(productId);
  return {
    product,
    hasRecipe: cost.hasRecipe,
    yieldQuantity: cost.yield ?? 1,
    note: recipe?.note ?? null,
    items: cost.items,
    unitCost: round2(cost.unitCost),
    batchCost: cost.batchCost ?? 0,
    profit: productProfit(cost.unitCost, product.sale_price, product.vat_rate),
    candidates: db.products
      .filter((p) => p.is_active && p.product_type !== 'URETILEN')
      .sort((a, b) => (b.product_type.localeCompare(a.product_type) || a.name.localeCompare(b.name, 'tr')))
      .map((p) => ({
        id: p.id, name: p.name, unit: p.unit, barcode: p.barcode,
        product_type: p.product_type, purchase_price: p.purchase_price,
      })),
  };
});

route('PUT', '/api/recipes/:productId', ({ params, body }) => {
  requireWrite();
  const productId = Number(params.productId);
  const product = productById(productId);
  if (!product) throw notFound('Ürün bulunamadı.');
  if (product.product_type !== 'URETILEN') {
    throw bad('Reçete yalnızca "üretilen" tipindeki ürünler için tanımlanır.');
  }

  const yieldQuantity = num(body.yieldQuantity, 'Üretilen adet', { required: true, min: 0.001 });
  const lines = Array.isArray(body.items) ? body.items : [];
  if (!lines.length) throw bad('En az bir içerik satırı girmelisiniz.');

  const prepared = lines.map((raw, i) => {
    const ingredient = productById(raw.ingredientId);
    if (!ingredient) throw bad(`Satır ${i + 1}: içerik bulunamadı.`);
    if (ingredient.id === productId) throw bad('Bir ürün kendi reçetesinin içeriği olamaz.');
    if (ingredient.product_type === 'URETILEN') {
      throw bad(`Satır ${i + 1}: "${ingredient.name}" üretilen bir ürün; reçete içeriği olamaz.`);
    }
    return {
      ingredientId: ingredient.id,
      quantity: num(raw.quantity, `Satır ${i + 1} miktar`, { required: true, min: 0.0001 }),
    };
  });
  const ids = prepared.map((l) => l.ingredientId);
  if (new Set(ids).size !== ids.length) throw bad('Aynı içerik birden fazla satırda olamaz.');

  let recipe = db.recipes.find((r) => r.product_id === productId);
  if (recipe) {
    recipe.yield_quantity = yieldQuantity;
    recipe.note = text(body.note, 'Açıklama');
    recipe.is_active = 1;
    recipe.updated_at = now();
    db.recipe_items = db.recipe_items.filter((ri) => ri.recipe_id !== recipe.id);
  } else {
    recipe = {
      id: nextId('recipe'), product_id: productId, yield_quantity: yieldQuantity,
      note: text(body.note, 'Açıklama'), is_active: 1, created_by: session.id,
      created_at: now(), updated_at: now(),
    };
    db.recipes.push(recipe);
  }
  for (const l of prepared) {
    db.recipe_items.push({
      id: nextId('recipe_item'), recipe_id: recipe.id,
      ingredient_id: l.ingredientId, quantity: l.quantity, note: null,
    });
  }

  logAudit('UPDATE', 'recipes', productId, null, { product: product.name, itemCount: prepared.length });
  const campusId = session.campus_id || db.campuses[0]?.id;
  const cost = recipeUnitCost(campusId, productId);
  return {
    ok: true, unitCost: round2(cost.unitCost), batchCost: cost.batchCost,
    profit: productProfit(cost.unitCost, product.sale_price, product.vat_rate),
  };
});

route('DELETE', '/api/recipes/:productId', ({ params }) => {
  requireWrite();
  const productId = Number(params.productId);
  const recipe = db.recipes.find((r) => r.product_id === productId);
  if (!recipe) throw notFound('Reçete bulunamadı.');

  const used = db.production_sales.find((ps) => {
    const count = byId(db.counts, ps.count_id);
    return ps.product_id === productId && ps.quantity > 0 && count?.status === 'KESINLESMIS';
  });
  if (used) {
    const count = byId(db.counts, used.count_id);
    throw conflict(`Bu reçete ${count.count_date} tarihli kesinleşmiş sayımda kullanıldı. Silmek yerine içeriğini güncelleyin.`);
  }

  db.recipes = db.recipes.filter((r) => r.id !== recipe.id);
  db.recipe_items = db.recipe_items.filter((ri) => ri.recipe_id !== recipe.id);
  logAudit('DELETE', 'recipes', productId, null);
  return { ok: true };
});

/* ------------------------ Tedarikçiye iade ------------------------- */
const RETURN_REASONS = ['BOZUK', 'SKT', 'YANLIS_URUN', 'FAZLA_GONDERIM', 'HASARLI', 'DIGER'];

route('GET', '/api/returns', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const rows = db.supplier_returns
    .filter((r) => allowed.includes(r.campus_id))
    .filter((r) => !query.from || r.return_date >= query.from)
    .filter((r) => !query.to || r.return_date <= query.to)
    .filter((r) => !query.supplierId || r.supplier_id === Number(query.supplierId));

  const items = rows
    .sort((a, b) => (a.return_date < b.return_date ? 1 : a.return_date > b.return_date ? -1 : b.id - a.id))
    .slice(0, Number(query.limit || 200))
    .map((r) => ({
      ...r,
      supplier_name: byId(db.suppliers, r.supplier_id)?.name ?? '—',
      campus_name: campusName(r.campus_id),
      created_by_name: userName(r.created_by),
      purchase_document_no: r.purchase_id ? byId(db.purchases, r.purchase_id)?.document_no ?? null : null,
      line_count: db.supplier_return_lines.filter((l) => l.return_id === r.id).length,
    }));

  const reasonMap = new Map();
  for (const r of rows) {
    const g = reasonMap.get(r.reason) || { reason: r.reason, document_count: 0, total: 0 };
    g.document_count += 1; g.total += r.gross_total;
    reasonMap.set(r.reason, g);
  }

  return {
    items,
    summary: {
      documentCount: items.length,
      netTotal: round2(items.reduce((s2, r) => s2 + r.net_total, 0)),
      grossTotal: round2(items.reduce((s2, r) => s2 + r.gross_total, 0)),
    },
    byReason: [...reasonMap.values()]
      .map((r) => ({ ...r, total: round2(r.total) }))
      .sort((a, b) => b.total - a.total),
  };
});

route('GET', '/api/returns/:id', ({ params }) => {
  const header = byId(db.supplier_returns, params.id);
  if (!header) throw notFound('İade belgesi bulunamadı.');
  campusAccess(header.campus_id);
  const lines = db.supplier_return_lines
    .filter((l) => l.return_id === header.id)
    .map((l) => {
      const p = productById(l.product_id);
      return { ...l, product_name: p?.name ?? '—', barcode: p?.barcode ?? null, unit: p?.unit ?? 'ADET' };
    });
  return {
    ...header, lines,
    supplier_name: byId(db.suppliers, header.supplier_id)?.name ?? '—',
    campus_name: campusName(header.campus_id),
    created_by_name: userName(header.created_by),
    purchase_document_no: header.purchase_id ? byId(db.purchases, header.purchase_id)?.document_no ?? null : null,
  };
});

route('POST', '/api/returns', ({ body }) => {
  requireWrite();
  const campusId = campusAccess(body.campusId);
  const supplierId = Number(body.supplierId);
  if (!byId(db.suppliers, supplierId)) throw bad('Tedarikçi bulunamadı.');

  const returnDate = body.returnDate || today();
  if (returnDate > today()) throw bad('Gelecek tarihli iade girilemez.');
  const reason = String(body.reason || '');
  if (!RETURN_REASONS.includes(reason)) throw bad('Geçerli bir iade nedeni seçin.');
  const documentNo = text(body.documentNo, 'İade irsaliye no');
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('En az bir ürün satırı girmelisiniz.');

  assertNotLocked(campusId, returnDate);

  const purchaseId = body.purchaseId ? Number(body.purchaseId) : null;
  if (purchaseId) {
    const purchase = byId(db.purchases, purchaseId);
    if (!purchase) throw bad('Seçilen alım belgesi bulunamadı.');
    if (purchase.campus_id !== campusId) throw bad('Alım belgesi başka bir kampüse ait.');
    if (purchase.supplier_id !== supplierId) throw bad('Alım belgesi başka bir tedarikçiye ait.');
    if (purchase.status === 'IPTAL') throw bad('İptal edilmiş alım belgesine iade girilemez.');
  }

  if (documentNo) {
    const dup = db.supplier_returns.find((r) => r.supplier_id === supplierId
      && r.document_no === documentNo && r.campus_id === campusId);
    if (dup) throw conflict(`Bu iade irsaliye no (${documentNo}) bu tedarikçi için zaten kayıtlı. Belge #${dup.id}`);
  }

  const prepared = lines.map((raw, i) => {
    const product = productById(raw.productId);
    if (!product) throw bad(`Satır ${i + 1}: ürün bulunamadı.`);
    if (product.product_type === 'URETILEN') {
      throw bad(`Satır ${i + 1}: "${product.name}" kantinde üretilen bir ürün, tedarikçiye iade edilemez.`);
    }
    const quantity = num(raw.quantity, `Satır ${i + 1} miktar`, { required: true, min: 0.001 });
    const prices = effectivePrices(campusId, product.id);
    const unitPrice = num(raw.unitPrice, `Satır ${i + 1} birim fiyat`, { min: 0, def: prices.purchase_price })
      ?? prices.purchase_price;
    const vatRate = num(raw.vatRate, 'KDV', { def: product.vat_rate }) ?? product.vat_rate;
    const totals = purchaseLineTotals({ quantity, unitPrice, vatRate });
    return { product, quantity, unitPrice, vatRate, ...totals };
  });

  const netTotal = round2(prepared.reduce((s2, l) => s2 + l.netTotal, 0));
  const vatTotal = round2(prepared.reduce((s2, l) => s2 + l.vatTotal, 0));

  const stockWarnings = prepared
    .map((l) => ({
      name: l.product.name, quantity: l.quantity, stock: round2(stockOf(campusId, l.product.id)),
    }))
    .filter((w) => w.quantity > w.stock);

  const header = {
    id: nextId('supplier_return'), campus_id: campusId, supplier_id: supplierId, purchase_id: purchaseId,
    document_no: documentNo, return_date: returnDate, reason,
    net_total: netTotal, vat_total: vatTotal, gross_total: round2(netTotal + vatTotal),
    note: text(body.note, 'Açıklama'), created_by: session.id, created_at: now(),
  };
  db.supplier_returns.push(header);

  for (const l of prepared) {
    db.supplier_return_lines.push({
      id: nextId('supplier_return_line'), return_id: header.id, product_id: l.product.id,
      quantity: l.quantity, unit_price: l.unitPrice, vat_rate: l.vatRate,
      net_total: l.netTotal, vat_total: l.vatTotal, gross_total: l.grossTotal,
    });
    addMovement({
      campus_id: campusId, product_id: l.product.id, movement_type: 'IADE', quantity: -l.quantity,
      unit_cost: l.unitPrice, movement_date: returnDate,
      ref_type: 'return', ref_id: header.id, note: `Tedarikçiye iade - ${reason}`,
    });
  }

  logAudit('CREATE', 'supplier_returns', header.id, campusId, { supplierId, reason, grossTotal: header.gross_total });
  return { id: header.id, netTotal, vatTotal, grossTotal: header.gross_total, stockWarnings };
});

route('DELETE', '/api/returns/:id', ({ params }) => {
  requireWrite();
  const header = byId(db.supplier_returns, params.id);
  if (!header) throw notFound('İade belgesi bulunamadı.');
  campusAccess(header.campus_id);

  const later = db.counts.find((c) => c.campus_id === header.campus_id && c.status === 'KESINLESMIS'
    && c.count_type === 'DONEM' && c.count_date >= header.return_date);
  if (later) {
    throw conflict(`Bu belge ${later.count_date} tarihli kesinleşmiş sayıma dahil olduğu için silinemez.`);
  }

  db.movements = db.movements.filter((m) => !(m.ref_type === 'return' && m.ref_id === header.id));
  db.supplier_returns = db.supplier_returns.filter((r) => r.id !== header.id);
  db.supplier_return_lines = db.supplier_return_lines.filter((l) => l.return_id !== header.id);
  logAudit('DELETE', 'supplier_returns', header.id, header.campus_id, { grossTotal: header.gross_total });
  return { ok: true };
});

/* ------------------------------ Sayım ------------------------------ */
function withVariance(row) {
  const difference = round2((row.actual_revenue || 0) - (row.expected_revenue || 0));
  return { ...row, difference, difference_pct: pctOf(difference, row.expected_revenue || 0) };
}

function producedProducts(campusId) {
  return db.products
    .filter((p) => p.is_active && p.product_type === 'URETILEN')
    .map((p) => ({ id: p.id, ...effectivePrices(campusId, p.id) }))
    .sort((a, b) => (productById(a.id)?.name ?? '').localeCompare(productById(b.id)?.name ?? '', 'tr'));
}

/**
 * Sayım kaydını yükler.
 * KÖR SAYIM: taslak halindeyken beklenen miktar ve türevleri maskelenir.
 * Maskeleme burada (veri katmanında) yapılır; arayüzden aşılamaz.
 */
function loadCount(countId) {
  const header = byId(db.counts, countId);
  if (!header) throw notFound('Sayım bulunamadı.');
  const blindActive = !!header.is_blind && header.status === 'TASLAK';

  let lines = db.count_lines
    .filter((l) => l.count_id === header.id)
    .map((l) => {
      const p = productById(l.product_id);
      return {
        ...l, product_name: p?.name ?? '—', barcode: p?.barcode ?? null, unit: p?.unit ?? 'ADET',
        category_name: byId(db.categories, p?.category_id)?.name ?? null,
      };
    })
    .sort((a, b) => (a.category_name || '').localeCompare(b.category_name || '', 'tr')
      || a.product_name.localeCompare(b.product_name, 'tr'));

  const progress = { total: lines.length, filled: lines.filter((l) => l.counted_qty !== 0).length };
  if (blindActive) {
    lines = lines.map((l) => ({
      ...l, expected_qty: null, diff_qty: null, sold_qty: null, sales_value: null, cost_value: null,
    }));
  }

  const production = db.production_sales
    .filter((r) => r.count_id === header.id)
    .map((r) => {
      const p = productById(r.product_id);
      return { ...r, product_name: p?.name ?? '—', unit: p?.unit ?? 'ADET' };
    })
    .sort((a, b) => a.product_name.localeCompare(b.product_name, 'tr'));

  return withVariance({
    ...header, lines, production, progress,
    blind_active: blindActive,
    campus_name: campusName(header.campus_id),
    created_by_name: userName(header.created_by),
    submitted_by_name: userName(header.submitted_by),
    finalized_by_name: userName(header.finalized_by),
    can_finalize: header.status === 'SAYILDI' && header.count_type === 'DONEM'
      && header.submitted_by !== session?.id
      && ['ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI'].includes(session?.role),
  });
}

route('GET', '/api/counts', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const items = db.counts
    .filter((c) => allowed.includes(c.campus_id))
    .filter((c) => !query.type || c.count_type === query.type)
    .sort((a, b) => (a.count_date < b.count_date ? 1 : a.count_date > b.count_date ? -1 : b.id - a.id))
    .slice(0, Number(query.limit || 100))
    .map((c) => withVariance({
      ...c,
      campus_name: campusName(c.campus_id),
      created_by_name: userName(c.created_by),
      submitted_by_name: userName(c.submitted_by),
      finalized_by_name: userName(c.finalized_by),
      line_count: db.count_lines.filter((l) => l.count_id === c.id).length,
    }));
  return { items };
});

route('POST', '/api/counts', ({ body }) => {
  requireWrite();
  const campusId = campusAccess(body.campusId);
  const countType = body.countType === 'NOKTA' ? 'NOKTA' : 'DONEM';
  const countDate = body.countDate || today();
  if (countDate > today()) throw bad('Gelecek tarihli sayım oluşturulamaz.');

  // Kör sayım varsayılandır; kapatmak yalnızca genel müdürlüğün kararı olabilir
  let isBlind = 1;
  if (body.isBlind === false) { requireRole('ADMIN', 'GENEL_MUDURLUK'); isBlind = 0; }

  const open = db.counts.find((c) => c.campus_id === campusId && c.count_type === countType
    && ['TASLAK', 'SAYILDI'].includes(c.status));
  if (open) {
    throw conflict(`Bu kampüste tamamlanmamış bir ${countType === 'NOKTA' ? 'nokta' : 'dönem'} sayımı var (#${open.id}). Önce onu tamamlayın veya silin.`);
  }

  let periodStart = null;
  if (countType === 'DONEM') {
    const last = lastFinalizedCount(campusId);
    if (last && countDate <= last.count_date) {
      throw bad(`Son kesinleşmiş sayım ${last.count_date} tarihli. Sayım tarihi bundan sonra olmalıdır.`);
    }
    periodStart = last
      ? iso(new Date(new Date(`${last.count_date}T00:00:00Z`).getTime() + 86400000))
      : null;
  }

  const selectedIds = countType === 'NOKTA'
    ? (Array.isArray(body.productIds) ? body.productIds.map(Number) : [])
    : null;
  if (countType === 'NOKTA' && !selectedIds.length) throw bad('Nokta sayımı için en az bir ürün seçin.');

  const count = {
    id: nextId('count'), campus_id: campusId, count_date: countDate, period_start: periodStart,
    count_type: countType, status: 'TASLAK', is_blind: isBlind,
    note: text(body.note, 'Açıklama'), witness_name: null,
    expected_revenue: 0, actual_revenue: 0, cogs_total: 0, production_revenue: 0, reopened_count: 0,
    created_by: session.id, submitted_by: null, submitted_at: null,
    finalized_by: null, finalized_at: null, created_at: now(),
  };
  db.counts.push(count);

  const snapshot = stockSnapshot(campusId, { untilDate: countDate })
    .filter((p) => !selectedIds || selectedIds.includes(p.product_id));
  if (!snapshot.length) throw bad('Sayılacak ürün bulunamadı.');

  for (const snap of snapshot) {
    db.count_lines.push({
      id: nextId('count_line'), count_id: count.id, product_id: snap.product_id,
      expected_qty: snap.stock_qty, counted_qty: 0, diff_qty: 0, recipe_qty: 0, sold_qty: 0,
      purchase_price: snap.purchase_price, sale_price: snap.sale_price, vat_rate: snap.vat_rate,
      sales_value: 0, cost_value: 0,
    });
  }

  if (countType === 'DONEM') {
    for (const p of producedProducts(campusId)) {
      db.production_sales.push({
        id: nextId('production_sale'), count_id: count.id, product_id: p.id, quantity: 0,
        purchase_price: p.purchase_price, sale_price: p.sale_price, vat_rate: p.vat_rate,
        sales_value: 0, cost_value: 0,
      });
    }
  }

  logAudit('CREATE', 'counts', count.id, campusId, { countDate, countType, isBlind: !!isBlind });
  return loadCount(count.id);
});

route('GET', '/api/counts/:id', ({ params }) => {
  const data = loadCount(Number(params.id));
  campusAccess(data.campus_id);
  return data;
});

/** Sayım taslak mı? Kilitli/kesinleşmiş sayımda değişiklik engellenir. */
function requireDraft(id, what) {
  const header = byId(db.counts, id);
  if (!header) throw notFound('Sayım bulunamadı.');
  campusAccess(header.campus_id);
  if (header.status === 'KESINLESMIS') throw conflict('Kesinleşmiş sayım değiştirilemez.');
  if (header.status === 'SAYILDI') {
    throw conflict(`${what} kilitlenmiş sayımda değiştirilemez. Genel müdürlük sayımı yeniden açabilir.`);
  }
  return header;
}

route('PUT', '/api/counts/:id/lines', ({ params, body }) => {
  requireWrite();
  const header = requireDraft(Number(params.id), 'Sayım satırları');
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('En az bir satır gönderilmelidir.');

  for (const raw of lines) {
    const productId = Number(raw.productId);
    const countedQty = num(raw.countedQty, 'Sayılan', { required: true, min: 0 });
    const existing = db.count_lines.find((l) => l.count_id === header.id && l.product_id === productId);
    if (existing) {
      existing.counted_qty = countedQty;
      existing.diff_qty = round2(countedQty - existing.expected_qty);
    } else {
      const snap = stockSnapshot(header.campus_id, { untilDate: header.count_date })
        .find((p) => p.product_id === productId);
      if (!snap) throw bad('Ürün bulunamadı.');
      db.count_lines.push({
        id: nextId('count_line'), count_id: header.id, product_id: productId,
        expected_qty: snap.stock_qty, counted_qty: countedQty,
        diff_qty: round2(countedQty - snap.stock_qty), sold_qty: 0,
        purchase_price: snap.purchase_price, sale_price: snap.sale_price, vat_rate: snap.vat_rate,
        sales_value: 0, cost_value: 0,
      });
    }
  }
  persist();
  return { ok: true, updated: lines.length };
});

route('PUT', '/api/counts/:id/production', ({ params, body }) => {
  requireWrite();
  const header = requireDraft(Number(params.id), 'Üretim satışları');
  if (header.count_type !== 'DONEM') throw bad('Üretim satışı yalnızca dönem sayımında girilir.');
  const lines = Array.isArray(body.lines) ? body.lines : [];
  if (!lines.length) throw bad('En az bir satır gönderilmelidir.');

  for (const raw of lines) {
    const productId = Number(raw.productId);
    const quantity = num(raw.quantity, 'Adet', { required: true, min: 0 });
    const prices = effectivePrices(header.campus_id, productId);
    if (!prices) throw bad('Ürün bulunamadı.');
    let row = db.production_sales.find((r) => r.count_id === header.id && r.product_id === productId);
    if (!row) {
      row = {
        id: nextId('production_sale'), count_id: header.id, product_id: productId, quantity: 0,
        purchase_price: prices.purchase_price, sale_price: prices.sale_price, vat_rate: prices.vat_rate,
        sales_value: 0, cost_value: 0,
      };
      db.production_sales.push(row);
    }
    row.quantity = quantity;
  }
  persist();
  return { ok: true, updated: lines.length };
});

/* --------------------- Sayımı kilitle (kör sayım) ------------------- */
route('POST', '/api/counts/:id/submit', ({ params, body }) => {
  requireWrite();
  const header = requireDraft(Number(params.id), 'Sayım');
  const witnessName = text(body.witnessName, 'Sayıma katılan kişi', { required: true });
  if (witnessName.length < 3) throw bad('"Sayıma katılan kişi" en az 3 karakter olmalıdır.');

  const lines = db.count_lines.filter((l) => l.count_id === header.id);
  if (lines.every((l) => l.counted_qty === 0)) throw bad('Hiçbir ürün için miktar girilmemiş.');

  for (const l of lines) l.diff_qty = round2(l.counted_qty - l.expected_qty);
  Object.assign(header, {
    status: 'SAYILDI', witness_name: witnessName, submitted_by: session.id, submitted_at: now(),
  });
  logAudit('SUBMIT_COUNT', 'counts', header.id, header.campus_id, { witnessName });
  return loadCount(header.id);
});

/* ----------------------------- Kesinleştir -------------------------- */
route('POST', '/api/counts/:id/finalize', ({ params }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI');
  const header = byId(db.counts, params.id);
  if (!header) throw notFound('Sayım bulunamadı.');
  campusAccess(header.campus_id);

  if (header.count_type === 'NOKTA') throw bad('Nokta sayımı kesinleştirilmez; kilitlendiğinde tamamlanır.');
  if (header.status === 'KESINLESMIS') throw conflict('Sayım zaten kesinleşmiş.');
  if (header.status !== 'SAYILDI') {
    throw conflict('Önce sayımı kilitleyin ("Sayımı Kilitle"). Kesinleştirme kilitlenmiş sayım üzerinde yapılır.');
  }
  // İKİ İMZA: sayan ile onaylayan aynı kişi olamaz
  if (header.submitted_by && header.submitted_by === session.id) {
    throw forbidden('Sayımı kilitleyen kişi kendi sayımını kesinleştiremez. Kesinleştirmeyi başka bir yetkili yapmalıdır.');
  }

  const snap = new Map(
    stockSnapshot(header.campus_id, { untilDate: header.count_date, onlyActive: false })
      .map((p) => [p.product_id, p])
  );
  // REÇETE: beyan edilen üretimin gerektirdiği hammadde tüketimi sayım
  // farkından düşülür; aksi halde üretimde kullanılan mal "satılmış" görünür
  const productionRows = db.production_sales.filter((r) => r.count_id === header.id);
  const consumption = recipeConsumption(header.campus_id, productionRows);

  let expectedRevenue = 0;
  let cogsTotal = 0;

  for (const line of db.count_lines.filter((l) => l.count_id === header.id)) {
    const expected = round2(snap.get(line.product_id)?.stock_qty ?? line.expected_qty);
    const counted = round2(line.counted_qty);
    const diff = round2(counted - expected);
    const recipeQty = round4(consumption.get(line.product_id) || 0);
    const sold = round2(expected - recipeQty - counted);

    line.expected_qty = expected;
    line.diff_qty = diff;
    line.recipe_qty = recipeQty;
    line.sold_qty = sold;
    line.sales_value = round2(sold * line.sale_price);
    line.cost_value = round2(sold * line.purchase_price);
    expectedRevenue += line.sales_value;
    cogsTotal += line.cost_value;

    if (diff !== 0) {
      addMovement({
        campus_id: header.campus_id, product_id: line.product_id,
        movement_type: diff < 0 ? 'SATIS' : 'SAYIM_FAZLA', quantity: diff,
        unit_cost: line.purchase_price, movement_date: header.count_date,
        ref_type: 'count', ref_id: header.id,
        note: diff < 0 ? 'Sayım ile hesaplanan dönem satışı' : 'Sayımda fazla çıkan',
      });
    }
  }

  // Üretilen ürün maliyeti reçeteden gelir; hammadde satırında recipe_qty
  // kadar düşüldüğü için çift sayım olmaz
  let productionRevenue = 0;
  for (const row of productionRows) {
    const cost = recipeUnitCost(header.campus_id, row.product_id);
    const unitCost = cost.hasRecipe ? cost.unitCost : row.purchase_price;
    row.purchase_price = round4(unitCost);
    row.sales_value = round2(row.quantity * row.sale_price);
    row.cost_value = round2(row.quantity * unitCost);
    productionRevenue += row.sales_value;
    cogsTotal += row.cost_value;
  }
  expectedRevenue += productionRevenue;

  const actualRevenue = db.revenues
    .filter((r) => r.campus_id === header.campus_id && r.revenue_date <= header.count_date
      && (!header.period_start || r.revenue_date >= header.period_start))
    .reduce((s2, r) => s2 + r.total_amount, 0);

  Object.assign(header, {
    status: 'KESINLESMIS', finalized_by: session.id, finalized_at: now(),
    expected_revenue: round2(expectedRevenue), actual_revenue: round2(actualRevenue),
    cogs_total: round2(cogsTotal), production_revenue: round2(productionRevenue),
  });
  logAudit('FINALIZE', 'counts', header.id, header.campus_id, {
    expectedRevenue: header.expected_revenue, actualRevenue: header.actual_revenue,
  });
  return loadCount(header.id);
});

/* ----------------------- Sayımı yeniden aç -------------------------- */
route('POST', '/api/counts/:id/reopen', ({ params, body }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  const header = byId(db.counts, params.id);
  if (!header) throw notFound('Sayım bulunamadı.');
  if (header.status !== 'SAYILDI') throw conflict('Yalnızca kilitlenmiş, henüz kesinleşmemiş sayım yeniden açılabilir.');
  const reason = text(body.reason, 'Gerekçe', { required: true });
  if (reason.length < 5) throw bad('Gerekçe en az 5 karakter olmalıdır.');

  Object.assign(header, {
    status: 'TASLAK', submitted_by: null, submitted_at: null,
    reopened_count: (header.reopened_count || 0) + 1,
  });
  logAudit('REOPEN_COUNT', 'counts', header.id, header.campus_id, { reason });
  return loadCount(header.id);
});

route('DELETE', '/api/counts/:id', ({ params }) => {
  requireWrite();
  const header = byId(db.counts, params.id);
  if (!header) throw notFound('Sayım bulunamadı.');
  campusAccess(header.campus_id);
  if (header.status === 'KESINLESMIS') throw conflict('Kesinleşmiş sayım silinemez.');
  if (header.status === 'SAYILDI') {
    throw conflict('Kilitlenmiş sayım silinemez. Düzeltme gerekiyorsa genel müdürlük sayımı yeniden açabilir.');
  }
  db.counts = db.counts.filter((c) => c.id !== header.id);
  db.count_lines = db.count_lines.filter((l) => l.count_id !== header.id);
  db.production_sales = db.production_sales.filter((r) => r.count_id !== header.id);
  logAudit('DELETE', 'counts', header.id, header.campus_id);
  return { ok: true };
});

/* ------------------------- Mutabakat raporu ------------------------ */
route('GET', '/api/counts/:id/reconciliation', ({ params }) => {
  const data = loadCount(Number(params.id));
  campusAccess(data.campus_id);

  // KÖR SAYIM: kilitlenene kadar hiçbir beklenen değer dışarı verilmez
  if (data.blind_active) {
    return {
      blind: true,
      count: {
        id: data.id, campusId: data.campus_id, campusName: data.campus_name,
        countDate: data.count_date, periodStart: data.period_start,
        status: data.status, countType: data.count_type,
      },
      progress: data.progress,
    };
  }

  const isSpot = data.count_type === 'NOKTA';
  const firstMovement = db.movements
    .filter((m) => m.campus_id === data.campus_id)
    .reduce((min, m) => (min === null || m.movement_date < min ? m.movement_date : min), null);
  const from = data.period_start || firstMovement || data.count_date;
  const to = data.count_date;

  const periodRevenues = db.revenues.filter((r) => r.campus_id === data.campus_id
    && r.revenue_date >= from && r.revenue_date <= to);
  const sum = (key) => round2(periodRevenues.reduce((s2, r) => s2 + r[key], 0));

  const purchases = db.purchases.filter((p) => p.campus_id === data.campus_id
    && p.status !== 'IPTAL' && p.document_date >= from && p.document_date <= to);
  const waste = db.waste.filter((w) => w.campus_id === data.campus_id
    && w.waste_date >= from && w.waste_date <= to);
  // İade fire gibi maliyet değildir: tedarikçi alacaklandırır, ayrı gösterilir
  const returns = db.supplier_returns.filter((r) => r.campus_id === data.campus_id
    && r.return_date >= from && r.return_date <= to);
  const campus = byId(db.campuses, data.campus_id);

  const finalized = data.status === 'KESINLESMIS';

  // REÇETE: kesinleşmeden önce de önizleme yapabilmek için tüketim burada da hesaplanır
  const consumption = finalized
    ? new Map(data.lines.map((l) => [l.product_id, l.recipe_qty || 0]))
    : recipeConsumption(data.campus_id, data.production);
  const usedQty = (line) => (finalized ? (line.recipe_qty || 0) : (consumption.get(line.product_id) || 0));
  const directSold = (line) => round4((line.expected_qty ?? 0) - usedQty(line) - line.counted_qty);

  const countedRevenue = finalized
    ? round2(data.expected_revenue - data.production_revenue)
    : round2(data.lines.reduce((s2, l) => s2 + directSold(l) * l.sale_price, 0));
  const productionRevenue = finalized
    ? data.production_revenue
    : round2(data.production.reduce((s2, r) => s2 + r.quantity * r.sale_price, 0));
  const expectedRevenue = round2(countedRevenue + productionRevenue);
  const productionCost = round2(data.production.reduce((s2, r) => {
    const cost = finalized ? r.purchase_price : recipeUnitCost(data.campus_id, r.product_id).unitCost;
    return s2 + r.quantity * cost;
  }, 0));

  const cogs = finalized
    ? data.cogs_total
    : round2(data.lines.reduce((s2, l) => s2 + directSold(l) * l.purchase_price, 0) + productionCost);

  const recipeCheck = data.lines
    .filter((l) => usedQty(l) > 0)
    .map((l) => {
      const expectedUse = round4(usedQty(l));
      const totalOut = round4((l.expected_qty ?? 0) - l.counted_qty);
      const unexplained = round4(totalOut - expectedUse);
      return {
        product_id: l.product_id, product_name: l.product_name, unit: l.unit,
        product_type: productById(l.product_id)?.product_type ?? 'SATIN_ALINAN',
        recipe_qty: expectedUse, total_out: totalOut, unexplained,
        unexplained_value: round2(unexplained * l.purchase_price),
        unexplained_pct: expectedUse > 0 ? pctOf(unexplained, expectedUse) : null,
      };
    })
    .sort((a, b) => Math.abs(b.unexplained_value) - Math.abs(a.unexplained_value));

  const actualRevenue = sum('total_amount');
  const difference = isSpot ? null : round2(actualRevenue - expectedRevenue);

  let value = 0; let weighted = 0;
  for (const l of data.lines) {
    const v = Math.abs(((l.expected_qty ?? 0) - l.counted_qty) * l.sale_price);
    value += v; weighted += v * l.vat_rate;
  }
  const avgVat = value > 0 ? weighted / value : 10;
  const actualNet = round2(netFromGross(actualRevenue, avgVat));
  const grossProfit = isSpot ? null : round2(actualNet - cogs);
  const schoolDays = periodRevenues.filter((r) => r.is_school_day).length;

  return {
    blind: false,
    isSpot,
    count: {
      id: data.id, campusId: data.campus_id, campusName: data.campus_name,
      countDate: data.count_date, periodStart: data.period_start,
      status: data.status, countType: data.count_type,
      submittedByName: data.submitted_by_name, witnessName: data.witness_name,
      finalizedByName: data.finalized_by_name, reopenedCount: data.reopened_count,
    },
    period: { from, to, dayCount: periodRevenues.length, schoolDays },
    revenue: {
      expected: expectedRevenue, counted: countedRevenue, production: productionRevenue,
      actual: actualRevenue, difference,
      differencePct: isSpot ? null : pctOf(difference, expectedRevenue),
      cash: sum('cash_amount'), card: sum('card_amount'), credit: sum('credit_amount'),
    },
    production: {
      revenue: productionRevenue, cost: productionCost,
      sharePct: expectedRevenue > 0 ? pctOf(productionRevenue, expectedRevenue) : null,
      items: data.production.filter((r) => r.quantity > 0),
      withRecipe: data.production.filter((r) => r.quantity > 0
        && recipeUnitCost(data.campus_id, r.product_id).hasRecipe).length,
    },
    recipeCheck: {
      items: recipeCheck,
      totalUnexplainedValue: round2(recipeCheck
        .filter((r) => r.product_type === 'HAMMADDE')
        .reduce((s2, r) => s2 + r.unexplained_value, 0)),
    },
    profitability: {
      cogs, actualNet, grossProfit,
      grossMarginPct: isSpot ? null : pctOf(grossProfit, actualNet),
      theoreticalProfit: round2(data.lines.reduce(
        (s2, l) => s2 + ((l.expected_qty ?? 0) - l.counted_qty) * (netFromGross(l.sale_price, l.vat_rate) - l.purchase_price), 0
      )),
    },
    purchases: {
      netTotal: round2(purchases.reduce((s2, p) => s2 + p.net_total, 0)),
      grossTotal: round2(purchases.reduce((s2, p) => s2 + p.gross_total, 0)),
      documentCount: purchases.length,
    },
    waste: {
      costValue: round2(waste.reduce((s2, w) => s2 + w.quantity * w.unit_cost, 0)),
      recordCount: waste.length,
    },
    returns: {
      netTotal: round2(returns.reduce((s2, r) => s2 + r.net_total, 0)),
      grossTotal: round2(returns.reduce((s2, r) => s2 + r.gross_total, 0)),
      documentCount: returns.length,
    },
    perStudent: campus.student_count > 0 && !isSpot ? {
      studentCount: campus.student_count,
      revenuePerStudent: round2(actualRevenue / campus.student_count),
      dailyRevenuePerStudent: schoolDays > 0 ? round2(actualRevenue / campus.student_count / schoolDays) : null,
    } : null,
    schoolShare: campus.rent_share_pct > 0 && !isSpot
      ? { pct: campus.rent_share_pct, amount: round2(actualRevenue * campus.rent_share_pct / 100) }
      : null,
    topVariances: data.lines
      .filter((l) => l.diff_qty !== 0)
      .map((l) => ({ ...l, variance_value: round2(l.diff_qty * l.sale_price) }))
      .sort((a, b) => Math.abs(b.variance_value) - Math.abs(a.variance_value))
      .slice(0, 20),
    soldItems: data.lines
      .filter((l) => (l.expected_qty ?? 0) - l.counted_qty > 0)
      .map((l) => ({ ...l, sold: round2(l.expected_qty - l.counted_qty) }))
      .sort((a, b) => b.sold * b.sale_price - a.sold * a.sale_price)
      .slice(0, 30),
  };
});

/* ------------------------- Ciro teslim fişi ------------------------ */
/**
 * Teslim fişi tutarı DONDURUR: imzalanan kâğıttaki rakam ile sistemdeki rakam
 * sonradan ayrışırsa fiş "FARKLI" olarak işaretlenir ve ikisi yan yana görünür.
 */
function decorateHandover(h) {
  const currentTotal = round2(db.revenues
    .filter((r) => r.handover_id === h.id)
    .reduce((s, r) => s + r.total_amount, 0));
  const difference = round2(currentTotal - h.total_amount);
  return {
    ...h,
    campus_name: campusName(h.campus_id),
    campus_code: byId(db.campuses, h.campus_id)?.code ?? '',
    confirmed_by_name: userName(h.received_by_user),
    current_total: currentTotal,
    difference,
    has_mismatch: difference !== 0,
  };
}

function handoverDetail(id) {
  const h = byId(db.revenue_handovers, id);
  const days = db.revenues
    .filter((r) => r.handover_id === h.id)
    .sort((a, b) => (a.revenue_date < b.revenue_date ? -1 : 1))
    .map((r) => ({
      revenue_date: r.revenue_date, cash_amount: r.cash_amount, card_amount: r.card_amount,
      credit_amount: r.credit_amount, other_amount: r.other_amount,
      total_amount: r.total_amount, z_report_no: r.z_report_no, note: r.note,
    }));
  return { ...decorateHandover(h), days, amountInWords: amountInWords(h.total_amount) };
}

/** Fişe dahil bir ciro değiştirilebilir mi? */
function handoverGuard(revenueRow) {
  if (!revenueRow?.handover_id) return null;
  const h = byId(db.revenue_handovers, revenueRow.handover_id);
  if (!h) return null;
  if (!['ADMIN', 'GENEL_MUDURLUK'].includes(session.role)) {
    throw conflict(`${revenueRow.revenue_date} tarihli ciro, ${h.document_no} numaralı imzalı teslim fişine dahil. `
      + 'Değişiklik için genel müdürlüğe başvurun.');
  }
  return h;
}

function markHandoverMismatch(h, detail) {
  if (!h) return;
  if (h.status !== 'FARKLI') h.status = 'FARKLI';
  logAudit('HANDOVER_MISMATCH', 'revenue_handovers', h.id, h.campus_id,
    { documentNo: h.document_no, paperTotal: h.total_amount, ...detail });
}

route('GET', '/api/handovers', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const items = db.revenue_handovers
    .filter((h) => allowed.includes(h.campus_id))
    .filter((h) => !query.from || h.period_to >= query.from)
    .filter((h) => !query.to || h.period_from <= query.to)
    .filter((h) => !query.status || h.status === query.status)
    .sort((a, b) => (a.period_from === b.period_from ? b.id - a.id : (a.period_from < b.period_from ? 1 : -1)))
    .slice(0, Number(query.limit || 200))
    .map(decorateHandover);

  return {
    items,
    summary: {
      documentCount: items.length,
      totalAmount: round2(items.reduce((s, h) => s + h.total_amount, 0)),
      pendingConfirm: items.filter((h) => h.status === 'TESLIM_EDILDI').length,
      mismatched: items.filter((h) => h.status === 'FARKLI').length,
    },
  };
});

route('GET', '/api/handovers/pending', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const rows = db.revenues
    .filter((r) => allowed.includes(r.campus_id) && !r.handover_id)
    .sort((a, b) => (a.revenue_date < b.revenue_date ? -1 : 1));

  const byCampus = new Map();
  for (const row of rows) {
    const g = byCampus.get(row.campus_id)
      || { campusId: row.campus_id, campusName: campusName(row.campus_id), days: [], total: 0 };
    g.days.push({ date: row.revenue_date, amount: row.total_amount });
    g.total += row.total_amount;
    byCampus.set(row.campus_id, g);
  }

  return {
    items: [...byCampus.values()].map((g) => ({
      ...g,
      total: round2(g.total),
      dayCount: g.days.length,
      oldestDate: g.days[0]?.date ?? null,
      waitingDays: g.days[0] ? daysBetween(g.days[0].date, today()) : 0,
    })),
    totalPending: round2(rows.reduce((s, r) => s + r.total_amount, 0)),
  };
});

route('GET', '/api/handovers/verify/:documentNo', ({ params, query }) => {
  const h = db.revenue_handovers.find((x) => x.document_no === String(params.documentNo).toUpperCase());
  if (!h) throw notFound('Bu belge numarası sistemde kayıtlı değil.');
  campusAccess(h.campus_id);
  const currentTotal = round2(db.revenues
    .filter((r) => r.handover_id === h.id).reduce((s, r) => s + r.total_amount, 0));
  return {
    documentNo: h.document_no,
    campusName: campusName(h.campus_id),
    period: { from: h.period_from, to: h.period_to },
    paperTotal: h.total_amount,
    systemTotal: currentTotal,
    codeMatches: String(query.code || '').toUpperCase() === h.verification_code,
    changedAfterHandover: round2(currentTotal - h.total_amount) !== 0,
    status: h.status,
    amountInWords: amountInWords(h.total_amount),
  };
});

route('GET', '/api/handovers/:id', ({ params }) => {
  const h = byId(db.revenue_handovers, params.id);
  if (!h) throw notFound('Teslim fişi bulunamadı.');
  campusAccess(h.campus_id);
  return handoverDetail(h.id);
});

route('POST', '/api/handovers', ({ body }) => {
  requireWrite();
  const campusId = campusAccess(body.campusId);
  const campus = byId(db.campuses, campusId);

  const from = String(body.from || '').slice(0, 10);
  const to = String(body.to || from).slice(0, 10) || from;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) throw bad('"Başlangıç tarihi" YYYY-AA-GG biçiminde olmalıdır.');
  if (to < from) throw bad('Bitiş tarihi başlangıçtan önce olamaz.');
  if (to > today()) throw bad('Gelecek tarihli teslim fişi oluşturulamaz.');

  const receivedByName = String(body.receivedByName || '').trim();
  if (receivedByName.length < 3) throw bad('"Teslim alan kişi" en az 3 karakter olmalıdır.');

  const rows = db.revenues
    .filter((r) => r.campus_id === campusId && r.revenue_date >= from && r.revenue_date <= to)
    .sort((a, b) => (a.revenue_date < b.revenue_date ? -1 : 1));
  if (!rows.length) throw bad('Bu tarih aralığında ciro kaydı yok.');

  const already = rows.find((r) => r.handover_id);
  if (already) {
    const doc = byId(db.revenue_handovers, already.handover_id);
    throw conflict(`${already.revenue_date} tarihli ciro zaten ${doc?.document_no ?? '#' + already.handover_id} `
      + 'numaralı fişe dahil. Aynı gün iki kez teslim edilemez.');
  }

  const sum = (k) => round2(rows.reduce((s, r) => s + r[k], 0));
  const total = sum('total_amount');
  const year = to.slice(0, 4);
  const prefix = `${campus.code}-${year}-`;
  const last = db.revenue_handovers
    .filter((h) => h.document_no.startsWith(prefix))
    .map((h) => Number(h.document_no.slice(prefix.length)))
    .sort((a, b) => b - a)[0] || 0;
  const documentNo = `${prefix}${String(last + 1).padStart(4, '0')}`;

  const row = {
    id: nextId('handover'), campus_id: campusId, document_no: documentNo,
    period_from: from, period_to: to, day_count: rows.length,
    cash_amount: sum('cash_amount'), card_amount: sum('card_amount'),
    credit_amount: sum('credit_amount'), other_amount: sum('other_amount'),
    total_amount: total,
    verification_code: demoCode(`${documentNo}|${campusId}|${from}|${to}|${total.toFixed(2)}`),
    delivered_by: session.id, delivered_by_name: session.full_name,
    received_by_name: receivedByName, received_by_user: null, received_at: null,
    status: 'TESLIM_EDILDI', note: String(body.note || '').trim() || null,
    created_at: now(),
  };
  db.revenue_handovers.push(row);
  for (const r of rows) r.handover_id = row.id;

  logAudit('CREATE', 'revenue_handovers', row.id, campusId,
    { from, to, total, dayCount: rows.length, receivedByName });
  return handoverDetail(row.id);
});

route('POST', '/api/handovers/:id/confirm', ({ params, body }) => {
  // Ön muhasebe genel yazma yetkisine sahip değildir; bu uç ona AÇIKÇA açılır
  requireRole('ADMIN', 'GENEL_MUDURLUK', 'MUHASEBE');
  const h = byId(db.revenue_handovers, params.id);
  if (!h) throw notFound('Teslim fişi bulunamadı.');
  if (h.status === 'ONAYLANDI') throw conflict('Bu fiş zaten onaylanmış.');

  const code = String(body.verificationCode || '').toUpperCase();
  if (code !== h.verification_code) {
    throw bad('Doğrulama kodu belgeyle eşleşmiyor. Elinizdeki kâğıt sistemdeki kayıtla aynı belge değil.');
  }
  h.status = 'ONAYLANDI';
  h.received_by_user = session.id;
  h.received_at = now();
  logAudit('CONFIRM_HANDOVER', 'revenue_handovers', h.id, h.campus_id,
    { documentNo: h.document_no, total: h.total_amount });
  return handoverDetail(h.id);
});

function daysBetween(fromStr, toStr) {
  const a = new Date(`${fromStr}T00:00:00Z`);
  const b = new Date(`${toStr}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

/* ---------------------------- Günlük ciro -------------------------- */
route('GET', '/api/revenues', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  let { from, to } = { from: query.from, to: query.to };
  if (query.month) ({ from, to } = monthRange(query.month));

  const items = db.revenues
    .filter((r) => allowed.includes(r.campus_id))
    .filter((r) => !from || r.revenue_date >= from)
    .filter((r) => !to || r.revenue_date <= to)
    .sort((a, b) => (a.revenue_date < b.revenue_date ? 1 : -1))
    .slice(0, Number(query.limit || 400))
    .map((r) => {
      const h = r.handover_id ? byId(db.revenue_handovers, r.handover_id) : null;
      return {
        ...r, campus_name: campusName(r.campus_id),
        created_by_name: userName(r.created_by), updated_by_name: userName(r.updated_by),
        handover_no: h?.document_no ?? null, handover_status: h?.status ?? null,
      };
    });

  const summary = items.reduce((acc, r) => {
    acc.total += r.total_amount; acc.cash += r.cash_amount;
    acc.card += r.card_amount; acc.credit += r.credit_amount;
    acc.schoolDays += r.is_school_day ? 1 : 0;
    acc.undelivered += r.handover_id ? 0 : r.total_amount;
    acc.undeliveredDays += r.handover_id ? 0 : 1;
    return acc;
  }, { total: 0, cash: 0, card: 0, credit: 0, schoolDays: 0, undelivered: 0, undeliveredDays: 0, dayCount: items.length });
  for (const k of ['total', 'cash', 'card', 'credit', 'undelivered']) summary[k] = round2(summary[k]);
  summary.dailyAverage = summary.schoolDays > 0 ? round2(summary.total / summary.schoolDays) : 0;
  return { items, summary };
});

route('GET', '/api/revenues/calendar', ({ query }) => {
  const campusId = campusAccess(query.campusId);
  const { from, to } = monthRange(query.month);
  const rows = db.revenues
    .filter((r) => r.campus_id === campusId && r.revenue_date >= from && r.revenue_date <= to)
    .sort((a, b) => (a.revenue_date < b.revenue_date ? -1 : 1));
  const byDate = new Map(rows.map((r) => [r.revenue_date, r]));

  const days = eachDay(from, to).map((date) => {
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const entry = byDate.get(date) || null;
    return {
      date, weekday,
      isWeekend: weekday === 0 || weekday === 6,
      entry,
      missing: !entry && isWeekday(date) && date <= today(),
    };
  });

  const total = round2(rows.reduce((s, r) => s + r.total_amount, 0));
  const schoolDays = rows.filter((r) => r.is_school_day).length;
  return {
    month: query.month, from, to, days,
    summary: {
      total, entryCount: rows.length,
      missingCount: days.filter((d) => d.missing).length,
      schoolDays,
      dailyAverage: schoolDays > 0 ? round2(total / schoolDays) : 0,
    },
  };
});

route('POST', '/api/revenues', ({ body }) => {
  requireWrite();
  const data = parseRevenue(body);
  const existing = db.revenues.find((r) => r.campus_id === data.campus_id && r.revenue_date === data.revenue_date);
  if (existing && !body.overwrite) {
    throw conflict(`${data.revenue_date} tarihi için zaten ciro girilmiş (${existing.total_amount} TL). Güncellemek için düzenleyin.`);
  }
  assertRevenueEditable(data.campus_id, data.revenue_date);

  if (existing) {
    // İmzalı teslim fişine dahil gün: görevli değiştiremez, yönetim değiştirirse fiş FARKLI olur
    const handover = handoverGuard(existing);
    const oldTotal = existing.total_amount;
    Object.assign(existing, data, { updated_by: session.id, updated_at: now() });
    logAudit('UPDATE', 'daily_revenues', existing.id, data.campus_id, { date: data.revenue_date, total: data.total_amount });
    if (handover && round2(data.total_amount) !== round2(oldTotal)) {
      markHandoverMismatch(handover, { date: data.revenue_date, oldTotal, newTotal: data.total_amount, reason: 'CIRO_GUNCELLENDI' });
    }
    return existing;
  }
  const row = {
    id: nextId('revenue'), ...data, z_report_no: data.z_report_no,
    created_by: session.id, updated_by: session.id, created_at: now(), updated_at: now(),
  };
  db.revenues.push(row);
  logAudit('CREATE', 'daily_revenues', row.id, data.campus_id, { date: data.revenue_date, total: data.total_amount });
  return row;
});

route('POST', '/api/revenues/bulk', ({ body }) => {
  requireWrite();
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) throw bad('Kaydedilecek satır bulunamadı.');
  const result = { saved: 0, errors: [] };
  items.forEach((raw, i) => {
    try {
      const data = parseRevenue({ ...raw, campusId: raw.campusId ?? body.campusId });
      assertRevenueEditable(data.campus_id, data.revenue_date);
      const existing = db.revenues.find((r) => r.campus_id === data.campus_id && r.revenue_date === data.revenue_date);
      if (existing) {
        const handover = handoverGuard(existing);
        const oldTotal = existing.total_amount;
        Object.assign(existing, data, { updated_by: session.id, updated_at: now() });
        if (handover && round2(data.total_amount) !== round2(oldTotal)) {
          markHandoverMismatch(handover, { date: data.revenue_date, oldTotal, newTotal: data.total_amount, reason: 'TOPLU_GUNCELLEME' });
        }
      } else {
        db.revenues.push({
          id: nextId('revenue'), ...data, created_by: session.id, updated_by: session.id,
          created_at: now(), updated_at: now(),
        });
      }
      result.saved += 1;
    } catch (err) {
      result.errors.push({ row: i + 1, message: err.message });
    }
  });
  logAudit('BULK_SAVE', 'daily_revenues', null, null, { saved: result.saved });
  return result;
});

route('DELETE', '/api/revenues/:id', ({ params }) => {
  requireWrite();
  const row = byId(db.revenues, params.id);
  if (!row) throw notFound('Ciro kaydı bulunamadı.');
  campusAccess(row.campus_id);
  assertRevenueEditable(row.campus_id, row.revenue_date);
  const handover = handoverGuard(row);
  db.revenues = db.revenues.filter((r) => r.id !== row.id);
  logAudit('DELETE', 'daily_revenues', row.id, row.campus_id, { date: row.revenue_date, total: row.total_amount });
  if (handover) {
    markHandoverMismatch(handover, { date: row.revenue_date, oldTotal: row.total_amount, newTotal: 0, reason: 'CIRO_SILINDI' });
  }
  return { ok: true };
});

function parseRevenue(body) {
  const campusId = campusAccess(body.campusId);
  const revenueDate = String(body.revenueDate || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(revenueDate)) throw bad('"Tarih" YYYY-AA-GG biçiminde olmalıdır.');
  if (revenueDate > today()) throw bad('Gelecek tarihli ciro girilemez.');
  const cash = num(body.cashAmount, 'Nakit', { min: 0, def: 0 }) ?? 0;
  const card = num(body.cardAmount, 'Kredi kartı', { min: 0, def: 0 }) ?? 0;
  const credit = num(body.creditAmount, 'Veresiye', { min: 0, def: 0 }) ?? 0;
  const other = num(body.otherAmount, 'Diğer', { min: 0, def: 0 }) ?? 0;
  const total = round2(cash + card + credit + other);
  if (total <= 0 && !body.allowZero) {
    throw bad('Toplam ciro sıfırdan büyük olmalıdır. Okulun kapalı olduğu günler için kayıt girmeyin.');
  }
  return {
    campus_id: campusId, revenue_date: revenueDate,
    cash_amount: cash, card_amount: card, credit_amount: credit, other_amount: other,
    total_amount: total, z_report_no: text(body.zReportNo, 'Z rapor no'),
    is_school_day: body.isSchoolDay === false ? 0 : 1, note: text(body.note, 'Not'),
  };
}

function assertRevenueEditable(campusId, revenueDate) {
  const u = requireUser();
  const locked = db.counts.find((c) => c.campus_id === campusId && c.status === 'KESINLESMIS'
    && c.count_type === 'DONEM' && c.count_date >= revenueDate);
  if (locked && !['ADMIN', 'GENEL_MUDURLUK'].includes(u.role)) {
    throw conflict(`${locked.count_date} tarihli kesinleşmiş sayım bu günü kapsıyor. Değişiklik için genel müdürlüğe başvurun.`);
  }
}

/* ----------------------------- Raporlar ---------------------------- */
route('GET', '/api/reports/dashboard', ({ query }) => {
  const u = requireUser();
  const month = query.month || today().slice(0, 7);
  const { from, to } = monthRange(month);
  const campuses = seesAll(u)
    ? db.campuses.filter((c) => c.is_active)
    : db.campuses.filter((c) => c.id === u.campus_id);

  const cards = campuses.map((campus) => {
    const revenues = db.revenues.filter((r) => r.campus_id === campus.id
      && r.revenue_date >= from && r.revenue_date <= to);
    const revenue = round2(revenues.reduce((s, r) => s + r.total_amount, 0));
    const schoolDays = revenues.filter((r) => r.is_school_day).length;
    const purchaseTotal = round2(db.purchases
      .filter((p) => p.campus_id === campus.id && p.status !== 'IPTAL'
        && p.document_date >= from && p.document_date <= to)
      .reduce((s, p) => s + p.gross_total, 0));
    const wasteCost = round2(db.waste
      .filter((w) => w.campus_id === campus.id && w.waste_date >= from && w.waste_date <= to)
      .reduce((s, w) => s + w.quantity * w.unit_cost, 0));

    const last = db.counts
      .filter((c) => c.campus_id === campus.id && c.count_type === 'DONEM')
      .sort((a, b) => (a.count_date < b.count_date ? 1 : a.count_date > b.count_date ? -1 : b.id - a.id))[0] ?? null;
    const openDraft = db.counts.find((c) => c.campus_id === campus.id && c.status === 'TASLAK');
    const difference = last && last.status === 'KESINLESMIS'
      ? round2(last.actual_revenue - last.expected_revenue) : null;

    return {
      campusId: campus.id, campusName: campus.name, studentCount: campus.student_count,
      revenue, revenueDays: revenues.length, schoolDays,
      dailyAverage: schoolDays > 0 ? round2(revenue / schoolDays) : 0,
      revenuePerStudent: campus.student_count > 0 ? round2(revenue / campus.student_count) : null,
      purchaseTotal, wasteCost,
      stock: stockValue(campus.id),
      lastCount: last ? {
        id: last.id, count_date: last.count_date, status: last.status,
        expected_revenue: last.expected_revenue, actual_revenue: last.actual_revenue,
        difference, differencePct: pctOf(difference, last.expected_revenue),
      } : null,
      openDraftCountId: openDraft?.id ?? null,
      missingRevenueDays: missingRevenueDays(campus.id, from, to < today() ? to : today()),
    };
  });

  return {
    month, period: { from, to }, campuses: cards,
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

function missingRevenueDays(campusId, from, to) {
  const existing = new Set(db.revenues
    .filter((r) => r.campus_id === campusId && r.revenue_date >= from && r.revenue_date <= to)
    .map((r) => r.revenue_date));
  return eachDay(from, to).filter((d) => isWeekday(d) && !existing.has(d));
}

route('GET', '/api/reports/product-sales', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const { from, to } = dateRange(query);
  const counts = db.counts.filter((c) => c.status === 'KESINLESMIS' && c.count_type === 'DONEM'
    && allowed.includes(c.campus_id) && c.count_date >= from && c.count_date <= to);
  const countIds = new Set(counts.map((c) => c.id));

  const grouped = new Map();
  for (const l of db.count_lines) {
    if (!countIds.has(l.count_id)) continue;
    const key = l.product_id;
    if (!grouped.has(key)) {
      grouped.set(key, {
        product_id: key, sold_qty: 0, sales_value: 0, cost_value: 0,
        saleSum: 0, purchaseSum: 0, vatSum: 0, n: 0, sessions: new Set(),
      });
    }
    const g = grouped.get(key);
    g.sold_qty += l.sold_qty;
    g.sales_value += l.sales_value;
    g.cost_value += l.cost_value;
    g.saleSum += l.sale_price; g.purchaseSum += l.purchase_price; g.vatSum += l.vat_rate;
    g.n += 1;
    g.sessions.add(l.count_id);
  }

  const items = [...grouped.values()]
    .filter((g) => g.sold_qty !== 0)
    .map((g) => {
      const p = productById(g.product_id);
      const vatRate = g.vatSum / g.n;
      const salesNet = round2(netFromGross(g.sales_value, vatRate));
      const profit = round2(salesNet - g.cost_value);
      return {
        product_id: g.product_id, product_name: p?.name ?? '—', barcode: p?.barcode ?? null,
        unit: p?.unit ?? 'ADET', category_name: byId(db.categories, p?.category_id)?.name ?? null,
        sold_qty: round2(g.sold_qty), sales_value: round2(g.sales_value), sales_net: salesNet,
        cost_value: round2(g.cost_value), profit, margin_pct: pctOf(profit, salesNet),
        unit_profit: g.sold_qty ? round2(profit / g.sold_qty) : 0,
        avg_sale_price: round2(g.saleSum / g.n), avg_purchase_price: round2(g.purchaseSum / g.n),
        vat_rate: round2(vatRate), count_sessions: g.sessions.size,
      };
    })
    .sort((a, b) => b.sales_value - a.sales_value);

  const totals = items.reduce((a, r) => ({
    soldQty: a.soldQty + r.sold_qty, salesValue: a.salesValue + r.sales_value,
    salesNet: a.salesNet + r.sales_net, costValue: a.costValue + r.cost_value,
    profit: a.profit + r.profit,
  }), { soldQty: 0, salesValue: 0, salesNet: 0, costValue: 0, profit: 0 });
  for (const k of Object.keys(totals)) totals[k] = round2(totals[k]);
  totals.marginPct = pctOf(totals.profit, totals.salesNet);
  return { period: { from, to }, items, totals };
});

route('GET', '/api/reports/monthly', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const { from, to } = dateRange(query, 12);

  const revMap = new Map();
  for (const r of db.revenues) {
    if (!allowed.includes(r.campus_id) || r.revenue_date < from || r.revenue_date > to) continue;
    const key = `${r.revenue_date.slice(0, 7)}|${r.campus_id}`;
    if (!revMap.has(key)) {
      revMap.set(key, {
        month: r.revenue_date.slice(0, 7), campusId: r.campus_id,
        revenue: 0, cash: 0, card: 0, credit: 0, dayCount: 0, schoolDays: 0,
      });
    }
    const g = revMap.get(key);
    g.revenue += r.total_amount; g.cash += r.cash_amount;
    g.card += r.card_amount; g.credit += r.credit_amount;
    g.dayCount += 1; g.schoolDays += r.is_school_day ? 1 : 0;
  }

  const countMap = new Map();
  for (const c of db.counts) {
    if (c.status !== 'KESINLESMIS' || c.count_type !== 'DONEM' || !allowed.includes(c.campus_id)
      || c.count_date < from || c.count_date > to) continue;
    const key = `${c.count_date.slice(0, 7)}|${c.campus_id}`;
    const lines = db.count_lines.filter((l) => l.count_id === c.id);
    const g = countMap.get(key) || { soldQty: 0, expected: 0, cogs: 0 };
    g.soldQty += lines.reduce((s, l) => s + l.sold_qty, 0);
    g.expected += lines.reduce((s, l) => s + l.sales_value, 0);
    g.cogs += lines.reduce((s, l) => s + l.cost_value, 0);
    countMap.set(key, g);
  }

  const purchaseMap = new Map();
  for (const p of db.purchases) {
    if (p.status === 'IPTAL' || !allowed.includes(p.campus_id)
      || p.document_date < from || p.document_date > to) continue;
    const key = `${p.document_date.slice(0, 7)}|${p.campus_id}`;
    purchaseMap.set(key, (purchaseMap.get(key) || 0) + p.gross_total);
  }

  const items = [...revMap.values()]
    .sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)
      || campusName(a.campusId).localeCompare(campusName(b.campusId), 'tr'))
    .map((r) => {
      const key = `${r.month}|${r.campusId}`;
      const c = countMap.get(key);
      const expected = c ? round2(c.expected) : null;
      const difference = expected === null ? null : round2(r.revenue - expected);
      const cogs = c ? round2(c.cogs) : null;
      const salesNet = c ? round2(netFromGross(r.revenue, 10)) : null;
      return {
        month: r.month, campusId: r.campusId, campusName: campusName(r.campusId),
        revenue: round2(r.revenue), cash: round2(r.cash), card: round2(r.card), credit: round2(r.credit),
        dayCount: r.dayCount, schoolDays: r.schoolDays,
        dailyAverage: r.schoolDays > 0 ? round2(r.revenue / r.schoolDays) : 0,
        soldQty: c ? round2(c.soldQty) : null,
        expectedRevenue: expected, difference, differencePct: pctOf(difference, expected),
        cogs, grossProfit: cogs === null ? null : round2((salesNet ?? 0) - cogs),
        purchaseTotal: round2(purchaseMap.get(key) || 0),
      };
    });
  return { period: { from, to }, items };
});

route('GET', '/api/reports/campus-comparison', ({ query }) => {
  const u = requireUser();
  const { from, to } = dateRange(query);
  const campuses = seesAll(u)
    ? db.campuses.filter((c) => c.is_active)
    : db.campuses.filter((c) => c.id === u.campus_id);

  const items = campuses.map((k) => {
    const revenues = db.revenues.filter((r) => r.campus_id === k.id
      && r.revenue_date >= from && r.revenue_date <= to);
    const revenue = round2(revenues.reduce((s, r) => s + r.total_amount, 0));
    const schoolDays = revenues.filter((r) => r.is_school_day).length;

    const counts = db.counts.filter((c) => c.campus_id === k.id && c.status === 'KESINLESMIS'
      && c.count_type === 'DONEM' && c.count_date >= from && c.count_date <= to);
    const countIds = new Set(counts.map((c) => c.id));
    const lines = db.count_lines.filter((l) => countIds.has(l.count_id));
    const soldQty = round2(lines.reduce((s, l) => s + l.sold_qty, 0));
    const expected = round2(lines.reduce((s, l) => s + l.sales_value, 0));
    const cogs = round2(lines.reduce((s, l) => s + l.cost_value, 0));

    const wasteCost = round2(db.waste
      .filter((w) => w.campus_id === k.id && w.waste_date >= from && w.waste_date <= to)
      .reduce((s, w) => s + w.quantity * w.unit_cost, 0));

    const difference = expected > 0 ? round2(revenue - expected) : null;
    const salesNet = round2(netFromGross(revenue, 10));
    const grossProfit = cogs > 0 ? round2(salesNet - cogs) : null;

    return {
      campusId: k.id, campusName: k.name, studentCount: k.student_count,
      revenue, schoolDays,
      dailyAverage: schoolDays > 0 ? round2(revenue / schoolDays) : 0,
      revenuePerStudent: k.student_count > 0 ? round2(revenue / k.student_count) : null,
      dailyPerStudent: k.student_count > 0 && schoolDays > 0
        ? round2(revenue / k.student_count / schoolDays) : null,
      soldQty, expectedRevenue: expected, difference, differencePct: pctOf(difference, expected),
      cogs, grossProfit, grossMarginPct: pctOf(grossProfit, salesNet),
      wasteCost, wastePct: pctOf(wasteCost, revenue),
      schoolShare: k.rent_share_pct > 0 ? round2(revenue * k.rent_share_pct / 100) : null,
    };
  });
  return { period: { from, to }, items };
});

route('GET', '/api/reports/price-control', ({ query }) => {
  const u = requireUser();
  const campusId = query.campusId ? campusAccess(query.campusId) : (u.campus_id || db.campuses[0]?.id);
  const minMargin = Number(query.minMargin || 20);

  const items = db.products
    .filter((p) => p.is_active)
    .map((p) => {
      const prices = effectivePrices(campusId, p.id);
      // Üretilen üründe maliyet reçeteden gelir; reçete yoksa elle girilen tahmindir
      const recipe = p.product_type === 'URETILEN' ? recipeUnitCost(campusId, p.id) : null;
      const purchasePrice = recipe?.hasRecipe ? recipe.unitCost : prices.purchase_price;
      const profit = productProfit(purchasePrice, prices.sale_price, p.vat_rate);
      const issues = [];

      // Hammadde doğrudan satılmaz: satış fiyatı aranmaz, marj hesaplanmaz
      if (p.product_type === 'HAMMADDE') {
        if (purchasePrice <= 0) issues.push('Alış fiyatı tanımsız');
        return {
          ...p, category_name: byId(db.categories, p.category_id)?.name ?? null,
          effective_purchase_price: purchasePrice, effective_sale_price: 0, profit, issues,
        };
      }
      if (p.product_type === 'URETILEN' && !recipe?.hasRecipe) {
        issues.push('Reçete tanımsız - maliyet tahmine dayalı');
      }
      if (prices.sale_price <= 0) issues.push('Satış fiyatı tanımsız');
      if (purchasePrice <= 0) issues.push('Alış fiyatı tanımsız');
      if (prices.sale_price > 0 && purchasePrice > 0 && profit.unitProfit < 0) issues.push('Zararına satış');
      if (prices.sale_price > 0 && purchasePrice > 0
        && profit.marginPct < minMargin && profit.unitProfit >= 0) {
        issues.push(`Kâr marjı %${minMargin} altında`);
      }
      if (p.max_price > 0 && prices.sale_price > p.max_price) issues.push(`Tavan fiyat aşımı (tavan: ${p.max_price})`);
      if (!p.meb_approved) issues.push('Yönetmeliğe uygun değil');
      return {
        ...p, category_name: byId(db.categories, p.category_id)?.name ?? null,
        effective_purchase_price: purchasePrice,
        effective_sale_price: prices.sale_price,
        profit, issues, has_recipe: recipe?.hasRecipe ?? null,
      };
    })
    .filter((r) => r.issues.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
  return { minMargin, items };
});

route('GET', '/api/reports/critical-stock', () => {
  const u = requireUser();
  const campuses = seesAll(u)
    ? db.campuses.filter((c) => c.is_active)
    : db.campuses.filter((c) => c.id === u.campus_id);

  const items = [];
  for (const k of campuses) {
    for (const p of stockSnapshot(k.id)) {
      if (p.critical_stock > 0 && p.stock_qty <= p.critical_stock) {
        items.push({
          campusId: k.id, campusName: k.name, productId: p.product_id, productName: p.name,
          barcode: p.barcode, unit: p.unit, stockQty: round2(p.stock_qty),
          criticalStock: p.critical_stock,
          suggestedOrder: round2(Math.max(p.critical_stock * 2 - p.stock_qty, 0)),
        });
      }
    }
  }
  items.sort((a, b) => a.stockQty - b.stockQty);
  return { items };
});

route('GET', '/api/reports/waste', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const { from, to } = dateRange(query);
  const rows = db.waste.filter((w) => allowed.includes(w.campus_id)
    && w.waste_date >= from && w.waste_date <= to);

  const reasonMap = new Map();
  const productMap = new Map();
  for (const w of rows) {
    const cost = w.quantity * w.unit_cost;
    const r = reasonMap.get(w.reason) || { reason: w.reason, qty: 0, cost: 0, records: 0 };
    r.qty += w.quantity; r.cost += cost; r.records += 1;
    reasonMap.set(w.reason, r);

    const p = productById(w.product_id);
    const key = w.product_id;
    const g = productMap.get(key) || { product_name: p?.name ?? '—', unit: p?.unit ?? 'ADET', qty: 0, cost: 0 };
    g.qty += w.quantity; g.cost += cost;
    productMap.set(key, g);
  }
  const fix = (r) => ({ ...r, qty: round2(r.qty), cost: round2(r.cost) });
  return {
    period: { from, to },
    byReason: [...reasonMap.values()].sort((a, b) => b.cost - a.cost).map(fix),
    byProduct: [...productMap.values()].sort((a, b) => b.cost - a.cost).slice(0, 30).map(fix),
    totalCost: round2(rows.reduce((s, w) => s + w.quantity * w.unit_cost, 0)),
  };
});

route('GET', '/api/reports/purchases-by-supplier', ({ query }) => {
  const allowed = visibleCampusIds(query.campusId);
  const { from, to } = dateRange(query);
  const grouped = new Map();
  for (const p of db.purchases) {
    if (p.status === 'IPTAL' || !allowed.includes(p.campus_id)
      || p.document_date < from || p.document_date > to) continue;
    const g = grouped.get(p.supplier_id) || {
      supplier_id: p.supplier_id, supplier_name: byId(db.suppliers, p.supplier_id)?.name ?? '—',
      document_count: 0, net_total: 0, vat_total: 0, gross_total: 0,
    };
    g.document_count += 1; g.net_total += p.net_total;
    g.vat_total += p.vat_total; g.gross_total += p.gross_total;
    grouped.set(p.supplier_id, g);
  }
  const returnMap = new Map();
  for (const r of db.supplier_returns) {
    if (!allowed.includes(r.campus_id) || r.return_date < from || r.return_date > to) continue;
    const g = returnMap.get(r.supplier_id) || { document_count: 0, gross_total: 0 };
    g.document_count += 1; g.gross_total += r.gross_total;
    returnMap.set(r.supplier_id, g);
  }

  const items = [...grouped.values()]
    .map((g) => {
      const ret = returnMap.get(g.supplier_id);
      const returnTotal = round2(ret?.gross_total ?? 0);
      return {
        ...g,
        net_total: round2(g.net_total), vat_total: round2(g.vat_total), gross_total: round2(g.gross_total),
        return_total: returnTotal,
        return_count: ret?.document_count ?? 0,
        net_purchase: round2(g.gross_total - returnTotal),
        return_pct: g.gross_total > 0 ? pctOf(returnTotal, g.gross_total) : null,
      };
    })
    .sort((a, b) => b.gross_total - a.gross_total);

  return {
    period: { from, to },
    items,
    total: round2(items.reduce((s2, r) => s2 + r.gross_total, 0)),
    returnTotal: round2(items.reduce((s2, r) => s2 + r.return_total, 0)),
    netTotal: round2(items.reduce((s2, r) => s2 + r.net_purchase, 0)),
  };
});

/* -------------------------- Kullanıcılar --------------------------- */
const ROLES = ['ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI', 'KANTIN_GOREVLISI', 'MUHASEBE', 'DENETCI'];

route('GET', '/api/users', () => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  return {
    items: [...db.users]
      .sort((a, b) => a.full_name.localeCompare(b.full_name, 'tr'))
      .map((u) => ({
        ...publicUser(u),
        campusName: u.campus_id ? campusName(u.campus_id) : null,
        isActive: !!u.is_active,
      })),
    roles: ROLES,
  };
});

route('POST', '/api/users', ({ body }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  const data = parseUser(body);
  if (db.users.some((u) => u.email.toLowerCase() === data.email)) throw conflict('Bu e-posta zaten kayıtlı.');
  if (String(body.password || '').length < 8) throw bad('Parola en az 8 karakter olmalıdır.');
  const row = {
    id: nextId('user'), ...data, last_login_at: null, created_at: now(),
  };
  db.users.push(row);
  logAudit('CREATE', 'users', row.id, null, { email: data.email, role: data.role });
  return publicUser(row);
});

route('PUT', '/api/users/:id', ({ params, body }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  const row = byId(db.users, params.id);
  if (!row) throw notFound('Kullanıcı bulunamadı.');
  const data = parseUser(body);
  if (db.users.some((u) => u.email.toLowerCase() === data.email && u.id !== row.id)) {
    throw conflict('Bu e-posta başka bir kullanıcıya ait.');
  }
  if (row.id === session.id && !data.is_active) throw bad('Kendi hesabınızı pasife alamazsınız.');
  Object.assign(row, data);
  logAudit('UPDATE', 'users', row.id, null, { email: data.email, role: data.role });
  persist();
  return publicUser(row);
});

route('POST', '/api/users/:id/reset-password', ({ params, body }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK');
  const row = byId(db.users, params.id);
  if (!row) throw notFound('Kullanıcı bulunamadı.');
  if (String(body.password || '').length < 8) throw bad('Parola en az 8 karakter olmalıdır.');
  logAudit('RESET_PASSWORD', 'users', row.id, null);
  return { ok: true };
});

function parseUser(body) {
  const role = String(body.role || '');
  if (!ROLES.includes(role)) throw bad('Geçerli bir rol seçin.');
  const campusId = body.campusId ? Number(body.campusId) : null;
  if (['KAMPUS_YONETICISI', 'KANTIN_GOREVLISI'].includes(role) && !campusId) {
    throw bad('Kampüs yöneticisi ve kantin görevlisi için kampüs seçilmelidir.');
  }
  return {
    email: (text(body.email, 'E-posta', { required: true }) || '').toLowerCase(),
    full_name: text(body.fullName, 'Ad soyad', { required: true }),
    role,
    campus_id: ['ADMIN', 'GENEL_MUDURLUK', 'MUHASEBE', 'DENETCI'].includes(role) ? null : campusId,
    is_active: body.isActive === false ? 0 : 1,
  };
}

/* --------------------------- Denetim izi --------------------------- */
route('GET', '/api/audit', ({ query }) => {
  requireRole('ADMIN', 'GENEL_MUDURLUK', 'DENETCI');
  const items = db.audit_logs
    .filter((a) => !query.entity || a.entity === query.entity)
    .filter((a) => !query.campusId || a.campus_id === Number(query.campusId))
    .slice(Number(query.offset || 0), Number(query.offset || 0) + Math.min(Number(query.limit || 200), 1000));
  return { items };
});

/* =================================================================== */
/*                            Dağıtıcı                                 */
/* =================================================================== */
export function dispatch(method, path, query, body) {
  loadDb();
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (!m || r.method !== method) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const result = r.handler({ params, query: query || {}, body: body || {} });
    persist();
    return result;
  }
  throw notFound('Böyle bir API ucu yok.');
}

/** Demo hesapları — giriş ekranında listelenir. */
export function demoAccounts() {
  loadDb();
  return db.users.map((u) => ({
    email: u.email, fullName: u.full_name, role: u.role,
    campusName: u.campus_id ? campusName(u.campus_id) : null,
  }));
}
