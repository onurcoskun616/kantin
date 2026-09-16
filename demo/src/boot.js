/**
 * Demo açılış betiği.
 * Uygulamayı başlatır, demo çubuğunu ve giriş ekranındaki hesap seçiciyi bağlar.
 */
import { demoAccounts, resetDemo } from './demo/store.js';
import { toast, el, ROLE_LABELS } from './ui.js';

// Uygulama kabuğu (app.js) yüklendiğinde kendini başlatır
import './app.js';

/* ------------------------ Demo hesap seçici ------------------------ */
const ACCOUNT_ORDER = ['ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI', 'KANTIN_GOREVLISI', 'DENETCI'];

function mountAccountPicker() {
  const form = document.getElementById('loginForm');
  if (!form || form.querySelector('.demo-accounts')) return;

  const accounts = demoAccounts()
    .sort((a, b) => ACCOUNT_ORDER.indexOf(a.role) - ACCOUNT_ORDER.indexOf(b.role));

  // Her rolden bir örnek göster; liste uzayıp giriş ekranını boğmasın
  const seen = new Set();
  const picks = accounts.filter((a) => {
    if (seen.has(a.role)) return false;
    seen.add(a.role);
    return true;
  });

  const list = el('div.demo-accounts', {}, [
    el('div.demo-accounts-title', { text: 'Demo hesapları — tıklayın, parola gerekmez' }),
    ...picks.map((a) => el('button.demo-account', {
      type: 'button',
      onclick: () => {
        form.email.value = a.email;
        form.password.value = 'demo';
        form.requestSubmit();
      },
    }, [
      el('span.role', { text: ROLE_LABELS[a.role] || a.role }),
      el('span.who', { text: a.campusName ? shortCampus(a.campusName) : a.fullName }),
    ])),
    el('p.login-hint', {
      style: 'margin:2px 0 0;text-align:left',
      text: 'Rolleri deneyerek yetki farklarını görebilirsiniz: kantin görevlisi sayımı kesinleştiremez, denetçi hiçbir kaydı değiştiremez.',
    }),
  ]);

  form.querySelector('.login-hint')?.replaceWith(list);
}

const shortCampus = (name) => String(name).replace(/^\s*Topkapı\s+Okulları\s*[-–—]\s*/i, '');

/* --------------------------- Demo çubuğu --------------------------- */
document.getElementById('demoResetBtn')?.addEventListener('click', () => {
  const ok = window.confirm(
    'Demo verisi başlangıç haline dönecek. Girdiğiniz kayıtlar silinecek. Devam edilsin mi?'
  );
  if (!ok) return;
  resetDemo();
  try { sessionStorage.removeItem('kantin_demo_token'); } catch { /* yoksay */ }
  window.location.hash = '';
  window.location.reload();
});

window.addEventListener('demo:download-blocked', () => {
  toast(
    'Demo sürümünde dosya indirme kapalıdır (tarayıcı korumalı alanı engelliyor). '
    + 'Kurulu sürümde bu düğme Excel dosyasını indirir.',
    'warning', 6000
  );
});

/* Giriş ekranı görünür olduğunda hesap seçiciyi yerleştir */
mountAccountPicker();
new MutationObserver(() => {
  if (!document.getElementById('loginScreen')?.hidden) mountAccountPicker();
}).observe(document.getElementById('loginScreen'), { attributes: true, attributeFilter: ['hidden'] });
