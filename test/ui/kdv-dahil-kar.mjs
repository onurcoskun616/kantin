/**
 * Arayuz regresyon testi: KDV DAHIL KAR HESABI.
 *
 * Alis KDV'si beyannamede indirilmiyor; yani maliyettir. Bu yuzden hem
 * alis hem satis KDV DAHIL tutulur ve kar ikisinin farkidir.
 *
 * EN SIK YAPILAN HATA: satisi netlestirip KDV DAHIL alisla karsilastirmak.
 * Bu, KDV'yi IKI KEZ aleyhe saymak olur (hem gelirden dusulur hem maliyete
 * eklenir) ve karli bir urun ZARARINA satiliyor gibi gorunur. Gercekte
 * yasandi: 400 TL alis / 500 TL satis (%1 KDV) "95,05 kar" diye gosterildi;
 * dogrusu 100 TL'dir. %10 KDV'li 320/350 ise "-1,82 ZARAR" gorundu.
 *
 * Bu test hesabin uc yerde de ayni oldugunu dogrular: urun listesi,
 * Excel/CSV aktarim onizlemesi ve recete ekrani.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/index.js &
 *   node test/ui/kdv-dahil-kar.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-6).toUpperCase();

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
const EXPECTED = /Failed to load resource.*\b(400|403|409)\b|TypeError: Failed to fetch|\[YAVAS\]/;
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

const apiCall = (method, p, body) => page.evaluate(async ([m, pp, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(pp, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, p, body]);

console.log('\n1) Excel/CSV aktarim ONIZLEMESI');
// Gercekte yasanan satirlar: %1 ve %10 KDV, biri dusuk marjli
const csv = [
  'Barkod;Ürün Adı;Kategori;Birim;Alış Fiyatı (KDV dahil);Satış Fiyatı (KDV dahil);KDV Oranı',
  `;KDV Test Çikolatalı Süt ${RUN};;PAKET;400;500;1`,
  `;KDV Test Capri ${RUN};;PAKET;320;350;10`,
].join('\n');
const csvYol = path.join(os.tmpdir(), `kdv-test-${RUN}.csv`);
fs.writeFileSync(csvYol, '﻿' + csv, 'utf8');

await page.evaluate(() => { location.hash = '#/products'; });
await page.waitForTimeout(2200);
await page.click("button:has-text(\"Excel'den Aktar\")");
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(600);
await page.setInputFiles('.modal input[type=file]', csvYol);
await page.waitForTimeout(2000);

const onizleme = await page.textContent('.modal-body');
ok('Iki urun okundu', /2 ürün okundu/.test(onizleme), onizleme.slice(0, 300));
// 500 - 400 = 100 (95,05 DEGIL: o, satisin netlestirilmis hali demektir)
ok('%1 KDV: kar 100,00 (95,05 DEGIL)',
  /100,00/.test(onizleme) && !/95,05/.test(onizleme), onizleme.slice(0, 900));
// 350 - 320 = 30 (-1,82 DEGIL)
ok('%10 KDV: kar 30,00 (eksi DEGIL)',
  /30,00/.test(onizleme) && !/-₺1,82/.test(onizleme), onizleme.slice(0, 900));
ok('Yanlis "zararina satis" uyarisi YOK',
  !/Zararına satış uyarısı/.test(onizleme), onizleme.slice(0, 600));

await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2500);

console.log('\n2) Urun listesinde ayni hesap');
const liste = (await apiCall('GET', '/api/products')).data.items;
const cikolata = liste.find((p) => p.name.includes(`Çikolatalı Süt ${RUN}`));
ok('Urun aktarildi', !!cikolata, JSON.stringify(liste.slice(0, 2)).slice(0, 200));
if (cikolata) {
  ok('Birim kar 100', Math.abs(cikolata.profit.unitProfit - 100) < 0.01,
    String(cikolata.profit.unitProfit));
  ok('Marj %20 (kar / KDV DAHIL satis)', Math.abs(cikolata.profit.marginPct - 20) < 0.1,
    String(cikolata.profit.marginPct));
  ok('Alis KDV DAHIL okundu', Math.abs(cikolata.purchase_price - 400) < 0.01,
    String(cikolata.purchase_price));
}

console.log('\n3) Recete ekraninda ayni hesap');
// 1 adet uretilen urun = 1 adet hammadde; maliyet = hammadde fiyati
const ham = (await apiCall('POST', '/api/products', {
  name: `KDV Test Hammadde ${RUN}`, productType: 'HAMMADDE', unit: 'ADET',
  purchasePrice: 40, salePrice: 0, vatRate: 1,
})).data;
const uretilen = (await apiCall('POST', '/api/products', {
  name: `KDV Test Üretilen ${RUN}`, productType: 'URETILEN', unit: 'ADET',
  salePrice: 50, vatRate: 1,
})).data;
await apiCall('PUT', `/api/recipes/${uretilen.id}`, {
  yieldQuantity: 1, items: [{ ingredientId: ham.id, quantity: 1 }],
});

await page.goto(`${BASE}/#/recipes`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(2200);
await page.click(`tr:has-text("KDV Test Üretilen ${RUN}") button`);
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(1500);
const recete = await page.textContent('.modal-body');
// 50 - 40 = 10 (49,50 - 40 = 9,50 DEGIL)
ok('Recete birim kar 10,00 (9,50 DEGIL)',
  /10,00/.test(recete) && !/9,50/.test(recete), recete.slice(0, 500));
ok('Recete marji %20', /%20/.test(recete) || /20,0/.test(recete), recete.slice(0, 500));
ok('Zararina satis uyarisi YOK', !/Zararına satış/.test(recete), recete.slice(0, 400));

// Sunucu tarafi da ayni demeli
const receteApi = (await apiCall('GET', `/api/recipes/${uretilen.id}`)).data;
ok('Sunucu ayni kari veriyor', Math.abs(receteApi.profit.unitProfit - 10) < 0.01,
  String(receteApi.profit?.unitProfit));

fs.unlinkSync(csvYol);
await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
