/**
 * Arayuz regresyon testi: GUNCELLE DUGMESI.
 *
 * Uygulama guncellemeyi KENDI CALISTIRMAZ: paylasimli klasore bir istek
 * dosyasi birakir, host uzerindeki systemd birimi onu gorup SABIT bir
 * komut calistirir. Konteynere Docker yetkisi verilmez.
 *
 * Kontrol edilen zincir:
 *   Calistirici kuruluysa dugme cikiyor -> onay penceresi ne olacagini
 *   soyluyor -> basinca istek birakiliyor ve ilerleme gosteriliyor ->
 *   ADMIN olmayan tetikleyemiyor -> kurulu degilse dugme yerine komut
 *   gosteriliyor.
 *
 * Gereksinim: Playwright. Sunucu KANTIN_CONTROL_DIR ile calismali.
 * Kullanim:
 *   node test/ui/guncelle-dugmesi.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

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

const api = (method, path, token) => page.evaluate(async ([m, p, t]) => {
  const r = await fetch(p, {
    method: m, credentials: 'omit',
    headers: { Authorization: `Bearer ${t || localStorage.getItem('kantin_token')}` },
  });
  return { status: r.status, data: await r.json().catch(() => ({})) };
}, [method, path, token]);

console.log('\n1) Yetki: yalnizca ADMIN tetikleyebilir');
const gt = await page.evaluate(async () => {
  const t = localStorage.getItem('kantin_token');
  const e = `gunc-gm-${Date.now()}@topkapiokullari.com`;
  await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ email: e, fullName: 'Güncelleme GM', role: 'GENEL_MUDURLUK', password: 'Mudur123456' }),
  });
  const g = await (await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Mudur123456' }),
  })).json();
  return g.token;
});
const gmTetik = await api('POST', '/api/health/guncelleme', gt);
ok('Genel mudurluk TETIKLEYEMIYOR', gmTetik.status === 403, String(gmTetik.status));
const gmDurum = await api('GET', '/api/health/guncelleme/durum', gt);
ok('Genel mudurluk durumu okuyabiliyor', gmDurum.status === 200, String(gmDurum.status));

console.log('\n2) Calistiricinin kurulu olup olmamasina gore ekran');
const c = (await api('GET', '/api/health/guncelleme/durum')).data;
await page.evaluate(() => { location.hash = '#/system'; });
await page.waitForTimeout(3000);
let ekran = await page.textContent('#pageContent');
const dugme = await page.$('button:has-text("Şimdi Güncelle")');

if (!c.kurulu) {
  // Cogu kurulumda guncelleyici KURULU DEGILDIR; o zaman dugme yerine
  // komut gosterilmeli ve nasil etkinlestirilecegi yazmali.
  console.log('  (calistirici kurulu degil — komut yolu dogrulanir)');
  ok('Dugme YOK', !dugme);
  ok('Komut gosteriliyor', /kur\.sh/.test(ekran), ekran.slice(0, 900));
  ok('Nasil etkinlestirilecegi yaziyor',
    /Tek tıkla güncelleme isterseniz/.test(ekran), ekran.slice(0, 1200));
  const t = await api('POST', '/api/health/guncelleme');
  ok('Tetikleme ACIK bir mesajla reddediliyor',
    t.status === 409 && /kurulu değil/.test(t.data.error || ''), JSON.stringify(t).slice(0, 200));
  await b.close();
  console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
  process.exit(problems.length ? 1 : 0);
}

ok('Calistirici kurulu gorunuyor', c.kurulu === true, JSON.stringify(c));
ok('Klasor yazilabilir', c.yazilabilir === true, JSON.stringify(c));
ok('"Şimdi Güncelle" dugmesi var', !!dugme, ekran.slice(0, 800));
ok('Yetkinin sinirli oldugu yaziyor',
  /hangi komutun çalışacağını/.test(ekran), ekran.slice(0, 1200));
ok('Komutla guncelleme secenegi de duruyor',
  /Komutla güncellemeyi tercih ederim/.test(ekran));

console.log('\n3) Onay penceresi ne olacagini soyluyor');
await dugme.click();
await page.waitForSelector('.modal-backdrop');
await page.waitForTimeout(500);
const onay = await page.textContent('.modal-backdrop .modal-body');
// Surum dogrulanabiliyorsa kac degisiklik oldugu, dogrulanamiyorsa neden
// yine de guvenli oldugu yazmali. Ikisi de gecerli durumdur.
ok('Ne olacagi aciklaniyor',
  /değişiklik sunucuya uygulanacak/.test(onay)
  || /son sürüme güncellenecek/.test(onay), onay.slice(0, 300));
ok('Erisilemezlik uyarisi var', /birkaç saniye erişilemez/.test(onay), onay.slice(0, 400));
ok('Yedek alinacagi soyleniyor', /otomatik yedek/.test(onay), onay.slice(0, 400));
ok('Dokunulmayanlar sayiliyor', /fatura eklerine/.test(onay), onay.slice(0, 500));

console.log('\n4) Onaylanınca istek birakiliyor');
await page.click('.modal-backdrop .btn-primary');
await page.waitForTimeout(3000);
ekran = await page.textContent('#pageContent');
ok('Ilerleme gosteriliyor',
  /Güncelleme başlatıldı|Güncelleme sürüyor|Güncelleme tamamlandı|Sunucu yeniden başlıyor/.test(ekran),
  ekran.slice(0, 600));
ok('Sayfayi kapatmama uyarisi var', /Sayfayı kapatmayın/.test(ekran), ekran.slice(0, 600));

// Kosucu isteği aldiysa dosya silinmis olmali
await page.waitForTimeout(6000);
const son = (await api('GET', '/api/health/guncelleme/durum')).data;
ok('Kosucu istegi ALDI (dosya silindi)', son.beklemede === false, JSON.stringify(son).slice(0, 200));
ok('Bir sonuc yazildi', !!son.son, JSON.stringify(son.son));

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
