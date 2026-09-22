/**
 * Arayuz regresyon testi: ACILIS SAYIMI.
 *
 * Kontrol edilen zincir:
 *   Kampusun ILK donem sayiminda "acilis sayimi" secenegi cikiyor ->
 *   isaretlenince sayim acilis olarak aciliyor ve listede rozeti gorunuyor ->
 *   mutabakat ekrani "rakamlar raporlara girmez" diyor ->
 *   kesinlesince stok gercege oturuyor -> IKINCI sayimda secenek KALKIYOR.
 *
 * Kurallarin kendisi test/api.test.js icinde sunucu tarafinda sinaniyor;
 * burasi kullanicinin GORDUGU seyi dogrular.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/acilis-sayimi.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const VKN = String(Date.now()).slice(-10);

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
const EXPECTED = /Failed to load resource.*\b(400|403|409)\b|TypeError: Failed to fetch/;
page.on('console', (m) => {
  if (m.type() === 'error' && !EXPECTED.test(m.text())) console.log('CONSOLE ' + m.text().slice(0, 160));
});

const problems = [];
const ok = (l, c, d = '') => {
  if (c) console.log(`  ✓ ${l}`);
  else { console.log(`  ✗ ${l}${d ? ' — ' + String(d).slice(0, 240) : ''}`); problems.push(l); }
};
const gun = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.toISOString().slice(0, 10); };

const giris = async (eposta, parola) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.removeItem('kantin_token'); } catch { /* yoksay */ } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', eposta);
  await page.fill('input[name=password]', parola);
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForTimeout(1500);
};

await giris('admin@topkapiokullari.com', 'Kantin2026!');

const apiCall = (method, path, body) => page.evaluate(async ([m, p, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(p, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, path, body]);

console.log('\n0) Temiz bir kampuse gecmis fatura girilir');
const kampus = (await apiCall('POST', '/api/campuses', { name: `Açılış UI ${RUN}`, code: `AU${RUN}` })).data;
const ted = (await apiCall('POST', '/api/suppliers', { name: `Açılış Ted ${RUN}`, taxNo: VKN })).data;
const urun = (await apiCall('POST', '/api/products',
  { name: `Açılış Ürün ${RUN}`, salePrice: 20, vatRate: 10, unit: 'ADET' })).data;
const alim = await apiCall('POST', '/api/purchases', {
  campusId: kampus.id, supplierId: ted.id, documentNo: `AU-${RUN}`, documentDate: gun(-30),
  lines: [{ productId: urun.id, quantity: 200, unitPrice: 10, vatRate: 10 }],
});
ok('Gecmis fatura girildi (200 adet)', alim.status === 200, JSON.stringify(alim.data).slice(0, 160));

const sayimlaraGit = async () => {
  await page.evaluate((k) => localStorage.setItem('kantin_campus', String(k)), kampus.id);
  await page.goto(`${BASE}/#/counts`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
};

console.log('\n1) ILK donem sayiminda "acilis sayimi" secenegi VAR');
await sayimlaraGit();
await page.click('button:has-text("+ Dönem Sayımı")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(500);
let form = await page.textContent('.modal-body');
ok('Acilis secenegi gorunuyor', /AÇILIŞ sayımıdır/.test(form), form.slice(0, 400));
ok('Ne ise yaradigi aciklanmis', /raporlarına GİRMEZ/.test(form), form.slice(0, 600));

await page.check('.modal input[name=isOpening]');
await page.fill('.modal input[name=countDate]', gun(-1));
await page.fill('.modal textarea[name=note]', 'Sisteme geçiş açılış sayımı');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2500);
ok('Acilis sayimi acildi', page.url().includes('countDetail'), page.url());

console.log('\n2) Mutabakat "raporlara girmez" diyor');
const detay = await page.textContent('#pageContent');
ok('Acilis sayimi oldugu ekranda yaziyor',
  /AÇILIŞ SAYIMI/.test(detay) || /açılış/i.test(detay), detay.slice(0, 400));

console.log('\n3) Listede ACILIS rozeti var');
await sayimlaraGit();
const liste = await page.textContent('#pageContent');
ok('Tip sutununda "Açılış" yaziyor', /Açılış/.test(liste), liste.slice(0, 400));

console.log('\n4) Sayim kesinlesince stok GERCEGE oturuyor');
const acik = (await apiCall('GET', `/api/counts?campusId=${kampus.id}`)).data.items[0];
await apiCall('PUT', `/api/counts/${acik.id}/lines`, { lines: [{ productId: urun.id, countedQty: 30 }] });
await apiCall('POST', `/api/counts/${acik.id}/submit`, { witnessName: 'UI Tanık' });

// IKI IMZA: kesinlestirmeyi baska bir yetkili yapar
const mudurEposta = `acilis-mudur-${RUN}@topkapiokullari.com`;
await apiCall('POST', '/api/users', {
  email: mudurEposta, fullName: 'Açılış Müdür', role: 'GENEL_MUDURLUK', password: 'Mudur123456',
});
await giris(mudurEposta, 'Mudur123456');
const kesin = await apiCall('POST', `/api/counts/${acik.id}/finalize`, {});
ok('Ikinci yetkili kesinlestirdi', kesin.status === 200, JSON.stringify(kesin.data).slice(0, 200));

const stok = (await apiCall('GET', `/api/stock?campusId=${kampus.id}`)).data.items
  .find((x) => x.product_id === urun.id);
ok('Stok sayilan miktara oturdu (30)', stok.stock_qty === 30, String(stok?.stock_qty));

console.log('\n5) Mutabakatta "raporlara yazilmadi" deniyor');
await page.goto(`${BASE}/#/countDetail/${acik.id}`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const mutabakat = await page.textContent('#pageContent');
ok('Acilis tamamlandi mesaji var', /Açılış tamamlandı/.test(mutabakat), mutabakat.slice(0, 500));
ok('"Ciro acigi" alarmi YOK', !/ciro açığı/i.test(mutabakat), mutabakat.slice(0, 500));

console.log('\n6) IKINCI sayimda secenek KALKIYOR');
await sayimlaraGit();
await page.click('button:has-text("+ Dönem Sayımı")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(500);
form = await page.textContent('.modal-body');
ok('Acilis secenegi artik YOK', !/AÇILIŞ sayımıdır/.test(form), form.slice(0, 400));
await page.click('.modal-head .icon-btn').catch(() => {});

console.log('\n7) Acilis sayimi aylik raporda YOK');
const ay = new Date().toISOString().slice(0, 7);
const rapor = (await apiCall('GET', `/api/reports/monthly?campusId=${kampus.id}&from=${gun(-60)}&to=${gun(0)}`)).data;
const satir = (rapor.items || []).find((r) => r.campusId === kampus.id && r.month === ay);
ok('Raporda beklenen ciro yok', !satir || satir.expectedRevenue === null,
  JSON.stringify(satir || 'satir yok'));

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
