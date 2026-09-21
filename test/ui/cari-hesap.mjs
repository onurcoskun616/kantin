/**
 * Arayuz regresyon testi: KAMPUS BAZLI TEDARIKCI CARI HESABI.
 *
 * Kontrol edilen zincir:
 *   Tedarikci karti tum kampuslerde ORTAK -> ama hesabi degil: listede
 *   gorunen bakiye secili kampusun bakiyesi -> kampus degisince bakiye de
 *   degisiyor -> odeme kaydederken hangi kampus adina oldugu SORULUYOR ->
 *   odeme yalnizca o kampusun borcunu kapatiyor -> cari hesap penceresi
 *   kampus kampus dokumu ve yuruyen bakiyeli ekstre gosteriyor.
 *
 * Kurallarin kendisi test/api.test.js icinde sunucu tarafinda sinaniyor;
 * burasi kullanicinin GORDUGU seyi dogrular.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/cari-hesap.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

// Ayni veritabaninda tekrar calistirilabilsin diye benzersiz ad/VKN/kod
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const TEDARIKCI = `Cari UI ${RUN}`;
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

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[name=email]', 'admin@topkapiokullari.com');
await page.fill('input[name=password]', 'Kantin2026!');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])');
await page.waitForTimeout(1500);

const apiCall = (method, path, body) => page.evaluate(async ([m, p, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(p, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, path, body]);

console.log('\n0) Iki kampuse ayni tedarikciden mal girisi');
const kampusA = (await apiCall('POST', '/api/campuses', { name: `Cari A ${RUN}`, code: `CA${RUN}` })).data;
const kampusB = (await apiCall('POST', '/api/campuses', { name: `Cari B ${RUN}`, code: `CB${RUN}` })).data;
ok('Iki kampus acildi', !!kampusA.id && !!kampusB.id, JSON.stringify([kampusA, kampusB]).slice(0, 200));

const ted = (await apiCall('POST', '/api/suppliers', { name: TEDARIKCI, taxNo: VKN })).data;
const urun = (await apiCall('POST', '/api/products',
  { name: `Cari Ürün ${RUN}`, salePrice: 20, vatRate: 10, unit: 'ADET' })).data;

// A: 100 x 10 + %10 KDV = 1100   B: 50 x 10 + %10 KDV = 550
for (const [k, adet, no] of [[kampusA.id, 100, `CA-${RUN}`], [kampusB.id, 50, `CB-${RUN}`]]) {
  const r = await apiCall('POST', '/api/purchases', {
    campusId: k, supplierId: ted.id, documentNo: no, documentDate: gun(-3),
    lines: [{ productId: urun.id, quantity: adet, unitPrice: 10, vatRate: 10 }],
  });
  ok(`${no} belgesi girildi`, r.status === 200, JSON.stringify(r.data).slice(0, 160));
}

// Kampus seciciyi A'ya al ve sayfayi gercekten tazele
const kampuseGec = async (id) => {
  await page.evaluate((k) => localStorage.setItem('kantin_campus', String(k)), id);
  await page.goto(`${BASE}/#/catalog`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await page.click('button:has-text("Tedarikçiler")').catch(() => {});
  await page.waitForTimeout(1200);
};

console.log('\n1) Listedeki bakiye SECILI KAMPUSUN bakiyesi');
await kampuseGec(kampusA.id);
let satir = await page.textContent(`tr:has-text("${TEDARIKCI}")`);
ok('A kampusunde borc 1.100', /1\.100,00/.test(satir), satir.slice(0, 200));
let baslik = await page.textContent('#pageContent');
ok('Kart tedarikcinin ortak, hesabinin ayri oldugunu soyluyor',
  /cari hesabı değildir|kartı tüm kampüslerde ortaktır/.test(baslik), baslik.slice(0, 300));

await kampuseGec(kampusB.id);
satir = await page.textContent(`tr:has-text("${TEDARIKCI}")`);
ok('B kampusunde borc 550 (A"nin borcu gorunmuyor)',
  /550,00/.test(satir) && !/1\.100,00/.test(satir), satir.slice(0, 200));

console.log('\n2) Odeme kaydinda kampus SORULUYOR');
await kampuseGec(kampusA.id);
await page.click(`tr:has-text("${TEDARIKCI}") button:has-text("Cari Hesap")`);
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(1200);
const pencere = await page.textContent('.modal-body');
ok('Baslik hangi kampusun hesabi oldugunu soyluyor',
  (await page.textContent('.modal-head')).includes('Cari A'), await page.textContent('.modal-head'));
ok('Kampus dokumu tablosu var', /Kampüs Hesapları/.test(pencere), pencere.slice(0, 300));
ok('Dokumde her iki kampus de var', /Cari A/.test(pencere) && /Cari B/.test(pencere));
ok('Ekstre yuruyen bakiye gosteriyor', /Hesap Ekstresi/.test(pencere) && /Bakiye/.test(pencere));

await page.click('.modal button:has-text("+ Ödeme Kaydet")');
await page.waitForTimeout(800);
const odemeFormu = await page.textContent('.modal-backdrop:last-of-type .modal-body');
ok('Kampus secimi zorunlu alan olarak var',
  /Hangi kampüs adına\?/.test(odemeFormu), odemeFormu.slice(0, 300));
const secili = await page.$eval('.modal-backdrop:last-of-type select[name=campusId]', (n) => n.value);
ok('On tanimli deger SECILI kampus', Number(secili) === kampusA.id, `${secili} != ${kampusA.id}`);
const secenekler = await page.$$eval('.modal-backdrop:last-of-type select[name=campusId] option', (ns) => ns.map((n) => n.textContent));
ok('Secenekte kampusun borcu yaziyor',
  secenekler.some((o) => /Cari A.*1\.100,00/.test(o)), JSON.stringify(secenekler));

await page.fill('.modal-backdrop:last-of-type input[name=amount]', '400');
await page.click('.modal-backdrop:last-of-type .btn-primary');
await page.waitForTimeout(2000);

console.log('\n3) Odeme YALNIZCA odendigi kampusun borcunu kapatiyor');
const a = (await apiCall('GET', `/api/suppliers/${ted.id}?campusId=${kampusA.id}`)).data;
const bk = (await apiCall('GET', `/api/suppliers/${ted.id}?campusId=${kampusB.id}`)).data;
ok('A kampusu 1.100 − 400 = 700', Math.abs(a.balance.debt - 700) < 0.01, String(a.balance.debt));
ok('B kampusu 550 (etkilenmedi)', Math.abs(bk.balance.debt - 550) < 0.01, String(bk.balance.debt));
ok('A"nin ekstresi 2 satir (alim + odeme)', a.ledger.length === 2, JSON.stringify(a.ledger).slice(0, 200));
ok('Ekstrenin son bakiyesi 700', Math.abs(a.ledger.at(-1).balance - 700) < 0.01, String(a.ledger.at(-1).balance));

console.log('\n4) Listede de guncel bakiye gorunuyor');
await kampuseGec(kampusA.id);
satir = await page.textContent(`tr:has-text("${TEDARIKCI}")`);
ok('A kampusu listede 700 gosteriyor', /700,00/.test(satir), satir.slice(0, 200));
await kampuseGec(kampusB.id);
satir = await page.textContent(`tr:has-text("${TEDARIKCI}")`);
ok('B kampusu hala 550', /550,00/.test(satir), satir.slice(0, 200));

console.log('\n5) Kampus yoneticisi BASKA kampusun hesabini gormuyor');
const eposta = `cari-ui-${RUN}@topkapiokullari.com`;
await apiCall('POST', '/api/users', {
  email: eposta, fullName: 'Cari UI Yönetici', role: 'KAMPUS_YONETICISI',
  campusId: kampusA.id, password: 'CariUIParola123',
});
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.evaluate(() => { try { localStorage.removeItem('kantin_token'); } catch { /* yoksay */ } });
await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[name=email]', eposta);
await page.fill('input[name=password]', 'CariUIParola123');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])');
await page.waitForTimeout(1800);
await page.goto(`${BASE}/#/catalog`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.click('button:has-text("Tedarikçiler")').catch(() => {});
await page.waitForTimeout(1200);
await page.click(`tr:has-text("${TEDARIKCI}") button:has-text("Cari Hesap")`);
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(1200);
const yoneticiPencere = await page.textContent('.modal-body');
ok('Kendi kampusunun borcunu goruyor', /700,00/.test(yoneticiPencere), yoneticiPencere.slice(0, 300));
ok('Diger kampusun hesabini GORMUYOR',
  !/Cari B/.test(yoneticiPencere), yoneticiPencere.slice(0, 400));

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
