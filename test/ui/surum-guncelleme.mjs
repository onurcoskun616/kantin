/**
 * Arayuz regresyon testi: SURUM ve GUNCELLEME BILDIRIMI.
 *
 * Uygulama kendi kendini GUNCELLEMEZ -- bunun icin konteynere Docker
 * yetkisi vermek gerekirdi ve o an uygulamadaki herhangi bir acik
 * sunucunun tamamini ele gecirmeye donusurdu. Bu ekran yalnizca "yeni
 * surum var" der ve calistirilacak komutu verir.
 *
 * Kontrol edilen zincir:
 *   Calisan surum ekranda yaziyor -> GitHub ile karsilastiriliyor ->
 *   geride kalindiysa bekleyen degisiklikler listeleniyor ve komut
 *   kopyalanabilir sekilde veriliyor -> ekranda "guncelle" diye bir sey
 *   CALISTIRMIYOR.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim (KANTIN_GITHUB_API ile taklit sunucuya baglanmis olmali):
 *   node test/ui/surum-guncelleme.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';

const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1050 }, permissions: [] });
const page = await ctx.newPage();
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

console.log('\n1) Yetki: olcum ve surum yalnizca yoneticiye');
const gorevliYanit = await page.evaluate(async () => {
  const t = localStorage.getItem('kantin_token');
  const kampus = (await (await fetch('/api/campuses', { headers: { Authorization: `Bearer ${t}` } })).json()).items[0].id;
  const e = `surum-gorevli-${Date.now()}@topkapiokullari.com`;
  await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ email: e, fullName: 'Sürüm Görevli', role: 'KANTIN_GOREVLISI', campusId: kampus, password: 'Gorevli12345' }),
  });
  const g = await (await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Gorevli12345' }),
  })).json();
  const r = await fetch('/api/health/guncelleme', {
    credentials: 'omit', headers: { Authorization: `Bearer ${g.token}` },
  });
  return r.status;
});
ok('Kantin gorevlisi guncelleme bilgisi GOREMIYOR', gorevliYanit === 403, String(gorevliYanit));

console.log('\n2) Sistem Durumu: calisan surum');
await page.evaluate(() => { location.hash = '#/system'; });
await page.waitForTimeout(3000);
const ekran = await page.textContent('#pageContent');
ok('Calisan surum yaziyor', /Çalışan sürüm/.test(ekran), ekran.slice(0, 400));
ok('Surum tarihi ve kurulum zamani var',
  /Sürüm tarihi/.test(ekran) && /Kurulum zamanı/.test(ekran));

// Sunucunun hangi durumda oldugunu API'den ogrenip ONA gore dogrulariz:
// "geride kalindi" ve "kontrol edilemedi" ikisi de gercek durumlardir.
const durum = await page.evaluate(async () => {
  const t = localStorage.getItem('kantin_token');
  return (await (await fetch('/api/health/guncelleme', { headers: { Authorization: `Bearer ${t}` } })).json());
});

if (durum.kontrolEdilemedi) {
  console.log(`  (kontrol edilemiyor: ${durum.kontrolEdilemedi})`);
  ok('Kontrol edilemedigi EKRANDA soyleniyor',
    /Güncelleme kontrol edilemedi/.test(ekran), ekran.slice(0, 900));
  ok('Ekran yine de cizildi (kirilmadi)', /Çalışan sürüm/.test(ekran));
} else if (durum.guncel) {
  ok('Surum guncel deniyor', /Sürüm güncel/.test(ekran), ekran.slice(0, 900));
} else {
  ok('Yeni degisiklik uyarisi cikti', /yeni değişiklik var/.test(ekran), ekran.slice(0, 900));
  ok('Bekleyen degisiklikler listeleniyor',
    /Bekleyen değişiklikler/.test(ekran), ekran.slice(0, 1200));
  const ilk = durum.bekleyenler[0]?.subject;
  const son = durum.bekleyenler.at(-1)?.subject;
  ok('En yeni degisiklik EN USTTE',
    !ilk || !son || ilk === son || ekran.indexOf(ilk) < ekran.indexOf(son),
    `${ilk} / ${son}`);

  console.log('\n3) Guncelleme komutu veriliyor, CALISTIRILMIYOR');
  const komut = await page.textContent('pre.kod').catch(() => '');
  ok('kur.sh komutu gosteriliyor', /kur\.sh/.test(komut), komut.slice(0, 200));
  ok('Iki satirin ikisi de var',
    /curl -fsSL/.test(komut) && /sudo bash \/tmp\/kur\.sh/.test(komut), komut.slice(0, 200));
  ok('Kopyala dugmesi var', !!(await page.$('button:has-text("Komutu kopyala")')));
  ok('Neden uygulamadan calistirilmadigi aciklanmis',
    /kendi kendini güncelleyemez/.test(ekran), ekran.slice(0, 1500));
}
// Guncellemeyi TETIKLEYEN bir uc olmamali
const tetikleme = await page.evaluate(async () => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch('/api/health/guncelle', {
    method: 'POST', headers: { Authorization: `Bearer ${t}` },
  });
  return r.status;
});
ok('Guncellemeyi CALISTIRAN bir uc YOK', tetikleme === 404, String(tetikleme));

console.log('\n4) Tekrar kontrol dugmesi calisiyor');
await page.click('button:has-text("Güncellemeleri kontrol et")');
await page.waitForTimeout(2500);
const sonra = await page.textContent('#pageContent');
ok('Ekran kontrolden sonra da saglam', /Çalışan sürüm/.test(sonra), sonra.slice(0, 400));
if (!durum.kontrolEdilemedi) {
  ok('Son kontrol zamani yaziyor', /Son kontrol:/.test(sonra), sonra.slice(0, 600));
}

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
