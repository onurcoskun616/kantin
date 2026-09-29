/**
 * Arayuz regresyon testi: LOGO/TIGER TRANSFER XML'I VE DOSYA TANIMA.
 *
 * Tedarikcilerin hepsi UBL gondermiyor. LOGO ailesi programlar (Tiger,
 * Go, j-Guar) faturayi kendi transfer biciminde verir:
 *
 *   <PURCHASE_INVOICES><INVOICE DBOP="INS"> ... <TRANSACTIONS>
 *
 * Icinde ayni bilgiler var; "UBL degil" deyip geri cevirmek kullaniciya
 * faturayi elle girdirmek demekti. Ustelik bu dosyalar iso-8859-9 kodlu
 * oldugu icin UTF-8 sayilirsa "LİEVİTO" bozuk karakterlere donusuyor,
 * urun adlari hicbir seye eslesmiyordu.
 *
 * Kontrol edilen zincir:
 *   LOGO dosyasi okunur -> tedarikci, belge no ve tarih dolar -> satirlar
 *   Turkce karakterleriyle gelir -> birimler cevrilir (C62=ADET, KGM=KG)
 *   -> toplam faturanin yazdigini tutar. Ayrica desteklenmeyen dosyalarda
 *   kullaniciya ELINDEKININ NE OLDUGU soylenir.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/logo-fatura.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const LOGO = new URL('../../docs/sablonlar/ornek-logo-fatura.xml', import.meta.url).pathname;

const b = await chromium.launch();
const page = await (await b.newContext({ viewport: { width: 1600, height: 1050 } })).newPage();
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantin-logo-'));

async function yukle(dosya) {
  await page.goto(`${BASE}/#/purchases`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await page.click('button:has-text("+ Yeni Mal Girişi")');
  await page.waitForSelector('.modal-backdrop');
  await page.setInputFiles('.modal input[type=file][accept*="xml"]', dosya);
  await page.waitForTimeout(1600);
  return (await page.textContent('.modal-body')).replace(/\s+/g, ' ');
}

console.log('\n1) LOGO transfer dosyasi okunuyor');
const ozet = await yukle(LOGO);
ok('Fatura okundu', /Fatura okundu: LGO2026000000001 · 2 kalem/.test(ozet), ozet.slice(0, 300));
ok('Tedarikci unvani ve VKN geldi',
  /YILDIZ GIDA DAĞITIM AYDIN GEÇİT/.test(ozet) && /19327941040/.test(ozet), ozet.slice(0, 300));
ok('Toplam faturanin yazdigini tutuyor',
  /₺1\.100,00 \+ KDV ₺11,00 = ₺1\.111,00/.test(ozet), ozet.slice(0, 300));

console.log('\n2) Turkce karakterler bozulmadi (iso-8859-9)');
const satirlar = await page.$$eval('.modal .line-table tbody tr',
  (ns) => ns.map((n) => n.querySelector('td:nth-child(1)').textContent.replace(/\s+/g, ' ')));
ok('LİEVİTO PİZZATOST dogru okundu', satirlar.some((t) => t.includes('LİEVİTO PİZZATOST')),
  JSON.stringify(satirlar));
ok('MEZİYET KASAP KÖFTE dogru okundu', satirlar.some((t) => t.includes('MEZİYET KASAP KÖFTE')),
  JSON.stringify(satirlar));
ok('Bozuk karakter yok', !satirlar.some((t) => /�/.test(t)), JSON.stringify(satirlar));

console.log('\n3) Birimler ve rakamlar dogru cevrildi');
ok('C62 -> ADET', satirlar.some((t) => /20 ADET × ₺32,00/.test(t)), JSON.stringify(satirlar));
ok('KGM -> KG', satirlar.some((t) => /2 KG × ₺230,00/.test(t)), JSON.stringify(satirlar));
const tarih = await page.inputValue('.modal input[type=date]');
ok('Belge tarihi 13.09.2026 -> 2026-09-13', tarih === '2026-09-13', tarih);
const belgeNo = await page.inputValue('.modal input[placeholder*="rsaliye"]');
ok('Belge no doldu', belgeNo === 'LGO2026000000001', belgeNo);

console.log('\n4) Desteklenmeyen dosyada NE OLDUGU soyleniyor');
const irsaliye = path.join(dir, 'irsaliye.xml');
fs.writeFileSync(irsaliye, `<?xml version="1.0" encoding="UTF-8"?>
<DespatchAdvice xmlns="urn:oasis:names:specification:ubl:schema:xsd:DespatchAdvice-2"
                xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:ID>IRS001</cbc:ID>
</DespatchAdvice>`);
const m1 = await yukle(irsaliye);
ok('Kok etiket soyleniyor', /kök etiketi "DespatchAdvice"/.test(m1), m1.slice(0, 300));
ok('e-Irsaliye oldugu anlatiliyor', /e-İrsaliye/.test(m1), m1.slice(0, 300));

const duzMetin = path.join(dir, 'liste.xml');
fs.writeFileSync(duzMetin, 'EFA2026000000393_YILDIZ GIDA DAĞITIM AYDIN GEÇİT.xml\n');
const m2 = await yukle(duzMetin);
ok('Duz metin dosyasi taniniyor', /XML değil; içeriği düz metin/.test(m2), m2.slice(0, 300));

const zip = path.join(dir, 'arsiv.xml');
fs.writeFileSync(zip, Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(80, 7)]));
const m3 = await yukle(zip);
ok('ZIP dosyasi taniniyor', /ZIP arşivi/.test(m3), m3.slice(0, 300));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ LOGO transfer dosyasi okunuyor, taninmayan dosya aciklaniyor.\n');
