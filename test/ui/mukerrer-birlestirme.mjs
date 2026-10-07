/**
 * Arayuz regresyon testi: MUKERRER URUN KARTLARINI BIRLESTIRME.
 *
 * Sahadan gelen durum: bir kampusun katalogunda 15 urun adi birden fazla
 * kartta duruyordu, besinde IKI KARTTA BIRDEN stok vardi ("GUZELPINAR
 * 0.5 CC PET SU" 6912 + 2016). Faturadaki ad tam eslesmeyince yeni kart
 * aciliyor; stok ikiye bolunuyor, sayim mutabakati tutmuyor, karlilik
 * yanlis cikiyor. Kullanici 200+ kart icinde bunlari gozle arayamaz.
 *
 * Kontrol edilen zincir:
 *   Katalog ekrani mukerrerleri KENDISI bulup listeler -> birlestirme
 *   penceresi NE OLACAGINI tek tek sayar ve birim farkini uyarir ->
 *   onaylaninca stok tek kartta toplanir, kaynak kart silinir ->
 *   panelden duser.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/mukerrer-birlestirme.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const AD = `MÜKERRER SU ${RUN}`;

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));

const problems = [];
const ok = (l, c, d = '') => {
  if (c) console.log(`  ✓ ${l}`);
  else { console.log(`  ✗ ${l}${d ? ' — ' + String(d).slice(0, 220) : ''}`); problems.push(l); }
};

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[name=email]', 'admin@topkapiokullari.com');
await page.fill('input[name=password]', 'Kantin2026!');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])');
await page.waitForTimeout(1500);

const apiCall = (method, p, body) => page.evaluate(async ([m, pp, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(pp, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, p, body]);

// Hazirlik: ayni urun icin IKI kart + ikisine de mal girisi
const kampus = (await apiCall('GET', '/api/campuses')).data.items[0].id;
const ted = (await apiCall('POST', '/api/suppliers',
  { name: `Mükerrer Ted ${RUN}`, taxNo: String(Date.now()).slice(-10) })).data;
const kalan = (await apiCall('POST', '/api/products',
  { name: AD, salePrice: 20, vatRate: 10, unit: 'ADET' })).data;
const silinecek = (await apiCall('POST', '/api/products',
  { name: `${AD}  `, salePrice: 20, vatRate: 10, unit: 'KUTU' })).data;
for (const [k, q] of [[kalan, 100], [silinecek, 40]]) {
  await apiCall('POST', '/api/purchases', {
    campusId: kampus, supplierId: ted.id, documentNo: `MKR-${k.id}-${RUN}`,
    documentDate: '2026-09-15',
    lines: [{ productId: k.id, quantity: q, unitPrice: 5, vatRate: 10 }],
  });
}
ok('Hazirlik: ayni urune iki kart, ikisinde de stok', Boolean(kalan.id && silinecek.id));

const stok = async (id) => {
  const r = await apiCall('GET', `/api/stock?campusId=${kampus}`);
  return r.data.items.find((x) => x.product_id === id)?.stock_qty ?? 0;
};
ok('Stok ikiye bolunmus (100 / 40)', (await stok(kalan.id)) === 100 && (await stok(silinecek.id)) === 40);

console.log('\n1) Katalog ekrani mukerrerleri KENDISI buluyor');
await page.goto(`${BASE}/#/products`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
let metin = await page.textContent('#app');
ok('"Mükerrer Ürün Kartları" paneli var', /Mükerrer Ürün Kartları/.test(metin), metin.slice(0, 200));
ok('Bizim urun panelde listeleniyor', metin.includes(AD), AD);
ok('Iki kartta da stok oldugu isaretli', /kartta birden stok var/.test(metin), metin.slice(0, 300));

console.log('\n2) Birlestirme penceresi NE OLACAGINI soyluyor');
await page.click(`button:has-text("#${silinecek.id} kartını #${kalan.id} ile birleştir")`);
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(1500);
const pencere = await page.textContent('.modal-body');
ok('Geri alinamaz uyarisi var', /geri alınamaz/.test(pencere), pencere.slice(0, 200));
ok('Hangi kartin silinecegi yaziyor', pencere.includes(`#${silinecek.id}`), pencere.slice(0, 300));
ok('Tasinacak kayitlar tek tek sayiliyor', /Taşınacak kayıtlar/.test(pencere), pencere.slice(0, 400));
ok('Stok hareketi sayisi yaziyor', /stok hareketi/.test(pencere), pencere.slice(0, 500));
ok('BIRIM FARKI uyarisi cikti', /Birimler FARKLI/.test(pencere), pencere.slice(0, 600));
ok('Sayimda toplanacagi anlatiliyor', /miktarlar TOPLANIR/.test(pencere), pencere.slice(0, 700));

console.log('\n3) Onaylaninca stok TEK kartta toplaniyor');
await page.click('.modal-foot .btn-danger');
await page.waitForTimeout(2500);
ok('Kaynak kart silindi', (await apiCall('GET', `/api/products/${silinecek.id}`)).status === 404);
ok('Stok tek kartta toplandi (140)', (await stok(kalan.id)) === 140, String(await stok(kalan.id)));

console.log('\n4) Panelden dustu');
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
metin = await page.textContent('#app');
ok('Bu urun artik mukerrer listesinde yok', !metin.includes(`#${silinecek.id} kartını`), AD);

console.log('\n5) Denetim izine yazildi');
const izl = (await apiCall('GET', '/api/audit?entity=products&limit=20')).data.items || [];
const kayit = izl.find((x) => x.action === 'MERGE' && x.entity_id === kalan.id);
ok('Birlestirme denetim izinde', Boolean(kayit), JSON.stringify(izl.slice(0, 2)).slice(0, 160));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Mukerrer kartlar bulunuyor ve guvenle birlestiriliyor.\n');
