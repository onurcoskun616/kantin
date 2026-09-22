/**
 * Arayuz regresyon testi: fiyat mimarisi (4, 7 ve 9. maddeler).
 *
 * Kontrol edilen zincir:
 *   Urun kartinda ALIS FIYATI ALANI YOK, yerine nereden geldigi yaziyor ->
 *   fatura girilince alis fiyati faturadan olusuyor ve kart bunu soyluyor ->
 *   urun duzenlemek alis fiyatini silmiyor ->
 *   satis fiyati TARIHTEN ITIBAREN geciyor: ileri tarihli fiyat bugunku
 *   fiyati degistirmiyor, listede "yaklasan fiyat" olarak gorunuyor ve
 *   iptal edilebiliyor; yururluge girmis fiyat silinemiyor.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/fiyat-mimarisi.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const URUN = `Fiyat Testi ${RUN}`;
const VKN = String(Date.now()).slice(-10);

const gun = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};

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

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[name=email]', 'admin@topkapiokullari.com');
await page.fill('input[name=password]', 'Kantin2026!');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])');
await page.waitForTimeout(1500);

/** Kisa yoldan API cagrisi (hazirlik icin; kontroller arayuzden yapilir). */
const apiCall = (method, path, body) => page.evaluate(async ([m, p, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(p, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, path, body]);

console.log('\n1) Urun kartinda alis fiyati alani YOK');
await page.evaluate(() => { location.hash = '#/products'; });
await page.waitForTimeout(2200);
await page.click('button:has-text("+ Yeni Ürün")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(400);

const form = await page.textContent('.modal-body');
ok('Alis fiyati GIRDISI yok', !(await page.$('.modal input[name=purchasePrice]')));
ok('Alis fiyatinin nereden gelecegi yaziyor',
  /ürün kartında tutulmaz/.test(form), form.slice(0, 400));
ok('Satis fiyati alani duruyor', !!(await page.$('.modal input[name=salePrice]')));
ok('Gecerlilik tarihi alani eklendi', !!(await page.$('.modal input[name=effectiveDate]')));

await page.fill('.modal input[name=name]', URUN);
await page.fill('.modal input[name=salePrice]', '20');
await page.fill('.modal input[name=vatRate]', '10');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(1800);
ok('Alis fiyati olmadan urun acilabildi', (await page.$$('.modal-backdrop')).length === 0);

console.log('\n2) Alis fiyati FATURADAN olusuyor');
const urunId = (await apiCall('GET', '/api/products')).data.items.find((p) => p.name === URUN)?.id;
ok('Urun bulundu', !!urunId);

const ted = await apiCall('POST', '/api/suppliers', { name: `Fiyat Ted ${RUN}`, taxNo: VKN });
const kampusId = await page.evaluate(() => Number(document.getElementById('campusSelect').value));
const alim = await apiCall('POST', '/api/purchases', {
  campusId: kampusId, supplierId: ted.data.id, documentNo: `FYT${RUN}`, documentDate: gun(-1),
  lines: [{ productId: urunId, quantity: 10, unitPrice: 12, vatRate: 10, discountPct: 25 }],
});
ok('Iskontolu alim girildi', alim.status === 200, JSON.stringify(alim.data).slice(0, 150));

// AYNI hash'e gitmek hashchange tetiklemez ve sayfa TAZELENMEZ; alim
// sonrasi guncel veriyi gormek icin gercekten yeniden yukleriz.
await page.goto(`${BASE}/#/products`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const liste = (await apiCall('GET', `/api/products?campusId=${kampusId}`)).data.items;
const urun = liste.find((p) => p.id === urunId);
// 12,00 birim fiyat - %25 iskonto = 9,00 (KDV haric) + %10 KDV = 9,90
// Alis KDV'si indirilmedigi icin maliyet KDV DAHIL tutulur.
ok('Alis fiyati iskontolu ve KDV DAHIL maliyet (9,90)',
  Math.abs(urun.effective_purchase_price - 9.9) < 0.01,
  String(urun.effective_purchase_price));
ok('Kaynak ALIM olarak isaretlendi', urun.purchase_price_source === 'ALIM', urun.purchase_price_source);

await page.click(`tr:has-text("${URUN}") button:has-text("Düzenle")`);
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(500);
const kart = await page.textContent('.modal-body');
ok('Kart alis fiyatinin faturadan geldigini soyluyor',
  /mal girişinden/.test(kart) && /9,90/.test(kart), kart.slice(0, 600));

console.log('\n3) Urun duzenlemek alis fiyatini SILMIYOR');
await page.fill('.modal input[name=salePrice]', '24');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(1800);
const sonrasi = (await apiCall('GET', `/api/products?campusId=${kampusId}`)).data.items
  .find((p) => p.id === urunId);
ok('Alis fiyati korundu', Math.abs(sonrasi.effective_purchase_price - 9.9) < 0.01,
  String(sonrasi.effective_purchase_price));
ok('Satis fiyati guncellendi', Math.abs(sonrasi.effective_sale_price - 24) < 0.01,
  String(sonrasi.effective_sale_price));

console.log('\n4) Satis fiyati TARIHTEN ITIBAREN gecerli');
await page.click(`tr:has-text("${URUN}") button:has-text("Fiyat Takvimi")`);
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(1200);
let takvim = await page.textContent('.modal-body');
ok('Takvim mevcut fiyati listeliyor', /24,00/.test(takvim), takvim.slice(0, 400));

await page.fill('.modal input.num', '30');
await page.fill('.modal input[type=date]', gun(14));
await page.fill('.modal input[placeholder*="tedarikçi"]', 'Test zammı');
await page.click('.modal button:has-text("Fiyatı Tanımla")');
await page.waitForTimeout(1800);
takvim = await page.textContent('.modal-body');
ok('Ileri tarihli fiyat listeye girdi', /30,00/.test(takvim), takvim.slice(0, 400));
ok('"Yururluge girmedi" olarak isaretlendi', /Yürürlüğe girmedi/.test(takvim));

const bugunFiyat = (await apiCall('GET', `/api/products?campusId=${kampusId}`)).data.items
  .find((p) => p.id === urunId);
ok('BUGUNKU fiyat degismedi', Math.abs(bugunFiyat.effective_sale_price - 24) < 0.01,
  String(bugunFiyat.effective_sale_price));
ok('Yaklasan fiyat tarihi bildiriliyor', bugunFiyat.next_price_date === gun(14),
  String(bugunFiyat.next_price_date));

console.log('\n5) Yururluge girmis fiyat silinemez, ileri tarihli iptal edilir');
const silinemez = await page.$$eval('.modal table.data tbody tr',
  (ns) => ns.filter((n) => !n.textContent.includes('Yürürlüğe girmedi'))
    .every((n) => !n.querySelector('button')));
ok('Yururlukteki satirda iptal dugmesi yok', silinemez);

await page.click('.modal table.data tbody tr:has-text("Yürürlüğe girmedi") button:has-text("İptal")');
await page.waitForTimeout(1500);
takvim = await page.textContent('.modal-body');
ok('Ileri tarihli fiyat iptal edildi', !/Yürürlüğe girmedi/.test(takvim), takvim.slice(0, 300));

const iptalSonrasi = (await apiCall('GET', `/api/products?campusId=${kampusId}`)).data.items
  .find((p) => p.id === urunId);
ok('Yaklasan fiyat uyarisi kalkti', !iptalSonrasi.next_price_date, String(iptalSonrasi.next_price_date));

await page.click('.modal-foot button:has-text("Kapat")');
await page.waitForTimeout(600);

console.log('\n6) Gecmise donuk stok degeri O GUNUN fiyatiyla');
await apiCall('POST', `/api/products/${urunId}/prices`, { salePrice: 15, effectiveFrom: gun(-30) });
const bugunStok = (await apiCall('GET', `/api/stock?campusId=${kampusId}`)).data.items
  .find((x) => x.product_id === urunId);
const eskiStok = (await apiCall('GET', `/api/stock?campusId=${kampusId}&date=${gun(-20)}`)).data.items
  .find((x) => x.product_id === urunId);
ok('Bugun 24,00', Math.abs(bugunStok.sale_price - 24) < 0.01, String(bugunStok.sale_price));
ok('20 gun once 15,00', Math.abs(eskiStok.sale_price - 15) < 0.01, String(eskiStok.sale_price));

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
