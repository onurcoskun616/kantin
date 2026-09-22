/**
 * Arayuz regresyon testi: MAL GIRISI SATIRLARINDA KUTU GENISLIGI.
 *
 * Fatura satirinda urun, miktar, birim fiyat, iskonto, KDV, SKT ve tutar
 * YAN YANA durur. Girdilere alt sinir genislik verilmezse her kutu kendi
 * sutunu kadar daralir; urun sutunu genis oldugu icin miktar/iskonto/KDV
 * kutulari iki-uc karakter gosterecek hale geliyordu. Kullanici "454,57"
 * yazdiginda rakamin yarisini goremiyordu ve yanlis rakami fark etmeden
 * kaydedebiliyordu.
 *
 * Kontrol edilen zincir:
 *   Mal Girisi acilir -> pencere genis acilir -> satirdaki sayi kutulari
 *   uzun bir deger yazildiginda TASMADAN okunur -> tablo yatay kaymaz.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/girdi-genisligi.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1500, height: 1050 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
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

console.log('\n1) Mal Girisi penceresi genis acilir');
await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(2000);
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(400);

const pencere = await page.$eval('.modal', (n) => n.getBoundingClientRect().width);
ok('Pencere 900px dar kalibindan genis', pencere > 1000, `genislik=${Math.round(pencere)}`);

console.log('\n2) Sayi kutulari uzun degeri tasirmadan gosterir');
// Gercek hayattaki en uzun degerler: binlik ayracli miktar ve kurusu olan
// fiyat. Bunlar sigmiyorsa kullanici yazdigini dogrulayamaz.
const hucreler = [
  { ad: 'Miktar', sutun: 2, deger: '1234.56' },
  { ad: 'Birim Fiyat', sutun: 3, deger: '1234.56' },
  { ad: 'İskonto', sutun: 4, deger: '12.75' },
  { ad: 'KDV', sutun: 5, deger: '20' },
];
for (const h of hucreler) {
  const sec = `.modal .line-table tbody tr:first-child td:nth-child(${h.sutun}) input`;
  await page.fill(sec, h.deger);
  const o = await page.$eval(sec, (n) => ({
    goruntu: n.clientWidth, icerik: n.scrollWidth,
  }));
  ok(`${h.ad} kutusu "${h.deger}" degerini tam gosteriyor`,
    o.icerik <= o.goruntu + 1 && o.goruntu >= 80,
    `goruntu=${o.goruntu} icerik=${o.icerik}`);
}

console.log('\n3) Basliklar iki satira dusmuyor');
const basliklar = await page.$$eval('.modal .line-table thead th', (ns) => ns.map((n) => ({
  metin: n.textContent.trim(),
  satir: Math.round(n.getBoundingClientRect().height),
})));
const yuksek = basliklar.filter((x) => x.satir > 44);
ok('Tum sutun basliklari tek satir', yuksek.length === 0, JSON.stringify(yuksek));

console.log('\n4) Tablo yatay kaymiyor');
const kayma = await page.$eval('.modal .table-wrap', (n) => ({
  goruntu: n.clientWidth, icerik: n.scrollWidth,
}));
ok('Satir tablosu pencereye sigiyor', kayma.icerik <= kayma.goruntu + 1,
  `goruntu=${kayma.goruntu} icerik=${kayma.icerik}`);

console.log('\n5) Artan-azalan oklari rakami ortmuyor');
const ok_gizli = await page.$eval('.modal .line-table tbody tr:first-child td:nth-child(2) input',
  (n) => getComputedStyle(n).getPropertyValue('-moz-appearance') === 'textfield'
    || getComputedStyle(n).appearance === 'textfield');
ok('Sayi oklari gizli', ok_gizli);

console.log('\n6) Acik urun listesi kendi kutusunu ortmuyor');
// Liste `position:fixed` ile konumlanir. Satir eklendiginde ya da fatura
// yuklendiginde girdi yer degistirdiginde liste yerinde kalirsa KUTUNUN
// USTUNE biner ve kullanici kutuya tiklayamaz olur (bkz. urun-secici.js).
await page.click('.modal .line-table tbody tr:first-child .picker-input');
await page.waitForTimeout(400);
const ortusme = await page.evaluate(() => {
  const i = document.querySelector('.modal .line-table tbody tr:first-child .picker-input');
  const l = document.querySelector('.picker-list.floating');
  if (!l || l.hidden) return { acik: false };
  const a = i.getBoundingClientRect();
  const c = l.getBoundingClientRect();
  return { acik: true, ortuyor: !(c.top >= a.bottom - 1 || c.bottom <= a.top + 1) };
});
ok('Liste acildi', ortusme.acik);
ok('Liste girdinin uzerine binmiyor', ortusme.acik && !ortusme.ortuyor, JSON.stringify(ortusme));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Mal girisi satir kutulari okunabilir.\n');
