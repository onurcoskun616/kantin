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
  let campusId; let productId; let supplierId; let producedId; let countId; let managerToken;

  test('kampus, urun ve tedarikci hazirlanir', async () => {
    campusId = (await ok('GET', '/api/campuses')).items[0].id;
    supplierId = (await ok('GET', '/api/suppliers')).items[0].id;
    const product = await ok('POST', '/api/products', {
      name: 'Test Ürünü', barcode: 'TEST-0001', purchasePrice: 10, salePrice: 22, vatRate: 10, criticalStock: 5,
    });
    productId = product.id;
    assert.ok(productId);

    // Kantinde hazirlanan urun: raftan sayilamaz, ayri beyan edilir
    const produced = await ok('POST', '/api/products', {
      name: 'Test Tost', productType: 'URETILEN', purchasePrice: 15, salePrice: 30, vatRate: 10,
    });
    producedId = produced.id;
    assert.equal(produced.product_type, 'URETILEN');
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

  test('kor sayim: olmasi gereken miktar taslakta gizlenir', async () => {
    // Ilk sayim dun yapilmis olsun; ikinci sayim bugun yapilacak
    const count = await ok('POST', '/api/counts', { campusId, countDate: daysAgo(1) });
    countId = count.id;
    assert.equal(count.is_blind, 1);
    assert.equal(count.blind_active, true);

    const line = count.lines.find((l) => l.product_id === productId);
    assert.equal(line.expected_qty, null, 'kor sayimda olmasi gereken miktar gizlenmeli');
    assert.equal(line.diff_qty, null);
    assert.equal(line.sold_qty, null);

    // Mutabakat ucu da kilitlenene kadar hicbir beklenen deger sizdirmamali
    const rec = await ok('GET', `/api/counts/${countId}/reconciliation`);
    assert.equal(rec.blind, true);
    assert.equal(rec.revenue, undefined, 'kor sayimda ciro beklentisi verilmemeli');
  });

  test('uretilen urun sayim fisine girmez, ayri beyan edilir', async () => {
    const count = await ok('GET', `/api/counts/${countId}`);
    assert.ok(!count.lines.some((l) => l.product_id === producedId), 'uretilen urun sayilmamali');
    assert.ok(count.production.some((r) => r.product_id === producedId), 'uretilen urun beyan listesinde olmali');

    await ok('PUT', `/api/counts/${countId}/production`, {
      lines: [{ productId: producedId, quantity: 40 }],
    });
  });

  test('sayim kilitlenmeden kesinlestirilemez', async () => {
    await ok('PUT', `/api/counts/${countId}/lines`, { lines: [{ productId, countedQty: 30 }] });
    const r = await api('POST', `/api/counts/${countId}/finalize`);
    assert.equal(r.status, 409);
  });

  test('kilitleme sayima katilan kisiyi zorunlu tutar', async () => {
    const r = await api('POST', `/api/counts/${countId}/submit`, {});
    assert.equal(r.status, 400);
  });

  test('kilitlendikten sonra sapmalar acilir ve satirlar donar', async () => {
    const submitted = await ok('POST', `/api/counts/${countId}/submit`, { witnessName: 'Ayse Demir' });
    assert.equal(submitted.status, 'SAYILDI');
    assert.equal(submitted.witness_name, 'Ayse Demir');
    assert.equal(submitted.blind_active, false);

    const line = submitted.lines.find((l) => l.product_id === productId);
    assert.equal(line.expected_qty, 90, 'olmasi gereken stok 100 alim - 10 fire = 90');
    assert.equal(line.counted_qty, 30);

    // Kilitli sayimda miktar degistirilemez
    const r = await api('PUT', `/api/counts/${countId}/lines`, { lines: [{ productId, countedQty: 99 }] });
    assert.equal(r.status, 409);
  });

  test('IKI IMZA: sayimi kilitleyen kendi sayimini kesinlestiremez', async () => {
    const r = await api('POST', `/api/counts/${countId}/finalize`);
    assert.equal(r.status, 403, 'ayni kisi hem sayip hem onaylayamamali');
  });

  test('baska bir yetkili kesinlestirebilir ve mutabakat dogru cikar', async () => {
    // Ikinci yonetici olustur
    await ok('POST', '/api/users', {
      email: 'ikinci.mudur@topkapiokullari.com', fullName: 'Ikinci Mudur',
      role: 'GENEL_MUDURLUK', password: 'Mudur123456',
    });
    const login = await api('POST', '/api/auth/login',
      { email: 'ikinci.mudur@topkapiokullari.com', password: 'Mudur123456' }, false);
    managerToken = login.data.token;

    const res = await fetch(`${BASE}/api/counts/${countId}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${managerToken}` },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const finalized = await res.json();

    assert.equal(finalized.status, 'KESINLESMIS');
    // Sayimdan: 60 adet x 22 TL = 1320 · Uretimden: 40 adet x 30 TL = 1200
    assert.equal(finalized.production_revenue, 1200);
    assert.equal(finalized.expected_revenue, 2520);
    assert.equal(finalized.actual_revenue, 1320);
    assert.equal(finalized.difference, -1200, 'beyan edilen uretim satisi karsiligi ciro girilmemis');
  });

  test('mutabakat sayimdan geleni beyandan ayirir', async () => {
    const rec = await ok('GET', `/api/counts/${countId}/reconciliation`);
    assert.equal(rec.revenue.counted, 1320);
    assert.equal(rec.revenue.production, 1200);
    assert.equal(rec.production.items.length, 1);
    assert.equal(rec.count.witnessName, 'Ayse Demir');
    assert.ok(rec.count.submittedByName);
    assert.ok(rec.count.finalizedByName);
    assert.notEqual(rec.count.submittedByName, rec.count.finalizedByName);
  });

  test('sayim sonrasi stok defteri sayilan miktara esitlenir', async () => {
    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    assert.equal(stock.items.find((i) => i.product_id === productId).stock_qty, 30);
    assert.ok(!stock.items.some((i) => i.product_id === producedId), 'uretilen urun stokta gorunmemeli');
  });

  test('kesinlesmis sayimdan onceye kayit girilemez', async () => {
    const r = await api('POST', '/api/waste', {
      campusId, productId, quantity: 1, reason: 'DIGER', wasteDate: daysAgo(3),
    });
    assert.equal(r.status, 409);
  });

  test('kesinlesmis sayim degistirilemez ve silinemez', async () => {
    assert.equal((await api('PUT', `/api/counts/${countId}/lines`, { lines: [{ productId, countedQty: 5 }] })).status, 409);
    assert.equal((await api('DELETE', `/api/counts/${countId}`)).status, 409);
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

});

/* --------------------- Nokta sayimi (habersiz) --------------------- */
describe('Nokta sayimi', () => {
  let campusId; let productId; let spotId;

  test('hazirlik: ayri bir kampuste stok olustur', async () => {
    campusId = (await ok('GET', '/api/campuses')).items[3].id;
    const supplierId = (await ok('GET', '/api/suppliers')).items[0].id;
    productId = (await ok('POST', '/api/products', {
      name: 'Nokta Test Ürünü', barcode: 'SPOT-0001', purchasePrice: 5, salePrice: 11, vatRate: 10,
    })).id;
    await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'SPOT-IRS-1', documentDate: daysAgo(10),
      lines: [{ productId, quantity: 200, unitPrice: 5, vatRate: 10 }],
    });
  });

  test('yalnizca secilen urunleri kapsar ve kor baslar', async () => {
    const spot = await ok('POST', '/api/counts', {
      campusId, countType: 'NOKTA', countDate: iso(new Date()), productIds: [productId],
      note: 'Habersiz ara kontrol',
    });
    spotId = spot.id;
    assert.equal(spot.count_type, 'NOKTA');
    assert.equal(spot.lines.length, 1, 'yalnizca secilen urun sayilmali');
    assert.equal(spot.lines[0].expected_qty, null, 'nokta sayimi da kor baslar');
    assert.equal(spot.period_start, null);
  });

  test('kilitlendiginde sapma acilir ama stoga dokunmaz', async () => {
    await ok('PUT', `/api/counts/${spotId}/lines`, { lines: [{ productId, countedQty: 150 }] });
    const submitted = await ok('POST', `/api/counts/${spotId}/submit`, { witnessName: 'Denetim Ekibi' });
    assert.equal(submitted.status, 'SAYILDI');
    assert.equal(submitted.lines[0].expected_qty, 200);
    assert.equal(submitted.lines[0].diff_qty, -50);

    // Stok defteri degismemis olmali
    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    assert.equal(stock.items.find((i) => i.product_id === productId).stock_qty, 200,
      'nokta sayimi stok hareketi yazmamali');
  });

  test('kesinlestirilemez ve silinemez', async () => {
    assert.equal((await api('POST', `/api/counts/${spotId}/finalize`)).status, 400);
    assert.equal((await api('DELETE', `/api/counts/${spotId}`)).status, 409);
  });

  test('donemi kilitlemez - gecmise kayit hala girilebilir', async () => {
    const r = await api('POST', '/api/waste', {
      campusId, productId, quantity: 2, reason: 'KIRILMA', wasteDate: daysAgo(5),
    });
    assert.equal(r.status, 200, 'nokta sayimi donem kilidi olusturmamali');
  });

  test('mutabakatta fark hesaplanmaz, tespit olarak sunulur', async () => {
    const rec = await ok('GET', `/api/counts/${spotId}/reconciliation`);
    assert.equal(rec.isSpot, true);
    assert.equal(rec.revenue.difference, null, 'alt kume oldugu icin fark hesaplanmamali');
    assert.equal(rec.topVariances.length, 1);
  });
});

/* ------------------------ Sayimi yeniden acma ---------------------- */
describe('Sayimi yeniden acma', () => {
  test('kilitli sayim gerekce ile yeniden acilir ve denetim izine yazilir', async () => {
    const campusId = (await ok('GET', '/api/campuses')).items[4].id;
    const productId = (await ok('POST', '/api/products', {
      name: 'Yeniden Ac Test', barcode: 'REOPEN-1', purchasePrice: 2, salePrice: 5,
    })).id;
    await ok('POST', '/api/stock/opening', {
      campusId, date: daysAgo(15), lines: [{ productId, quantity: 50 }],
    });

    const count = await ok('POST', '/api/counts', { campusId, countDate: iso(new Date()) });
    await ok('PUT', `/api/counts/${count.id}/lines`, { lines: [{ productId, countedQty: 20 }] });
    await ok('POST', `/api/counts/${count.id}/submit`, { witnessName: 'Tanik Kisi' });

    // Gerekce zorunlu
    assert.equal((await api('POST', `/api/counts/${count.id}/reopen`, {})).status, 400);

    const reopened = await ok('POST', `/api/counts/${count.id}/reopen`, { reason: 'Sayimda iki raf atlanmis' });
    assert.equal(reopened.status, 'TASLAK');
    assert.equal(reopened.reopened_count, 1);
    assert.equal(reopened.blind_active, true, 'yeniden acilan sayim tekrar korlesir');
    assert.equal(reopened.lines[0].expected_qty, null);

    const audit = await ok('GET', '/api/audit?limit=50');
    assert.ok(audit.items.some((a) => a.action === 'REOPEN_COUNT'), 'yeniden acma denetim izine yazilmali');
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
