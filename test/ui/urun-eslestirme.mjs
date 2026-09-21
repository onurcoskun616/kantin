/**
 * Arayuz regresyon testi: tedarikci urun eslestirmelerinin OGRENILMESI.
 *
 * Muhasebenin isaret ettigi sorun: ayni urun her faturada ayni adla gelmez.
 * Bir tedarikci "KUTU AYRAN 200ML", oteki "AYRAN PK" yazar. Her faturada
 * elle eslestirmek hem zaman kaybi hem hata kaynagi (ayni urun iki karta
 * bolunur, stok anlamsizlasir).
 *
 * Kontrol edilen zincir:
 *   1. fatura: kalem eslesmiyor -> kullanici elle seciyor -> kaydediyor
 *   2. fatura (AYNI tedarikci, AYNI ad): kendiliginden esleiyor
 *   3. BASKA tedarikci ayni urune baska ad veriyor -> ayri ogrenilyor
 *   4. Eslestirme ekranindan duzeltilebiliyor ve silinebiliyor
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/urun-eslestirme.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const VKN_A = String(Date.now()).slice(-10);
const VKN_B = String(Date.now() + 7777).slice(-10);
const URUN = `Eşleştirme Ayranı ${RUN}`;
// Tedarikcilerin faturada kullandigi FARKLI adlar — is ayni urun
const AD_A = `KUTU AYRAN 200ML ${RUN}`;
const AD_B = `ayran  pk. ${RUN}`;

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

const apiCall = (method, p, body) => page.evaluate(async ([m, pp, bd]) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch(pp, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: bd ? JSON.stringify(bd) : undefined,
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, p, body]);

/** Verilen ad/VKN ile UBL fatura dosyasi uretir (tek kalem). */
function xmlYaz(dosya, { vkn, unvan, belgeNo, ettn, kalemAdi, kod }) {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
         xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
         xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UUID>${ettn}</cbc:UUID>
  <cbc:ID>${belgeNo}</cbc:ID>
  <cbc:IssueDate>2026-09-15</cbc:IssueDate>
  <cbc:DocumentCurrencyCode>TRY</cbc:DocumentCurrencyCode>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">${vkn}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${unvan}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">8.00</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">800.00</cbc:LineExtensionAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">808.00</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="TRY">808.00</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">100</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">800.00</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">8.00</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">800.00</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">8.00</cbc:TaxAmount>
        <cbc:Percent>1</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item>
      <cbc:Name>${kalemAdi}</cbc:Name>
      ${kod ? `<cac:SellersItemIdentification><cbc:ID>${kod}</cbc:ID></cac:SellersItemIdentification>` : ''}
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">8.00</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
  fs.writeFileSync(dosya, xml);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantin-alias-'));
const XML1 = path.join(dir, 'a1.xml');
const XML2 = path.join(dir, 'a2.xml');
const XML3 = path.join(dir, 'b1.xml');

// Hazirlik: iki tedarikci ve bir urun
await apiCall('POST', '/api/suppliers', { name: `Eşleştirme A ${RUN}`, taxNo: VKN_A });
await apiCall('POST', '/api/suppliers', { name: `Eşleştirme B ${RUN}`, taxNo: VKN_B });
const urun = await apiCall('POST', '/api/products', { name: URUN, salePrice: 15, vatRate: 1, unit: 'ADET' });
ok('Hazirlik: iki tedarikci ve bir urun', urun.status === 200, JSON.stringify(urun.data).slice(0, 120));

xmlYaz(XML1, { vkn: VKN_A, unvan: `Eşleştirme A ${RUN}`, belgeNo: `AL1${RUN}`, ettn: `1111${RUN}-aaaa-bbbb-cccc-000000000001`, kalemAdi: AD_A });
xmlYaz(XML2, { vkn: VKN_A, unvan: `Eşleştirme A ${RUN}`, belgeNo: `AL2${RUN}`, ettn: `1111${RUN}-aaaa-bbbb-cccc-000000000002`, kalemAdi: AD_A });
xmlYaz(XML3, { vkn: VKN_B, unvan: `Eşleştirme B ${RUN}`, belgeNo: `BL1${RUN}`, ettn: `2222${RUN}-aaaa-bbbb-cccc-000000000003`, kalemAdi: AD_B });

/** Formu acar, XML yukler, satiri (gerekiyorsa) elle esler, kaydeder. */
async function faturaGir(xmlYolu, { elleSec = false } = {}) {
  await page.goto(`${BASE}/#/purchases`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await page.click('button:has-text("+ Yeni Mal Girişi")');
  await page.waitForSelector('.modal-backdrop');
  await page.setInputFiles('.modal input[type=file][accept*="xml"]', xmlYolu);
  await page.waitForTimeout(1800);

  const secim = await page.$eval('.modal .line-table tbody tr:nth-child(1) .picker-input', (n) => n.value);
  const metin = await page.textContent('.modal-body');

  if (elleSec) {
    const tr = '.modal .line-table tbody tr:nth-child(1)';
    await page.click(`${tr} .picker-input`);
    await page.fill(`${tr} .picker-input`, URUN);
    await page.waitForTimeout(400);
    await page.click(`${tr} .picker-list .picker-item:not(.picker-new)`);
    await page.waitForTimeout(300);
  }
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(2500);
  // Kaydetme sonrasi acik kalan pencere (fiyat artisi vb.) kapatilir
  for (let i = 0; i < 4 && (await page.$$('.modal-backdrop')).length; i++) {
    await page.click('.modal-backdrop:last-of-type .modal-head .icon-btn').catch(() => {});
    await page.waitForTimeout(300);
  }
  return { secim, metin };
}

console.log('\n1) Ilk faturada kalem ESLESMIYOR, elle seciliyor');
const ilk = await faturaGir(XML1, { elleSec: true });
ok('Kalem eslesmedi olarak geldi', ilk.secim === '', `secili: "${ilk.secim}"`);
ok('Kullaniciya "bir kez yeterli" deniyor', /BİR KEZ seçmeniz yeterli/.test(ilk.metin), ilk.metin.slice(0, 300));

const ogrenilenler = (await apiCall('GET', '/api/products/aliases')).data.items;
const kayitA = ogrenilenler.find((a) => a.source_name === AD_A);
ok('Eslestirme ogrenildi', !!kayitA, JSON.stringify(ogrenilenler.slice(0, 3)));
ok('Dogru urune baglandi', kayitA && kayitA.product_id === urun.data.id);

console.log('\n2) IKINCI faturada ayni kalem KENDILIGINDEN esleiyor');
const ikinci = await faturaGir(XML2);
ok('Urun kendiliginden secildi', ikinci.secim === URUN, `secili: "${ikinci.secim}"`);
ok('"Onceki eslestirmelerden bulundu" bildirimi',
  /önceki eşleştirmelerden bulundu/.test(ikinci.metin), ikinci.metin.slice(0, 300));
ok('"eslesmedi" uyarisi CIKMADI', !/kalem eşleşmedi/.test(ikinci.metin), ikinci.metin.slice(0, 300));

console.log('\n3) BASKA tedarikci ayni urune BASKA ad veriyor');
const ucuncu = await faturaGir(XML3, { elleSec: true });
ok('B tedarikcisinde eslesmedi (kendi adi farkli)', ucuncu.secim === '', `secili: "${ucuncu.secim}"`);

const hepsi = (await apiCall('GET', '/api/products/aliases')).data.items;
const kayitB = hepsi.find((a) => a.source_name === AD_B);
ok('B icin ayri eslestirme ogrenildi', !!kayitB);
ok('Ikisi de AYNI urune isaret ediyor',
  kayitA && kayitB && kayitA.product_id === kayitB.product_id,
  `A:${kayitA?.product_id} B:${kayitB?.product_id}`);
ok('Farkli tedarikcilere ait olarak kaydedildi',
  kayitA && kayitB && kayitA.supplier_id !== kayitB.supplier_id);

console.log('\n4) Eslestirme ekrani: goruntule, duzelt, sil');
await page.goto(`${BASE}/#/suppliers`, { waitUntil: 'networkidle' });
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
await page.click('button:has-text("Ürün Eşleştirmeleri")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(1200);

await page.fill('.modal input[type=search]', RUN);
await page.waitForTimeout(900);
const ekran = await page.textContent('.modal-body');
ok('Her iki eslestirme de listeleniyor',
  ekran.includes(AD_A) && ekran.includes(AD_B.trim()), ekran.slice(0, 400));
ok('Hangi urune baglandigi gosteriliyor', ekran.includes(URUN));
ok('Cevrim carpani sutunu var', /1 : 1/.test(ekran), ekran.slice(0, 400));

// Carpani degistir: 1 koli = 24 adet
await page.click(`.modal table.data tbody tr:has-text("${AD_A}") button:has-text("Düzelt")`);
await page.waitForSelector('.modal-backdrop:last-of-type');
await page.waitForTimeout(800);
const duzeltEkrani = await page.textContent('.modal-backdrop:last-of-type .modal-body');
ok('Carpanin ne ise yaradigi anlatiliyor', /1 koli 24 adetse 24 yazın/.test(duzeltEkrani), duzeltEkrani.slice(0, 400));
await page.fill('.modal-backdrop:last-of-type input.num', '24');
await page.click('.modal-backdrop:last-of-type .btn-primary');
await page.waitForTimeout(1500);

const carpanli = (await apiCall('GET', '/api/products/aliases')).data.items.find((a) => a.id === kayitA.id);
ok('Carpan kaydedildi', carpanli && Number(carpanli.factor) === 24, String(carpanli?.factor));
const listeSonrasi = await page.textContent('.modal-body');
ok('Listede cevrim gosteriliyor', /1 fatura = 24/.test(listeSonrasi), listeSonrasi.slice(0, 400));

await b.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
