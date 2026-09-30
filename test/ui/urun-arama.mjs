/**
 * Arayuz regresyon testi: URUN ARAMA KUTUSU.
 *
 * Iki ayri hata birlestiginde kutu "hic calismiyor" gibi gorunuyordu:
 *
 *  1. ODAK KAYBI. Filtre cubugu her cizimde yeniden kuruluyordu; arama
 *     sonucu gelince kutu DOM'dan silinip yerine yenisi konuyor ve odak
 *     gidiyordu. Kullanici birkac harf yaziyor, kutu oluyor, sonra
 *     yazdigi hicbir sey islenmiyordu.
 *  2. TURKCE HARFLER. SQLite'in LIKE'i yalnizca ASCII'de buyuk/kucuk
 *     harf ayrimini yok sayar: "çikolatalı" yazan "Çikolatalı Süt"
 *     urununu BULAMIYORDU; ancak harfi harfine ayni yazim calisiyordu.
 *
 * Ayrica fiyat uyarilari listesi suzulmuyordu: bir urun arayan kullanici
 * ekranin tamamini baska urunlerin uyarilariyla dolu goruyordu.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/urun-arama.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const URUN = `Çikolatalı Süt Arama ${RUN}`;
const SU = `GÜZELPINAR 0.5 CC PET SU ${RUN}`;

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));

const problems = [];
const ok = (l, c, d = '') => {
  if (c) console.log(`  ✓ ${l}`);
  else { console.log(`  ✗ ${l}${d ? ' — ' + String(d).slice(0, 200) : ''}`); problems.push(l); }
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

await apiCall('POST', '/api/products', { name: URUN, salePrice: 20, vatRate: 1, unit: 'ADET' });
await apiCall('POST', '/api/products', { name: SU, salePrice: 10, vatRate: 1, unit: 'ADET' });

const git = async (yol) => {
  await page.goto(`${BASE}/#${yol}`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);
};
const durum = () => page.evaluate(() => ({
  odak: document.activeElement?.className || document.activeElement?.tagName,
  deger: document.querySelector('.search-input')?.value,
  satirlar: [...document.querySelectorAll('.card:last-of-type table tbody tr')].length,
}));

console.log('\n1) Yazarken ODAK kutuda kalir');
await git('/products');
await page.click('.search-input');
await page.keyboard.type('Çikolatalı');
await page.waitForTimeout(800);          // debounce + cizim
let d = await durum();
ok('Arama sonrasi odak hala kutuda', /search-input/.test(d.odak), JSON.stringify(d));

console.log('\n2) Yazmaya DEVAM edilebiliyor');
await page.keyboard.type(' Süt');
await page.waitForTimeout(800);
d = await durum();
ok('Sonraki harfler kutuya islendi', d.deger === 'Çikolatalı Süt', JSON.stringify(d));
ok('Odak yine kutuda', /search-input/.test(d.odak), JSON.stringify(d));

console.log('\n3) Silip yeniden aramak calisiyor');
await page.fill('.search-input', '');
await page.click('.search-input');
await page.keyboard.type('güzelpinar');
await page.waitForTimeout(900);
let metin = await page.textContent('#app');
ok('KUCUK harfle Turkce arama buldu', metin.includes(SU), 'aranan: güzelpinar');

console.log('\n4) Turkce harf ve buyuk/kucuk farki aramayi bozmuyor');
for (const q of ['cikolatali', 'ÇİKOLATALI', 'Çikolatali', 'çikolatalı']) {
  await page.fill('.search-input', '');
  await page.click('.search-input');
  await page.keyboard.type(q);
  await page.waitForTimeout(900);
  metin = await page.textContent('#app');
  ok(`"${q}" aramasi urunu buldu`, metin.includes(URUN));
}

console.log('\n5) Sonuc yoksa ne arandigi yaziliyor');
await page.fill('.search-input', '');
await page.click('.search-input');
await page.keyboard.type('zzzyokboyleurun');
await page.waitForTimeout(900);
metin = await page.textContent('#app');
ok('Bulunamadi mesaji arama terimini iceriyor',
  /"zzzyokboyleurun" için ürün bulunamadı/.test(metin), metin.slice(0, 200));

console.log('\n6) Fiyat uyarilari listesi de suzuluyor');
await page.fill('.search-input', '');
await page.click('.search-input');
await page.keyboard.type(SU);
await page.waitForTimeout(900);
const uyariMetni = await page.$eval('#app', (n) => n.textContent.replace(/\s+/g, ' '));
const baskaUrun = /0,7 KALEM|BISCOLATA/.test(uyariMetni);
ok('Aramayla ilgisiz uyarilar gosterilmiyor', !baskaUrun, uyariMetni.slice(0, 200));

console.log('\n7) Stok Durumu ekraninda da ayni');
await git('/stock');
await page.click('.search-input');
await page.keyboard.type('çikolatalı');
await page.waitForTimeout(800);
d = await durum();
ok('Stok ekraninda odak korunuyor', /search-input/.test(d.odak), JSON.stringify(d));
await page.keyboard.type(' süt');
await page.waitForTimeout(900);
d = await durum();
ok('Stok ekraninda yazmaya devam edilebiliyor', d.deger === 'çikolatalı süt', JSON.stringify(d));
metin = await page.textContent('#app');
ok('Stok ekraninda Turkce arama buluyor', metin.includes(URUN), metin.slice(0, 200));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Arama kutusu odagi koruyor ve Turkce harflerde de buluyor.\n');
