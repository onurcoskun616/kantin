/**
 * Arayuz regresyon testi: BELGE SATIRLARINI DUZELTME.
 *
 * Sahadan: faturalar koli uzerinden kesiliyor. Cevrim uygulanmadan
 * kaydedilen belgede stokta "2 adet x 534,60 TL" duruyor; oysa 2 koli,
 * yani 36 adet x 29,70 TL gelmis. Bugune kadar tek care belgeyi SILIP
 * yeniden girmekti: fatura dosyasi, ekleri ve belge numarasi gidiyordu.
 *
 * Kontrol edilen zincir:
 *   Yalnizca yonetim "Satirlari Duzelt" gorur -> koli cevrim yardimcisi
 *   miktari carpip fiyati boler ve BELGE TUTARI DEGISMEZ -> kaydedilince
 *   stok hareketleri yeniden kurulur -> fatura dosyasi yerinde kalir ->
 *   islem oncesi/sonrasi denetim izine yazilir.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/satir-duzeltme.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

// 'X' elenir: base36 damgasi "1X24B" uretirse urun adi KAZARA ambalaj
// ipucu tasir ("x24") ve birim/cevrim mantigi yanilir.
const RUN = Date.now().toString(36).slice(-6).toUpperCase().replace(/X/g, 'Z');
const VKN = String(Date.now()).slice(-10);

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1700, height: 1050 } })).newPage();
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
  await page.waitForTimeout(1400);
};
const call = (m, p, bd) => page.evaluate(async ([mm, pp, bb]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(pp, {
    method: mm,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bb ? JSON.stringify(bb) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [m, p, bd]);

await giris('admin@topkapiokullari.com', 'Kantin2026!');

console.log('\n0) Koli miktariyla girilmis belge');
const kampus = (await call('POST', '/api/campuses',
  { name: `Satır UI ${RUN}`, code: `SU${RUN}` })).data;
const ted = (await call('POST', '/api/suppliers',
  { name: `Satır Ted ${RUN}`, taxNo: VKN })).data;
const urun = (await call('POST', '/api/products',
  { name: `Satır Ürün ${RUN}`, salePrice: 50, vatRate: 1, unit: 'ADET' })).data;
const belge = (await call('POST', '/api/purchases', {
  campusId: kampus.id, supplierId: ted.id, documentNo: `SU-${RUN}`, documentDate: gun(-4),
  lines: [{ productId: urun.id, quantity: 2, unitPrice: 534.60, vatRate: 1 }],
})).data;
const stok = async () => (await call('GET', `/api/stock?campusId=${kampus.id}`))
  .data.items.find((x) => x.product_id === urun.id)?.stock_qty ?? 0;
ok('Stok koli miktariyla girmis (2)', (await stok()) === 2, String(await stok()));

const detayAc = async () => {
  await page.evaluate((k) => localStorage.setItem('kantin_campus', String(k)), kampus.id);
  await page.goto(`${BASE}/#/purchases`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2200);
  await page.click(`tr:has-text("SU-${RUN}") button:has-text("Detay")`);
  await page.waitForSelector('.modal-backdrop');
  await page.waitForTimeout(700);
};

console.log('\n1) Dugme YALNIZCA yonetimde');
const gorevliEposta = `satir-gorevli-${RUN}@topkapiokullari.com`;
await call('POST', '/api/users', {
  email: gorevliEposta, fullName: 'Satır Görevli', role: 'KANTIN_GOREVLISI',
  password: 'Gorevli123456', campusId: kampus.id,
});
await giris(gorevliEposta, 'Gorevli123456');
await detayAc();
ok('Kantin gorevlisi dugmeyi GORMUYOR',
  (await page.locator('button:has-text("Satırları Düzelt")').count()) === 0);
await page.click('.modal-head .icon-btn').catch(() => {});

await giris('admin@topkapiokullari.com', 'Kantin2026!');
await detayAc();
ok('Yonetim dugmeyi goruyor',
  (await page.locator('button:has-text("Satırları Düzelt")').count()) === 1);

console.log('\n2) Koli cevrimi: miktar carpilir, fiyat bolunur, TUTAR AYNI');
await page.click('button:has-text("Satırları Düzelt")');
await page.waitForSelector('.modal-backdrop:last-of-type .line-table');
await page.waitForTimeout(600);
const pencere = () => page.locator('.modal-backdrop:last-of-type');
ok('Birimin kartta tutuldugu anlatiliyor',
  /Birim \(adet \/ koli \/ paket\) ürün kartında tutulur/.test(await pencere().textContent()));
ok('Kart birimi satirda yaziyor', /Kart birimi: ADET/.test(await pencere().textContent()));

await pencere().locator('input[placeholder="koli içi adet"]').first().fill('18');
await pencere().locator('button:has-text("× çevir")').first().click();
await page.waitForTimeout(400);
const satirMetni = await pencere().textContent();
ok('Belge tutari degismiyor denildi', /belge tutarı değişmiyor/.test(satirMetni), satirMetni.slice(-300));
const miktar = await pencere().locator('.line-table tbody tr').first().locator('input.num').first().inputValue();
ok('Miktar 36 oldu', miktar === '36', miktar);

console.log('\n3) Gerekce zorunlu, kaydedince stok yeniden kuruluyor');
await pencere().locator('.modal-foot .btn-primary').click();
await page.waitForTimeout(800);
ok('Gerekcesiz kaydedilmiyor', (await pencere().count()) === 1
  && /Gerekce|zorunlu/i.test(await pencere().textContent()));

await pencere().locator('textarea').fill('Fatura koli üzerinden kesilmiş, adede çevrildi.');
await pencere().locator('.modal-foot .btn-primary').click();
await page.waitForTimeout(2500);
ok('Stok adede cevrildi (36)', (await stok()) === 36, String(await stok()));

const sonra = (await call('GET', `/api/purchases/${belge.id}`)).data;
ok('Belge tutari korundu', Math.abs(sonra.gross_total - belge.grossTotal) < 0.01,
  `${sonra.gross_total} / ${belge.grossTotal}`);
ok('Belge NO ve TARIHI yerinde', sonra.document_no === `SU-${RUN}`, sonra.document_no);
ok('Birim fiyat bolundu (29,70)', Math.abs(sonra.lines[0].unit_price - 29.7) < 0.001,
  String(sonra.lines[0].unit_price));

console.log('\n4) Denetim izinde oncesi ve sonrasi var');
const izl = (await call('GET', '/api/audit?entity=purchases&limit=40')).data.items || [];
const kayit = izl.find((x) => JSON.stringify(x.detail || '').includes('belge-satirlari-duzeltildi'));
ok('Duzeltme denetim izinde', Boolean(kayit));
const d = kayit && (typeof kayit.detail === 'string' ? JSON.parse(kayit.detail) : kayit.detail);
ok('Onceki miktar 2, yeni miktar 36',
  d?.onceki?.[0]?.miktar === 2 && d?.yeni?.[0]?.miktar === 36, JSON.stringify(d?.yeni));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Belge satirlari yerinde duzeltilebiliyor.\n');
