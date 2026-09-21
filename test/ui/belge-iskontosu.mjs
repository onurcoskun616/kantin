/**
 * Arayuz regresyon testi: BELGE GENELI iskonto.
 *
 * Satir iskontosu (cac:AllowanceCharge / InvoiceLine) zaten satir fiyatina
 * yansir. Belge geneli iskonto (LegalMonetaryTotal/AllowanceTotalAmount)
 * ise yansimaz: yalnizca odenecek tutari dusurur. Okunmazsa stok maliyeti
 * GERCEKTEN ODENENDEN YUKSEK kaydedilir ve kar olduğundan dusuk gorunur.
 *
 * Kontrol edilen zincir:
 *   Iskontolu XML aktarilir -> iskonto satirlara orantili dagitilir ->
 *   kullaniciya ne yapildigi soylenir -> belge toplami faturanin odenecek
 *   tutarina esit cikar -> stok maliyeti dusen fiyatla olusur.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/belge-iskontosu.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const DOC_NO = `ISK${RUN}`;
const SAMPLE = new URL('../../docs/sablonlar/ornek-efatura-iskontolu.xml', import.meta.url).pathname;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantin-isk-'));
const XML = path.join(dir, 'fatura.xml');
fs.writeFileSync(XML, fs.readFileSync(SAMPLE, 'utf8')
  .replace('<cbc:ID>GIB2026000000900</cbc:ID>', `<cbc:ID>${DOC_NO}</cbc:ID>`)
  .replace('9a25f56a-dffb-4e3a-8b2c-1d4e3f6a7c02', `9a25f56a-dffb-4e3a-8b2c-${RUN.toLowerCase().padEnd(12, '0')}`));

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

await page.evaluate(async (vkn) => {
  const t = localStorage.getItem('kantin_token');
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` };
  const list = (await (await fetch('/api/suppliers', { headers: h })).json()).items;
  if (list.some((x) => String(x.tax_no || '').trim() === vkn)) return;
  const s = list[0];
  await fetch(`/api/suppliers/${s.id}`, {
    method: 'PUT', headers: h,
    body: JSON.stringify({ name: s.name, taxNo: vkn, taxOffice: 'Beşiktaş', phone: s.phone }),
  });
}, '1234567890');

console.log('\n1) Belge geneli iskonto satirlara dagitilir');
await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(2000);
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');
await page.setInputFiles('.modal input[type=file][accept*="xml"]', XML);
await page.waitForTimeout(1600);

const metin = await page.textContent('.modal-body');
ok('Belge iskontosu bildirildi', /belge geneli iskonto var/.test(metin), metin.slice(0, 400));
ok('Ne yapildigi anlatildi', /orantılı dağıtıldı/.test(metin), metin.slice(0, 400));
ok('Yanlis KDV uyarisi CIKMADI', !/faturanın yazdığı KDV'den/.test(metin), metin.slice(0, 400));

// Satirlardaki iskonto sutunu: 1. satir iskontosuz (0 -> %10), 2. satir %10 -> %19
const isk = await page.$$eval('.modal .line-table tbody tr td:nth-child(4) input', (ns) => ns.map((n) => Number(n.value)));
ok('1. satira %10 belge iskontosu islendi', Math.abs(isk[0] - 10) < 0.01, JSON.stringify(isk));
ok('2. satirda satir+belge iskontosu birlesti (%19)', Math.abs(isk[1] - 19) < 0.01, JSON.stringify(isk));

// Genel toplam faturanin odenecek tutarina esit olmali.
// 3. satir (Kagit Havlu) sistemde yok; onu silince kalan iki satirin toplami:
//   918.00 + 9.18 + 648.00 + 64.80 = 1639.98
await page.click('.modal .line-table tbody tr:nth-child(3) .icon-btn');
await page.waitForTimeout(400);
const toplam = await page.textContent('.modal .row:last-of-type, .modal-body');
ok('Genel toplam iskontolu hesaplandi', /1\.639,98/.test(toplam), toplam.slice(-400));

console.log('\n2) Kaydedilen belge gercekten odenen tutari tasir');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2500);
const created = await page.evaluate(async (no) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch('/api/purchases?from=2000-01-01&to=2099-12-31', { headers: { Authorization: `Bearer ${t}` } });
  return (await r.json()).items.find((p) => p.document_no === no) || null;
}, DOC_NO);
ok('Belge kaydedildi', !!created);
ok('Net toplam 1.566,00 (iskonto dusulmus)', created && Math.abs(created.net_total - 1566) < 0.02, String(created?.net_total));
ok('KDV 73,98', created && Math.abs(created.vat_total - 73.98) < 0.02, String(created?.vat_total));

// Stok maliyeti de dusen fiyattan olusmali: Ayran 8,50 -> 7,65
const detay = await page.evaluate(async (id) => {
  const t = localStorage.getItem('kantin_token');
  return (await fetch(`/api/purchases/${id}`, { headers: { Authorization: `Bearer ${t}` } })).json();
}, created.id);
const ayran = detay.lines.find((l) => /Ayran/.test(l.product_name));
ok('Satir birim fiyati faturadaki HAM fiyat', Math.abs(ayran.unit_price - 8.5) < 0.01, String(ayran?.unit_price));
ok('Iskonto satira yazildi (%10)', Math.abs(ayran.discount_pct - 10) < 0.01, String(ayran?.discount_pct));
ok('Satir neti iskontolu (918,00)', Math.abs(ayran.net_total - 918) < 0.02, String(ayran?.net_total));

await b.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
