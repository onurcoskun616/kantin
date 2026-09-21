/**
 * Arayuz regresyon testi: yetkiler, tedarikci VKN'si ve belge silme.
 *
 * Kontrol edilen zincir:
 *   Tedarikci VKN'siz acilamaz -> mukerrer VKN firma adiyla reddedilir ->
 *   belge detayinda hem "iptal" hem "kalici sil" cikar -> silme penceresi
 *   ne kaybedilecegini sayar ve belge no yazilmadan silmez ->
 *   on muhasebe fatura/ciro girebilir ama sayim ve silme goremez.
 *
 * Kurallarin kendisi test/api.test.js icinde sunucu tarafinda sinaniyor;
 * burasi kullanicinin GORDUGU seyi dogrular.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/yetki-ve-silme.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

// Ayni veritabaninda tekrar calistirilabilsin diye her kosuda benzersiz
// VKN ve e-posta: VKN artik tekil, ikinci kosu aksi halde catisirdi.
const RUN = String(Date.now()).slice(-8);
const VKN = `9${RUN}`;                       // 9 + 8 hane = 9 hane... asagida tamamlanir
const VKN10 = VKN.padEnd(10, '0').slice(0, 10);
const MUHASEBE_EPOSTA = `ui-muhasebe-${RUN}@topkapiokullari.com`;
const MUHASEBE_PAROLA = 'Muhasebe12345';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1500, height: 1050 } });
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR ' + e.message));
// Test bilerek reddedilen istekler yapiyor (400/403/409); bunlar hata degil
const EXPECTED = /Failed to load resource.*\b(400|403|409)\b|TypeError: Failed to fetch/;
page.on('console', (m) => {
  if (m.type() === 'error' && !EXPECTED.test(m.text())) console.log('CONSOLE ' + m.text().slice(0, 160));
});

const problems = [];
const ok = (l, c, d = '') => {
  if (c) console.log(`  ✓ ${l}`);
  else { console.log(`  ✗ ${l}${d ? ' — ' + String(d).slice(0, 240) : ''}`); problems.push(l); }
};
const giris = async (eposta, parola) => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.removeItem('kantin_token'); } catch { /* yoksay */ } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', eposta);
  await page.fill('input[name=password]', parola);
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])');
  await page.waitForTimeout(1500);
};

await giris('admin@topkapiokullari.com', 'Kantin2026!');

console.log('\n1) Tedarikci vergi numarasi');
await page.evaluate(() => { location.hash = '#/catalog'; });
await page.waitForTimeout(2000);
await page.click('button:has-text("Tedarikçiler")').catch(() => {});
await page.waitForTimeout(800);

await page.click('button:has-text("+ Yeni Tedarikçi")');
await page.waitForSelector('.modal-backdrop');
const form = await page.textContent('.modal-body');
ok('VKN alani zorunlu oldugu yaziyor', /Vergi \/ TC no/.test(form) && /Zorunlu/.test(form), form.slice(0, 250));

await page.fill('.modal input[name=name]', `UI Test Firma ${RUN}`);
await page.fill('.modal input[name=taxNo]', '123');
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(900);
let hata = await page.textContent('.modal .alert-danger').catch(() => '');
ok('Gecersiz uzunluk reddedildi', /10 haneli|11 haneli/.test(hata), hata.slice(0, 160));

await page.fill('.modal input[name=taxNo]', VKN10);
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(1500);
ok('Gecerli VKN kabul edildi', (await page.$$('.modal-backdrop')).length === 0);

await page.click('button:has-text("+ Yeni Tedarikçi")');
await page.waitForSelector('.modal-backdrop');
await page.fill('.modal input[name=name]', `Cakisan Firma ${RUN}`);
await page.fill('.modal input[name=taxNo]', VKN10);
await page.click('.modal-foot .btn-primary');
await page.waitForTimeout(1200);
hata = await page.textContent('.modal .alert-danger').catch(() => '');
ok('Mukerrer VKN engellendi', /zaten tanimlidir/i.test(hata), hata.slice(0, 200));
ok('Cakisan firmanin adi soylendi', hata.includes(`UI Test Firma ${RUN}`), hata.slice(0, 200));
await page.click('.modal-head .icon-btn');
await page.waitForTimeout(400);

console.log('\n2) Belge silme penceresi');
await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(2200);
await page.click('tbody tr:first-child button:has-text("Detay")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(900);
const actions = await page.textContent('.modal-foot');
ok('Iptal dugmesi var', /İptal Et/.test(actions), actions);
ok('Kalici sil dugmesi var', /Kalıcı Olarak Sil/.test(actions), actions);

await page.click('.modal-foot button:has-text("Kalıcı Olarak Sil")');
await page.waitForTimeout(700);
const onay = await page.textContent('.modal-backdrop:last-of-type .modal-body');
ok('Geri alinamaz uyarisi var', /geri alınamaz/i.test(onay), onay.slice(0, 200));
ok('Silinecekler tek tek sayiliyor', /ürün satırı/.test(onay), onay.slice(0, 400));
ok('Iptal alternatifi oneriliyor', /silmek yerine/.test(onay), onay.slice(0, 600));

await page.click('.modal-backdrop:last-of-type .btn-danger');
await page.waitForTimeout(700);
const dogrulamaHatasi = await page.textContent('.modal-backdrop:last-of-type .alert-danger').catch(() => '');
ok('Belge no yazilmadan silinmiyor', /eşleşmedi/.test(dogrulamaHatasi), dogrulamaHatasi.slice(0, 160));

// Dogru belge no yazilinca silinir
const belgeNo = await page.$eval('.modal-backdrop:last-of-type input', (n) => n.placeholder);
await page.fill('.modal-backdrop:last-of-type input', belgeNo);
await page.click('.modal-backdrop:last-of-type .btn-danger');
// Sabit bekleme yerine pencerenin kapanmasini bekle: sunucu yavas
// oldugunda sabit sure yetmiyor ve test nedensiz kiriliyordu.
const kapandi = await page.waitForSelector('.modal-backdrop', { state: 'detached', timeout: 15000 })
  .then(() => true).catch(() => false);
ok('Dogru belge no ile silindi', kapandi,
  await page.textContent('.modal-backdrop .alert-danger').catch(() => 'pencere kapanmadi'));
const silindiMi = await page.evaluate(async (no) => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch('/api/purchases?from=2000-01-01&to=2099-01-01', { headers: { Authorization: `Bearer ${t}` } });
  return (await r.json()).items.some((x) => x.document_no === no);
}, belgeNo);
ok('Belge listeden de gitti', silindiMi === false);

console.log('\n3) On muhasebe rolu: veri girer, onaylamaz');
await page.evaluate(async ({ eposta, parola }) => {
  const t = localStorage.getItem('kantin_token');
  await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ email: eposta, fullName: 'UI Ön Muhasebe', role: 'MUHASEBE', password: parola }),
  });
}, { eposta: MUHASEBE_EPOSTA, parola: MUHASEBE_PAROLA });

await giris(MUHASEBE_EPOSTA, MUHASEBE_PAROLA);

await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(2000);
ok('Mal girisi yapabiliyor', !!(await page.$('button:has-text("+ Yeni Mal Girişi")')));

await page.evaluate(() => { location.hash = '#/revenues'; });
await page.waitForTimeout(2000);
const ciro = await page.textContent('#pageContent');
ok('Ciro girisi yapabiliyor', /Ciro Gir|Günlük Ciro/.test(ciro), ciro.slice(0, 200));

await page.evaluate(() => { location.hash = '#/counts'; });
await page.waitForTimeout(2000);
ok('Sayim baslatamiyor', !(await page.$('button:has-text("Yeni Sayım")')));

await page.evaluate(() => { location.hash = '#/purchases'; });
await page.waitForTimeout(2000);
await page.click('tbody tr:first-child button:has-text("Detay")');
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(800);
const muhActions = await page.textContent('.modal-foot').catch(() => '');
ok('Belgeyi iptal edebiliyor', /İptal Et/.test(muhActions), muhActions);
ok('Kalici silme dugmesini GORMUYOR', !/Kalıcı Olarak Sil/.test(muhActions), muhActions);

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
