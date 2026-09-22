/**
 * Arayuz regresyon testi: FATURADAN BARKOD OKUMA.
 *
 * Gercek bir e-faturada GTIN cogu zaman StandardItemIdentification'da DEGIL,
 * ManufacturersItemIdentification altinda gelir; SellersItemIdentification'a
 * da tedarikcinin KENDI ic stok kodu yazilir ("130302" gibi).
 *
 * Kontrol edilen zincir:
 *   Miktar faturadan okunuyor -> gercek barkod (uretici alanindaki GTIN)
 *   urun kartina yaziliyor -> tedarikcinin ic kodu barkod alanina
 *   YAZILMIYOR (barkod tekildir; baska tedarikcinin ayni kisa kodu ikinci
 *   urunu hic acilamaz hale getirirdi) ama eslestirmeye ogretiliyor.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/fatura-barkod.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const SAMPLE = new URL('../../docs/sablonlar/ornek-efatura-uretici-kodu.xml', import.meta.url).pathname;

const RUN = Date.now().toString(36).slice(-6).toUpperCase();

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

const apiCall = (method, path, body) => page.evaluate(async ([m, p, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(p, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, path, body]);

console.log('\n1) Cozumleyici: miktar, barkod ve tedarikci kodu ayri ayri');
const cozum = await page.evaluate(async (xml) => {
  const m = await import('/js/efatura.js');
  return m.parseEFatura(xml).lines.map((l) => ({
    name: l.name, quantity: l.quantity, barcode: l.barcode,
    supplierCode: l.supplierCode, codes: l.codes,
  }));
}, fs.readFileSync(SAMPLE, 'utf8'));

ok('Satir sayisi 2', cozum.length === 2, JSON.stringify(cozum).slice(0, 200));
ok('Miktar faturadan okundu (100)', cozum[0].quantity === 100, String(cozum[0]?.quantity));
ok('URETICI alanindaki GTIN barkod olarak alindi',
  cozum[0].barcode === '8697462736435', String(cozum[0]?.barcode));
ok('Tedarikci ic kodu ayri tutuldu', cozum[0].supplierCode === '130302', String(cozum[0]?.supplierCode));
ok('Iki kod da eslestirmeye aday', cozum[0].codes.length === 2, JSON.stringify(cozum[0]?.codes));
ok('GTIN olmayan satirda barkod BOS', cozum[1].barcode === null, String(cozum[1]?.barcode));
ok('O satirda tedarikci kodu yine var', cozum[1].supplierCode === 'A-77', String(cozum[1]?.supplierCode));

console.log('\n2) XML formdan yuklenince miktarlar tabloya geliyor');
await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(2200);
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(600);
await page.setInputFiles('.modal input[type=file]', SAMPLE);
await page.waitForTimeout(2500);

const miktarlar = await page.$$eval('.modal tbody tr input.num',
  (ns) => ns.map((n) => n.value).filter((v) => v !== ''));
ok('Tabloda 100 miktari var', miktarlar.includes('100'), JSON.stringify(miktarlar).slice(0, 200));
ok('Tabloda 50 miktari var', miktarlar.includes('50'), JSON.stringify(miktarlar).slice(0, 200));

console.log('\n3) Yeni urun tanimlama formunda barkod DOGRU geliyor');
// Ilk satir (uretici kodlu ayran) sistemde yok; secicinin sonundaki
// "yeni urun tanimla" ile kart acilir ve barkodun ne onerildigine bakilir.
const tr1 = '.modal .line-table tbody tr:nth-child(1)';
await page.click(`${tr1} .picker-input`);
await page.waitForTimeout(500);
await page.click(`${tr1} .picker-list .picker-new`);
await page.waitForTimeout(900);
const barkod = await page.$eval('.modal-backdrop:last-of-type input[name=barcode]', (n) => n.value)
  .catch(() => null);
ok('Urun kartina GERCEK barkod onerildi', barkod === '8697462736435', String(barkod));
const ipucu = await page.textContent('.modal-backdrop:last-of-type .modal-body').catch(() => '');
ok('Tedarikci ic kodu barkod olarak ONERILMEDI', barkod !== '130302', String(barkod));

// Ikinci satir: GTIN yok -> barkod bos ve NEDEN bos oldugu yaziyor
await page.click('.modal-backdrop:last-of-type .modal-head .icon-btn').catch(() => {});
await page.waitForTimeout(500);
const tr2 = '.modal .line-table tbody tr:nth-child(2)';
await page.click(`${tr2} .picker-input`);
await page.waitForTimeout(500);
await page.click(`${tr2} .picker-list .picker-new`);
await page.waitForTimeout(900);
const barkod2 = await page.$eval('.modal-backdrop:last-of-type input[name=barcode]', (n) => n.value)
  .catch(() => null);
ok('GTIN yokken barkod BOS birakildi', barkod2 === '', String(barkod2));
const ipucu2 = await page.textContent('.modal-backdrop:last-of-type .modal-body').catch(() => '');
ok('Neden bos oldugu aciklaniyor',
  /tedarikçinin kendi stok kodudur/.test(ipucu2), ipucu2.slice(0, 300));
void ipucu;

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
