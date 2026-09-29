/**
 * Arayuz regresyon testi: AYNI SATICI KODU IKI AYRI URUNDE.
 *
 * Sahadan gelen fatura (OZG2026000000132): toptanci ayni faturada
 * "ÇİKOLATALI SÜT" ve "ÇİLEKLİ SÜT" kalemlerinin IKISINE DE satici kodu
 * olarak "15" yazmisti. Eslestirme ogrenilirken kodla bulunan satirin ADI
 * digerinin uzerine yazilmaya calisiliyor, benzersiz indeks patliyor ve
 * SUNUCU HATASI donuyordu: kullanici faturayi HIC kaydedemiyordu.
 *
 * Kontrol edilen zincir:
 *   Kalemler ayri urunlere baglanir -> belge KAYDEDILIR (500 yok) ->
 *   belirsiz kod hicbir eslestirmede tutulmaz -> adlar dogru urunde kalir
 *   -> sonraki faturada kalemler yine dogru urune gider.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/tekrar-eden-satici-kodu.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const VKN = String(Date.now()).slice(-10);
const AD_A = `ÇİKOLATALI SÜT ${RUN}`;
const AD_B = `ÇİLEKLİ SÜT ${RUN}`;
const URUN_A = `Kod Testi Çikolatalı ${RUN}`;
const URUN_B = `Kod Testi Çilekli ${RUN}`;

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

const apiCall = (method, p, body) => page.evaluate(async ([m, pp, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(pp, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, p, body]);

/** Iki kalemi de AYNI satici koduyla tasiyan UBL fatura. */
function xmlYaz(dosya, { belgeNo, ettn, kod }) {
  const kalem = (no, ad) => `
  <cac:InvoiceLine>
    <cbc:ID>${no}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">5.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">500.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">5.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">500.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">5.00</cbc:TaxAmount>
        <cbc:Percent>1</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${ad}</cbc:Name>
      <cac:SellersItemIdentification><cbc:ID>${kod}</cbc:ID></cac:SellersItemIdentification>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">100.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`;
  fs.writeFileSync(dosya, `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UUID>${ettn}</cbc:UUID>
  <cbc:ID>${belgeNo}</cbc:ID>
  <cbc:IssueDate>2026-09-09</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">${VKN}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>Kod Karisik Toptanci ${RUN}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">10.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">1000.00</cbc:LineExtensionAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">1010.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="TRY">1010.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${kalem(1, AD_A)}${kalem(2, AD_B)}
</Invoice>`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantin-kod-'));
const XML1 = path.join(dir, 'kod1.xml');
const XML2 = path.join(dir, 'kod2.xml');
xmlYaz(XML1, { belgeNo: `KD1${RUN}`, ettn: `4444${RUN}-aaaa-bbbb-cccc-000000000001`, kod: '15' });
xmlYaz(XML2, { belgeNo: `KD2${RUN}`, ettn: `4444${RUN}-aaaa-bbbb-cccc-000000000002`, kod: '15' });

await apiCall('POST', '/api/suppliers', { name: `Kod Karisik Toptanci ${RUN}`, taxNo: VKN });
const pA = await apiCall('POST', '/api/products', { name: URUN_A, salePrice: 20, vatRate: 1, unit: 'ADET' });
const pB = await apiCall('POST', '/api/products', { name: URUN_B, salePrice: 20, vatRate: 1, unit: 'ADET' });
ok('Hazirlik: tedarikci ve iki urun', pA.status === 200 && pB.status === 200);

async function formAc(xmlYolu) {
  await page.goto(`${BASE}/#/purchases`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await page.click('button:has-text("+ Yeni Mal Girişi")');
  await page.waitForSelector('.modal-backdrop');
  await page.setInputFiles('.modal input[type=file][accept*="xml"]', xmlYolu);
  await page.waitForTimeout(1800);
}
async function satiraUrunSec(sira, urunAdi) {
  const tr = `.modal .line-table tbody tr:nth-child(${sira})`;
  await page.click(`${tr} .picker-input`);
  await page.fill(`${tr} .picker-input`, urunAdi);
  await page.waitForTimeout(400);
  await page.click(`${tr} .picker-list .picker-item:not(.picker-new)`);
  await page.waitForTimeout(300);
}
async function kaydet() {
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(2500);
  const hata = await page.$eval('.modal .alert-danger', (n) => (n.hidden ? '' : n.textContent)).catch(() => '');
  for (let i = 0; i < 4 && (await page.$$('.modal-backdrop')).length; i++) {
    await page.click('.modal-backdrop:last-of-type .modal-head .icon-btn').catch(() => {});
    await page.waitForTimeout(300);
  }
  return hata;
}

console.log('\n1) Iki kalem de "15" kodunu tasiyor: belge KAYDEDILMELI');
await formAc(XML1);
await satiraUrunSec(1, URUN_A);
await satiraUrunSec(2, URUN_B);
const hata1 = await kaydet();
ok('Sunucu hatasi YOK', !/Sunucu hatasi|sunucu hatası/i.test(hata1), hata1);

const belgeler = (await apiCall('GET', '/api/purchases?limit=50')).data.items || [];
ok('Belge kaydedildi', belgeler.some((x) => x.document_no === `KD1${RUN}`),
  JSON.stringify(belgeler.slice(0, 2)).slice(0, 200));

console.log('\n2) Belirsiz kod ogrenilmedi, adlar dogru urunde');
const tedarikciler = (await apiCall('GET', '/api/suppliers')).data.items || [];
const ted = tedarikciler.find((x) => x.tax_no === VKN);
const esl = (await apiCall('GET', `/api/products/aliases?supplierId=${ted.id}`)).data.items || [];
ok('"15" kodu hicbir kayitta tutulmuyor', !esl.some((a) => a.source_code === '15'),
  JSON.stringify(esl.map((a) => [a.source_name, a.source_code])));
const eA = esl.find((a) => a.source_name === AD_A);
const eB = esl.find((a) => a.source_name === AD_B);
ok('Cikolatali dogru urune bagli', eA && eA.product_id === pA.data.id, JSON.stringify(eA));
ok('Cilekli dogru urune bagli', eB && eB.product_id === pB.data.id, JSON.stringify(eB));

console.log('\n3) Ikinci fatura: kalemler yine DOGRU urune gidiyor');
await formAc(XML2);
const secimler = await page.$$eval('.modal .line-table tbody tr .picker-input', (ns) => ns.map((n) => n.value));
ok('1. satir Cikolatali', secimler[0] === URUN_A, JSON.stringify(secimler));
ok('2. satir Cilekli', secimler[1] === URUN_B, JSON.stringify(secimler));
const hata2 = await kaydet();
ok('Ikinci belge de kaydedildi', !/Sunucu hatasi|sunucu hatası/i.test(hata2), hata2);

console.log('\n4) Sunucu hatalari Sistem Durumu ekraninda gorunuyor');
await page.goto(`${BASE}/#/system`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2500);
const sistem = await page.textContent('#app');
ok('"Son Sunucu Hataları" karti var', /Son Sunucu Hataları/.test(sistem), sistem.slice(0, 200));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Tekrar eden satici kodu belgeyi dusurmuyor.\n');
