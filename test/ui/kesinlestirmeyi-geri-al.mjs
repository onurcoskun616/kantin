/**
 * Arayuz regresyon testi: KESINLESTIRMEYI GERI ALMA (yanlis fatura).
 *
 * Sahadan gelen durum (Ikitelli OSB): 30.09 tarihli CAN2026000089717
 * no.lu fatura YANLIS girilmis; muhasebe iptal edip yeniden girmek
 * istiyor. 02.10 tarihli kesinlesmis sayim o tarihi kilitledigi icin
 * belge ne iptal ne silinebiliyordu -- ve kesinlesmis sayimi geri almanin
 * HICBIR yolu yoktu: hatali bir kesinlestirme kalici oluyordu.
 *
 * Kontrol edilen zincir:
 *   Kilitli belgede cikis yolu YAZIYOR -> sayim ekraninda "Kesinlestirmeyi
 *   Geri Al" var -> onay NE OLACAGINI anlatiyor -> geri alinca stok sayim
 *   oncesine doner ve fatura duzeltilebilir -> duzeltme sonrasi yeniden
 *   kesinlestirilince rakamlar yeniden hesaplanir.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/kesinlestirmeyi-geri-al.mjs [http://127.0.0.1:3000]
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

console.log('\n0) Yanlis fatura girilir (1000 adet olmasi gereken 100)');
const kampus = (await call('POST', '/api/campuses',
  { name: `Geri Al UI ${RUN}`, code: `GA${RUN}` })).data;
const ted = (await call('POST', '/api/suppliers',
  { name: `Geri Al Ted ${RUN}`, taxNo: VKN })).data;
const urun = (await call('POST', '/api/products',
  { name: `Geri Al Ürün ${RUN}`, salePrice: 50, vatRate: 10, unit: 'ADET' })).data;
const fatura = (await call('POST', '/api/purchases', {
  campusId: kampus.id, supplierId: ted.id, documentNo: `GA-${RUN}`, documentDate: gun(-10),
  lines: [{ productId: urun.id, quantity: 1000, unitPrice: 10, vatRate: 10 }],
})).data;
const sayim = (await call('POST', '/api/counts',
  { campusId: kampus.id, countDate: gun(-5), isBlind: false })).data;
await call('PUT', `/api/counts/${sayim.id}/lines`, { lines: [{ productId: urun.id, countedQty: 900 }] });
await call('POST', `/api/counts/${sayim.id}/submit`, { witnessName: 'UI Tanık' });

const mudurEposta = `gerial-mudur-${RUN}@topkapiokullari.com`;
await call('POST', '/api/users', {
  email: mudurEposta, fullName: 'Geri Al Müdür', role: 'GENEL_MUDURLUK', password: 'Mudur123456',
});
await giris(mudurEposta, 'Mudur123456');
ok('Sayim kesinlestirildi', (await call('POST', `/api/counts/${sayim.id}/finalize`, {})).status === 200);

const stok = async () => (await call('GET', `/api/stock?campusId=${kampus.id}`))
  .data.items.find((x) => x.product_id === urun.id)?.stock_qty ?? 0;
ok('Stok sayilan miktara oturdu (900)', (await stok()) === 900, String(await stok()));

console.log('\n1) Kilitli belge CIKIS YOLUNU yaziyor');
const red = await call('POST', `/api/purchases/${fatura.id}/cancel`);
ok('Iptal reddedildi', red.status === 409, String(red.status));
ok('Mesaj "Kesinlestirmeyi Geri Al" diyor', /Kesinlestirmeyi Geri Al/i.test(red.data.error || ''),
  red.data.error);

console.log('\n2) Sayim ekraninda GERI AL dugmesi var ve NE OLACAGINI anlatiyor');
await page.evaluate((k) => localStorage.setItem('kantin_campus', String(k)), kampus.id);
await page.goto(`${BASE}/#/countDetail/${sayim.id}`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
const dugme = page.locator('button:has-text("Kesinleştirmeyi Geri Al")');
ok('Dugme gorunuyor', (await dugme.count()) >= 1, String(await dugme.count()));
await dugme.first().click();
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(500);
const onay = await page.textContent('.modal-body');
ok('Stogun geri donecegi yaziyor', /stoğa yazdığı hareketler silinir/i.test(onay), onay.slice(0, 300));
ok('Sayilan miktarlarin DURACAGI yaziyor', /miktarlar ve tanık bilgisi DURUR/i.test(onay), onay.slice(0, 400));
ok('Gerekce zorunlu', (await page.locator('.modal textarea[name=reason]').count()) === 1);

console.log('\n3) Geri alinca stok sayim oncesine doner');
await page.fill('.modal textarea[name=reason]', 'Fatura yanlış girildi, düzeltilip yeniden kesinleştirilecek.');
await page.click('.modal-foot .btn-danger');
await page.waitForTimeout(2500);
const guncel = (await call('GET', `/api/counts/${sayim.id}`)).data;
ok('Durum KILITLI (SAYILDI)', guncel.status === 'SAYILDI', guncel.status);
ok('Sayilan miktar korundu (900)',
  guncel.lines.find((l) => l.product_id === urun.id)?.counted_qty === 900);
ok('Stok fatura miktarina dondu (1000)', (await stok()) === 1000, String(await stok()));

console.log('\n4) Fatura artik duzeltilebiliyor');
const iptal = await call('POST', `/api/purchases/${fatura.id}/cancel`);
ok('Iptal kabul edildi', iptal.status === 200, JSON.stringify(iptal.data).slice(0, 160));
await call('POST', '/api/purchases', {
  campusId: kampus.id, supplierId: ted.id, documentNo: `GA-${RUN}-D`, documentDate: gun(-10),
  lines: [{ productId: urun.id, quantity: 100, unitPrice: 10, vatRate: 10 }],
});
ok('Dogru fatura girildi (100)', (await stok()) === 100, String(await stok()));

console.log('\n5) Kilitli durumda "olmasi gereken" CANLI okunuyor');
const kilitli = (await call('GET', `/api/counts/${sayim.id}`)).data;
ok('Olmasi gereken duzeltilmis faturayi gosteriyor (100)',
  kilitli.lines.find((l) => l.product_id === urun.id)?.expected_qty === 100,
  String(kilitli.lines.find((l) => l.product_id === urun.id)?.expected_qty));
ok('Kesinlestirmenin yazdigi donem satisi temizlendi',
  kilitli.lines.find((l) => l.product_id === urun.id)?.sold_qty === 0,
  String(kilitli.lines.find((l) => l.product_id === urun.id)?.sold_qty));

console.log('\n6) Yeniden kesinlestirince rakamlar YENIDEN hesaplanir');
// IKI IMZA: kilitleyen ile kesinlestiren ayni kisi olamaz
await giris('admin@topkapiokullari.com', 'Kantin2026!');
await call('POST', `/api/counts/${sayim.id}/reopen`, { reason: 'Sayılan miktar da düzeltilecek.' });
await call('PUT', `/api/counts/${sayim.id}/lines`, { lines: [{ productId: urun.id, countedQty: 90 }] });
await call('POST', `/api/counts/${sayim.id}/submit`, { witnessName: 'UI Tanık' });
await giris(mudurEposta, 'Mudur123456');
ok('Yeniden kesinlestirildi', (await call('POST', `/api/counts/${sayim.id}/finalize`, {})).status === 200);
const son = (await call('GET', `/api/counts/${sayim.id}`)).data;
const satir = son.lines.find((l) => l.product_id === urun.id);
ok('Olmasi gereken DUZELTILMIS faturadan (100)', satir.expected_qty === 100, String(satir.expected_qty));
ok('Donem satisi dogru (10)', satir.sold_qty === 10, String(satir.sold_qty));
ok('Stok 90', (await stok()) === 90, String(await stok()));

console.log('\n7) Islem denetim izinde');
const izl = (await call('GET', '/api/audit?entity=counts&limit=40')).data.items || [];
const kayit = izl.find((x) => x.action === 'REOPEN_COUNT'
  && JSON.stringify(x.detail || '').includes('kesinlestirme-geri-alindi'));
ok('Geri alma denetim izinde', Boolean(kayit), JSON.stringify(izl.slice(0, 2)).slice(0, 160));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Kesinlestirme geri alinip yanlis fatura duzeltilebiliyor.\n');
