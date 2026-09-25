/**
 * Arayuz regresyon testi: FATURA KOLI/PAKET, URUN KARTI ADET.
 *
 * Toptancilarin cogu faturayi koli uzerinden keser: UBL satirinda
 * `unitCode="PK"` ve "30 × 454,57" yazar. Uygulama bu 30'u oldugu gibi
 * alirsa stoga 30 ADET girer — oysa 30 KOLI gelmistir. Hata SESSIZDIR:
 * belge toplami faturayla tutar, kimse fark etmez; sayimda devasa bir
 * fark cikar ve nereden geldigi anlasilmaz.
 *
 * Kontrol edilen zincir:
 *   Fatura PK, kart ADET -> uyari cikar ve "1 PAKET kac ADET?" diye
 *   sorar -> cevap satira uygulanir (miktar carpilir, fiyat bolunur,
 *   TUTAR DEGISMEZ) -> belge kaydedilir -> carpan ogrenilir -> ayni
 *   tedarikcinin ikinci faturasi kendiliginden cevrilir.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/birim-uyusmazligi.mjs [http://127.0.0.1:3000]
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
const URUN = `Koli Testi Meyve Suyu ${RUN}`;
const AD_FATURA = `MEYVE SUYU ÇEŞİTLERİ ${RUN}`;
// Fatura: 30 koli × 290,909 TL. Koli 24'lu ise stoga 720 adet × 12,1212 girer.
const KOLI = 30;
const KOLI_FIYAT = 290.909;
const ADET_KOLIDE = 24;

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

/** Koli (PK) biriminden kesilmis tek kalemli UBL fatura. */
function xmlYaz(dosya, { belgeNo, ettn }) {
  const net = Math.round(KOLI * KOLI_FIYAT * 100) / 100;
  const kdv = Math.round(net * 0.10 * 100) / 100;
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
      <cac:PartyName><cbc:Name>Koli Toptan ${RUN}</cbc:Name></cac:PartyName>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:TaxTotal><cbc:TaxAmount currencyID="TRY">${kdv.toFixed(2)}</cbc:TaxAmount></cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="TRY">${net.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxInclusiveAmount currencyID="TRY">${(net + kdv).toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="TRY">${(net + kdv).toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="PK">${KOLI}.00</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="TRY">${net.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="TRY">${kdv.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="TRY">${net.toFixed(2)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="TRY">${kdv.toFixed(2)}</cbc:TaxAmount>
        <cbc:Percent>10</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>${AD_FATURA}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="TRY">${KOLI_FIYAT}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kantin-koli-'));
const XML1 = path.join(dir, 'k1.xml');
const XML2 = path.join(dir, 'k2.xml');
xmlYaz(XML1, { belgeNo: `KL1${RUN}`, ettn: `3333${RUN}-aaaa-bbbb-cccc-000000000001` });
xmlYaz(XML2, { belgeNo: `KL2${RUN}`, ettn: `3333${RUN}-aaaa-bbbb-cccc-000000000002` });

await apiCall('POST', '/api/suppliers', { name: `Koli Toptan ${RUN}`, taxNo: VKN });
// Kart ADET tutuyor: fatura PK dedigi icin uyusmazlik BEKLENIR
const urun = await apiCall('POST', '/api/products', {
  name: URUN, salePrice: 25, vatRate: 10, unit: 'ADET',
});
ok('Hazirlik: tedarikci ve ADET birimli urun', urun.status === 200, JSON.stringify(urun.data).slice(0, 140));

/** Formu acar, XML yukler. */
async function formAc(xmlYolu) {
  await page.goto(`${BASE}/#/purchases`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  await page.click('button:has-text("+ Yeni Mal Girişi")');
  await page.waitForSelector('.modal-backdrop');
  await page.setInputFiles('.modal input[type=file][accept*="xml"]', xmlYolu);
  await page.waitForTimeout(1800);
}

const satirDegeri = (sutun) => page.$eval(
  `.modal .line-table tbody tr:first-child td:nth-child(${sutun}) input`, (n) => Number(n.value));
const toplamMetni = () => page.textContent('.modal-body');

console.log('\n1) Ilk fatura: kalem elle eslestirilir, BIRIM UYARISI cikar');
await formAc(XML1);
const tr1 = '.modal .line-table tbody tr:first-child';
await page.click(`${tr1} .picker-input`);
await page.fill(`${tr1} .picker-input`, URUN);
await page.waitForTimeout(400);
await page.click(`${tr1} .picker-list .picker-item:not(.picker-new)`);
await page.waitForTimeout(400);

const satirMetni = await page.textContent(tr1);
ok('Satirda faturanin kendi miktari ve birimi yaziyor',
  /30\s*PAKET/.test(satirMetni), satirMetni.slice(0, 200));
ok('Satirda kart biriminin farkli oldugu isaretli',
  /kart birimi ADET/.test(satirMetni), satirMetni.slice(0, 200));

const uyari = await toplamMetni();
ok('Birim uyusmazligi uyarisi cikti', /birim faturadan farklı/.test(uyari), uyari.slice(0, 300));
ok('Ne yapilacagi soruluyor', /1 PAKET kaç ADET/.test(uyari), uyari.slice(0, 400));

console.log('\n2) Carpan uygulanir: miktar carpilir, tutar DEGISMEZ');
const tutarOnce = await page.textContent(`${tr1} td.num`);
await page.fill('.alert-danger input[type=number]', String(ADET_KOLIDE));
await page.click('.alert-danger button:has-text("Uygula")');
await page.waitForTimeout(400);

const miktar = await satirDegeri(2);
const fiyat = await satirDegeri(3);
const tutarSonra = await page.textContent(`${tr1} td.num`);
ok('Miktar adede cevrildi', Math.abs(miktar - KOLI * ADET_KOLIDE) < 0.01, `miktar=${miktar}`);
ok('Birim fiyat kolideki adede bolundu',
  Math.abs(fiyat - KOLI_FIYAT / ADET_KOLIDE) < 0.001, `fiyat=${fiyat}`);
ok('Satir tutari DEGISMEDI', tutarOnce === tutarSonra, `${tutarOnce} -> ${tutarSonra}`);

console.log('\n3) Belge kaydedilir, belge toplami faturayla tutar');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2500);
for (let i = 0; i < 4 && (await page.$$('.modal-backdrop')).length; i++) {
  await page.click('.modal-backdrop:last-of-type .modal-head .icon-btn').catch(() => {});
  await page.waitForTimeout(300);
}
const belgeler = (await apiCall('GET', '/api/purchases?limit=50')).data.items || [];
const belge = belgeler.find((x) => x.document_no === `KL1${RUN}`);
const beklenenTutar = Math.round(KOLI * KOLI_FIYAT * 1.10 * 100) / 100;
ok('Belge kaydedildi', Boolean(belge), JSON.stringify(belgeler.slice(0, 2)).slice(0, 200));
ok('Belge toplami faturanin odenecek tutari',
  belge && Math.abs(belge.gross_total - beklenenTutar) < 0.05,
  `kayit=${belge?.gross_total} bekleniyor=${beklenenTutar}`);

const detay = belge ? (await apiCall('GET', `/api/purchases/${belge.id}`)).data : null;
const kalem = detay?.lines?.[0];
ok('Stoga ADET olarak girdi', kalem && Math.abs(kalem.quantity - KOLI * ADET_KOLIDE) < 0.01,
  `miktar=${kalem?.quantity}`);

console.log('\n4) Ayni tedarikcinin ikinci faturasi KENDILIGINDEN cevrilir');
await formAc(XML2);
const metin2 = await toplamMetni();
const miktar2 = await satirDegeri(2);
ok('Kalem kendiliginden eslesti', miktar2 > 0 && Number.isFinite(miktar2), `miktar=${miktar2}`);
ok('Carpan ogrenilmis ve uygulanmis',
  Math.abs(miktar2 - KOLI * ADET_KOLIDE) < 0.01, `miktar=${miktar2}`);
ok('Birim cevrimi bildirildi', /birim çevrimi yapıldı/.test(metin2), metin2.slice(0, 300));
ok('Ikinci faturada birim uyarisi CIKMADI', !/birim faturadan farklı/.test(metin2), metin2.slice(0, 300));

console.log('\n5) Kart da PAKET tutuyorsa yine SORULUR (asil tuzak)');
// Urun kartlari cogu zaman faturadan acilir ve birimi faturadan miras
// alir. O zaman birimler "tutuyor" gorunur ama stok yanlistir: kantin
// urunu tek tek satar. Bu durumda soru yine sorulmali ve cevap verilince
// KARTIN BIRIMI de ADET'e cevrilmeli.
const VKN2 = String(Date.now() + 4242).slice(-10);
const URUN2 = `Koli Testi Gofret ${RUN}`;
await apiCall('POST', '/api/suppliers', { name: `Koli Toptan İki ${RUN}`, taxNo: VKN2 });
const urun2 = await apiCall('POST', '/api/products', {
  name: URUN2, salePrice: 30, vatRate: 10, unit: 'PAKET',
});
const XML3 = path.join(dir, 'k3.xml');
xmlYaz(XML3, { belgeNo: `KL3${RUN}`, ettn: `3333${RUN}-aaaa-bbbb-cccc-000000000003` });
// Ucuncu fatura ikinci tedarikciden gelsin: ogrenilmis carpan karismasin
fs.writeFileSync(XML3, fs.readFileSync(XML3, 'utf8')
  .replace(`>${VKN}<`, `>${VKN2}<`)
  .replace(AD_FATURA, `GOFRET ÇEŞİTLERİ ${RUN}`));

await formAc(XML3);
await page.click(`${tr1} .picker-input`);
await page.fill(`${tr1} .picker-input`, URUN2);
await page.waitForTimeout(400);
await page.click(`${tr1} .picker-list .picker-item:not(.picker-new)`);
await page.waitForTimeout(500);

const metin3 = await toplamMetni();
ok('Kart PAKET olsa da soru soruldu',
  /koli\/paket olarak faturalanmış/.test(metin3), metin3.slice(0, 300));
ok('Hedef birim ADET soruluyor', /1 PAKET kaç ADET/.test(metin3), metin3.slice(0, 400));

await page.fill('.alert-warning input[type=number]', '12');
await page.click('.alert-warning button:has-text("Uygula")');
await page.waitForTimeout(900);
const miktar3 = await satirDegeri(2);
ok('Miktar adede cevrildi', Math.abs(miktar3 - KOLI * 12) < 0.01, `miktar=${miktar3}`);

const kart = (await apiCall('GET', `/api/products/${urun2.data.id}`)).data;
ok('Urun kartinin birimi ADET oldu', kart && kart.unit === 'ADET', `birim=${kart?.unit}`);
ok('Soru kutusu kapandi', !/1 PAKET kaç ADET/.test(await toplamMetni()));

console.log('\n6) Kalem faturadan URUN OLARAK TANIMLANINCA da sorulur');
// Kullanicinin gercek akisi bu: kalem eslesmiyor, "+ yeni urun tanimla"
// ile karti faturadan aciyor. Kart birimi faturadan miras kaldigi icin
// PAKET oluyor ve hicbir sey uyusmaz gorunmuyor. Soru burada sorulmazsa
// hic sorulmaz.
const VKN3 = String(Date.now() + 9191).slice(-10);
const AD3 = `KEK ÇEŞİTLERİ ${RUN}`;
await apiCall('POST', '/api/suppliers', { name: `Koli Toptan Üç ${RUN}`, taxNo: VKN3 });
const XML4 = path.join(dir, 'k4.xml');
xmlYaz(XML4, { belgeNo: `KL4${RUN}`, ettn: `3333${RUN}-aaaa-bbbb-cccc-000000000004` });
fs.writeFileSync(XML4, fs.readFileSync(XML4, 'utf8')
  .replace(`>${VKN}<`, `>${VKN3}<`)
  .replace(AD_FATURA, AD3));

await formAc(XML4);
await page.click(`${tr1} .picker-input`);
await page.fill(`${tr1} .picker-input`, AD3);
await page.waitForTimeout(400);
await page.click(`${tr1} .picker-list .picker-new`);
await page.waitForSelector('.modal-backdrop:last-of-type input[name=salePrice]');
const birimSecili = await page.$eval('.modal-backdrop:last-of-type select[name=unit]', (n) => n.value);
ok('Yeni urun formunda birim faturadan geldi', birimSecili === 'PAKET', `birim=${birimSecili}`);
const ipucu = await page.textContent('.modal-backdrop:last-of-type .modal-body');
ok('Tek tek satanlar icin ADET onerisi var', /TEK TEK/.test(ipucu), ipucu.slice(0, 200));

await page.fill('.modal-backdrop:last-of-type input[name=salePrice]', '20');
await page.click('.modal-backdrop:last-of-type .modal-foot .btn-primary');
await page.waitForTimeout(1200);

const metin4 = await toplamMetni();
ok('Faturadan acilan kart icin de soruldu',
  /1 PAKET kaç ADET/.test(metin4), metin4.slice(0, 400));

await b.close();
if (problems.length) {
  console.log(`\n✗ ${problems.length} sorun: ${problems.join(' | ')}\n`);
  process.exit(1);
}
console.log('\n✓ Koli/paket faturasi stok birimine dogru cevriliyor.\n');
