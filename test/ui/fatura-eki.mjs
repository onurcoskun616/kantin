/**
 * Arayuz regresyon testi: e-Fatura XML aktarimi ve fatura eki.
 *
 * Kontrol edilen zincir:
 *   XML yukle -> baslik ve satirlar dolar -> eslesmeyen kalem isaretlenir ->
 *   urun secilmeden kaydedilemez -> kaydedilince XML belgeye eklenir ->
 *   ayni fatura ikinci kez aktarilamaz -> belgeye PDF fatura eklenir.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/fatura-eki.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const SAMPLE = new URL('../../docs/sablonlar/ornek-efatura.xml', import.meta.url).pathname;

// Ayni veritabaninda tekrar calistirilabilmesi icin her kosuda belge no ve
// ETTN benzersiz yapilir: sistem ayni faturayi iki kez kabul etmedigi icin
// sabit ornek dosya ikinci kosuda reddedilirdi.
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const DOC_NO = `GIB${RUN}`;
const XML_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kantin-efatura-')), 'fatura.xml');
fs.writeFileSync(XML_PATH, fs.readFileSync(SAMPLE, 'utf8')
  .replace('<cbc:ID>GIB2026000000123</cbc:ID>', `<cbc:ID>${DOC_NO}</cbc:ID>`)
  .replace('8f14e45f-ceea-4d29-9a1b-7c3d2e5a9b01', `8f14e45f-ceea-4d29-9a1b-${RUN.toLowerCase().padEnd(12, '0')}`));
const b=await chromium.launch(); const ctx=await b.newContext({viewport:{width:1500,height:1050}});
const page=await ctx.newPage();
page.on('pageerror',e=>console.log('PAGEERROR '+e.message));
// Test bilerek reddedilen istekler yapiyor (409); bunlar hata sayilmaz
const EXPECTED = /Failed to load resource.*\b409\b|TypeError: Failed to fetch/;
page.on('console', (m) => { if (m.type() === 'error' && !EXPECTED.test(m.text())) console.log('CONSOLE ' + m.text().slice(0, 160)); });
const problems = [];
const ok = (l, c, d = '') => {
  if (c) console.log(`  ✓ ${l}`);
  else { console.log(`  ✗ ${l}${d ? ' — ' + String(d).slice(0, 220) : ''}`); problems.push(l); }
};

await page.goto(BASE,{waitUntil:'networkidle'});
await page.fill('input[name=email]','admin@topkapiokullari.com');
await page.fill('input[name=password]','Kantin2026!');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])');
await page.waitForTimeout(1500);

// Tedarikciye VKN yaz ki e-fatura eslessin
const supplierId = await page.evaluate(async()=>{
  const t=localStorage.getItem('kantin_token');
  const r=await fetch('/api/suppliers',{headers:{Authorization:`Bearer ${t}`}});
  const s=(await r.json()).items[0];
  await fetch(`/api/suppliers/${s.id}`,{method:'PUT',
    headers:{'Content-Type':'application/json',Authorization:`Bearer ${t}`},
    body:JSON.stringify({name:s.name, taxNo:'1234567890', taxOffice:'Beşiktaş', phone:s.phone})});
  return s.id;
});
ok('Tedarikciye VKN yazildi', !!supplierId);

await page.evaluate(()=>{location.hash='#/purchases';});
await page.waitForTimeout(2000);
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');

console.log('\n1) e-Fatura XML aktarimi');
await page.setInputFiles('.modal input[type=file][accept*="xml"]', XML_PATH);
await page.waitForTimeout(1500);

const importText = await page.textContent('.modal-body');
ok('Fatura okundu bildirimi', importText.includes('Fatura okundu'), importText.slice(0,150));
ok('Belge no dolduruldu', (await page.inputValue('.modal input[placeholder*="rsaliye"]'))===DOC_NO);
ok('Belge tarihi dolduruldu', (await page.inputValue('.modal input[type=date]'))==='2026-09-15');
ok('Eslesmeyen kalem uyarisi var', importText.includes('eşleşmedi'), '');
ok('Kagit Havlu eslesmeyen olarak listelendi', importText.includes('Kağıt Havlu'));

const rows = await page.$$eval('.modal .line-table tbody tr', ns=>ns.length);
ok('3 satir olusturuldu', rows===3, String(rows));
const selects = await page.$$eval('.modal .line-table tbody tr select', ns=>ns.map(n=>({v:n.value, warn:n.classList.contains('needs-pick')})));
ok('Iki satir urunle esleşti', selects.filter(s=>s.v).length===2, JSON.stringify(selects));
ok('Eslesmeyen satir kirmizi isaretli', selects.filter(s=>s.warn).length===1, JSON.stringify(selects));

const qtys = await page.$$eval('.modal .line-table tbody tr td:nth-child(2) input', ns=>ns.map(n=>n.value));
const prices = await page.$$eval('.modal .line-table tbody tr td:nth-child(3) input', ns=>ns.map(n=>n.value));
const discs = await page.$$eval('.modal .line-table tbody tr td:nth-child(4) input', ns=>ns.map(n=>n.value));
const vats = await page.$$eval('.modal .line-table tbody tr td:nth-child(5) input', ns=>ns.map(n=>n.value));
ok('Miktarlar dogru', JSON.stringify(qtys)===JSON.stringify(['120','200','50']), JSON.stringify(qtys));
ok('Birim fiyatlar dogru (KDV haric)', JSON.stringify(prices)===JSON.stringify(['8.5','4','30']), JSON.stringify(prices));
ok('Iskonto %10 aktarildi', discs[1]==='10', JSON.stringify(discs));
ok('KDV oranlari satir bazinda', JSON.stringify(vats)===JSON.stringify(['1','10','10']), JSON.stringify(vats));

console.log('\n2) Urun secilmeden kaydedilemez');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(1200);
const err = await page.textContent('.modal .alert-danger').catch(()=>'');
ok('Eksik urun uyarisi verildi', /ürün seçilmemiş/.test(err), err.slice(0,120));

console.log('\n3) Eslesmeyen satir silinip kaydedilir');
await page.click('.modal .line-table tbody tr:nth-child(3) .icon-btn');
await page.waitForTimeout(400);
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2500);
const purchases = await page.evaluate(async()=>{const t=localStorage.getItem('kantin_token');
  const r=await fetch('/api/purchases',{headers:{Authorization:`Bearer ${t}`}}); return (await r.json()).items;});
const created = purchases.find(p=>p.document_no===DOC_NO);
ok('Belge kaydedildi', !!created, JSON.stringify(purchases.slice(0,1)));
ok('Net toplam dogru (1020 + 720)', created && Math.abs(created.net_total-1740)<0.01, String(created?.net_total));
ok('KDV dogru (10,20 + 72)', created && Math.abs(created.vat_total-82.2)<0.01, String(created?.vat_total));
ok('XML belgeye otomatik eklendi', created?.attachment_count===1, String(created?.attachment_count));

console.log('\n4) Ayni fatura ikinci kez aktarilamaz');
await page.evaluate(()=>{location.hash='#/purchases';}); await page.waitForTimeout(1500);
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');
await page.setInputFiles('.modal input[type=file][accept*="xml"]', XML_PATH);
await page.waitForTimeout(1500);
await page.click('.modal .line-table tbody tr:nth-child(3) .icon-btn');
await page.waitForTimeout(300);
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2000);
const dupErr = await page.textContent('.modal .alert-danger').catch(()=>'');
ok('Mukerrer e-Fatura reddedildi', /zaten sisteme aktarilmis/i.test(dupErr), dupErr.slice(0,140));
await page.click('.modal-head .icon-btn');
await page.waitForTimeout(500);

console.log('\n5) Belge detayinda fatura dosyalari');
await page.evaluate(()=>{location.hash='#/purchases';}); await page.waitForTimeout(1800);
await page.click(`tr:has-text("${DOC_NO}") button:has-text("Detay")`);
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(800);
const detail = await page.textContent('.modal-body');
ok('Fatura Dosyalari bolumu var', detail.includes('Fatura Dosyaları'));
ok('XML eki listelendi', detail.includes('e-Fatura XML'), detail.slice(0,200));
ok('SHA-256 ozeti gosteriliyor', !!(await page.$('.modal-body code')));

await page.setInputFiles('.modal input[type=file][accept*="pdf"]', {
  name:'tedarikci-faturasi.pdf', mimeType:'application/pdf',
  buffer: Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('ornek fatura ciktisi')]),
});
await page.waitForTimeout(2000);
const afterUpload = await page.textContent('.modal-body');
ok('PDF fatura eklendi', afterUpload.includes('tedarikci-faturasi.pdf'), afterUpload.slice(0,200));
await b.close();
fs.rmSync(path.dirname(XML_PATH), { recursive: true, force: true });

console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
