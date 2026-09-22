/**
 * Arayuz regresyon testi: SISTEM DURUMU ve ISTEK SURESI OLCUMU.
 *
 * "Sistem yavas" sikayeti olculemedigi surece cozulemez. Bu ekran gecen
 * surenin NEREDE gectigini ayirir: sunucunun kendi isleme suresi, diskin
 * yazma suresi ve agda gecen sure.
 *
 * Kontrol edilen zincir:
 *   Sunucu her yanitta Server-Timing gonderiyor -> istemci bunu okuyup
 *   sure kaydi tutuyor -> Sistem Durumu ekrani olcumleri ve yorumu
 *   gosteriyor -> en yavas istekler listeleniyor.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/index.js &
 *   node test/ui/sistem-durumu.mjs [http://127.0.0.1:3000]
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

console.log('\n1) Sunucu her yanitta kendi suresini bildiriyor');
const baslik = await page.evaluate(async () => {
  const t = localStorage.getItem('kantin_token');
  const r = await fetch('/api/products', { headers: { Authorization: `Bearer ${t}` } });
  return r.headers.get('Server-Timing');
});
ok('Server-Timing basligi var', /dur=[\d.]+/.test(baslik || ''), String(baslik));

console.log('\n2) Saglik ucu OTURUMSUZ ayrinti vermiyor');
// credentials: 'omit' -> cerez de gitmez, gercekten oturumsuz istek
const acik = await page.evaluate(async () => (await (await fetch('/api/health', { credentials: 'omit' })).json()));
ok('Oturumsuz yanit sade (ic bilgi sizmiyor)', acik.ok === true && !acik.db, JSON.stringify(acik));

const kapali = await page.evaluate(async () => {
  const t = localStorage.getItem('kantin_token');
  return (await (await fetch('/api/health', { headers: { Authorization: `Bearer ${t}` } })).json());
});
ok('Oturumlu yanit olcum veriyor', !!kapali.db, JSON.stringify(kapali).slice(0, 200));
ok('Veritabani okuma suresi olculuyor', typeof kapali.db.readMs === 'number', String(kapali.db?.readMs));
ok('Veritabani yazma suresi olculuyor', typeof kapali.db.writeMs === 'number', String(kapali.db?.writeMs));
ok('Calisma suresi bildiriliyor', typeof kapali.uptimeSeconds === 'number', String(kapali.uptimeSeconds));

// Yetkisiz rol olcum GORMEZ: sunucu ic bilgisi herkese acik olmamali
const eposta = `perf-gorevli-${Date.now()}@topkapiokullari.com`;
await page.evaluate(async (e) => {
  const t = localStorage.getItem('kantin_token');
  const kampus = (await (await fetch('/api/campuses', { headers: { Authorization: `Bearer ${t}` } })).json()).items[0].id;
  await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
    body: JSON.stringify({ email: e, fullName: 'Perf Görevli', role: 'KANTIN_GOREVLISI', campusId: kampus, password: 'Gorevli12345' }),
  });
}, eposta);
const gorevli = await page.evaluate(async (e) => {
  const g = await (await fetch('/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: e, password: 'Gorevli12345' }),
  })).json();
  return (await (await fetch('/api/health', {
    credentials: 'omit', headers: { Authorization: `Bearer ${g.token}` },
  })).json());
}, eposta);
ok('Kantin gorevlisi olcum GORMUYOR', !gorevli.db, JSON.stringify(gorevli).slice(0, 200));

console.log('\n3) Sistem Durumu ekrani');
await page.evaluate(() => { location.hash = '#/system'; });
await page.waitForTimeout(2500);
const ekran = await page.textContent('#pageContent');
ok('Gidis-donus suresi gosteriliyor', /Gidiş-Dönüş/.test(ekran), ekran.slice(0, 300));
ok('Ag/vekil suresi ayri gosteriliyor', /Ağ \/ Vekil/.test(ekran), ekran.slice(0, 300));
ok('Veritabani yazma suresi gosteriliyor', /Veritabanı Yazma/.test(ekran), ekran.slice(0, 400));
ok('Disk gecikmesi gosteriliyor', /Disk \(fsync\)/.test(ekran), ekran.slice(0, 400));
ok('Rakamlar YORUMLANIYOR', /normal hızda|yavaş|Gidiş-dönüş \d+ ms|saniye önce başlamış/.test(ekran),
  ekran.slice(0, 700));
ok('Sunucu kunyesi var', /Çalışma süresi/.test(ekran) && /Node sürümü/.test(ekran));
ok('En yavas istekler listeleniyor', /En Yavaş İstekler/.test(ekran));
ok('Sunucu ve ag sutunlari ayri', /Sunucu/.test(ekran) && /Ağ/.test(ekran));

console.log('\n4) Menude yalnizca yoneticiye gorunuyor');
const menu = await page.textContent('#sidebar');
ok('Yonetici menude goruyor', /Sistem Durumu/.test(menu), menu.slice(-200));

await b.close();
console.log(problems.length ? `\n${problems.length} kontrol basarisiz.\n` : '\nTum kontroller gecti.\n');
process.exit(problems.length ? 1 : 0);
