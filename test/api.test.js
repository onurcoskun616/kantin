/**
 * Uctan uca API testleri.
 * Sunucuyu ayri bir surecte, gecici bir veritabani ile baslatir.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 31000 + Math.floor(Math.random() * 2000);
const BASE = `http://127.0.0.1:${PORT}`;
const tmpDb = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kantin-test-')), 'test.db');

const ADMIN = { email: 'test-admin@topkapiokullari.com', password: 'TestParola123' };

let child;
let token;

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

async function api(method, pathname, body, useToken = true) {
  const headers = { 'Content-Type': 'application/json' };
  if (useToken && token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function ok(method, pathname, body) {
  const r = await api(method, pathname, body);
  assert.equal(r.status, 200, `${method} ${pathname} -> ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

before(async () => {
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      DB_PATH: tmpDb,
      SESSION_SECRET: 'test-secret-anahtari-cok-uzun-olmali-12345',
      ADMIN_EMAIL: ADMIN.email,
      ADMIN_PASSWORD: ADMIN.password,
      ADMIN_NAME: 'Test Yoneticisi',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr.on('data', (d) => {
    const s = String(d);
    if (!s.includes('ExperimentalWarning') && !s.includes('trace-warnings')) process.stderr.write(s);
  });

  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) break;
    } catch { /* henuz ayakta degil */ }
    if (Date.now() > deadline) throw new Error('Sunucu baslatilamadi.');
    await new Promise((r) => setTimeout(r, 120));
  }
});

after(() => {
  child?.kill();
  fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
});

/* ------------------------------ Oturum ----------------------------- */
describe('Kimlik dogrulama', () => {
  test('gecersiz parola reddedilir', async () => {
    const r = await api('POST', '/api/auth/login', { email: ADMIN.email, password: 'yanlis-parola' }, false);
    assert.equal(r.status, 401);
  });

  test('gecerli bilgilerle giris yapilir', async () => {
    const r = await api('POST', '/api/auth/login', ADMIN, false);
    assert.equal(r.status, 200);
    assert.ok(r.data.token);
    assert.equal(r.data.user.role, 'ADMIN');
    token = r.data.token;
  });

  test('tokensiz istek 401 doner', async () => {
    const res = await fetch(`${BASE}/api/campuses`);
    assert.equal(res.status, 401);
  });

  test('kurulumda 5 kampus olusturulur', async () => {
    const data = await ok('GET', '/api/campuses');
    assert.equal(data.items.length, 5);
  });
});

/* --------------------------- Is akisi ------------------------------ */
describe('Alim -> ciro -> sayim -> mutabakat akisi', () => {
  let campusId; let productId; let supplierId;

  test('kampus, urun ve tedarikci hazirlanir', async () => {
    campusId = (await ok('GET', '/api/campuses')).items[0].id;
    supplierId = (await ok('GET', '/api/suppliers')).items[0].id;
    const product = await ok('POST', '/api/products', {
      name: 'Test Ürünü', barcode: 'TEST-0001', purchasePrice: 10, salePrice: 22, vatRate: 10, criticalStock: 5,
    });
    productId = product.id;
    assert.ok(productId);
  });

  test('mal girisi stogu artirir', async () => {
    const r = await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'IRS-001', documentDate: daysAgo(20),
      lines: [{ productId, quantity: 100, unitPrice: 10, vatRate: 10 }],
    });
    assert.equal(r.netTotal, 1000);
    assert.equal(r.vatTotal, 100);
    assert.equal(r.grossTotal, 1100);

    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    const line = stock.items.find((i) => i.product_id === productId);
    assert.equal(line.stock_qty, 100);
  });

  test('ayni belge no ikinci kez girilemez', async () => {
    const r = await api('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'IRS-001', documentDate: daysAgo(20),
      lines: [{ productId, quantity: 5, unitPrice: 10 }],
    });
    assert.equal(r.status, 409);
  });

  test('birim kar ve marj KDV haric hesaplanir', async () => {
    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    const line = stock.items.find((i) => i.product_id === productId);
    // 22 TL KDV dahil, %10 KDV -> net 20 TL; maliyet 10 TL -> kar 10 TL, marj %50
    assert.equal(line.profit.saleNet, 20);
    assert.equal(line.profit.unitProfit, 10);
    assert.equal(line.profit.marginPct, 50);
    assert.equal(line.profit.markupPct, 100);
  });

  test('fire stoktan duser', async () => {
    await ok('POST', '/api/waste', {
      campusId, productId, quantity: 10, reason: 'SKT', wasteDate: daysAgo(10),
    });
    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    assert.equal(stock.items.find((i) => i.product_id === productId).stock_qty, 90);
  });

  test('gunluk ciro kaydedilir', async () => {
    // 60 adet satildigi varsayimi: 60 x 22 = 1320 TL
    await ok('POST', '/api/revenues', { campusId, revenueDate: daysAgo(5), cashAmount: 800 });
    await ok('POST', '/api/revenues', { campusId, revenueDate: daysAgo(4), cashAmount: 520 });
    const list = await ok('GET', `/api/revenues?campusId=${campusId}`);
    assert.equal(list.summary.total, 1320);
  });

  test('ayni gune ikinci ciro girisi catisma doner', async () => {
    const r = await api('POST', '/api/revenues', { campusId, revenueDate: daysAgo(5), cashAmount: 100 });
    assert.equal(r.status, 409);
  });

  test('gelecek tarihli ciro reddedilir', async () => {
    const future = new Date();
    future.setDate(future.getDate() + 3);
    const r = await api('POST', '/api/revenues', { campusId, revenueDate: iso(future), cashAmount: 100 });
    assert.equal(r.status, 400);
  });

  test('sayim ornek satisi dogru hesaplar ve mutabakat saglanir', async () => {
    // Ilk sayim dun yapilmis olsun; ikinci sayim bugun yapilacak
    const count = await ok('POST', '/api/counts', { campusId, countDate: daysAgo(1) });
    const line = count.lines.find((l) => l.product_id === productId);
    assert.equal(line.expected_qty, 90, 'olmasi gereken stok 100 alim - 10 fire = 90');

    // Fiilen 30 adet sayildi -> donem satisi 60 adet -> beklenen ciro 60 x 22 = 1320
    await ok('PUT', `/api/counts/${count.id}/lines`, { lines: [{ productId, countedQty: 30 }] });
    const finalized = await ok('POST', `/api/counts/${count.id}/finalize`);

    assert.equal(finalized.status, 'KESINLESMIS');
    assert.equal(finalized.expected_revenue, 1320);
    assert.equal(finalized.actual_revenue, 1320);
    assert.equal(finalized.difference, 0, 'ciro ile sayim ortusmelidir');

    const rec = await ok('GET', `/api/counts/${count.id}/reconciliation`);
    assert.equal(rec.profitability.cogs, 600, '60 adet x 10 TL maliyet');
    assert.equal(rec.profitability.theoreticalProfit, 600, '60 adet x 10 TL birim kar');
  });

  test('sayim sonrasi stok defteri sayilan miktara esitlenir', async () => {
    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    assert.equal(stock.items.find((i) => i.product_id === productId).stock_qty, 30);
  });

  test('kesinlesmis sayimdan onceye kayit girilemez', async () => {
    const r = await api('POST', '/api/waste', {
      campusId, productId, quantity: 1, reason: 'DIGER', wasteDate: daysAgo(3),
    });
    assert.equal(r.status, 409);
  });

  test('kesinlesmis sayim degistirilemez ve silinemez', async () => {
    const counts = await ok('GET', `/api/counts?campusId=${campusId}`);
    const id = counts.items[0].id;
    assert.equal((await api('PUT', `/api/counts/${id}/lines`, { lines: [{ productId, countedQty: 5 }] })).status, 409);
    assert.equal((await api('DELETE', `/api/counts/${id}`)).status, 409);
  });

  test('urun satis raporu sayim verisinden uretilir', async () => {
    const rep = await ok('GET', `/api/reports/product-sales?campusId=${campusId}&from=${daysAgo(60)}&to=${iso(new Date())}`);
    const row = rep.items.find((i) => i.product_id === productId);
    assert.equal(row.sold_qty, 60);
    assert.equal(row.sales_value, 1320);
    assert.equal(row.cost_value, 600);
    assert.equal(row.profit, 600);
  });

  test('ayni gune ikinci sayim acilamaz', async () => {
    const r = await api('POST', '/api/counts', { campusId, countDate: daysAgo(1) });
    assert.equal(r.status, 400);
  });

  test('ciro acigi tespit edilir', async () => {
    // Yeni donem: 50 adet alim, hic ciro girilmeden 20 adet eksilme
    await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'IRS-002', documentDate: iso(new Date()),
      lines: [{ productId, quantity: 50, unitPrice: 10, vatRate: 10 }],
    });
    const count = await ok('POST', '/api/counts', { campusId, countDate: iso(new Date()) });
    await ok('PUT', `/api/counts/${count.id}/lines`, { lines: [{ productId, countedQty: 60 }] });
    const finalized = await ok('POST', `/api/counts/${count.id}/finalize`);
    // 30 + 50 = 80 olmali, 60 sayildi -> 20 adet satis -> beklenen 440 TL, girilen ciro 0
    assert.equal(finalized.expected_revenue, 440);
    assert.ok(finalized.difference < 0, 'ciro acigi negatif fark olarak raporlanmali');
  });
});

/* ----------------------------- Yetkiler ---------------------------- */
describe('Rol ve yetki kontrolleri', () => {
  let campusA; let campusB; let staffToken;

  test('kampus gorevlisi olusturulur', async () => {
    const campuses = (await ok('GET', '/api/campuses')).items;
    campusA = campuses[0].id;
    campusB = campuses[1].id;
    await ok('POST', '/api/users', {
      email: 'gorevli@topkapiokullari.com', fullName: 'Kantin Görevlisi',
      role: 'KANTIN_GOREVLISI', campusId: campusA, password: 'Gorevli12345',
    });
    const login = await api('POST', '/api/auth/login',
      { email: 'gorevli@topkapiokullari.com', password: 'Gorevli12345' }, false);
    assert.equal(login.status, 200);
    staffToken = login.data.token;
  });

  test('gorevli baska kampuse kayit giremez', async () => {
    const res = await fetch(`${BASE}/api/revenues`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staffToken}` },
      body: JSON.stringify({ campusId: campusB, revenueDate: daysAgo(1), cashAmount: 100 }),
    });
    assert.equal(res.status, 403);
  });

  test('gorevli kullanici yonetimine erisemez', async () => {
    const res = await fetch(`${BASE}/api/users`, { headers: { Authorization: `Bearer ${staffToken}` } });
    assert.equal(res.status, 403);
  });

  test('denetci salt okunurdur', async () => {
    await ok('POST', '/api/users', {
      email: 'denetci@topkapiokullari.com', fullName: 'Denetçi',
      role: 'DENETCI', password: 'Denetci12345',
    });
    const login = await api('POST', '/api/auth/login',
      { email: 'denetci@topkapiokullari.com', password: 'Denetci12345' }, false);
    const auditorToken = login.data.token;

    const read = await fetch(`${BASE}/api/campuses`, { headers: { Authorization: `Bearer ${auditorToken}` } });
    assert.equal(read.status, 200, 'denetci okuyabilmeli');

    const write = await fetch(`${BASE}/api/waste`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${auditorToken}` },
      body: JSON.stringify({ campusId: campusA, productId: 1, quantity: 1, reason: 'DIGER' }),
    });
    assert.equal(write.status, 403, 'denetci yazamamali');
  });
});


/* ------------------------- Excel ice aktarma ----------------------- */
describe('Toplu ice aktarma', () => {
  let campusId; let campusCode;

  test('urun listesi kategori adiyla birlikte aktarilir', async () => {
    // Onceki testlerde sayim kesinlesmemis bir kampus kullan; aksi halde
    // gecmise donuk acilis stogu kilidi devreye girer (bkz. assertNotLocked)
    const campus = (await ok('GET', '/api/campuses')).items[2];
    campusId = campus.id;
    campusCode = campus.code;

    const r = await ok('POST', '/api/products/bulk-import', {
      items: [
        { __row: 2, barcode: 'IMP-001', name: 'İçe Aktarılan Ayran', categoryName: 'Yeni Kategori',
          unit: 'ADET', purchasePrice: 8.5, salePrice: 13, vatRate: 1, criticalStock: 24 },
        { __row: 3, barcode: null, name: 'İçe Aktarılan Tost', categoryName: 'Yeni Kategori',
          purchasePrice: 18, salePrice: 35, vatRate: 10 },
        { __row: 4, name: '', purchasePrice: 1, salePrice: 2 },
      ],
    });
    assert.equal(r.created, 2);
    assert.equal(r.categoriesCreated, 1, 'olmayan kategori otomatik olusturulmali');
    assert.equal(r.errors.length, 1, 'adi bos satir hata vermeli');
    assert.equal(r.errors[0].row, 4);
  });

  test('ayni barkod tekrar yuklenirse yeni kayit acilmaz, guncellenir', async () => {
    const r = await ok('POST', '/api/products/bulk-import', {
      items: [{ barcode: 'IMP-001', name: 'İçe Aktarılan Ayran', purchasePrice: 9, salePrice: 14, vatRate: 1 }],
    });
    assert.equal(r.created, 0);
    assert.equal(r.updated, 1);

    const list = await ok('GET', '/api/products?search=İçe Aktarılan Ayran');
    assert.equal(list.items.length, 1, 'mukerrer kayit olusmamali');
    assert.equal(list.items[0].purchase_price, 9);
  });

  test('barkodsuz urun ada gore eslestirilir', async () => {
    const r = await ok('POST', '/api/products/bulk-import', {
      items: [{ name: 'İçe Aktarılan Tost', purchasePrice: 20, salePrice: 38, vatRate: 10 }],
    });
    assert.equal(r.created, 0);
    assert.equal(r.updated, 1);
  });

  test('acilis stogu kampus koduyla aktarilir', async () => {
    const r = await ok('POST', '/api/stock/opening-import', {
      date: daysAgo(30),
      items: [
        { __row: 2, barcode: 'IMP-001', campusCode, quantity: 48 },
        { __row: 3, productName: 'İçe Aktarılan Tost', campusCode, quantity: 12 },
        { __row: 4, barcode: 'IMP-001', campusCode, quantity: 0 },
        { __row: 5, barcode: 'IMP-001', campusCode: 'YOK', quantity: 5 },
        { __row: 6, barcode: 'OLMAYAN-BARKOD', campusCode, quantity: 5 },
      ],
    });
    assert.equal(r.imported, 2);
    assert.equal(r.skipped, 1, 'miktari sifir olan satir atlanmali');
    assert.equal(r.errors.length, 2, 'gecersiz kampus ve bulunamayan urun hata vermeli');

    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    const ayran = stock.items.find((i) => i.barcode === 'IMP-001');
    assert.equal(ayran.stock_qty, 48);
    const tost = stock.items.find((i) => i.name === 'İçe Aktarılan Tost');
    assert.equal(tost.stock_qty, 12);
  });

  test('bos liste reddedilir', async () => {
    assert.equal((await api('POST', '/api/products/bulk-import', { items: [] })).status, 400);
    assert.equal((await api('POST', '/api/stock/opening-import', { items: [] })).status, 400);
  });
});

/* --------------------------- Denetim izi --------------------------- */
describe('Denetim izi', () => {
  test('islemler kayit altina alinir', async () => {
    const data = await ok('GET', '/api/audit?limit=100');
    const actions = data.items.map((i) => i.action);
    assert.ok(actions.includes('FINALIZE'), 'sayim kesinlestirme kaydedilmeli');
    assert.ok(actions.includes('LOGIN_FAILED'), 'basarisiz giris kaydedilmeli');
    assert.ok(actions.includes('CREATE'));
  });
});
