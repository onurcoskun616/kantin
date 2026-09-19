/**
 * Arayuz regresyon testi: fatura karekodu (GIB QR) ile giris.
 *
 * Kontrol edilen zincir:
 *   Karekod okut -> baslik dolar (tedarikci/belge no/tarih) ->
 *   "urun satiri karekodda yok" uyarisi -> girilen satirlar faturanin
 *   toplamlariyla anlik karsilastirilir -> fark varken kaydetmek onay ister ->
 *   duzeltince "birebir uyusuyor" -> kaydedilir -> ayni ETTN ikinci kez
 *   kabul edilmez.
 *
 * Karekod GORUNTUSU okutulmaz: BarcodeDetector her ortamda yok (Firefox,
 * Safari ve cogu headless Linux tarayicisi desteklemez). Bu yuzden test,
 * kullanicinin da ayni durumda kullandigi "karekod metnini yapistir"
 * yolundan ilerler; metin cozumlemesi ve karsilastirma ayni koddur.
 * Cozumleyicinin kendi birim testleri: test/karekod.test.js
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/karekod.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

// Ayni veritabaninda tekrar calistirilabilsin diye belge no ve ETTN her
// kosuda benzersiz: sistem ayni ETTN'yi ikinci kez kabul etmiyor.
const RUN = Date.now().toString(36).slice(-6).toUpperCase();
const DOC_NO = `QR${RUN}`;
const ETTN = `7c1e45f0-aaaa-4bbb-8ccc-${RUN.toLowerCase().padEnd(12, '0')}`;
const VKN = '1234567890';

// Faturanin beyan ettigi tutarlar. Asagida once YANLIS (eksik) miktar
// girilecek, sonra duzeltilecek: 20 adet x 5,00 TL = 100,00 + %20 KDV.
const QR = JSON.stringify({
  vkntckn: VKN,
  avkntckn: '9876543210',
  senaryo: 'TEMELFATURA',
  tip: 'SATIS',
  tarih: '2026-09-15',
  no: DOC_NO,
  ettn: ETTN,
  malhizmettoplam: 100.0,
  'kdvmatrah(1)': 0,
  'hesaplanankdv(1)': 0,
  'kdvmatrah(10)': 0,
  'hesaplanankdv(10)': 0,
  'kdvmatrah(20)': 100.0,
  'hesaplanankdv(20)': 20.0,
  vergidahil: 120.0,
  odenecek: 120.0,
});

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 1050 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
const EXPECTED = /Failed to load resource.*\b409\b|TypeError: Failed to fetch/;
page.on('console', (m) => {
  if (m.type() === 'error' && !EXPECTED.test(m.text())) console.log('CONSOLE ' + m.text().slice(0, 160));
});

const problems = [];
const ok = (l, c, d = '') => {
  if (c) console.log(`  ✓ ${l}`);
  else { console.log(`  ✗ ${l}${d ? ' — ' + String(d).slice(0, 240) : ''}`); problems.push(l); }
};

/** Karekod penceresini acar ve metni yapistirarak okutur. */
async function karekodOkut(text) {
  await page.click('button:has-text("Karekod Okut")');
  await page.waitForSelector('text=Fatura Karekodunu Okut');
  // BarcodeDetector destekleniyorsa bolum kapali gelir; testte metin yolunu
  // kullandigimiz icin acikca aciyoruz.
  await page.evaluate(() => {
    document.querySelectorAll('.modal-backdrop details').forEach((d) => d.setAttribute('open', ''));
  });
  await page.fill('textarea[placeholder*="vkntckn"]', text);
  await page.click('button:has-text("Bu metni kullan")');
  await page.waitForTimeout(800);
}

/** Bir satirin alanlarini doldurur (satir 1'den baslar). */
async function satirDoldur(n, { urun = null, miktar, fiyat, kdv }) {
  const tr = `.modal .line-table tbody tr:nth-child(${n})`;
  if (urun !== null) await page.selectOption(`${tr} select`, String(urun));
  await page.fill(`${tr} td:nth-child(2) input`, String(miktar));
  await page.fill(`${tr} td:nth-child(3) input`, String(fiyat));
  await page.fill(`${tr} td:nth-child(5) input`, String(kdv));
  await page.waitForTimeout(300);
}

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.fill('input[name=email]', 'admin@topkapiokullari.com');
await page.fill('input[name=password]', 'Kantin2026!');
await page.click('button[type=submit]');
await page.waitForSelector('#app:not([hidden])');
await page.waitForTimeout(1500);

// Tedarikciye VKN yaz ki karekod eslessin
const supplier = await page.evaluate(async (vkn) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch('/api/suppliers', { headers: { Authorization: `Bearer ${t}` } });
  const s = (await r.json()).items[0];
  await fetch(`/api/suppliers/${s.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ name: s.name, taxNo: vkn, taxOffice: 'Beşiktaş', phone: s.phone }),
  });
  return s;
}, VKN);
ok('Tedarikciye VKN yazildi', !!supplier?.id);

// Test KENDI urununu kullanir. Ortak bir urunu 5,00 TL'ye almak, sonraki
// testlerin ayni urunu daha pahaliya almasi durumunda "alis fiyati artti"
// penceresini acar ve o testleri kilitlerdi. Urun her kosuda ayni fiyatla
// alindigi icin uyari hic cikmaz.
const PRODUCT_NAME = 'Karekod Testi (silinebilir)';
const product = await page.evaluate(async (name) => {
  const t = localStorage.getItem('kantin_token');
  const h = { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` };
  const list = await (await fetch('/api/products', { headers: h })).json();
  const varOlan = list.items.find((p) => p.name === name);
  if (varOlan) return varOlan;
  const cats = await (await fetch('/api/products/categories', { headers: h })).json();
  const r = await fetch('/api/products', {
    method: 'POST', headers: h,
    body: JSON.stringify({
      name, categoryId: cats.items[0].id, unit: 'ADET', productType: 'SATIN_ALINAN',
      purchasePrice: 5, salePrice: 9, vatRate: 20, criticalStock: 0,
    }),
  });
  return r.ok ? r.json() : null;
}, PRODUCT_NAME);
ok('Test urunu hazir', !!product?.id, JSON.stringify(product));

await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(2000);
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');

console.log('\n1) Karekod okuyamayan tarayicida yapistirma yolu acik');
// Bu tarayicida BarcodeDetector yok (Firefox/Safari ve headless Chromium
// ile ayni durum). Kullanici cikmaza girmemeli.
await page.click('button:has-text("Karekod Okut")');
await page.waitForSelector('text=Fatura Karekodunu Okut');
const destekVar = await page.evaluate(() => typeof window.BarcodeDetector === 'function');
ok('Test ortaminda BarcodeDetector yok', destekVar === false, 'destek var, bu bolum atlaniyor');
if (!destekVar) {
  const tarayici = await page.textContent('.modal-backdrop:last-of-type .modal-body');
  ok('Desteklenmedigi soylendi', /desteklemiyor/.test(tarayici), tarayici.slice(0, 200));
  ok('Chrome/Edge onerildi', /Chrome/.test(tarayici));
  ok('Yapistirma bolumu acik geldi',
    await page.$eval('.modal-backdrop:last-of-type details', (n) => n.hasAttribute('open')));
  ok('Kamera dugmesi pasif',
    await page.$eval('.modal-backdrop:last-of-type button:has-text("Kamerayı Aç")', (n) => n.disabled)
      .catch(() => true));
}
await page.click('.modal-backdrop:last-of-type button:has-text("Vazgeç")');
await page.waitForTimeout(500);
ok('Vazgecilince alim formu acik kaldi', (await page.$$('.modal-backdrop')).length === 1);

console.log('\n2) Karekod okutulur, baslik dolar');
await karekodOkut(QR);

const body = await page.textContent('.modal-body');
ok('Karekod okundu bildirimi', body.includes('Karekod okundu'), body.slice(0, 200));
ok('Satirlarin karekodda olmadigi soylendi', body.includes('Ürün satırları karekodda yok'));
ok('Tedarikci VKN ile secildi', await page.$eval('.modal select', (n) => n.value) === String(supplier.id));
ok('Belge no dolduruldu', (await page.inputValue('.modal input[placeholder*="rsaliye"]')) === DOC_NO);
ok('Belge tarihi dolduruldu', (await page.inputValue('.modal input[type=date]')) === '2026-09-15');
ok('Karsilastirma tablosu acildi', body.includes('Karekodla karşılaştırma'));
ok('Faturanin %20 matrahi gosteriliyor', /%20 matrah/.test(body), body.slice(0, 300));

console.log('\n3) Eksik girilen satir aninda yakalanir');
// Once YANLIS: 16 adet girilir (100,00 yerine 80,00)
await satirDoldur(1, { urun: product.id, miktar: 16, fiyat: 5, kdv: 20 });
let compare = await page.textContent('.modal-body');
ok('Fark uyarisi rozeti cikti', /kalemde fark var/.test(compare), compare.slice(0, 200));

const farkSatiri = await page.$$eval('.modal .card table.data tbody tr', (ns) =>
  ns.map((n) => [...n.children].map((c) => c.textContent.trim())));
const genel = farkSatiri.find((r) => r[0] === 'Genel toplam');
ok('Genel toplam satiri faturayi gosteriyor', genel && /120/.test(genel[1]), JSON.stringify(genel));
ok('Genel toplam satiri girileni gosteriyor', genel && /96/.test(genel[2]), JSON.stringify(genel));
ok('Eksik oldugu isaretlendi', genel && genel[4].includes('eksik'), JSON.stringify(genel));
ok('Farkli satirlar renklendi', (await page.$$('.modal .card table.data tr.is-warn')).length > 0);

console.log('\n4) Fark varken kaydetmek onay ister');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(900);
const onayText = await page.textContent('.modal-backdrop:last-of-type .modal-body').catch(() => '');
ok('Onay penceresi acildi', /uyuşmuyor/.test(onayText), onayText.slice(0, 200));
ok('Fark ayrintisi yaziyor', /%20 matrah/.test(onayText), onayText.slice(0, 250));
await page.click('.modal-backdrop:last-of-type button:has-text("Vazgeç")');
await page.waitForTimeout(600);

const kaydedildiMi = await page.evaluate(async (no) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch('/api/purchases', { headers: { Authorization: `Bearer ${t}` } });
  return (await r.json()).items.some((p) => p.document_no === no);
}, DOC_NO);
ok('Vazgecilince belge KAYDEDILMEDI', kaydedildiMi === false);

console.log('\n5) Duzeltince fatura ile birebir uyusur');
await satirDoldur(1, { urun: product.id, miktar: 20, fiyat: 5, kdv: 20 });
compare = await page.textContent('.modal-body');
ok('Birebir uyusuyor rozeti', /birebir uyuşuyor/.test(compare), compare.slice(0, 200));

await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2500);
const created = await page.evaluate(async (no) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch('/api/purchases', { headers: { Authorization: `Bearer ${t}` } });
  return (await r.json()).items.find((p) => p.document_no === no) || null;
}, DOC_NO);
ok('Belge kaydedildi', !!created, 'belge bulunamadi');
ok('Net toplam 100,00', created && Math.abs(created.net_total - 100) < 0.01, String(created?.net_total));
ok('KDV 20,00', created && Math.abs(created.vat_total - 20) < 0.01, String(created?.vat_total));

console.log('\n6) Ayni karekod ikinci kez kabul edilmez (ETTN)');
await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(1800);
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');
await karekodOkut(QR);
await satirDoldur(1, { urun: product.id, miktar: 20, fiyat: 5, kdv: 20 });
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(2200);
const dupErr = await page.textContent('.modal .alert-danger').catch(() => '');
ok('Mukerrer fatura reddedildi', /zaten sisteme aktarilmis/i.test(dupErr), dupErr.slice(0, 160));
await page.click('.modal-head .icon-btn');
await page.waitForTimeout(400);

console.log('\n7) Fatura karekodu olmayan icerik reddedilir');
await page.click('button:has-text("+ Yeni Mal Girişi")');
await page.waitForSelector('.modal-backdrop');
await karekodOkut('https://www.ornek-market.com.tr/kampanya/yaz2026');
const redText = await page.textContent('.modal-body');
ok('Taninmayan karekod aciklandi', /tanınamadı/.test(redText), redText.slice(0, 220));
ok('Okunan ham metin gosterildi', /ornek-market/.test(redText), redText.slice(0, 260));
ok('Karsilastirma tablosu acilmadi', !redText.includes('Karekodla karşılaştırma'));
await page.click('.modal-head .icon-btn');
await page.waitForTimeout(400);

// Kaydettikten sonra "alis fiyati artti" gibi bir pencere acilip kalmamali:
// acik kalan bir modal, ayni veritabaninda kosan diger testleri kilitler.
await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(1200);
ok('Ekranda acik pencere kalmadi', (await page.$$('.modal-backdrop')).length === 0);

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
