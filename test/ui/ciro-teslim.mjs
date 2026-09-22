/**
 * Arayuz regresyon testi: ciro teslim fisi.
 *
 * Kontrol edilen zincir:
 *   fis olustur -> tutar donar -> gorevli o gunu degistiremez ->
 *   yonetim degistirirse fis FARKLI olur -> on muhasebe kodla onaylar ->
 *   ciktı iki nusha olarak basilabilir.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/ciro-teslim.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';

const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const ADMIN = { email: 'admin@topkapiokullari.com', password: 'Kantin2026!' };
// Test ayni veritabaninda tekrar tekrar calistirilabilsin diye her kosuda
// kendi kampusunu ve kullanicilarini benzersiz bir on ekle olusturur.
const RUN = Date.now().toString(36).slice(-5).toUpperCase();
const CAMPUS_CODE = `UIT${RUN}`;
const STAFF = { email: `ui.gorevli.${RUN}@topkapiokullari.com`, password: 'Gorevli12345' };
const ACCOUNTING = { email: `ui.muhasebe.${RUN}@topkapiokullari.com`, password: 'Muhasebe12345' };

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
// Bu test bilerek reddedilen istekler yapiyor (400/403/404/409); tarayicinin
// bunlar icin bastigi "failed to load resource" satirlari hata sayilmaz.
// 404: silinen fisin gercekten gittigini dogrularken bilerek isteniyor.
// Sayfa yeniden yuklenirken ucusta olan istekler iptal olur ve tarayici
// "Failed to fetch" basar; bu testin kullanici degistirme adimlarinin
// dogal sonucu, urun hatasi degil.
const EXPECTED_HTTP = /Failed to load resource.*\b(400|403|404|409)\b|TypeError: Failed to fetch/;
const record = (text) => { if (!EXPECTED_HTTP.test(text)) consoleErrors.push(text); };
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

/** Tarayicidan API cagirir — kurulum adimlarini UI'siz yapmak icin. */
const call = (method, path, body) => page.evaluate(async ([m, p, b]) => {
  const token = localStorage.getItem('kantin_token');
  const res = await fetch(p, {
    method: m,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: b ? JSON.stringify(b) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}, [method, path, body]);

const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return iso(d); };

try {
  console.log('\n1) Hazirlik: kampus, gorevli ve on muhasebe kullanicisi');
  await login(ADMIN);
  const created = await call('POST', '/api/campuses',
    { code: CAMPUS_CODE, name: `UI Teslim Kampüsü ${RUN}`, studentCount: 50 });
  const campusId = created.data.id;
  check('Test kampusu olusturuldu', !!campusId, JSON.stringify(created.data));

  await call('POST', '/api/users', {
    email: STAFF.email, fullName: 'UI Kantin Görevlisi',
    role: 'KANTIN_GOREVLISI', campusId, password: STAFF.password,
  });
  await call('POST', '/api/users', {
    email: ACCOUNTING.email, fullName: 'UI Ön Muhasebe',
    role: 'MUHASEBE', password: ACCOUNTING.password,
  });
  for (const [i, amount] of [1000, 1200, 800].entries()) {
    await call('POST', '/api/revenues',
      { campusId, revenueDate: daysAgo(5 - i), cashAmount: amount, overwrite: true });
  }
  check('Uc gunluk ciro girildi', true);

  console.log('\n2) Teslim edilmemis ciro ekranda uyari olarak cikar');
  // Kampus API ile olusturuldu; arayuzun kampus listesi ancak tam yeniden
  // yuklemeyle tazelenir (hash degisimi sayfayi yeniden yuklemez).
  await page.goto(`${BASE}/#/handovers`);
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  await page.selectOption('#campusSelect', String(campusId));
  await page.waitForTimeout(1500);
  const pendingText = await page.textContent('.content').catch(() => '');
  check('"Teslim Edilmemiş Ciro" karti gorunuyor', pendingText.includes('Teslim Edilmemiş Ciro'));
  check('Bekleyen tutar 3.000 TL gorunuyor', /3\.000,00/.test(pendingText), pendingText.slice(0, 200));

  console.log('\n3) Teslim fisi olusturulur ve tutar donar');
  // Fis kaydedilir kaydedilmez ciktı penceresi acilir; testi durdurmasin.
  // Gercek yazdirma gibi davranmasi icin beforeprint olayini tetikliyoruz:
  // aksi halde kod "yazdirma engellendi" yoluna sapar ve yeni pencere acar.
  const stubPrint = () => { window.print = () => window.dispatchEvent(new Event('beforeprint')); };
  await page.addInitScript(stubPrint);
  await page.evaluate(stubPrint);
  await page.click('button:has-text("+ Teslim Fişi Oluştur")');
  await page.waitForSelector('.modal-backdrop');
  await page.fill('.modal input[name=from]', daysAgo(5));
  await page.fill('.modal input[name=to]', daysAgo(3));
  await page.fill('.modal input[name=receivedByName]', 'Ayşe Muhasebe');
  await page.selectOption('.modal select[name=campusId]', String(campusId));
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(2500);

  const list = await call('GET', `/api/handovers?campusId=${campusId}`);
  const handover = list.data.items[0];
  check('Fis olusturuldu', !!handover, JSON.stringify(list.data).slice(0, 200));
  check('Tutar donduruldu (3000 TL)', handover?.total_amount === 3000, String(handover?.total_amount));
  check('Belge no kampus koduyla uretildi',
    new RegExp(`^${CAMPUS_CODE}-\\d{4}-0001$`).test(handover?.document_no || ''), handover?.document_no);
  check('Dogrulama kodu 6 hane', handover?.verification_code?.length === 6, handover?.verification_code);

  console.log('\n4) Onizleme ekranda acilir, iki nusha basilir');
  await page.goto(`${BASE}/#/handoverDetail/${handover.id}`);
  await page.waitForTimeout(1500);
  await page.click('button:has-text("Yazdır")');
  await page.waitForTimeout(900);

  // Yazdirma penceresi acilamayan ortamlarda (korumali cerceve) da belge
  // en azindan ekranda gorunmeli: onizleme katmani bunun icin var.
  check('Onizleme ekranda acildi', await page.$eval('#printRoot', (n) => n.classList.contains('open')));
  check('Onizleme arac cubugu var', !!(await page.$('.slip-toolbar')));
  const visible = await page.$$eval('#printRoot .slip', (ns) => ns.map((n) => n.offsetHeight));
  check('Nushalar ekranda gorunur boyutta', visible.length === 2 && visible.every((h) => h > 200), visible.join(','));
  check('Engel uyarisi gosterilmedi', await page.$eval('.slip-note', (n) => n.hidden));

  const slips = await page.$$eval('#printRoot .slip', (ns) => ns.map((n) => n.textContent));
  check('Iki nusha basildi', slips.length === 2, `nusha=${slips.length}`);
  check('Kantin nushasi var', slips[0]?.includes('KANTİN NÜSHASI'));
  check('On muhasebe nushasi var', slips[1]?.includes('ÖN MUHASEBE NÜSHASI'));
  check('Imza satirlari var', (slips[0]?.match(/İmza/g) || []).length === 2);
  check('Tutar yaziyla basildi', /TL/.test(slips[0] || '') && /Yazıyla/.test(slips[0] || ''));
  check('Dogrulama kodu kagitta', slips[0]?.includes(handover.verification_code));

  // Yazdirmada kagida yalnizca fis cikmali
  await page.emulateMedia({ media: 'print' });
  await page.waitForTimeout(300);
  const printView = await page.evaluate(() => ({
    app: getComputedStyle(document.getElementById('app')).display,
    toolbar: getComputedStyle(document.querySelector('.slip-toolbar')).display,
    slip: getComputedStyle(document.querySelector('#printRoot .slip')).display,
  }));
  check('Yazdirmada uygulama gizleniyor', printView.app === 'none', JSON.stringify(printView));
  check('Yazdirmada arac cubugu gizleniyor', printView.toolbar === 'none', JSON.stringify(printView));
  check('Yazdirmada fis gorunuyor', printView.slip === 'block', JSON.stringify(printView));
  await page.emulateMedia({ media: 'screen' });

  // Baska sayfaya gecince onizleme ustte asili kalmamali
  await page.evaluate(() => { location.hash = '#/handovers'; });
  await page.waitForTimeout(900);
  check('Sayfa degisince onizleme kapaniyor',
    !(await page.$eval('#printRoot', (n) => n.classList.contains('open'))));

  console.log('\n5) Gorevli fise dahil ciroyu degistiremez');
  await login(STAFF);
  const staffEdit = await call('POST', '/api/revenues',
    { campusId, revenueDate: daysAgo(5), cashAmount: 9999, overwrite: true });
  check('Gorevlinin degisikligi 409 ile reddedildi', staffEdit.status === 409, JSON.stringify(staffEdit.data));

  await page.goto(`${BASE}/#/revenues`);
  await page.reload({ waitUntil: 'networkidle' });
  // Gorevli tek kampuse bagli oldugu icin kampus secici gizlidir
  await page.waitForTimeout(2000);
  const revenueText = await page.textContent('.content').catch(() => '');
  check('Ciro listesinde kilit isareti var', revenueText.includes('imzalı'), revenueText.slice(0, 120));

  console.log('\n6) Yonetim degistirirse fis FARKLI olur');
  await login(ADMIN);
  const adminEdit = await call('POST', '/api/revenues',
    { campusId, revenueDate: daysAgo(5), cashAmount: 700, overwrite: true });
  check('Yonetim degistirebildi', adminEdit.status === 200, JSON.stringify(adminEdit.data));
  const afterEdit = await call('GET', `/api/handovers/${handover.id}`);
  check('Fis FARKLI isaretlendi', afterEdit.data.status === 'FARKLI', afterEdit.data.status);
  check('Kagittaki tutar degismedi', afterEdit.data.total_amount === 3000, String(afterEdit.data.total_amount));
  check('Sistemdeki tutar guncellendi', afterEdit.data.current_total === 2700, String(afterEdit.data.current_total));

  await page.goto(`${BASE}/#/handoverDetail/${handover.id}`);
  await page.waitForTimeout(1500);
  const detailText = await page.textContent('.content').catch(() => '');
  check('Ekranda fark uyarisi gorunuyor', detailText.includes('Kâğıttaki tutar ile sistemdeki tutar farklı'));

  console.log('\n7) On muhasebe kodla onaylar, onay disina cikamaz');
  await login(ACCOUNTING);
  // On muhasebe bir VERI GIRISI rolu: ciro girebilir. Sayim kesinlestirme ve
  // stok duzeltme yine kapalidir (test/api.test.js "On muhasebe yetkileri").
  const accWrite = await call('POST', '/api/revenues', { campusId, revenueDate: daysAgo(1), cashAmount: 500 });
  check('On muhasebe ciro girebiliyor', accWrite.status === 200, String(accWrite.status));
  const accCount = await call('POST', '/api/counts', { campusId, countDate: daysAgo(1) });
  check('On muhasebe sayim acamiyor (403)', accCount.status === 403, String(accCount.status));

  await page.goto(`${BASE}/#/handoverDetail/${handover.id}`);
  await page.waitForTimeout(1500);
  await page.click('button:has-text("Teslim Aldım")');
  await page.waitForSelector('.modal-backdrop');
  await page.fill('.modal input[name=verificationCode]', 'XXXXXX');
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(1200);
  const wrongCodeErr = await page.textContent('.modal .alert-danger').catch(() => '');
  check('Yanlis kod reddedildi', /eşleşmiyor|eslesmiyor/i.test(wrongCodeErr), wrongCodeErr.slice(0, 80));

  await page.fill('.modal input[name=verificationCode]', handover.verification_code);
  await page.click('.modal-foot .btn-primary');
  await page.waitForTimeout(2000);
  const confirmed = await call('GET', `/api/handovers/${handover.id}`);
  check('Dogru kodla onaylandi', confirmed.data.status === 'ONAYLANDI', confirmed.data.status);
  check('Onaylayan kaydedildi', confirmed.data.confirmed_by_name === 'UI Ön Muhasebe', confirmed.data.confirmed_by_name);

  /* ----------------------------------------------------------------
   * FIS SILME: yalnizca SISTEM YONETICISI
   *
   * Fis imzalanmis bir kagidin sistemdeki karsiligidir. Silme yetkisi
   * genel mudurluk ve on muhasebe icin bile fazla agirdir; ama yanlis
   * acilmis bir fisin de bir cikisi olmali.
   * ---------------------------------------------------------------- */
  console.log('\n8) Fis silme yalnizca sistem yoneticisinde');

  // Su an ON MUHASEBE olarak giriliyiz (onceki adimda onayladik)
  await page.goto(`${BASE}/#/handoverDetail/${handover.id}`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  check('On muhasebe silme dugmesini GORMUYOR', !(await page.$('button:has-text("Fişi Sil")')));

  // Arayuzu atlayan bir istek de reddedilmeli
  const muhSil = await call('DELETE', `/api/handovers/${handover.id}`,
    { reason: 'arayuzu atlayan istek denemesi', documentNo: handover.document_no });
  check('Sunucu on muhasebeyi reddediyor (403)', muhSil.status === 403, String(muhSil.status));

  await login(ADMIN);
  await page.goto(`${BASE}/#/handoverDetail/${handover.id}`, { waitUntil: 'networkidle' });
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  const silDugmesi = await page.$('button:has-text("Fişi Sil")');
  check('Sistem yoneticisi silme dugmesini GORUYOR', !!silDugmesi);

  if (silDugmesi) {
    await silDugmesi.click();
    await page.waitForSelector('.modal-backdrop');
    await page.waitForTimeout(600);
    const pencere = await page.textContent('.modal-body');
    check('Ne silinecegi sayiliyor', /gün/.test(pencere), pencere.slice(0, 300));
    check('Gerekce isteniyor', !!(await page.$('.modal textarea[name=reason]')));
    check('Belge no dogrulamasi isteniyor', !!(await page.$('.modal input[name=documentNo]')));

    // Yanlis belge no ile SILINMEMELI
    await page.fill('.modal textarea[name=reason]', 'Yanlış dönemle açıldı, yeniden düzenlenecek');
    await page.fill('.modal input[name=documentNo]', 'YANLIS-NO');
    await page.click('.modal-foot .btn-primary');
    await page.waitForTimeout(1500);
    const hataMetni = await page.textContent('.modal .alert-danger').catch(() => '');
    check('Yanlis belge no reddedildi', /eşleşmedi|eslesmedi/i.test(hataMetni), hataMetni.slice(0, 200));

    // Dogru belge no ile silinir ve gunler serbest kalir
    await page.fill('.modal input[name=documentNo]', handover.document_no);
    await page.click('.modal-foot .btn-primary');
    await page.waitForTimeout(2500);
    const silindi = await call('GET', `/api/handovers/${handover.id}`);
    check('Dogru belge no ile silindi', silindi.status === 404, String(silindi.status));

    const bekleyen = await call('GET', `/api/handovers/pending?campusId=${campusId}`);
    const grup = (bekleyen.data.items || []).find((g) => g.campusId === campusId);
    check('Gunler bekleyenler listesine dondu', !!grup && grup.dayCount >= 3,
      JSON.stringify(grup || 'grup yok').slice(0, 200));
  }

  check('Tarayici hatasi yok', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
} catch (err) {
  console.error('\nTest calistirilamadi:', err.message);
  problems.push(err.message);
} finally {
  await browser.close();
}

console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
