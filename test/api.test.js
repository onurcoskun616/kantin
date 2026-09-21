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

/**
 * Sunucu yalnizca zorunlu kayitlari olusturur (yonetici, kampusler,
 * kategoriler); ornek tedarikci katalogu artik gelmiyor. Testler bu yuzden
 * ihtiyac duyduklari tedarikciyi kendileri olusturur.
 */
async function ensureSupplier() {
  const list = await ok('GET', '/api/suppliers');
  if (list.items.length) return list.items[0].id;
  return (await ok('POST', '/api/suppliers', {
    name: 'Test Tedarikçi A.Ş.', taxNo: '1111111111', taxOffice: 'Test',
  })).id;
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
    supplierId = await ensureSupplier();
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
    campusId = (await ok('POST', '/api/campuses', {
      code: 'NKT', name: 'Nokta Sayim Test Kampüsü', studentCount: 50,
    })).id;
    const supplierId = await ensureSupplier();
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
    const campusId = (await ok('POST', '/api/campuses', {
      code: 'RPN', name: 'Yeniden Acma Test Kampüsü', studentCount: 50,
    })).id;
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

/* --------------------- Tedarikciye iade ---------------------------- */
describe('Tedarikciye iade', () => {
  let campusId; let supplierId; let productId; let producedId; let purchaseId; let returnId;

  test('hazirlik: alim yapilir', async () => {
    campusId = (await ok('POST', '/api/campuses', {
      code: 'IAD', name: 'Iade Test Kampüsü', studentCount: 50,
    })).id;
    supplierId = await ensureSupplier();
    productId = (await ok('POST', '/api/products', {
      name: 'Iade Test Ürünü', barcode: 'RET-0001', purchasePrice: 20, salePrice: 33, vatRate: 10,
    })).id;
    producedId = (await ok('POST', '/api/products', {
      name: 'Iade Test Tost', productType: 'URETILEN', purchasePrice: 15, salePrice: 30,
    })).id;

    const r = await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'RET-IRS-1', documentDate: daysAgo(10),
      lines: [{ productId, quantity: 100, unitPrice: 20, vatRate: 10 }],
    });
    purchaseId = r.id;
    assert.equal(r.grossTotal, 2200);
  });

  test('iade stoktan duser', async () => {
    const r = await ok('POST', '/api/returns', {
      campusId, supplierId, purchaseId, documentNo: 'IADE-001', returnDate: daysAgo(8),
      reason: 'BOZUK', lines: [{ productId, quantity: 20, unitPrice: 20, vatRate: 10 }],
    });
    returnId = r.id;
    assert.equal(r.netTotal, 400);
    assert.equal(r.grossTotal, 440);
    assert.equal(r.stockWarnings.length, 0);

    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    assert.equal(stock.items.find((i) => i.product_id === productId).stock_qty, 80);
  });

  test('iade fire degildir: fire raporuna girmez', async () => {
    const waste = await ok('GET', `/api/reports/waste?campusId=${campusId}&from=${daysAgo(30)}&to=${iso(new Date())}`);
    assert.equal(waste.totalCost, 0, 'iade fire maliyeti olarak sayilmamali');
  });

  test('iade tedarikcinin borcunu azaltir', async () => {
    const supplier = await ok('GET', `/api/suppliers/${supplierId}`);
    assert.equal(supplier.balance.totalReturn >= 440, true);
    assert.equal(
      supplier.balance.netPurchase,
      Math.round((supplier.balance.totalPurchase - supplier.balance.totalReturn) * 100) / 100
    );
    assert.equal(
      supplier.balance.debt,
      Math.round((supplier.balance.totalPurchase - supplier.balance.totalReturn - supplier.balance.totalPaid) * 100) / 100
    );
    assert.ok(supplier.returns.some((r) => r.id === returnId));
  });

  test('uretilen urun iade edilemez', async () => {
    const r = await api('POST', '/api/returns', {
      campusId, supplierId, returnDate: daysAgo(5), reason: 'BOZUK',
      lines: [{ productId: producedId, quantity: 1, unitPrice: 15 }],
    });
    assert.equal(r.status, 400);
  });

  test('ayni iade irsaliye no ikinci kez girilemez', async () => {
    const r = await api('POST', '/api/returns', {
      campusId, supplierId, documentNo: 'IADE-001', returnDate: daysAgo(5), reason: 'SKT',
      lines: [{ productId, quantity: 1, unitPrice: 20 }],
    });
    assert.equal(r.status, 409);
  });

  test('gecersiz neden reddedilir', async () => {
    const r = await api('POST', '/api/returns', {
      campusId, supplierId, returnDate: daysAgo(5), reason: 'OLMAYAN_NEDEN',
      lines: [{ productId, quantity: 1, unitPrice: 20 }],
    });
    assert.equal(r.status, 400);
  });

  test('baska tedarikcinin alim belgesine iade girilemez', async () => {
    // Belgenin tedarikcisinden FARKLI bir tedarikci gerekiyor
    const otherSupplier = (await ok('POST', '/api/suppliers', {
      name: 'Iade Capraz Test Tedarikçisi', taxNo: '2222222222',
    })).id;
    const r = await api('POST', '/api/returns', {
      campusId, supplierId: otherSupplier, purchaseId, returnDate: daysAgo(5), reason: 'BOZUK',
      lines: [{ productId, quantity: 1, unitPrice: 20 }],
    });
    assert.equal(r.status, 400);
  });

  test('stoktan fazla iade uyari verir ama kaydedilir', async () => {
    const r = await ok('POST', '/api/returns', {
      campusId, supplierId, documentNo: 'IADE-002', returnDate: daysAgo(4), reason: 'FAZLA_GONDERIM',
      lines: [{ productId, quantity: 500, unitPrice: 20, vatRate: 10 }],
    });
    assert.equal(r.stockWarnings.length, 1);
    assert.equal(r.stockWarnings[0].stock, 80);
    // Geri al: stok tutarliligini bozmasin
    await ok('DELETE', `/api/returns/${r.id}`);
    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    assert.equal(stock.items.find((i) => i.product_id === productId).stock_qty, 80, 'silinen iade stogu geri vermeli');
  });

  test('iadesi olan alim belgesi iptal edilemez', async () => {
    const r = await api('POST', `/api/purchases/${purchaseId}/cancel`);
    assert.equal(r.status, 409);
  });

  test('mutabakatta iade ayri kalem olarak gorunur', async () => {
    await ok('POST', '/api/revenues', { campusId, revenueDate: daysAgo(3), cashAmount: 1650 });
    const count = await ok('POST', '/api/counts', { campusId, countDate: iso(new Date()) });
    // 100 alim - 20 iade = 80 olmali; 30 sayilirsa 50 adet satilmis demektir
    await ok('PUT', `/api/counts/${count.id}/lines`, { lines: [{ productId, countedQty: 30 }] });
    await ok('POST', `/api/counts/${count.id}/submit`, { witnessName: 'Iade Tanik' });

    const rec = await ok('GET', `/api/counts/${count.id}/reconciliation`);
    assert.equal(rec.returns.grossTotal, 440);
    assert.equal(rec.returns.documentCount, 1);
    assert.equal(rec.waste.costValue, 0, 'iade fire olarak sayilmamali');

    const line = (await ok('GET', `/api/counts/${count.id}`)).lines.find((l) => l.product_id === productId);
    assert.equal(line.expected_qty, 80, 'iade stoktan dusulmus olmali');
    // 50 adet x 33 TL = 1650 TL, girilen ciro da 1650 -> mutabakat tam
    assert.equal(rec.revenue.expected, 1650);
    assert.equal(rec.revenue.difference, 0, 'iade dogru islenirse mutabakat tutmali');
  });

  test('kesinlesmis sayim donemine geriye donuk iade girilemez', async () => {
    const counts = await ok('GET', `/api/counts?campusId=${campusId}`);
    const submitted = counts.items.find((c) => c.status === 'SAYILDI');

    // Iki imza kurali: sayimi kilitleyen admin degil, baska bir yetkili kesinlestirmeli
    const login = await api('POST', '/api/auth/login',
      { email: 'ikinci.mudur@topkapiokullari.com', password: 'Mudur123456' }, false);
    const res = await fetch(`${BASE}/api/counts/${submitted.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${login.data.token}` },
      body: '{}',
    });
    assert.equal(res.status, 200);

    // Artik bu tarihten onceye iade girilemez
    const blocked = await api('POST', '/api/returns', {
      campusId, supplierId, documentNo: 'IADE-GEC', returnDate: daysAgo(2), reason: 'BOZUK',
      lines: [{ productId, quantity: 1, unitPrice: 20 }],
    });
    assert.equal(blocked.status, 409);

    // Kesinlesmis sayima dahil olan iade de silinemez
    assert.equal((await api('DELETE', `/api/returns/${returnId}`)).status, 409);
  });
});

/* ----------------------------- Reçete ------------------------------ */
describe('Recete (BOM)', () => {
  let campusId; let breadId; let cheeseId; let toastId; let approverToken;

  test('hazirlik: hammadde, uretilen urun ve recete', async () => {
    campusId = (await ok('POST', '/api/campuses', {
      code: 'RCT', name: 'Recete Test Kampüsü', studentCount: 100,
    })).id;

    breadId = (await ok('POST', '/api/products', {
      name: 'Test Ekmek Dilim', productType: 'HAMMADDE', unit: 'ADET', purchasePrice: 1, salePrice: 0,
    })).id;
    cheeseId = (await ok('POST', '/api/products', {
      name: 'Test Kasar', productType: 'HAMMADDE', unit: 'GR', purchasePrice: 0.5, salePrice: 0,
    })).id;
    toastId = (await ok('POST', '/api/products', {
      name: 'Test Recete Tost', productType: 'URETILEN', purchasePrice: 99, salePrice: 33, vatRate: 10,
    })).id;

    // 1 tost = 2 dilim ekmek + 20 g kasar -> birim maliyet 2 + 10 = 12 TL
    const res = await ok('PUT', `/api/recipes/${toastId}`, {
      yieldQuantity: 1,
      items: [
        { ingredientId: breadId, quantity: 2 },
        { ingredientId: cheeseId, quantity: 20 },
      ],
    });
    assert.equal(res.unitCost, 12, 'birim maliyet hammadde toplamindan gelmeli');
    // Satis 33 TL KDV dahil -> net 30 TL; kar 18 TL, marj %60
    assert.equal(res.profit.unitProfit, 18);
    assert.equal(res.profit.marginPct, 60);
  });

  test('recete yalnizca uretilen urunlere tanimlanir', async () => {
    const r = await api('PUT', `/api/recipes/${breadId}`, {
      yieldQuantity: 1, items: [{ ingredientId: cheeseId, quantity: 1 }],
    });
    assert.equal(r.status, 400);
  });

  test('uretilen urun baska bir recetenin icerigi olamaz', async () => {
    const other = (await ok('POST', '/api/products', {
      name: 'Test Recete Sandvic', productType: 'URETILEN', purchasePrice: 10, salePrice: 40,
    })).id;
    const r = await api('PUT', `/api/recipes/${other}`, {
      yieldQuantity: 1, items: [{ ingredientId: toastId, quantity: 1 }],
    });
    assert.equal(r.status, 400);
  });

  test('ayni icerik iki kez eklenemez', async () => {
    const r = await api('PUT', `/api/recipes/${toastId}`, {
      yieldQuantity: 1,
      items: [{ ingredientId: breadId, quantity: 2 }, { ingredientId: breadId, quantity: 1 }],
    });
    assert.equal(r.status, 400);
  });

  test('partili recete birim maliyeti boler', async () => {
    const teaLeafId = (await ok('POST', '/api/products', {
      name: 'Test Cay Gram', productType: 'HAMMADDE', unit: 'GR', purchasePrice: 0.2, salePrice: 0,
    })).id;
    const teaId = (await ok('POST', '/api/products', {
      name: 'Test Cay Bardak', productType: 'URETILEN', purchasePrice: 3, salePrice: 11, vatRate: 10,
    })).id;
    // 1 demlik = 40 bardak, 60 g cay -> parti 12 TL, birim 0.30 TL
    const res = await ok('PUT', `/api/recipes/${teaId}`, {
      yieldQuantity: 40, items: [{ ingredientId: teaLeafId, quantity: 60 }],
    });
    assert.equal(res.batchCost, 12);
    assert.equal(res.unitCost, 0.3);
  });

  test('hammadde stogu sayima girer, uretilen urun girmez', async () => {
    await ok('POST', '/api/stock/opening', {
      campusId, date: daysAgo(20),
      lines: [{ productId: breadId, quantity: 200 }, { productId: cheeseId, quantity: 2000 }],
    });
    const stock = await ok('GET', `/api/stock?campusId=${campusId}`);
    assert.ok(stock.items.some((i) => i.product_id === breadId), 'hammadde stokta gorunmeli');
    assert.ok(!stock.items.some((i) => i.product_id === toastId), 'uretilen urun stokta gorunmemeli');
  });

  test('RECETE TUKETIMI sayim farkindan dusulur', async () => {
    // 50 tost beyan edilirse 100 dilim ekmek + 1000 g kasar tuketilmis olmali
    await ok('POST', '/api/revenues', { campusId, revenueDate: daysAgo(2), cashAmount: 1650 });

    const count = await ok('POST', '/api/counts', { campusId, countDate: iso(new Date()) });
    await ok('PUT', `/api/counts/${count.id}/production`, { lines: [{ productId: toastId, quantity: 50 }] });
    await ok('PUT', `/api/counts/${count.id}/lines`, {
      lines: [{ productId: breadId, countedQty: 100 }, { productId: cheeseId, countedQty: 1000 }],
    });
    await ok('POST', `/api/counts/${count.id}/submit`, { witnessName: 'Recete Tanik' });

    const login = await api('POST', '/api/auth/login',
      { email: 'ikinci.mudur@topkapiokullari.com', password: 'Mudur123456' }, false);
    approverToken = login.data.token;
    const res = await fetch(`${BASE}/api/counts/${count.id}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${approverToken}` },
      body: '{}',
    });
    assert.equal(res.status, 200);
    const finalized = await res.json();

    const bread = finalized.lines.find((l) => l.product_id === breadId);
    assert.equal(bread.expected_qty, 200);
    assert.equal(bread.counted_qty, 100);
    assert.equal(bread.recipe_qty, 100, 'recete tuketimi 50 tost x 2 dilim = 100 olmali');
    assert.equal(bread.sold_qty, 0, 'recete dususunden sonra dogrudan satis kalmamali');
    assert.equal(bread.sales_value, 0, 'hammadde beklenen ciroya katki yapmamali');

    // Beklenen ciro yalnizca tost satisindan: 50 x 33 = 1650
    assert.equal(finalized.production_revenue, 1650);
    assert.equal(finalized.expected_revenue, 1650);
    assert.equal(finalized.actual_revenue, 1650);
    assert.equal(finalized.difference, 0, 'recete dogru islenirse mutabakat tutmali');

    // Maliyet recete uzerinden: 50 x 12 = 600
    assert.equal(finalized.cogs_total, 600, 'uretilen urun maliyeti receteden gelmeli, 99 TL tahminden degil');
  });

  test('recete kontrolu aciklanamayan tuketimi ortaya cikarir', async () => {
    // Yeni donem: 100 dilim ekmek daha alalim
    const supplierId = await ensureSupplier();
    await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'RCT-IRS-1', documentDate: iso(new Date()),
      lines: [{ productId: breadId, quantity: 100, unitPrice: 1, vatRate: 1 }],
    });

    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    // Bugun kesinlesmis sayim var; bir sonraki sayim icin tarih ilerlemeli.
    // Bunun yerine mutabakat onizlemesini TASLAK uzerinden dogrulayalim.
    const counts = await ok('GET', `/api/counts?campusId=${campusId}`);
    const finalizedCount = counts.items.find((c) => c.status === 'KESINLESMIS');
    const rec = await ok('GET', `/api/counts/${finalizedCount.id}/reconciliation`);

    const bread = rec.recipeCheck.items.find((r) => r.product_id === breadId);
    assert.ok(bread, 'ekmek recete kontrolunde gorunmeli');
    assert.equal(bread.recipe_qty, 100);
    assert.equal(bread.total_out, 100);
    assert.equal(bread.unexplained, 0, 'tutarli sayimda aciklanamayan tuketim olmamali');
    assert.equal(rec.recipeCheck.totalUnexplainedValue, 0);
    assert.equal(rec.production.withRecipe, 1, 'recetesi olan uretim kalemi sayilmali');
  });

  test('kesinlesmis sayimda kullanilan recete silinemez', async () => {
    const r = await api('DELETE', `/api/recipes/${toastId}`);
    assert.equal(r.status, 409);
  });

  test('fiyat denetimi recetesiz uretilen urunu isaretler', async () => {
    const noRecipeId = (await ok('POST', '/api/products', {
      name: 'Recetesiz Uretilen', productType: 'URETILEN', purchasePrice: 5, salePrice: 20,
    })).id;
    const report = await ok('GET', `/api/reports/price-control?campusId=${campusId}`);
    const row = report.items.find((i) => i.id === noRecipeId);
    assert.ok(row, 'recetesiz uretilen urun uyari listesinde olmali');
    assert.ok(row.issues.some((i) => i.includes('Recete tanimsiz')));

    // Hammadde satis fiyati olmadigi icin "zararina satis" uyarisi almamali
    const breadRow = report.items.find((i) => i.id === breadId);
    if (breadRow) {
      assert.ok(!breadRow.issues.some((i) => i.includes('Zararina')), 'hammadde zararina satis sayilmamali');
    }
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
    // Testler birbirini etkilemesin diye kendi kampusunu olusturur:
    // baska bir testin kesinlestirdigi sayim, acilis stogu kilidini tetiklerdi
    const campus = await ok('POST', '/api/campuses', {
      code: 'IMP', name: 'Ice Aktarma Test Kampüsü', studentCount: 50,
    });
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

/* ----------------------- Ciro teslim fisi -------------------------- */
describe('Ciro teslim fisi', () => {
  let campusId; let handover; let staffToken; let accountingToken;

  const asUser = async (tok, method, pathname, body) => {
    const res = await fetch(BASE + pathname, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  test('hazirlik: kampus, gorevli ve on muhasebe kullanicisi', async () => {
    campusId = (await ok('POST', '/api/campuses', {
      code: 'TSL', name: 'Teslim Test Kampüsü', studentCount: 50,
    })).id;

    await ok('POST', '/api/users', {
      email: 'teslim-gorevli@topkapiokullari.com', fullName: 'Teslim Görevlisi',
      role: 'KANTIN_GOREVLISI', campusId, password: 'Gorevli12345',
    });
    staffToken = (await api('POST', '/api/auth/login',
      { email: 'teslim-gorevli@topkapiokullari.com', password: 'Gorevli12345' }, false)).data.token;

    await ok('POST', '/api/users', {
      email: 'muhasebe@topkapiokullari.com', fullName: 'Ön Muhasebe Görevlisi',
      role: 'MUHASEBE', password: 'Muhasebe12345',
    });
    accountingToken = (await api('POST', '/api/auth/login',
      { email: 'muhasebe@topkapiokullari.com', password: 'Muhasebe12345' }, false)).data.token;
    assert.ok(accountingToken, 'on muhasebe giris yapabilmeli');

    for (const [i, amount] of [1000, 1200, 800].entries()) {
      await ok('POST', '/api/revenues', {
        campusId, revenueDate: daysAgo(5 - i), cashAmount: amount, overwrite: true,
      });
    }
  });

  test('teslim edilmemis ciro bekleyenler listesinde gorunur', async () => {
    const pending = await ok('GET', `/api/handovers/pending?campusId=${campusId}`);
    const mine = pending.items.find((p) => p.campusId === campusId);
    assert.equal(mine.dayCount, 3);
    assert.equal(mine.total, 3000);
  });

  test('fis olusturulunca tutar dondurulur', async () => {
    handover = await ok('POST', '/api/handovers', {
      campusId, from: daysAgo(5), to: daysAgo(3),
      receivedByName: 'Ayşe Muhasebe',
    });
    assert.equal(handover.total_amount, 3000);
    assert.equal(handover.cash_amount, 3000);
    assert.equal(handover.day_count, 3);
    assert.equal(handover.status, 'TESLIM_EDILDI');
    assert.equal(handover.has_mismatch, false);
    assert.match(handover.document_no, /^TSL-\d{4}-0001$/);
    assert.equal(handover.verification_code.length, 6);
    assert.ok(handover.amountInWords.includes('TL'), 'tutar yaziyla yazilmali');

    const pending = await ok('GET', `/api/handovers/pending?campusId=${campusId}`);
    assert.equal(pending.items.find((p) => p.campusId === campusId), undefined,
      'fise dahil gunler artik bekleyenler listesinde olmamali');
  });

  test('ayni gun ikinci kez teslim edilemez', async () => {
    const r = await api('POST', '/api/handovers', {
      campusId, from: daysAgo(4), to: daysAgo(3), receivedByName: 'Ayşe Muhasebe',
    });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /zaten/i);
  });

  test('ciro kaydi olmayan aralik reddedilir', async () => {
    const r = await api('POST', '/api/handovers', {
      campusId, from: daysAgo(60), to: daysAgo(59), receivedByName: 'Ayşe Muhasebe',
    });
    assert.equal(r.status, 400);
  });

  test('gorevli fise dahil ciroyu degistiremez', async () => {
    const r = await asUser(staffToken, 'POST', '/api/revenues', {
      campusId, revenueDate: daysAgo(5), cashAmount: 9999, overwrite: true,
    });
    assert.equal(r.status, 409, 'imzali fise dahil gun gorevli tarafindan degistirilememeli');
    assert.match(r.data.error, /teslim fisine dahil/i);

    const del = await asUser(staffToken, 'DELETE',
      `/api/revenues/${(await ok('GET', `/api/revenues?campusId=${campusId}`)).items[0].id}`);
    assert.equal(del.status, 409, 'imzali fise dahil gun gorevli tarafindan silinememeli');
  });

  test('dogrulama kodu tutmazsa onay reddedilir', async () => {
    const r = await asUser(accountingToken, 'POST', `/api/handovers/${handover.id}/confirm`,
      { verificationCode: 'XXXXXX' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /eslesmiyor/i);
  });

  test('on muhasebe kodu dogru girerse onaylar, onay disina cikamaz', async () => {
    // On muhasebe bir VERI GIRISI rolu: ciro girebilir ama sayim
    // kesinlestiremez, stok duzeltemez, kullanici tanimlayamaz.
    const write = await asUser(accountingToken, 'POST', '/api/revenues', {
      campusId, revenueDate: daysAgo(1), cashAmount: 500,
    });
    assert.equal(write.status, 200, 'on muhasebe ciro girebilmeli');

    const r = await asUser(accountingToken, 'POST', `/api/handovers/${handover.id}/confirm`,
      { verificationCode: handover.verification_code });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'ONAYLANDI');
    assert.equal(r.data.confirmed_by_name, 'Ön Muhasebe Görevlisi');

    const again = await asUser(accountingToken, 'POST', `/api/handovers/${handover.id}/confirm`,
      { verificationCode: handover.verification_code });
    assert.equal(again.status, 409, 'ayni fis iki kez onaylanamaz');
  });

  test('yonetim degistirirse fis FARKLI olarak isaretlenir', async () => {
    await ok('POST', '/api/revenues', {
      campusId, revenueDate: daysAgo(5), cashAmount: 700, overwrite: true,
    });
    const detail = await ok('GET', `/api/handovers/${handover.id}`);
    assert.equal(detail.status, 'FARKLI');
    assert.equal(detail.total_amount, 3000, 'kagittaki tutar degismemeli');
    assert.equal(detail.current_total, 2700, 'sistemdeki guncel tutar yeni degeri gostermeli');
    assert.equal(detail.difference, -300);
    assert.equal(detail.has_mismatch, true);

    const audit = await ok('GET', '/api/audit?limit=100');
    assert.ok(audit.items.some((i) => i.action === 'HANDOVER_MISMATCH'),
      'teslim sonrasi degisiklik denetim izine yazilmali');
  });

  test('belge dogrulama ekrani farki gosterir', async () => {
    const good = await ok('GET',
      `/api/handovers/verify/${handover.document_no}?code=${handover.verification_code}`);
    assert.equal(good.codeMatches, true);
    assert.equal(good.paperTotal, 3000);
    assert.equal(good.systemTotal, 2700);
    assert.equal(good.changedAfterHandover, true);

    const bad = await ok('GET', `/api/handovers/verify/${handover.document_no}?code=ZZZZZZ`);
    assert.equal(bad.codeMatches, false);

    assert.equal((await api('GET', '/api/handovers/verify/YOK-2026-0001?code=ABC')).status, 404);
  });

  test('belge numarasi kampus ve yil bazinda sirali ilerler', async () => {
    await ok('POST', '/api/revenues', { campusId, revenueDate: daysAgo(2), cashAmount: 400, overwrite: true });
    const second = await ok('POST', '/api/handovers', {
      campusId, from: daysAgo(2), to: daysAgo(2), receivedByName: 'Ayşe Muhasebe',
    });
    assert.match(second.document_no, /^TSL-\d{4}-0002$/);
    assert.notEqual(second.verification_code, handover.verification_code,
      'her belgenin dogrulama kodu farkli olmali');
  });
});


/* ------------------- Fatura ekleri ve e-Fatura --------------------- */
describe('Fatura ekleri', () => {
  let campusId; let purchaseId; let productId; let supplierId; let staffToken;

  const PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('ornek fatura icerigi')]);
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const XML = Buffer.from('<?xml version="1.0"?><Invoice><ID>A1</ID></Invoice>', 'utf8');
  const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00]);

  const upload = async (path, buffer, tok = token) => {
    const res = await fetch(BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${tok}` },
      body: buffer,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  test('hazirlik: kampus, urun ve alim belgesi', async () => {
    campusId = (await ok('POST', '/api/campuses', {
      code: 'EKT', name: 'Ek Belge Test Kampüsü', studentCount: 50,
    })).id;
    supplierId = await ensureSupplier();
    productId = (await ok('POST', '/api/products', {
      name: 'Ek Test Ürünü', barcode: 'EK-0001', purchasePrice: 10, salePrice: 18, vatRate: 10,
    })).id;
    purchaseId = (await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'EK-IRS-1', documentDate: daysAgo(3),
      lines: [{ productId, quantity: 10, unitPrice: 10, vatRate: 10 }],
    })).id;
    assert.ok(purchaseId);
  });

  test('PDF fatura belgeye eklenir', async () => {
    const r = await upload(`/api/purchases/${purchaseId}/attachments?filename=fatura.pdf`, PDF);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.items.length, 1);
    const [a] = r.data.items;
    assert.equal(a.file_name, 'fatura.pdf');
    assert.equal(a.content_type, 'application/pdf');
    assert.equal(a.byte_size, PDF.length);
    assert.equal(a.kind, 'BELGE');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  });

  test('yuklenen dosya geri okunabilir ve birebir aynidir', async () => {
    const list = await ok('GET', `/api/purchases/${purchaseId}/attachments`);
    const res = await fetch(`${BASE}/api/purchases/${purchaseId}/attachments/${list.items[0].id}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/pdf');
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(PDF), 'indirilen dosya yuklenenle ayni olmali');
  });

  test('ayni dosya iki kez eklenemez', async () => {
    const r = await upload(`/api/purchases/${purchaseId}/attachments?filename=kopya.pdf`, PDF);
    assert.equal(r.status, 409);
  });

  test('PNG ve XML kabul edilir, calistirilabilir dosya reddedilir', async () => {
    assert.equal((await upload(`/api/purchases/${purchaseId}/attachments?filename=foto.png`, PNG)).status, 200);
    const xml = await upload(`/api/purchases/${purchaseId}/attachments?filename=e.xml&kind=EFATURA_XML`, XML);
    assert.equal(xml.status, 200);
    assert.equal(xml.data.items.find((a) => a.file_name === 'e.xml').kind, 'EFATURA_XML');

    const bad = await upload(`/api/purchases/${purchaseId}/attachments?filename=zarar.png`, EXE);
    assert.equal(bad.status, 400, 'icerik PNG degilse uzanti PNG olsa da reddedilmeli');
  });

  test('dosya adi dizin disina cikamaz', async () => {
    const r = await upload(
      `/api/purchases/${purchaseId}/attachments?filename=${encodeURIComponent('../../../etc/passwd.pdf')}`,
      Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('traversal denemesi')])
    );
    assert.equal(r.status, 200);
    const saved = r.data.items.find((a) => a.byte_size !== PDF.length && a.content_type === 'application/pdf');
    assert.ok(!saved.file_name.includes('/'), `ad temizlenmeli: ${saved.file_name}`);
    assert.ok(!saved.file_name.includes('\\'), `ad temizlenmeli: ${saved.file_name}`);
  });

  test('belge listesinde ek sayisi gorunur', async () => {
    const list = await ok('GET', `/api/purchases?campusId=${campusId}`);
    const row = list.items.find((p) => p.id === purchaseId);
    assert.ok(row.attachment_count >= 4, `ek sayisi: ${row.attachment_count}`);
  });

  test('baska kampusun gorevlisi eki goremez', async () => {
    const other = (await ok('POST', '/api/campuses', {
      code: 'EKX', name: 'Ek Erisim Testi', studentCount: 20,
    })).id;
    await ok('POST', '/api/users', {
      email: 'ek-gorevli@topkapiokullari.com', fullName: 'Ek Görevlisi',
      role: 'KANTIN_GOREVLISI', campusId: other, password: 'Gorevli12345',
    });
    staffToken = (await api('POST', '/api/auth/login',
      { email: 'ek-gorevli@topkapiokullari.com', password: 'Gorevli12345' }, false)).data.token;

    const res = await fetch(`${BASE}/api/purchases/${purchaseId}/attachments`, {
      headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(res.status, 403);
  });

  test('gorevli fatura kanitini silemez, yonetim silebilir', async () => {
    const list = await ok('GET', `/api/purchases/${purchaseId}/attachments`);
    const target = list.items.find((a) => a.file_name === 'foto.png');

    const denied = await fetch(`${BASE}/api/purchases/${purchaseId}/attachments/${target.id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${staffToken}` },
    });
    assert.equal(denied.status, 403);

    const removed = await ok('DELETE', `/api/purchases/${purchaseId}/attachments/${target.id}`);
    assert.ok(!removed.items.some((a) => a.id === target.id));

    const audit = await ok('GET', '/api/audit?limit=100');
    assert.ok(audit.items.some((i) => i.action === 'ATTACHMENT_DELETE'), 'silme denetim izine yazilmali');
    assert.ok(audit.items.some((i) => i.action === 'ATTACH'), 'ekleme denetim izine yazilmali');
  });

  test('ayni e-Fatura ikinci kez aktarilamaz', async () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const first = await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'EF-001', documentDate: daysAgo(2), efaturaUuid: uuid,
      lines: [{ productId, quantity: 5, unitPrice: 10, vatRate: 10 }],
    });
    assert.ok(first.id);

    const again = await api('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'EF-002', documentDate: daysAgo(1), efaturaUuid: uuid,
      lines: [{ productId, quantity: 5, unitPrice: 10, vatRate: 10 }],
    });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /zaten sisteme aktarilmis/i);
  });

  test('iptal edilmis belgeye ek eklenemez', async () => {
    const p = await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'EK-IPTAL-1', documentDate: daysAgo(1),
      lines: [{ productId, quantity: 1, unitPrice: 10, vatRate: 10 }],
    });
    await ok('POST', `/api/purchases/${p.id}/cancel`);
    const r = await upload(`/api/purchases/${p.id}/attachments?filename=x.pdf`,
      Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('iptal')]));
    assert.equal(r.status, 409);
  });
});


/* --------------------------- Denetim izi --------------------------- */
describe('Denetim izi', () => {
  test('basarisiz giris gercek sebebi doner', async () => {
    // Istemci her 401'i "oturum doldu" sayarsa yanlis parola giren kullanici
    // sebebi anlamaz. Sunucunun mesaji net olmali.
    const r = await api('POST', '/api/auth/login',
      { email: ADMIN.email, password: 'kesinlikle-yanlis' }, false);
    assert.equal(r.status, 401);
    assert.match(r.data.error, /parola hatali/i);
    assert.doesNotMatch(r.data.error, /oturum/i);
  });

  test('islemler kayit altina alinir', async () => {
    const data = await ok('GET', '/api/audit?limit=100');
    const actions = data.items.map((i) => i.action);
    assert.ok(actions.includes('FINALIZE'), 'sayim kesinlestirme kaydedilmeli');
    assert.ok(actions.includes('LOGIN_FAILED'), 'basarisiz giris kaydedilmeli');
    assert.ok(actions.includes('CREATE'));
  });
});

/* ============ Tedarikci vergi numarasi (zorunlu + tekil) ============ */
describe('Tedarikci vergi numarasi', () => {
  test('VKN olmadan tedarikci acilamaz', async () => {
    const r = await api('POST', '/api/suppliers', { name: 'VKN Yok Ltd.' });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /Vergi\/TC no/i);
  });

  test('gecersiz uzunluktaki numara reddedilir', async () => {
    for (const bad of ['12345', '123456789012', 'abcdefghij']) {
      const r = await api('POST', '/api/suppliers', { name: `Hatali ${bad}`, taxNo: bad });
      assert.equal(r.status, 400, `"${bad}" kabul edilmemeli`);
      assert.match(r.data.error, /10 haneli|11 haneli/);
    }
  });

  test('bosluk ve tire temizlenir, 10 ve 11 hane kabul edilir', async () => {
    const a = await ok('POST', '/api/suppliers', { name: 'Bosluklu A.Ş.', taxNo: '123 456 78 90' });
    assert.equal(a.tax_no, '1234567890');
    const b = await ok('POST', '/api/suppliers', { name: 'Sahis Isletmesi', taxNo: '12345678901' });
    assert.equal(b.tax_no, '12345678901');
  });

  test('ayni VKN ikinci firmaya verilemez ve firma adi soylenir', async () => {
    await ok('POST', '/api/suppliers', { name: 'Tekil Gıda A.Ş.', taxNo: '9988776655' });
    const r = await api('POST', '/api/suppliers', { name: 'Baska Firma', taxNo: '9988776655' });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /9988776655/);
    assert.match(r.data.error, /Tekil Gıda A\.Ş\./);
  });

  test('firma kendi VKN"siyle guncellenebilir', async () => {
    const s = await ok('POST', '/api/suppliers', { name: 'Guncellenecek Ltd.', taxNo: '5544332211' });
    const r = await ok('PUT', `/api/suppliers/${s.id}`,
      { name: 'Guncellenecek Ltd. Şti.', taxNo: '5544332211' });
    assert.equal(r.name, 'Guncellenecek Ltd. Şti.');
  });
});

/* ============== Alim belgesi: iptal ve kalici silme =============== */
describe('Alim belgesi iptal ve silme', () => {
  let campusId; let supplierId; let productId;
  const ETTN = 'cccccccc-dddd-4eee-8fff-000011112222';

  before(async () => {
    campusId = (await ok('POST', '/api/campuses', { name: 'İptal Test Kampüsü', code: 'IPT' })).id;
    supplierId = (await ok('POST', '/api/suppliers',
      { name: 'İptal Test Tedarikçi', taxNo: '7070707070' })).id;
    productId = (await ok('POST', '/api/products',
      { name: 'İptal Test Ürünü', purchasePrice: 10, salePrice: 20, vatRate: 10 })).id;
  });

  const belgeAc = (documentNo, efaturaUuid) => ok('POST', '/api/purchases', {
    campusId, supplierId, documentNo, documentDate: daysAgo(1), efaturaUuid,
    lines: [{ productId, quantity: 5, unitPrice: 10, vatRate: 10 }],
  });

  test('ayni ETTN ikinci kez kabul edilmez', async () => {
    await belgeAc('IPT-001', ETTN);
    const r = await api('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'IPT-002', documentDate: daysAgo(1), efaturaUuid: ETTN,
      lines: [{ productId, quantity: 1, unitPrice: 10, vatRate: 10 }],
    });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /zaten sisteme aktarilmis/i);
  });

  test('IPTAL edilen belgenin ETTN"si yeniden girilebilir', async () => {
    const list = await ok('GET', `/api/purchases?campusId=${campusId}`);
    const ilk = list.items.find((p) => p.document_no === 'IPT-001');
    await ok('POST', `/api/purchases/${ilk.id}/cancel`);

    // Ayni ETTN artik serbest: tedarikci faturayi iptal edip yeniden
    // duzenlemis olabilir.
    const yeni = await belgeAc('IPT-003', ETTN);
    assert.ok(yeni.id, 'iptal sonrasi ayni ETTN yeniden girilebilmeli');
  });

  test('iptal stok hareketini geri alir, belgeyi kayitta birakir', async () => {
    const b = await belgeAc('IPT-004', null);
    const oncesi = await ok('GET', `/api/stock?campusId=${campusId}`);
    const oncekiMiktar = oncesi.items.find((r) => r.product_id === productId)?.stock_qty ?? 0;

    await ok('POST', `/api/purchases/${b.id}/cancel`);

    const sonrasi = await ok('GET', `/api/stock?campusId=${campusId}`);
    const sonrakiMiktar = sonrasi.items.find((r) => r.product_id === productId)?.stock_qty ?? 0;
    assert.equal(sonrakiMiktar, oncekiMiktar - 5, 'iptal 5 adedi stoktan dusmeli');

    const liste = await ok('GET', `/api/purchases?campusId=${campusId}`);
    const kalan = liste.items.find((p) => p.id === b.id);
    assert.ok(kalan, 'iptal edilen belge listede kalmali (denetim izi)');
    assert.equal(kalan.status, 'IPTAL');
  });

  test('ayni belge iki kez iptal edilemez', async () => {
    const b = await belgeAc('IPT-005', null);
    await ok('POST', `/api/purchases/${b.id}/cancel`);
    const r = await api('POST', `/api/purchases/${b.id}/cancel`);
    assert.equal(r.status, 409);
  });

  test('kalici silme belgeyi, satirlarini ve stok hareketini yok eder', async () => {
    const b = await belgeAc('IPT-006', null);
    const oncesi = await ok('GET', `/api/stock?campusId=${campusId}`);
    const oncekiMiktar = oncesi.items.find((r) => r.product_id === productId)?.stock_qty ?? 0;

    const sonuc = await ok('DELETE', `/api/purchases/${b.id}`);
    assert.equal(sonuc.deletedLines, 1);

    const detay = await api('GET', `/api/purchases/${b.id}`);
    assert.equal(detay.status, 404, 'silinen belge artik yok');

    const sonrasi = await ok('GET', `/api/stock?campusId=${campusId}`);
    const sonrakiMiktar = sonrasi.items.find((r) => r.product_id === productId)?.stock_qty ?? 0;
    assert.equal(sonrakiMiktar, oncekiMiktar - 5, 'silme de stogu geri almali');
  });

  test('silinen belgenin icerigi denetim gunlugune yazilir', async () => {
    const b = await belgeAc('IPT-007', null);
    await ok('DELETE', `/api/purchases/${b.id}`);
    const log = await ok('GET', '/api/audit?entity=purchases&action=DELETE');
    const kayit = log.items.find((r) => r.entity_id === b.id);
    assert.ok(kayit, 'silme denetim gunlugunde olmali');
    const detay = JSON.parse(kayit.detail);
    assert.equal(detay.documentNo, 'IPT-007');
    assert.equal(detay.lines.length, 1, 'silinen satirlar gunlukte durmali');
    assert.equal(detay.lines[0].urun, 'İptal Test Ürünü');
  });

  test('silinen belgenin ETTN"si de serbest kalir', async () => {
    const ettn = 'aaaa1111-bbbb-4ccc-8ddd-eeee22223333';
    const b = await belgeAc('IPT-008', ettn);
    await ok('DELETE', `/api/purchases/${b.id}`);
    const yeni = await belgeAc('IPT-009', ettn);
    assert.ok(yeni.id);
  });
});

/* ================= On muhasebe rolunun yazma sinirlari ============= */
describe('On muhasebe yetkileri', () => {
  let tok; let campusId; let supplierId; let productId;
  const asAcc = async (method, pathname, body) => {
    const res = await fetch(BASE + pathname, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };

  before(async () => {
    campusId = (await ok('POST', '/api/campuses', { name: 'Muhasebe Test Kampüsü', code: 'MUH' })).id;
    supplierId = (await ok('POST', '/api/suppliers',
      { name: 'Muhasebe Test Tedarikçi', taxNo: '3131313131' })).id;
    productId = (await ok('POST', '/api/products',
      { name: 'Muhasebe Test Ürünü', purchasePrice: 8, salePrice: 15, vatRate: 10 })).id;
    await ok('POST', '/api/users', {
      email: 'yetki-muhasebe@topkapiokullari.com', fullName: 'Yetki Muhasebe',
      role: 'MUHASEBE', password: 'Muhasebe12345',
    });
    tok = (await api('POST', '/api/auth/login',
      { email: 'yetki-muhasebe@topkapiokullari.com', password: 'Muhasebe12345' }, false)).data.token;
    assert.ok(tok);
  });

  test('YAPABILIR: fatura / mal girisi', async () => {
    const r = await asAcc('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'MUH-001', documentDate: daysAgo(1),
      lines: [{ productId, quantity: 3, unitPrice: 8, vatRate: 10 }],
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  });

  test('YAPABILIR: tedarikci tanimi ve odeme', async () => {
    const s = await asAcc('POST', '/api/suppliers', { name: 'Muhasebenin Açtığı', taxNo: '4242424242' });
    assert.equal(s.status, 200, JSON.stringify(s.data));
    const p = await asAcc('POST', `/api/suppliers/${supplierId}/payments`,
      { amount: 100, paymentDate: daysAgo(1), method: 'HAVALE' });
    assert.equal(p.status, 200, JSON.stringify(p.data));
  });

  test('YAPABILIR: urun karti ve gunluk ciro', async () => {
    const u = await asAcc('POST', '/api/products',
      { name: 'Muhasebenin Ürünü', purchasePrice: 5, salePrice: 10, vatRate: 10 });
    assert.equal(u.status, 200, JSON.stringify(u.data));
    const c = await asAcc('POST', '/api/revenues',
      { campusId, revenueDate: daysAgo(2), cashAmount: 250 });
    assert.equal(c.status, 200, JSON.stringify(c.data));
  });

  test('YAPAMAZ: sayim acma ve kesinlestirme', async () => {
    const r = await asAcc('POST', '/api/counts', { campusId, countDate: daysAgo(1) });
    assert.equal(r.status, 403, 'sayim mutabakatin kendisidir, veri girisi degildir');
    assert.match(r.data.error, /On muhasebe/i);
  });

  test('YAPAMAZ: stok duzeltme / fire', async () => {
    const r = await asAcc('POST', '/api/waste',
      { campusId, productId, quantity: 1, reason: 'KIRILMA', wasteDate: daysAgo(1) });
    assert.equal(r.status, 403);
  });

  test('YAPAMAZ: kampus ve kullanici tanimi', async () => {
    const k = await asAcc('POST', '/api/campuses', { name: 'Olmayan Kampüs', code: 'XXX' });
    assert.equal(k.status, 403);
    const u = await asAcc('POST', '/api/users', {
      email: 'olmaz@topkapiokullari.com', fullName: 'Olmaz', role: 'ADMIN', password: 'Parola123456',
    });
    assert.equal(u.status, 403);
  });

  test('YAPAMAZ: belgeyi kalici silme (yalnizca yonetim)', async () => {
    const b = await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'MUH-002', documentDate: daysAgo(1),
      lines: [{ productId, quantity: 1, unitPrice: 8, vatRate: 10 }],
    });
    const sil = await asAcc('DELETE', `/api/purchases/${b.id}`);
    assert.equal(sil.status, 403, 'silme geri alinamaz, yonetim yetkisi ister');
    // Ama iptal edebilir: bu bir veri girisi duzeltmesidir
    const iptal = await asAcc('POST', `/api/purchases/${b.id}/cancel`);
    assert.equal(iptal.status, 200, JSON.stringify(iptal.data));
  });

  test('denetci hicbirini yapamaz', async () => {
    await ok('POST', '/api/users', {
      email: 'yetki-denetci@topkapiokullari.com', fullName: 'Yetki Denetçi',
      role: 'DENETCI', password: 'Denetci12345',
    });
    const dTok = (await api('POST', '/api/auth/login',
      { email: 'yetki-denetci@topkapiokullari.com', password: 'Denetci12345' }, false)).data.token;
    const r = await fetch(`${BASE}/api/purchases`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${dTok}` },
      body: JSON.stringify({
        campusId, supplierId, documentNo: 'DEN-001', documentDate: daysAgo(1),
        lines: [{ productId, quantity: 1, unitPrice: 8, vatRate: 10 }],
      }),
    });
    assert.equal(r.status, 403);
  });
});

/* ====== Faturada olup kayda alinmayan satirlar (uyari paneli) ====== */
describe('Eslesmeyen fatura satirlari', () => {
  let campusId; let supplierId; let productId;

  before(async () => {
    campusId = (await ok('POST', '/api/campuses', { name: 'Eşleşmeyen Kampüsü', code: 'ESL' })).id;
    supplierId = (await ok('POST', '/api/suppliers',
      { name: 'Eşleşmeyen Tedarikçi', taxNo: '6060606060' })).id;
    productId = (await ok('POST', '/api/products',
      { name: 'Eşleşen Ürün', purchasePrice: 10, salePrice: 20, vatRate: 10 })).id;
  });

  /** Biri eslesen, ikisi eslesmeyen kalemli bir fatura kaydeder. */
  const belgeAc = (no) => ok('POST', '/api/purchases', {
    campusId, supplierId, documentNo: no, documentDate: daysAgo(1),
    lines: [{ productId, quantity: 10, unitPrice: 10, vatRate: 10 }],
    unmatchedLines: [
      { sourceName: 'KARGO VE NAKLIYE BEDELI', quantity: 1, unitPrice: 150, vatRate: 20 },
      { sourceName: 'ÇİKOLATALI GOFRET 40G', sourceCode: '8690000009999', quantity: 24, unitPrice: 7.5, vatRate: 10, unitCode: 'C62' },
    ],
  });

  test('kayda alinmayan kalemler belgeyle birlikte saklanir', async () => {
    const b = await belgeAc('ESL-001');
    assert.equal(b.unmatchedCount, 2);

    const liste = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}`);
    const bizimkiler = liste.items.filter((r) => r.document_no === 'ESL-001');
    assert.equal(bizimkiler.length, 2);
    const gofret = bizimkiler.find((r) => r.source_name.includes('GOFRET'));
    assert.equal(gofret.status, 'ACIK');
    assert.equal(gofret.source_code, '8690000009999');
    assert.equal(gofret.quantity, 24);
    // 24 x 7,50 = 180 + %10 KDV = 198
    assert.equal(gofret.net_total, 180);
    assert.equal(gofret.gross_total, 198);
    assert.equal(gofret.supplier_name, 'Eşleşmeyen Tedarikçi');
  });

  test('acik kalem sayisi ve tutari ozetlenir', async () => {
    const liste = await ok('GET', '/api/purchases/unmatched');
    assert.ok(liste.openCount >= 2, String(liste.openCount));
    assert.ok(liste.openTotal > 0, String(liste.openTotal));
  });

  test('kalem bir urune baglanip belgeye eklenebilir; stok ve belge toplami artar', async () => {
    const b = await belgeAc('ESL-002');
    const liste = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}`);
    const kalem = liste.items.find((r) => r.document_no === 'ESL-002' && r.source_name.includes('GOFRET'));

    const stokOnce = (await ok('GET', `/api/stock?campusId=${campusId}`))
      .items.find((r) => r.product_id === productId).stock_qty;
    const belgeOnce = await ok('GET', `/api/purchases/${b.id}`);

    const r = await ok('POST', `/api/purchases/unmatched/${kalem.id}/resolve`, { productId });
    assert.equal(r.status, 'COZULDU');

    const stokSonra = (await ok('GET', `/api/stock?campusId=${campusId}`))
      .items.find((r2) => r2.product_id === productId).stock_qty;
    assert.equal(stokSonra - stokOnce, 24, '24 adet stoga girmeli');

    const belgeSonra = await ok('GET', `/api/purchases/${b.id}`);
    assert.equal(belgeSonra.lines.length, belgeOnce.lines.length + 1, 'belgeye satir eklenmeli');
    assert.ok(Math.abs(belgeSonra.gross_total - (belgeOnce.gross_total + 198)) < 0.01,
      `${belgeSonra.gross_total} vs ${belgeOnce.gross_total}`);
  });

  test('cozulen kalem ikinci kez sonuclandirilamaz', async () => {
    const liste = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}&status=COZULDU`);
    const kalem = liste.items[0];
    assert.ok(kalem, 'cozulmus kalem olmali');
    const r = await api('POST', `/api/purchases/unmatched/${kalem.id}/resolve`, { productId });
    assert.equal(r.status, 409);
  });

  test('kalem sebep yazilarak yok sayilabilir; sebep zorunludur', async () => {
    const b = await belgeAc('ESL-003');
    assert.ok(b.id);
    const liste = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}`);
    const kargo = liste.items.find((r) => r.document_no === 'ESL-003' && r.source_name.includes('KARGO'));

    const sebepsiz = await api('POST', `/api/purchases/unmatched/${kargo.id}/resolve`, { ignore: true });
    assert.equal(sebepsiz.status, 400, 'sebep yazilmadan yok sayilamaz');

    const r = await ok('POST', `/api/purchases/unmatched/${kargo.id}/resolve`,
      { ignore: true, note: 'Nakliye bedeli, stok kalemi değil.' });
    assert.equal(r.status, 'YOKSAYILDI');

    const sonra = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}&status=YOKSAYILDI`);
    const kayit = sonra.items.find((r2) => r2.id === kargo.id);
    assert.match(kayit.resolution_note, /Nakliye bedeli/);
  });

  test('yok sayilan kalem acik listesinde gorunmez', async () => {
    const acik = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}`);
    assert.ok(acik.items.every((r) => r.status === 'ACIK'));
  });

  test('belge silinince kalemleri de gider', async () => {
    const b = await belgeAc('ESL-004');
    const once = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}`);
    assert.ok(once.items.some((r) => r.document_no === 'ESL-004'));

    await ok('DELETE', `/api/purchases/${b.id}`);

    const sonra = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}`);
    assert.ok(!sonra.items.some((r) => r.document_no === 'ESL-004'),
      'silinen belgenin kalemleri de silinmeli');
  });

  test('iptal edilmis belgeye satir eklenemez', async () => {
    const b = await belgeAc('ESL-005');
    const liste = await ok('GET', `/api/purchases/unmatched?campusId=${campusId}`);
    const kalem = liste.items.find((r) => r.document_no === 'ESL-005');
    await ok('POST', `/api/purchases/${b.id}/cancel`);
    const r = await api('POST', `/api/purchases/unmatched/${kalem.id}/resolve`, { productId });
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Iptal edilmis/i);
  });
});

/* ======= Alis fiyati faturadan/giristen gelir (kart degil) ======== */
describe('Alis fiyati kaynagi', () => {
  let campusA; let campusB; let supplierId; let productId;

  before(async () => {
    campusA = (await ok('POST', '/api/campuses', { name: 'Fiyat A Kampüsü', code: 'FYA' })).id;
    campusB = (await ok('POST', '/api/campuses', { name: 'Fiyat B Kampüsü', code: 'FYB' })).id;
    supplierId = (await ok('POST', '/api/suppliers',
      { name: 'Fiyat Test Tedarikçi', taxNo: '8080808080' })).id;
    // Kart uzerindeki deger yalnizca BASLANGIC degeridir
    productId = (await ok('POST', '/api/products',
      { name: 'Fiyat Test Ürünü', purchasePrice: 10, salePrice: 25, vatRate: 10 })).id;
  });

  const alim = (campusId, no, birimFiyat, iskonto = 0) => ok('POST', '/api/purchases', {
    campusId, supplierId, documentNo: no, documentDate: daysAgo(3),
    lines: [{ productId, quantity: 10, unitPrice: birimFiyat, vatRate: 10, discountPct: iskonto }],
  });

  test('hic alim yokken katalogdaki baslangic degeri gecerlidir', async () => {
    const r = await ok('GET', `/api/stock?campusId=${campusA}`);
    const satir = r.items.find((x) => x.product_id === productId);
    assert.equal(satir.purchase_price, 10);
    assert.equal(satir.last_purchase_price, null, 'henuz giris yok');
  });

  test('fatura girilince alis fiyati FATURADAN gelir', async () => {
    await alim(campusA, 'FY-001', 12.5);
    const satir = (await ok('GET', `/api/stock?campusId=${campusA}`))
      .items.find((x) => x.product_id === productId);
    assert.equal(satir.purchase_price, 12.5);
    assert.equal(satir.last_purchase_price, 12.5);
  });

  test('iskonto dusulmus GERCEK maliyet kullanilir', async () => {
    await alim(campusA, 'FY-002', 20, 25);          // 20 - %25 = 15,00
    const satir = (await ok('GET', `/api/stock?campusId=${campusA}`))
      .items.find((x) => x.product_id === productId);
    assert.equal(satir.purchase_price, 15, 'liste fiyati 20 degil, odenen 15 olmali');
  });

  test('her kampus KENDI alis fiyatini tasir', async () => {
    await alim(campusB, 'FY-003', 9.4);
    const a = (await ok('GET', `/api/stock?campusId=${campusA}`))
      .items.find((x) => x.product_id === productId);
    const b = (await ok('GET', `/api/stock?campusId=${campusB}`))
      .items.find((x) => x.product_id === productId);
    assert.equal(a.purchase_price, 15, 'A kampusu kendi fiyatini korumali');
    assert.equal(b.purchase_price, 9.4, 'B kampusu kendi fiyatini kullanmali');
  });

  test('stok degeri kampusun kendi maliyetiyle hesaplanir', async () => {
    const b = await ok('GET', `/api/stock?campusId=${campusB}`);
    const satir = b.items.find((x) => x.product_id === productId);
    assert.ok(Math.abs(satir.stock_cost_value - satir.stock_qty * 9.4) < 0.01,
      `${satir.stock_cost_value} vs ${satir.stock_qty} x 9.4`);
  });

  test('belge iptal edilince o giris fiyat kaynagi olmaktan cikar', async () => {
    const b = await alim(campusB, 'FY-004', 30);
    let satir = (await ok('GET', `/api/stock?campusId=${campusB}`))
      .items.find((x) => x.product_id === productId);
    assert.equal(satir.purchase_price, 30);

    await ok('POST', `/api/purchases/${b.id}/cancel`);

    satir = (await ok('GET', `/api/stock?campusId=${campusB}`))
      .items.find((x) => x.product_id === productId);
    assert.equal(satir.purchase_price, 9.4, 'iptal sonrasi bir onceki girise donmeli');
  });

  test('fire ve satis hareketleri fiyat kaynagi DEGILDIR', async () => {
    await ok('POST', '/api/waste', {
      campusId: campusB, productId, quantity: 1, reason: 'KIRILMA', wasteDate: daysAgo(1),
    });
    const satir = (await ok('GET', `/api/stock?campusId=${campusB}`))
      .items.find((x) => x.product_id === productId);
    assert.equal(satir.purchase_price, 9.4, 'fire fiyati degistirmemeli');
  });
});

/* ===== Urun kartinda alis fiyati artik ELLE tutulmaz (4. madde) ==== */
describe('Urun karti alis fiyatini korur', () => {
  let campusId; let supplierId; let productId;

  before(async () => {
    campusId = (await ok('POST', '/api/campuses', { name: 'Kart Kampüsü', code: 'KRT' })).id;
    supplierId = (await ok('POST', '/api/suppliers',
      { name: 'Kart Test Tedarikçi', taxNo: '1212121212' })).id;
    productId = (await ok('POST', '/api/products',
      { name: 'Kart Test Ürünü', purchasePrice: 11, salePrice: 25, vatRate: 10 })).id;
  });

  test('alis fiyati GONDERILMEDEN yapilan guncelleme onu silmez', async () => {
    // Arayuz artik purchasePrice gondermiyor; eskiden bu alani 0'a dusururdu
    const r = await ok('PUT', `/api/products/${productId}`, {
      name: 'Kart Test Ürünü (düzenlendi)', salePrice: 28, vatRate: 10, criticalStock: 3,
    });
    assert.equal(r.purchase_price, 11, 'alis fiyati korunmali');
    assert.equal(r.sale_price, 28);
    assert.equal(r.name, 'Kart Test Ürünü (düzenlendi)');
  });

  test('kampus fiyati guncellenirken de alis degeri silinmez', async () => {
    await ok('PUT', `/api/products/${productId}/campus-price/${campusId}`,
      { purchasePrice: 9, salePrice: 24 });
    const sonra = await ok('PUT', `/api/products/${productId}/campus-price/${campusId}`,
      { salePrice: 26 });
    assert.ok(sonra, 'istek gecmeli');
    const detay = await ok('GET', `/api/products/${productId}`);
    const kampus = detay.campusPrices.find((c) => c.campus_id === campusId);
    assert.equal(kampus.purchase_price, 9, 'gonderilmeyen alis degeri korunmali');
    assert.equal(kampus.sale_price, 26);
  });

  test('urun listesi alis fiyatinin KAYNAGINI soyler', async () => {
    const once = await ok('GET', `/api/products?campusId=${campusId}`);
    const k1 = once.items.find((p) => p.id === productId);
    assert.equal(k1.purchase_price_source, 'KAMPUS', 'henuz alim yok, kampus tanimi gecerli');

    await ok('POST', '/api/purchases', {
      campusId, supplierId, documentNo: 'KRT-001', documentDate: daysAgo(1),
      lines: [{ productId, quantity: 5, unitPrice: 13.2, vatRate: 10 }],
    });

    const sonra = await ok('GET', `/api/products?campusId=${campusId}`);
    const k2 = sonra.items.find((p) => p.id === productId);
    assert.equal(k2.purchase_price_source, 'ALIM');
    assert.equal(k2.effective_purchase_price, 13.2);
    assert.equal(k2.last_purchase_date, daysAgo(1));
  });

  test('kar marji gercek maliyet uzerinden hesaplanir', async () => {
    const r = await ok('GET', `/api/products?campusId=${campusId}`);
    const k = r.items.find((p) => p.id === productId);
    // Satis 26,00 KDV dahil %10 -> net 23,636..., maliyet 13,20
    assert.ok(Math.abs(k.profit.purchaseNet - 13.2) < 0.01, String(k.profit.purchaseNet));
    assert.ok(k.profit.unitProfit > 10 && k.profit.unitProfit < 11, String(k.profit.unitProfit));
  });
});

/* ============ Tarih bazli satis fiyati (9. madde) ================= */
describe('Tarih bazli satis fiyati', () => {
  let campusId; let otherCampus; let productId;
  const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

  before(async () => {
    campusId = (await ok('POST', '/api/campuses', { name: 'Fiyat Tarih Kampüsü', code: 'FTK' })).id;
    otherCampus = (await ok('POST', '/api/campuses', { name: 'Fiyat Tarih 2', code: 'FT2' })).id;
    productId = (await ok('POST', '/api/products',
      { name: 'Tarihli Fiyat Ürünü', purchasePrice: 10, salePrice: 20, vatRate: 10 })).id;
  });

  test('urun tanimlanirken fiyat listesine de yazilir', async () => {
    const r = await ok('GET', `/api/products/${productId}/prices`);
    assert.equal(r.items.length, 1);
    assert.equal(r.items[0].sale_price, 20);
    assert.equal(r.items[0].campus_id, null, 'katalog fiyati');
    assert.equal(r.items[0].is_future, false);
  });

  test('ILERI tarihli fiyat bugunku fiyati degistirmez', async () => {
    await ok('POST', `/api/products/${productId}/prices`,
      { salePrice: 26, effectiveFrom: iso(7), note: '1 hafta sonra zam' });

    const urun = (await ok('GET', `/api/products?campusId=${campusId}`))
      .items.find((p) => p.id === productId);
    assert.equal(urun.effective_sale_price, 20, 'bugun hala eski fiyat');
    assert.equal(urun.next_price_date, iso(7), 'yaklasan fiyat tarihi bildirilmeli');

    const kart = await ok('GET', `/api/products/${productId}`);
    assert.equal(kart.sale_price, 20, 'urun kartindaki gecerli fiyat degismemeli');
  });

  test('GECMIS tarihli fiyat o gunden itibaren gecerlidir', async () => {
    await ok('POST', `/api/products/${productId}/prices`,
      { salePrice: 22, effectiveFrom: daysAgo(10) });
    const urun = (await ok('GET', `/api/products?campusId=${campusId}`))
      .items.find((p) => p.id === productId);
    // Urun tanimi bugun yapildi (20 TL) ve o daha gec tarihli, yani 20 gecerli
    assert.equal(urun.effective_sale_price, 20, 'daha yeni tarihli fiyat kazanir');
  });

  test('gecmise donuk stok degeri O GUNUN fiyatini kullanir', async () => {
    const bugunku = await ok('GET', `/api/stock?campusId=${campusId}`);
    const gecmis = await ok('GET', `/api/stock?campusId=${campusId}&date=${daysAgo(5)}`);
    const b = bugunku.items.find((x) => x.product_id === productId);
    const g = gecmis.items.find((x) => x.product_id === productId);
    assert.equal(b.sale_price, 20, 'bugun 20');
    assert.equal(g.sale_price, 22, '5 gun once 22 gecerliydi');
  });

  test('kampus fiyati katalogu ezer, digerlerini etkilemez', async () => {
    await ok('POST', `/api/products/${productId}/prices`,
      { salePrice: 18, campusId, note: 'Kampüse özel' });

    const a = (await ok('GET', `/api/products?campusId=${campusId}`))
      .items.find((p) => p.id === productId);
    const b = (await ok('GET', `/api/products?campusId=${otherCampus}`))
      .items.find((p) => p.id === productId);
    assert.equal(a.effective_sale_price, 18, 'kendi kampusunde ozel fiyat');
    assert.equal(b.effective_sale_price, 20, 'diger kampus katalogu kullanir');
  });

  test('ayni gune ikinci fiyat girilirse sonuncusu gecerlidir', async () => {
    await ok('POST', `/api/products/${productId}/prices`, { salePrice: 19, campusId });
    const a = (await ok('GET', `/api/products?campusId=${campusId}`))
      .items.find((p) => p.id === productId);
    assert.equal(a.effective_sale_price, 19);
    const liste = await ok('GET', `/api/products/${productId}/prices`);
    const bugunKampus = liste.items.filter((r) => r.campus_id === campusId && r.effective_from === liste.today);
    assert.equal(bugunKampus.length, 1, 'ayni gun icin tek satir kalmali');
  });

  test('ileri tarihli fiyat iptal edilebilir', async () => {
    const liste = await ok('GET', `/api/products/${productId}/prices`);
    const gelecek = liste.items.find((r) => r.is_future);
    assert.ok(gelecek, 'ileri tarihli fiyat olmali');
    await ok('DELETE', `/api/products/${productId}/prices/${gelecek.id}`);
    const sonra = await ok('GET', `/api/products/${productId}/prices`);
    assert.ok(!sonra.items.some((r) => r.id === gelecek.id));
  });

  test('yururluge girmis fiyat SILINEMEZ', async () => {
    const liste = await ok('GET', `/api/products/${productId}/prices`);
    const gecmis = liste.items.find((r) => !r.is_future);
    const r = await api('DELETE', `/api/products/${productId}/prices/${gecmis.id}`);
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Yururluge girmis/i);
  });

  test('fiyat listesi kimin ne zaman girdigini tutar', async () => {
    const liste = await ok('GET', `/api/products/${productId}/prices`);
    assert.ok(liste.items.every((r) => r.created_by_name), JSON.stringify(liste.items.slice(0, 2)));
  });
});

/* ======= Excel toplu yukleme ve tarihli fiyat listesi ============== */
describe('Toplu yukleme fiyatlari', () => {
  const BARKOD = 'TOPLU-0001';

  test('yuklenen urun fiyat listesine yazilir', async () => {
    const r = await ok('POST', '/api/products/bulk-import', {
      items: [{ barcode: BARKOD, name: 'Toplu Ürün', purchasePrice: 7, salePrice: 14, vatRate: 10 }],
    });
    assert.equal(r.created, 1);

    const urun = (await ok('GET', '/api/products')).items.find((p) => p.barcode === BARKOD);
    const fiyatlar = await ok('GET', `/api/products/${urun.id}/prices`);
    assert.equal(fiyatlar.items.length, 1);
    assert.equal(fiyatlar.items[0].sale_price, 14);
    assert.match(fiyatlar.items[0].note, /Excel/);
  });

  test('alis fiyati sutunu BOS gelirse mevcut deger korunur', async () => {
    const once = (await ok('GET', '/api/products')).items.find((p) => p.barcode === BARKOD);
    assert.equal(once.purchase_price, 7);

    // Excel'de yalnizca satis fiyati guncellenmis bir satir
    const r = await ok('POST', '/api/products/bulk-import', {
      items: [{ barcode: BARKOD, name: 'Toplu Ürün', salePrice: 16, vatRate: 10 }],
    });
    assert.equal(r.updated, 1);

    const sonra = (await ok('GET', '/api/products')).items.find((p) => p.barcode === BARKOD);
    assert.equal(sonra.purchase_price, 7, 'bos birakilan alis fiyati silinmemeli');
    assert.equal(sonra.sale_price, 16);
  });

  test('toplu yukleme fiyat listesine yeni satir ekler', async () => {
    const urun = (await ok('GET', '/api/products')).items.find((p) => p.barcode === BARKOD);
    const fiyatlar = await ok('GET', `/api/products/${urun.id}/prices`);
    // Ayni gun oldugu icin tek satir kalir ama degeri guncellenmis olmali
    assert.equal(fiyatlar.items[0].sale_price, 16);
  });
});

/* ===== Istemci: bozuk yanitlar anlasilir hataya donusur ============ */
describe('Bozuk sunucu yaniti', () => {
  // Istemci katmani tarayicida calisiyor; burada sunucunun HER ZAMAN
  // gecerli JSON dondurdugunu dogrularız. Istemci tarafindaki koruma
  // test/ui/yetki-ve-silme.mjs icinde degil, api.js icinde: 2xx olup
  // cozumlenemeyen govde sessizce {} olmaz, anlasilir hata firlatir.
  test('tum basarili uclar gecerli JSON dondurur', async () => {
    const yollar = [
      '/api/campuses', '/api/products', '/api/products/categories', '/api/suppliers',
      '/api/purchases', '/api/purchases/unmatched', '/api/counts', '/api/audit',
    ];
    for (const yol of yollar) {
      const res = await fetch(BASE + yol, { headers: { Authorization: `Bearer ${token}` } });
      const metin = await res.text();
      assert.equal(res.status, 200, `${yol} -> ${res.status}`);
      assert.doesNotThrow(() => JSON.parse(metin), `${yol} gecerli JSON dondurmeli`);
      assert.match(res.headers.get('content-type') || '', /json/, `${yol} icin content-type`);
    }
  });

  test('hata yanitlari da JSON ve "error" alani tasir', async () => {
    const r = await fetch(`${BASE}/api/products/999999`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(r.status, 404);
    const data = JSON.parse(await r.text());
    assert.ok(data.error, JSON.stringify(data));
  });
});
