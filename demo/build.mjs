/**
 * Demo paketini üretir: public/ altındaki gerçek arayüzü alır, sunucu
 * iletişim katmanını tarayıcı içi demo sunucusuyla değiştirir ve claude.ai
 * Artifact biçiminde tek bir index.html + yan dosyalar üretir.
 *
 * Kullanım: node demo/build.mjs
 * Çıktı:    demo/dist/
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'demo', 'dist');

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(DIST, 'js', 'pages'), { recursive: true });
fs.mkdirSync(path.join(DIST, 'js', 'demo'), { recursive: true });

const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');
const write = (rel, content) => fs.writeFileSync(path.join(DIST, rel), content, 'utf8');

/* ------------------- Arayüz dosyalarını kopyala -------------------- */
for (const file of ['app.js', 'ui.js', 'xlsx.js', 'efatura.js']) {
  let source = read('public', 'js', file);

  if (file === 'app.js') {
    // 1) Demo, izleyicinin temasıyla açılsın (Artifact açık/koyu temayı barındırandan alır)
    source = source.replace(
      "applyTheme(localStorage.getItem('kantin_theme') || 'light');",
      "applyTheme(safeGet('kantin_theme')\n    || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));"
    );
    // 2) Gizli sekmede / depolama kapalıyken localStorage hata fırlatabilir
    source = source
      .replace("localStorage.setItem('kantin_theme', next);", "safeSet('kantin_theme', next);")
      .replace("localStorage.setItem('kantin_campus', e.target.value);", "safeSet('kantin_campus', e.target.value);")
      .replace("const saved = localStorage.getItem('kantin_campus');", "const saved = safeGet('kantin_campus');");
    source = source.replace(
      'export const state = {',
      `/** Depolama kapalı olabilir; okuma/yazma hatası demoyu durdurmamalı. */
const safeGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const safeSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* yoksay */ } };

export const state = {`
    );
  }

  write(`js/${file}`, source);
}
for (const file of fs.readdirSync(path.join(ROOT, 'public', 'js', 'pages'))) {
  let source = read('public', 'js', 'pages', file);

  // Artifact korumalı alanı dosya indirmeyi engelliyor; şablon indirme
  // bağlantısını açıklayıcı bir notla değiştiriyoruz.
  if (file === 'import.js') {
    source = source.replace(
      /      el\('div\.btn-row', \{\}, \[\n        el\('a\.btn', \{[\s\S]*?\n      \]\),\n/,
      `      el('div.alert.alert-warning', {}, [
        el('strong', { text: 'Demoda dosya indirme kapalı' }),
        'Bu demo claude.ai korumalı alanında çalıştığı için şablon indirilemiyor. '
        + 'Şablonu sohbetten indirip buradan yükleyebilirsiniz — yükleme demoda tam olarak çalışır.',
      ]),\n`
    );
  }
  write(`js/pages/${file}`, source);
}

/* --------------------- Demo sunucusu dosyaları --------------------- */
write('js/api.js', read('demo', 'src', 'api.js'));
write('js/demo/store.js', read('demo', 'src', 'store.js'));
write('js/demo/data.js', read('demo', 'src', 'data.js'));
// Finansal hesaplar gerçek sunucudan birebir alınır
write('js/demo/money.js', read('server', 'lib', 'money.js'));

/* --------------------------- index.html ---------------------------- */
const appCss = read('public', 'css', 'app.css');
const indexHtml = read('public', 'index.html');

// public/index.html'in <body> içeriğini al (Artifact iskeleti kendi html/head/body'sini sarar)
const bodyMatch = /<body>([\s\S]*?)<\/body>/.exec(indexHtml);
if (!bodyMatch) throw new Error('public/index.html içinde <body> bulunamadı.');
let body = bodyMatch[1]
  .replace(/<script type="module" src="\/js\/app\.js"><\/script>/, '')
  .trim();

const demoCss = `
/* ----------------------- Demo uyarlamaları ------------------------ */
:root { --demo-bar: 46px; }

.demo-bar {
  position: sticky;
  top: env(safe-area-inset-top, 0px);
  z-index: 80;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 8px 16px;
  min-height: var(--demo-bar);
  background: linear-gradient(90deg, var(--brand), var(--brand-500));
  color: #fff;
  font-size: 12.5px;
}
.demo-bar strong { font-weight: 700; letter-spacing: .04em; text-transform: uppercase; font-size: 11px; }
.demo-bar .demo-text { opacity: .92; }
.demo-bar .spacer { flex: 1; }
.demo-bar button {
  border: 1px solid rgba(255,255,255,.45);
  background: rgba(255,255,255,.12);
  color: #fff;
  font: inherit;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
}
.demo-bar button:hover { background: rgba(255,255,255,.22); }

.app { min-height: calc(100dvh - var(--demo-bar)); }
.login-screen { min-height: calc(100dvh - var(--demo-bar)); }
.sidebar { height: calc(100dvh - var(--demo-bar)); top: calc(var(--demo-bar) + env(safe-area-inset-top, 0px)); }
.topbar { top: calc(var(--demo-bar) + env(safe-area-inset-top, 0px)); }

@media (max-width: 900px) {
  .sidebar { top: 0; height: 100dvh; }
}

/* Giriş ekranındaki demo hesap seçici */
.demo-accounts { display: grid; gap: 6px; margin-top: 4px; }
.demo-accounts-title {
  font-size: 11.5px; font-weight: 700; letter-spacing: .06em;
  text-transform: uppercase; color: var(--text-soft);
}
.demo-account {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 8px 10px; border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); background: var(--surface);
  font-family: inherit; font-size: 13px; color: var(--text);
  cursor: pointer; text-align: left;
}
.demo-account:hover { background: var(--surface-2); border-color: var(--brand-500); }
.demo-account .role { font-weight: 600; }
.demo-account .who { color: var(--text-muted); font-size: 12px; margin-left: auto; text-align: right; }
`;

const page = `<title>Topkapı Kantin Demo</title>
<style>
${appCss}
${demoCss}
</style>

<div class="demo-bar">
  <strong>Demo</strong>
  <span class="demo-text">
    Örnek verilerle çalışan tanıtım sürümü. Girdikleriniz yalnızca bu tarayıcıda saklanır,
    kimseye gitmez. Gerçek kurulumda veriler okulun kendi sunucusunda tutulur.
  </span>
  <span class="spacer"></span>
  <button type="button" id="demoResetBtn">Demo verisini sıfırla</button>
</div>

${body}

<script type="module" src="js/boot.js"></script>
`;
write('index.html', page);

/* ----------------------------- boot.js ----------------------------- */
write('js/boot.js', read('demo', 'src', 'boot.js'));

/* ------------------------------ Özet ------------------------------- */
const files = [];
const walk = (dir, prefix = '') => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
    else files.push({ rel, size: fs.statSync(path.join(dir, entry.name)).size });
  }
};
walk(DIST);
files.sort((a, b) => a.rel.localeCompare(b.rel));
const total = files.reduce((s, f) => s + f.size, 0);
for (const f of files) console.log(`  ${f.rel.padEnd(28)} ${String(f.size).padStart(7)} bayt`);
console.log(`\n${files.length} dosya · toplam ${(total / 1024).toFixed(0)} KB · ${DIST}`);
