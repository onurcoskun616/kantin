/**
 * Arayuz regresyon testi: GECMIS YILDAN DEVREDEN STOGU SISTEME KABUL ETME.
 *
 * Sahadan gelen durum (Ikitelli OSB): "BISKREM KAKAOLU 100GRx18"
 * kartinda olmasi gereken 36, sayilan 101. Aradaki 65 adet gecen yildan
 * devreden, sisteme hic girilmemis maldir. Kullanici bunlari sisteme
 * kabul etmek istiyor.
 *
 * Yolu ACILIS SAYIMIDIR: kesinlesince fazla cikan mal stoga EKLENIR ve
 * rakam raporlara girmez. Ama "acilis" isareti eskiden YALNIZCA sayim
 * acilirken konabiliyordu; isaretlemeyi unutan kullanicinin tek caresi
 * sayimi SILIP bastan acmakti -- girilen yuzlerce miktar cope giderdi.
 *
 * Kontrol edilen zincir:
 *   Isaretsiz acilmis sayimda ekran "acilis olarak isaretle" diyor ->
 *   dugmeye basilinca isaret konuyor ve GIRILEN MIKTARLAR KORUNUYOR ->
 *   kesinlesince devreden mal stoga ekleniyor (stok = sayilan).
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/devir-stogu.mjs [http://127.0.0.1:3000]
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

console.log('\n0) Kampuse 36 adet fatura girilir, rafta 101 adet vardir');
const kampus = (await apiCall('POST', '/api/campuses',
  { name: `Devir UI ${RUN}`, code: `DU${RUN}` })).data;
const ted = (await apiCall('POST', '/api/suppliers',
  { name: `Devir Ted ${RUN}`, taxNo: VKN })).data;
const urun = (await apiCall('POST', '/api/products',
  { name: `Biskrem Devir ${RUN}`, salePrice: 50, vatRate: 10, unit: 'ADET' })).data;
await apiCall('POST', '/api/purchases', {
  campusId: kampus.id, supplierId: ted.id, documentNo: `DU-${RUN}`, documentDate: gun(-30),
  lines: [{ productId: urun.id, quantity: 36, unitPrice: 25, vatRate: 10 }],
});

// ACILIS ISARETI OLMADAN acilan sayim: kullanici isaretlemeyi unutmus
const sayim = (await apiCall('POST', '/api/counts',
  { campusId: kampus.id, countDate: gun(-1), isBlind: false })).data;
ok('Sayim acilis ISARETSIZ acildi', sayim.is_opening === 0, String(sayim.is_opening));
await apiCall('PUT', `/api/counts/${sayim.id}/lines`,
  { lines: [{ productId: urun.id, countedQty: 101 }] });

const detaya = async () => {
  await page.evaluate((k) => localStorage.setItem('kantin_campus', String(k)), kampus.id);
  await page.goto(`${BASE}/#/countDetail/${sayim.id}`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  return page.textContent('#pageContent');
};

console.log('\n1) Ekran isaretsiz ilk sayimi aciklıyor ve YOLU gosteriyor');
let metin = await detaya();
ok('Ilk sayim uyarisi var', /ilk dönem sayımı/i.test(metin), metin.slice(0, 400));
ok('Silip bastan acma ONERILMIYOR', !/silip/i.test(metin), metin.slice(0, 900));
const dugme = page.locator('button:has-text("Açılış Sayımı olarak işaretle")');
ok('"Acilis olarak isaretle" dugmesi var', (await dugme.count()) === 1, String(await dugme.count()));

console.log('\n2) Dugmeye basilinca isaret konuyor, MIKTARLAR KORUNUYOR');
await dugme.click();
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(400);
const onayMetni = await page.textContent('.modal-body');
ok('Onayda devreden malin EKLENECEGI yaziyor', /stoğa EKLENİR/.test(onayMetni), onayMetni.slice(0, 400));
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2500);

const guncel = (await apiCall('GET', `/api/counts/${sayim.id}`)).data;
ok('Sayim artik ACILIS', guncel.is_opening === 1, String(guncel.is_opening));
ok('Girilen miktar KORUNDU (101)',
  guncel.lines.find((l) => l.product_id === urun.id)?.counted_qty === 101,
  JSON.stringify(guncel.lines.find((l) => l.product_id === urun.id)));

metin = await detaya();
ok('Ekran artik "ACILIS SAYIMI" diyor', /AÇILIŞ SAYIMI/.test(metin), metin.slice(0, 400));

console.log('\n3) Kesinlesince DEVREDEN mal stoga ekleniyor');
await apiCall('POST', `/api/counts/${sayim.id}/submit`, { witnessName: 'Devir Tanık' });
const mudurEposta = `devir-mudur-${RUN}@topkapiokullari.com`;
await apiCall('POST', '/api/users', {
  email: mudurEposta, fullName: 'Devir Müdür', role: 'GENEL_MUDURLUK', password: 'Mudur123456',
});
await giris(mudurEposta, 'Mudur123456');
const kesin = await apiCall('POST', `/api/counts/${sayim.id}/finalize`, {});
ok('Ikinci yetkili kesinlestirdi', kesin.status === 200, JSON.stringify(kesin.data).slice(0, 200));

const stok = (await apiCall('GET', `/api/stock?campusId=${kampus.id}`)).data.items
  .find((x) => x.product_id === urun.id);
ok('Stok sayilan miktara oturdu (101)', stok?.stock_qty === 101, String(stok?.stock_qty));

const hareketler = (await apiCall('GET',
  `/api/stock/movements?campusId=${kampus.id}&productId=${urun.id}`)).data.items || [];
ok('Devreden 65 adet SAYIM_FAZLA hareketiyle girdi',
  hareketler.some((m) => m.movement_type === 'SAYIM_FAZLA' && m.quantity === 65),
  JSON.stringify(hareketler.map((m) => [m.movement_type, m.quantity])));

console.log('\n4) Acilis isareti kesinlesince KILITLI');
const reddet = await apiCall('PUT', `/api/counts/${sayim.id}/acilis`, { isOpening: false });
ok('Kesinlesmis sayimda isaret degistirilemiyor', reddet.status === 409,
  `${reddet.status} ${JSON.stringify(reddet.data).slice(0, 160)}`);

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Devreden stok acilis sayimiyla sisteme kabul ediliyor.\n');
