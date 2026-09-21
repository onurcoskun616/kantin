/** Uygulama kabugu: oturum, gezinme, sayfa yukleme. */
import { api, auth, ApiError } from './api.js';
import { el, clear, toast, modal, formModal, loading, ROLE_LABELS, dateUtil, shortName } from './ui.js';

export const state = {
  user: null,
  campuses: [],
  campusId: null,     // secili kampus (null = tumu)
  month: dateUtil.thisMonth(),
  page: 'dashboard',
};

/* ------------------------------ Menu ------------------------------- */
const NAV = [
  { group: 'Genel' },
  { id: 'dashboard', label: 'Panel', icon: '📊' },
  { group: 'Günlük İşlemler' },
  { id: 'revenues', label: 'Günlük Ciro', icon: '💰' },
  { id: 'handovers', label: 'Ciro Teslim Fişi', icon: '🧾' },
  { id: 'purchases', label: 'Mal Girişi (Alım)', icon: '🚚' },
  { id: 'returns', label: 'Tedarikçiye İade', icon: '↩️' },
  { id: 'waste', label: 'Fire / Zayiat', icon: '🗑️' },
  { id: 'transfers', label: 'Kampüsler Arası Transfer', icon: '🔁' },
  { group: 'Stok ve Sayım' },
  { id: 'stock', label: 'Stok Durumu', icon: '📦' },
  { id: 'counts', label: 'Sayım / Envanter', icon: '🧾' },
  { group: 'Tanımlar' },
  { id: 'products', label: 'Ürünler ve Fiyatlar', icon: '🏷️' },
  { id: 'recipes', label: 'Reçeteler', icon: '📋' },
  { id: 'suppliers', label: 'Tedarikçiler', icon: '🏭' },
  { group: 'Raporlar' },
  { id: 'reports', label: 'Raporlar', icon: '📈' },
  { group: 'Yönetim', roles: ['ADMIN', 'GENEL_MUDURLUK', 'DENETCI'] },
  { id: 'campuses', label: 'Kampüsler', icon: '🏫', roles: ['ADMIN', 'GENEL_MUDURLUK'] },
  { id: 'users', label: 'Kullanıcılar', icon: '👥', roles: ['ADMIN', 'GENEL_MUDURLUK'] },
  { id: 'audit', label: 'Denetim İzi', icon: '🔍', roles: ['ADMIN', 'GENEL_MUDURLUK', 'DENETCI'] },
];

/** Menude yer almayan detay sayfalarinin baslik karsiliklari. */
const DETAIL_TITLES = {
  countDetail: 'Sayım Detayı',
  handoverDetail: 'Teslim Fişi',
};

const PAGE_LOADERS = {
  dashboard: () => import('./pages/dashboard.js'),
  revenues: () => import('./pages/revenues.js'),
  handovers: () => import('./pages/handovers.js'),
  handoverDetail: () => import('./pages/handovers.js').then((m) => ({ render: m.renderDetail })),
  purchases: () => import('./pages/purchases.js'),
  returns: () => import('./pages/returns.js'),
  waste: () => import('./pages/movements.js').then((m) => ({ render: m.renderWaste })),
  transfers: () => import('./pages/movements.js').then((m) => ({ render: m.renderTransfers })),
  stock: () => import('./pages/stock.js'),
  counts: () => import('./pages/counts.js'),
  countDetail: () => import('./pages/counts.js').then((m) => ({ render: m.renderDetail })),
  products: () => import('./pages/catalog.js').then((m) => ({ render: m.renderProducts })),
  recipes: () => import('./pages/recipes.js'),
  suppliers: () => import('./pages/catalog.js').then((m) => ({ render: m.renderSuppliers })),
  reports: () => import('./pages/reports.js'),
  campuses: () => import('./pages/admin.js').then((m) => ({ render: m.renderCampuses })),
  users: () => import('./pages/admin.js').then((m) => ({ render: m.renderUsers })),
  audit: () => import('./pages/admin.js').then((m) => ({ render: m.renderAudit })),
};

/* ---------------------------- Baslangic ---------------------------- */
const loginScreen = document.getElementById('loginScreen');
const appRoot = document.getElementById('app');

init();

async function init() {
  applyTheme(localStorage.getItem('kantin_theme') || 'light');
  document.getElementById('themeBtn').addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem('kantin_theme', next);
  });

  document.getElementById('loginForm').addEventListener('submit', onLogin);
  document.getElementById('logoutBtn').addEventListener('click', onLogout);
  document.getElementById('changePasswordBtn').addEventListener('click', openChangePassword);
  document.getElementById('menuBtn').addEventListener('click', () => document.getElementById('sidebar').classList.add('open'));
  document.getElementById('sidebarClose').addEventListener('click', closeSidebar);
  document.getElementById('campusSelect').addEventListener('change', (e) => {
    state.campusId = e.target.value ? Number(e.target.value) : null;
    localStorage.setItem('kantin_campus', e.target.value);
    navigate(state.page, state.pageParams);
  });
  window.addEventListener('auth:expired', showLogin);
  window.addEventListener('hashchange', onHashChange);

  if (auth.token) {
    try {
      await loadSession();
      return;
    } catch { /* oturum gecersiz, giris ekranina dus */ }
  }
  showLogin();
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
}

async function onLogin(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const errorBox = document.getElementById('loginError');
  const btn = form.querySelector('button[type=submit]');
  errorBox.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Giriş yapılıyor...';
  try {
    const data = await api.post('/api/auth/login', {
      email: form.email.value.trim(),
      password: form.password.value,
    });
    auth.token = data.token;
    form.reset();
    await loadSession();
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Giriş Yap';
  }
}

async function onLogout() {
  try { await api.post('/api/auth/logout'); } catch { /* yoksay */ }
  auth.token = null;
  showLogin();
}

async function loadSession() {
  const data = await api.get('/api/auth/me');
  state.user = data.user;
  auth.user = data.user;
  state.campuses = data.campuses;

  const saved = localStorage.getItem('kantin_campus');
  if (state.user.campusId) state.campusId = state.user.campusId;
  else if (saved && state.campuses.some((c) => String(c.id) === saved)) state.campusId = Number(saved);
  else state.campusId = state.campuses[0]?.id ?? null;

  renderShell();
  loginScreen.hidden = true;
  appRoot.hidden = false;
  onHashChange();
}

function showLogin() {
  appRoot.hidden = true;
  loginScreen.hidden = false;
  state.user = null;
}

/* --------------------------- Kabuk cizimi --------------------------- */
function renderShell() {
  document.getElementById('userName').textContent = state.user.fullName;
  document.getElementById('userRole').textContent = ROLE_LABELS[state.user.role] || state.user.role;
  document.getElementById('userAvatar').textContent = initials(state.user.fullName);

  const nav = clear(document.getElementById('mainNav'));
  for (const item of NAV) {
    if (item.roles && !item.roles.includes(state.user.role)) continue;
    if (item.group) {
      nav.append(el('div.nav-group', { text: item.group }));
      continue;
    }
    nav.append(el('button.nav-item', {
      dataset: { page: item.id },
      onclick: () => { navigate(item.id); closeSidebar(); },
    }, [el('span.nav-icon', { text: item.icon }), item.label]));
  }

  const select = clear(document.getElementById('campusSelect'));
  const multi = state.campuses.length > 1;
  for (const c of state.campuses) {
    select.append(el('option', { value: c.id, selected: c.id === state.campusId }, [shortName(c.name)]));
  }
  document.getElementById('campusSelectWrap').hidden = !multi;
}

function initials(name) {
  return String(name).split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
}

function closeSidebar() { document.getElementById('sidebar').classList.remove('open'); }

/* ---------------------------- Gezinme ------------------------------ */
function onHashChange() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [page, ...rest] = hash.split('/');
  navigate(page || 'dashboard', rest, true);
}

export function navigate(page, params = [], fromHash = false) {
  if (!PAGE_LOADERS[page]) page = 'dashboard';
  state.page = page;
  state.pageParams = params;
  if (!fromHash) {
    const target = `#/${page}${params.length ? '/' + params.join('/') : ''}`;
    if (location.hash !== target) { location.hash = target; return; }
  }

  document.querySelectorAll('.nav-item').forEach((n) => {
    n.classList.toggle('active', n.dataset.page === page
      || (page === 'countDetail' && n.dataset.page === 'counts')
      || (page === 'handoverDetail' && n.dataset.page === 'handovers'));
  });
  const navLabel = NAV.find((n) => n.id === page)?.label;
  document.getElementById('pageTitle').textContent = navLabel || DETAIL_TITLES[page] || 'Detay';

  // Her gezinme kendi kabini alir ve ekrandaki kap onunla degistirilir.
  // Sayfa render'lari asenkron: onceki sayfa verisini gec getirirse kendi
  // (artik DOM'da olmayan) kabina yazar, yenisinin uzerine binemez.
  const content = clear(document.getElementById('pageContent'));
  const host = el('div.page-host');
  content.append(host);
  host.append(loading());

  PAGE_LOADERS[page]()
    .then((mod) => mod.render(clear(host), { params }))
    .catch((err) => {
      console.error(err);
      clear(host).append(el('div.alert.alert-danger', { text: err.message || 'Sayfa yüklenemedi.' }));
      if (!(err instanceof ApiError)) toast('Sayfa yüklenirken hata oluştu.', 'error');
    });
}

/* ------------------------- Parola degistirme ----------------------- */
function openChangePassword() {
  formModal({
    title: 'Parola Değiştir',
    fields: [
      { name: 'currentPassword', label: 'Mevcut parola', type: 'password', required: true },
      { name: 'newPassword', label: 'Yeni parola', type: 'password', required: true, hint: 'En az 8 karakter olmalıdır.' },
      { name: 'repeat', label: 'Yeni parola (tekrar)', type: 'password', required: true },
    ],
    submitText: 'Parolayı Değiştir',
    onSubmit: async (v) => {
      if (v.newPassword !== v.repeat) throw new Error('Yeni parolalar eşleşmiyor.');
      await api.post('/api/auth/change-password', { currentPassword: v.currentPassword, newPassword: v.newPassword });
      toast('Parolanız güncellendi. Diğer oturumlarınız kapatıldı.');
    },
  });
}

/* ------------------------ Sayfalar icin yardim --------------------- */
/** Secili kampusun adini dondurur. */
export function campusName(id = state.campusId) {
  return state.campuses.find((c) => c.id === id)?.name ?? '—';
}

/** Kullanici yazma yetkisine sahip mi? */
/**
 * Kullanici verilen alana yazabilir mi?
 *
 * Sunucudaki `requireWrite(user, area)` ile AYNI kurallari uygular; burasi
 * yalnizca arayuzu sadelestirir, guvenlik sunucudadir.
 *
 * ON MUHASEBE bir veri girisi rolu: fatura, tedarikci, iade, urun ve ciro
 * girebilir; sayim kesinlestiremez, stok duzeltemez, tanim degistiremez.
 * Alan adi verilmezse muhasebe icin KAPALI sayilir - guvenli varsayilan.
 */
const MUHASEBE_ALANLARI = ['purchases', 'suppliers', 'returns', 'products', 'revenues'];

export function canWrite(area = null) {
  if (!state.user || state.user.role === 'DENETCI') return false;
  if (state.user.role === 'MUHASEBE') return !!area && MUHASEBE_ALANLARI.includes(area);
  return true;
}

/** Alim belgesini KALICI silebilen roller (iptal etmek yetmediginde). */
export function canDeleteDocuments() {
  return state.user && ['ADMIN', 'GENEL_MUDURLUK'].includes(state.user.role);
}

/** Teslim fisini sistemde onaylayabilen roller. */
export function canConfirmHandover() {
  return state.user && ['ADMIN', 'GENEL_MUDURLUK', 'MUHASEBE'].includes(state.user.role);
}

export function isManager() {
  return state.user && ['ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI'].includes(state.user.role);
}

export { toast, modal };
