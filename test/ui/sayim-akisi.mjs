/**
 * Arayuz regresyon testi: kor sayim -> kilitleme -> iki imza -> kesinlestirme.
 *
 * Bu akis yalnizca gercek tarayicida surulerek dogrulanabilir; onay kutusunun
 * her zaman "iptal" dondurdugu hata da bu testle yakalandi.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 *   npm i -g playwright && playwright install chromium
 *
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/sayim-akisi.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const ADMIN = { email: 'admin@topkapiokullari.com', password: 'Kantin2026!' };
// Test ayni veritabaninda tekrar calistirilabilsin diye her kosuda kendi
// kampusunu ve onaylayanini olusturur: ayni gune ikinci bir donem sayimi
// acilamadigi icin sabit kampusle ikinci kosu basarisiz oluyordu.
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const CAMPUS_CODE = `UIS${RUN}`;
const APPROVER = { email: `onaylayan.${RUN}@topkapiokullari.com`, password: 'Onay123456' };

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright bulunamadi. Kurulum: npm i -g playwright && playwright install chromium');
  process.exit(2);
}

const problems = [];
const check = (label, condition, detail = '') => {
  if (condition) console.log(`  ✓ ${label}`);
  else { console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); problems.push(label); }
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
const consoleErrors = [];
// Kullanici degistirirken sayfa yeniden yuklenir ve ucusta olan istekler
// iptal olur; tarayici bunun icin "Failed to fetch" basar. Testin dogal
// sonucu, urun hatasi degil.
const ABORTED_FETCH = /TypeError: Failed to fetch/;
const record = (text) => { if (!ABORTED_FETCH.test(text)) consoleErrors.push(text); };
page.on('pageerror', (e) => record(e.message));
page.on('console', (m) => { if (m.type() === 'error') record(m.text()); });

async function login({ email, password }) {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.evaluate(() => { try { localStorage.removeItem('kantin_token'); } catch { /* yoksay */ } });
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', password);
  await page.click('button[type=submit]');
  await page.waitForSelector('#app:not([hidden])', { timeout: 15000 });
}

try {
  console.log('\n1) Yonetici girisi, test kampusu ve onaylayan kullanici');
  await login(ADMIN);
  const campusId = await page.evaluate(async ([user, code]) => {
    const token = localStorage.getItem('kantin_token');
    const post = (path, body) => fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then((r) => r.json());

    await post('/api/users', {
      email: user.email, fullName: 'Onaylayan Mudur', role: 'GENEL_MUDURLUK', password: user.password,
    });
    const campus = await post('/api/campuses', {
      code, name: `UI Sayım Kampüsü ${code}`, studentCount: 300,
    });
    return campus.id;
  }, [APPROVER, CAMPUS_CODE]);
  check('Test kampusu olusturuldu', !!campusId, String(campusId));

  console.log('\n2) Kor sayim acilir ve beklenen miktar gizlenir');
  // Kampus API ile olusturuldu; secici ancak tam yeniden yuklemeyle tazelenir
  await page.goto(`${BASE}/#/counts`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.selectOption('#campusSelect', String(campusId));
  await page.waitForTimeout(1200);
  await page.click('button:has-text("+ Dönem Sayımı")');
  await page.waitForSelector('.modal-backdrop');
  await page.click('.modal-foot .btn-primary');
  await page.waitForSelector('.card:has-text("Kör Sayım")', { timeout: 15000 });

  const sheetHeaders = await page.$$eval(
    '.card:has-text("Sayım Fişi") table.data thead th', (ns) => ns.map((n) => n.textContent.trim())
  );
  check('"Olmasi Gereken" sutunu gizli', !sheetHeaders.includes('Olması Gereken'), sheetHeaders.join(','));
  check('"Fark" sutunu gizli', !sheetHeaders.includes('Fark'));
  check('"Satis Tutari" sutunu gizli', !sheetHeaders.includes('Satış Tutarı'));

  const countId = page.url().split('/').pop();

  console.log('\n3) Miktarlar ve uretim satislari girilir');
  const inputs = await page.$$('.count-line-input');
  check('Sayim satirlari yuklendi', inputs.length > 0, `${inputs.length} satir`);
  for (let i = 0; i < inputs.length; i += 1) await inputs[i].fill(String(5 + i));

  const productionCard = await page.$('.card:has-text("Üretilen Ürün Satışları")');
  check('Uretilen urun bolumu ayri gosteriliyor', !!productionCard);
  if (productionCard) {
    for (const input of await productionCard.$$('input[type=number]')) await input.fill('100');
    await page.click('button:has-text("Adetleri Kaydet")');
    await page.waitForTimeout(500);
  }

  console.log('\n4) Sayim kilitlenir (sayima katilan kisi zorunlu)');
  await page.click('.filter-bar button:has-text("Sayımı Kilitle")');
  await page.waitForSelector('.modal-backdrop');
  await page.fill('.modal input[name=witnessName]', 'Serpil Aydın');
  await page.click('.modal-foot .btn-primary');
  await page.waitForSelector('.card:has-text("Sayım Fişi")', { timeout: 15000 });
  await page.waitForTimeout(800);

  const revealed = await page.$$eval(
    '.card:has-text("Sayım Fişi") table.data thead th', (ns) => ns.map((n) => n.textContent.trim())
  );
  check('Kilit sonrasi "Olmasi Gereken" acildi', revealed.includes('Olması Gereken'), revealed.join(','));

  console.log('\n5) IKI IMZA: sayan kisi kendi sayimini onaylayamaz');
  const ownBtn = await page.$eval('button:has-text("Kesinleştir")',
    (n) => ({ text: n.textContent.trim(), disabled: n.disabled })).catch(() => null);
  check('Kesinlestir dugmesi sayan kisiye kapali', ownBtn?.disabled === true, JSON.stringify(ownBtn));

  console.log('\n6) Baska yetkili kesinlestirir');
  await login(APPROVER);
  await page.goto(`${BASE}/#/countDetail/${countId}`);
  await page.waitForTimeout(1200);
  const approverBtn = await page.$eval('button:has-text("✓ Kesinleştir")',
    (n) => ({ disabled: n.disabled })).catch(() => null);
  check('Kesinlestir dugmesi onaylayana acik', approverBtn?.disabled === false);

  await page.click('button:has-text("✓ Kesinleştir")');
  await page.waitForSelector('.modal-backdrop');
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(2000);

  const status = await page.evaluate(async (id) => {
    const token = localStorage.getItem('kantin_token');
    const r = await fetch(`/api/counts/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    return (await r.json()).status;
  }, countId);
  // Onay kutusu hatasi bu adimda yakalanmisti: confirmDialog her zaman false donuyordu
  check('Sayim KESINLESMIS duruma gecti', status === 'KESINLESMIS', `durum=${status}`);

  check('Tarayici hatasi yok', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  console.error('\nTest calistirilamadi:', err.message);
  problems.push(err.message);
} finally {
  await browser.close();
}

console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
