/** Kampüs, kullanıcı ve denetim izi yönetimi. */
import { api } from '../api.js';
import { state } from '../app.js';
import { el, card, table, fmt, badge, toast, formModal, ROLE_LABELS, empty, alertBox, shortName} from '../ui.js';

/* ============================= Kampüsler ============================ */
export async function renderCampuses(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/campuses');
    container.replaceChildren();
    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div', {}, [
        el('h3', { text: 'Kampüsler' }),
        el('p.card-note', { text: 'Öğrenci sayısı, öğrenci başına ciro göstergelerinin hesaplanmasında kullanılır; güncel tutun.' }),
      ]),
      el('button.btn.btn-primary', { text: '+ Yeni Kampüs', onclick: () => openForm(null, draw) }),
    ]));

    container.append(card(null, [
      table([
        { label: 'Kod', value: (r) => r.code },
        { label: 'Kampüs', value: (r) => r.name, wrap: true },
        { label: 'Öğrenci', num: true, value: (r) => fmt.int(r.student_count) },
        { label: 'Telefon', value: (r) => r.phone || '—' },
        { label: 'Okul Payı', num: true, value: (r) => (r.rent_share_pct ? fmt.pct(r.rent_share_pct) : '—') },
        { label: 'Durum', render: (r) => (r.is_active ? badge('Aktif', 'ok') : badge('Pasif')) },
        { label: '', render: (r) => el('button.btn.btn-sm', { text: 'Düzenle', onclick: () => openForm(r, draw) }) },
      ], data.items),
    ], { tight: true }));
  }

  function openForm(campus, onDone) {
    formModal({
      title: campus ? `Kampüs Düzenle — ${campus.name}` : 'Yeni Kampüs',
      fields: [
        { name: 'code', label: 'Kampüs kodu', value: campus?.code ?? '', required: true, hint: 'Kısa kod, örn. MRK' },
        { name: 'name', label: 'Kampüs adı', value: campus?.name ?? '', required: true },
        { name: 'studentCount', label: 'Öğrenci sayısı', type: 'number', min: '0', value: campus?.student_count ?? 0 },
        { name: 'phone', label: 'Telefon', value: campus?.phone ?? '' },
        { name: 'address', label: 'Adres', type: 'textarea', value: campus?.address ?? '' },
        { name: 'rentSharePct', label: 'Okul pay oranı (%)', type: 'number', step: '0.01', min: '0', max: '100',
          value: campus?.rent_share_pct ?? 0, hint: 'Kantin işletmecisi ciro üzerinden okula pay veriyorsa oranı girin.' },
        { name: 'isActive', label: 'Aktif', type: 'checkbox', value: campus ? !!campus.is_active : true },
      ],
      submitText: campus ? 'Güncelle' : 'Ekle',
      onSubmit: async (v) => {
        if (campus) await api.put(`/api/campuses/${campus.id}`, v);
        else await api.post('/api/campuses', v);
        toast('Kaydedildi.');
        onDone();
      },
    });
  }
}

/* ============================ Kullanıcılar ========================== */
export async function renderUsers(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const [data, campuses] = await Promise.all([api.get('/api/users'), api.get('/api/campuses')]);
    container.replaceChildren();

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('h3', { text: 'Kullanıcılar ve Yetkiler' }),
      el('button.btn.btn-primary', { text: '+ Yeni Kullanıcı', onclick: () => openForm(null, campuses.items, draw) }),
    ]));

    container.append(card('Rol Açıklamaları', [
      el('dl.kv', {}, [
        el('dt', { text: 'Sistem Yöneticisi' }), el('dd', { text: 'Tüm yetkiler + kullanıcı yönetimi', style: 'text-align:left;font-weight:400' }),
        el('dt', { text: 'Genel Müdürlük' }), el('dd', { text: 'Tüm kampüsleri görür ve yönetir', style: 'text-align:left;font-weight:400' }),
        el('dt', { text: 'Kampüs Yöneticisi' }), el('dd', { text: 'Kendi kampüsü — sayım kesinleştirebilir', style: 'text-align:left;font-weight:400' }),
        el('dt', { text: 'Kantin Görevlisi' }), el('dd', { text: 'Kendi kampüsü — veri girer, sayım kesinleştiremez', style: 'text-align:left;font-weight:400' }),
        el('dt', { text: 'Denetçi' }), el('dd', { text: 'Tüm kampüsler, salt okunur', style: 'text-align:left;font-weight:400' }),
      ]),
    ]));

    container.append(card(null, [
      table([
        { label: 'Ad Soyad', value: (r) => r.fullName },
        { label: 'E-posta', value: (r) => r.email },
        { label: 'Rol', render: (r) => badge(ROLE_LABELS[r.role] || r.role, r.role === 'DENETCI' ? 'info' : '') },
        { label: 'Kampüs', value: (r) => (r.campusName ? shortName(r.campusName) : 'Tüm kampüsler') },
        { label: 'Son Giriş', value: (r) => fmt.dateTime(r.lastLoginAt) },
        { label: 'Durum', render: (r) => (r.isActive ? badge('Aktif', 'ok') : badge('Pasif', 'bad')) },
        {
          label: '', render: (r) => el('div.btn-row', {}, [
            el('button.btn.btn-sm', { text: 'Düzenle', onclick: () => openForm(r, campuses.items, draw) }),
            el('button.btn.btn-sm', { text: 'Parola Sıfırla', onclick: () => resetPassword(r) }),
          ]),
        },
      ], data.items),
    ], { tight: true }));
  }

  function openForm(user, campuses, onDone) {
    formModal({
      title: user ? `Kullanıcı Düzenle — ${user.fullName}` : 'Yeni Kullanıcı',
      fields: [
        { name: 'fullName', label: 'Ad Soyad', value: user?.fullName ?? '', required: true },
        { name: 'email', label: 'E-posta', type: 'email', value: user?.email ?? '', required: true },
        { name: 'role', label: 'Rol', type: 'select', value: user?.role ?? 'KANTIN_GOREVLISI',
          options: Object.entries(ROLE_LABELS).map(([value, label]) => ({ value, label })) },
        { name: 'campusId', label: 'Kampüs', type: 'select', value: user?.campusId ?? '',
          options: [{ value: '', label: 'Tüm kampüsler (yönetim rolleri)' }, ...campuses.map((c) => ({ value: c.id, label: shortName(c.name) }))],
          hint: 'Kampüs yöneticisi ve kantin görevlisi için zorunludur.' },
        ...(user ? [] : [{ name: 'password', label: 'Başlangıç parolası', type: 'password', required: true, hint: 'En az 8 karakter.' }]),
        { name: 'isActive', label: 'Aktif', type: 'checkbox', value: user ? user.isActive : true },
      ],
      submitText: user ? 'Güncelle' : 'Kullanıcı Oluştur',
      onSubmit: async (v) => {
        if (user) await api.put(`/api/users/${user.id}`, v);
        else await api.post('/api/users', v);
        toast('Kaydedildi.');
        onDone();
      },
    });
  }

  function resetPassword(user) {
    formModal({
      title: `Parola Sıfırla — ${user.fullName}`,
      fields: [{ name: 'password', label: 'Yeni parola', type: 'password', required: true, hint: 'En az 8 karakter. Kullanıcının açık oturumları kapatılır.' }],
      submitText: 'Parolayı Sıfırla',
      onSubmit: async (v) => {
        await api.post(`/api/users/${user.id}/reset-password`, v);
        toast('Parola sıfırlandı.');
      },
    });
  }
}

/* ============================ Denetim izi =========================== */
const ACTION_LABELS = {
  LOGIN: 'Giriş yaptı', LOGOUT: 'Çıkış yaptı', LOGIN_FAILED: 'Başarısız giriş denemesi',
  CREATE: 'Kayıt oluşturdu', UPDATE: 'Kayıt güncelledi', DELETE: 'Kayıt sildi',
  FINALIZE: 'Sayımı kesinleştirdi', CANCEL: 'Belgeyi iptal etti', DEACTIVATE: 'Pasife aldı',
  BULK_IMPORT: 'Toplu içeri aktarım', BULK_SAVE: 'Toplu kayıt', OPENING_STOCK: 'Açılış stoğu girdi',
  CHANGE_PASSWORD: 'Parola değiştirdi', RESET_PASSWORD: 'Parola sıfırladı',
};
const ENTITY_LABELS = {
  users: 'Kullanıcı', campuses: 'Kampüs', products: 'Ürün', categories: 'Kategori',
  suppliers: 'Tedarikçi', purchases: 'Alım belgesi', waste_records: 'Fire', transfers: 'Transfer',
  counts: 'Sayım', daily_revenues: 'Günlük ciro', campus_products: 'Kampüs fiyatı',
  stock_movements: 'Stok hareketi', supplier_payments: 'Tedarikçi ödemesi',
};

export async function renderAudit(root) {
  const filters = { entity: '', limit: 300 };
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/audit', filters);
    container.replaceChildren();

    const entitySelect = el('select', {}, [
      el('option', { value: '' }, ['Tüm kayıt türleri']),
      ...Object.entries(ENTITY_LABELS).map(([value, label]) => el('option', { value, selected: value === filters.entity }, [label])),
    ]);
    entitySelect.addEventListener('change', () => { filters.entity = entitySelect.value; draw(); });

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div', {}, [
        el('h3', { text: 'Denetim İzi' }),
        el('p.card-note', { text: 'Sistemde yapılan her değişiklik kullanıcı, tarih ve detayıyla kaydedilir. Bu kayıtlar silinemez.' }),
      ]),
      entitySelect,
    ]));

    container.append(card(null, [
      table([
        { label: 'Zaman', value: (r) => fmt.dateTime(r.created_at) },
        { label: 'Kullanıcı', value: (r) => r.user_email || '—' },
        { label: 'İşlem', render: (r) => badge(ACTION_LABELS[r.action] || r.action, r.action === 'LOGIN_FAILED' ? 'bad' : r.action === 'FINALIZE' ? 'ok' : '') },
        { label: 'Kayıt Türü', value: (r) => ENTITY_LABELS[r.entity] || r.entity },
        { label: 'Kayıt No', value: (r) => (r.entity_id ? `#${r.entity_id}` : '—') },
        { label: 'IP', value: (r) => r.ip || '—' },
        { label: 'Detay', value: (r) => (r.detail ? String(r.detail).slice(0, 120) : '—'), wrap: true },
      ], data.items, { emptyText: 'Kayıt yok.' }),
    ], { tight: true }));
  }
}

