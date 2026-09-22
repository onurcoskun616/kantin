/** Kampüs, kullanıcı ve denetim izi yönetimi. */
import { api } from '../api.js';
import { state } from '../app.js';
import { el, card, stat, table, fmt, badge, toast, formModal, ROLE_LABELS, empty, alertBox, shortName } from '../ui.js';

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

    // Bu açıklamalar yetkilerle BİRLİKTE güncellenmeli. Bir rolün yetkisi
    // değişip burası eski kalırsa kullanıcı ekranda yazanın aksine davranır
    // (ya da "böyle bir rol yok" sanır).
    const rolAciklama = (baslik, ozet, yapabilir = null, yapamaz = null) => [
      el('dt', { text: baslik }),
      el('dd', { style: 'text-align:left;font-weight:400' }, [
        ozet,
        yapabilir ? el('div.small', { text: `Yapabilir: ${yapabilir}`, style: 'color:var(--success);margin-top:3px' }) : null,
        yapamaz ? el('div.small', { text: `Yapamaz: ${yapamaz}`, style: 'color:var(--text-muted);margin-top:2px' }) : null,
      ]),
    ];

    container.append(card('Rol Açıklamaları', [
      el('dl.kv', {}, [
        ...rolAciklama('Sistem Yöneticisi', 'Tüm yetkiler + kullanıcı yönetimi'),
        ...rolAciklama('Genel Müdürlük', 'Tüm kampüsleri görür ve yönetir',
          null, 'yalnızca kullanıcı tanımlamada sistem yöneticisiyle aynı yetkide değil'),
        ...rolAciklama('Kampüs Yöneticisi', 'Kendi kampüsü — sayım kesinleştirebilir'),
        ...rolAciklama('Kantin Görevlisi', 'Kendi kampüsü — veri girer',
          null, 'sayım kesinleştiremez'),
        ...rolAciklama('Ön Muhasebe', 'Tüm kampüsler — VERİ GİRİŞİ rolü',
          'fatura/mal girişi, tedarikçi ve ödemeler, iadeler, ürün kartı ve fiyatlar, '
          + 'günlük ciro girişi, ciro teslim fişi onayı',
          'sayım açma/kesinleştirme, stok düzeltme ve fire, reçete, kampüs ve kullanıcı '
          + 'tanımı, belgeyi kalıcı silme'),
        ...rolAciklama('Denetçi', 'Tüm kampüsler, salt okunur',
          null, 'hiçbir kaydı değiştiremez'),
      ]),
    ], { note: 'Yetkiler sunucuda uygulanır; arayüz yalnızca kullanılamayan düğmeleri gizler.' }));

    container.append(card(null, [
      table([
        { label: 'Ad Soyad', value: (r) => r.fullName },
        { label: 'E-posta', value: (r) => r.email },
        { label: 'Rol', render: (r) => badge(ROLE_LABELS[r.role] || r.role, ['DENETCI', 'MUHASEBE'].includes(r.role) ? 'info' : '') },
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
  supplier_returns: 'Tedarikçiye iade',
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


/* =========================== Sistem Durumu ==========================
 *
 * "Sistem yavaş" şikâyeti ölçülemediği sürece çözülemez: geçen süre
 * sunucuda mı, ağda mı, tarayıcıda mı belli olmaz. Bu ekran üçünü
 * ayırır — DevTools açmadan, tek bakışta.
 * ------------------------------------------------------------------ */
export async function renderSystem(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    container.replaceChildren();
    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div', {}, [
        el('h3', { text: 'Sistem Durumu' }),
        el('p.card-note', {
          text: 'Yavaşlık yaşıyorsanız burası nerede geçtiğini söyler: sunucunun kendi '
            + 'işleme süresi, diskin yazma süresi ve ağda geçen süre ayrı ayrı ölçülür.',
        }),
      ]),
      el('button.btn', { text: '↻ Yenile', onclick: draw }),
    ]));

    // Ölçümün kendisi de bir istektir: süresini biz tutarız
    const t0 = performance.now();
    let sağlık = null;
    let hata = null;
    try {
      sağlık = await api.get('/api/health');
    } catch (err) {
      hata = err.message;
    }
    const turMs = Math.round(performance.now() - t0);

    if (hata) {
      container.append(card(null, [alertBox('danger', 'Sunucuya ulaşılamadı', hata)]));
      return;
    }
    if (!sağlık.db) {
      container.append(card(null, [alertBox('warning', 'Ölçüm alınamadı',
        'Sunucu ayrıntılı ölçüm döndürmedi. Sunucudaki sürüm güncel olmayabilir.')]));
      return;
    }

    const agMs = Math.max(0, turMs - Math.round(sağlık.db.readMs + sağlık.db.writeMs));
    const ton = (ms, iyi, orta) => (ms <= iyi ? 'ok' : ms <= orta ? 'warn' : 'bad');

    container.append(card(null, [
      el('div.grid.grid-4', {}, [
        stat('Gidiş-Dönüş', `${turMs} ms`, {
          sub: 'Tarayıcıdan sunucuya ve geri', tone: ton(turMs, 300, 1000),
        }),
        stat('Ağ / Vekil', `${agMs} ms`, {
          sub: 'Bu sürenin sunucuda geçmeyen kısmı', tone: ton(agMs, 300, 1000),
        }),
        stat('Veritabanı Yazma', `${sağlık.db.writeMs} ms`, {
          sub: 'Bir kaydın diske yazılması', tone: ton(sağlık.db.writeMs, 20, 100),
        }),
        stat('Disk (fsync)', sağlık.diskFsyncMs === null ? '—' : `${sağlık.diskFsyncMs} ms`, {
          sub: 'Sunucu diskinin yazma gecikmesi',
          tone: sağlık.diskFsyncMs === null ? '' : ton(sağlık.diskFsyncMs, 20, 100),
        }),
      ]),
      el('p.card-note', { text: yorum(turMs, agMs, sağlık) }),
    ]));

    container.append(card('Sunucu', [
      el('dl.kv', {}, [
        el('dt', { text: 'Çalışma süresi' }),
        el('dd', { text: sureMetni(sağlık.uptimeSeconds) }),
        el('dt', { text: 'Bellek (RSS)' }),
        el('dd', { text: `${sağlık.memoryMb.rss} MB (yığın ${sağlık.memoryMb.heapUsed} MB)` }),
        el('dt', { text: 'Node sürümü' }),
        el('dd', { text: sağlık.node }),
        el('dt', { text: 'Veritabanı' }),
        el('dd', { text: sağlık.db.path }),
      ]),
    ]));

    // Bu oturumda yapılan isteklerin süreleri
    const { sonIstekler } = await import('../api.js');
    const yavaslar = [...sonIstekler].sort((a, b) => b.toplamMs - a.toplamMs).slice(0, 15);
    container.append(card('Bu Oturumdaki En Yavaş İstekler', [
      yavaslar.length ? table([
        { label: 'İşlem', value: (r) => `${r.method} ${r.path}`, wrap: true },
        { label: 'Toplam', num: true, value: (r) => `${r.toplamMs} ms` },
        { label: 'Sunucu', num: true, value: (r) => (r.sunucuMs === null ? '—' : `${r.sunucuMs} ms`) },
        {
          label: 'Ağ', num: true,
          value: (r) => (r.sunucuMs === null ? '—' : `${Math.max(0, r.toplamMs - r.sunucuMs)} ms`),
        },
        { label: 'Durum', value: (r) => String(r.durum) },
      ], yavaslar) : empty('Henüz ölçüm yok. Birkaç sayfa gezip geri dönün.'),
    ], {
      note: '"Sunucu" sütunu sunucunun kendi işleme süresidir. Toplam süre büyük ama '
        + 'sunucu küçükse gecikme ağda ya da vekil sunucudadır — uygulamada değil.',
    }));
  }
}

/** Ölçümleri tek cümleyle yorumlar: kullanıcı rakamları yorumlamak zorunda kalmasın. */
function yorum(turMs, agMs, s) {
  if (s.uptimeSeconds < 120) {
    return `Sunucu ${s.uptimeSeconds} saniye önce başlamış. Sürekli yeniden başlıyorsa her `
      + 'istek açılış maliyetini öder; sunucu günlüğüne bakın.';
  }
  if (s.diskFsyncMs !== null && s.diskFsyncMs > 100) {
    return `Sunucu diski yavaş (fsync ${s.diskFsyncMs} ms). Kayıt işlemleri bu yüzden bekliyor; `
      + 'sunucu sağlayıcısının disk performansı ya da diskin dolu olması sebep olabilir.';
  }
  if (s.db.writeMs > 100) {
    return `Veritabanı yazma süresi yüksek (${s.db.writeMs} ms). Disk ya da dosya kilidi kaynaklı olabilir.`;
  }
  if (agMs > 1000) {
    return `Sunucu hızlı yanıt veriyor ama ağda ${agMs} ms geçiyor. Gecikme internet bağlantınızda `
      + 'ya da vekil sunucudadır (Caddy/CDN) — uygulamada değil.';
  }
  if (turMs > 1000) return `Gidiş-dönüş ${turMs} ms. Bağlantı yavaş ama sunucu sağlıklı.`;
  return 'Sunucu ve disk normal hızda çalışıyor.';
}

function sureMetni(saniye) {
  const g = Math.floor(saniye / 86400);
  const s = Math.floor((saniye % 86400) / 3600);
  const d = Math.floor((saniye % 3600) / 60);
  if (g) return `${g} gün ${s} saat`;
  if (s) return `${s} saat ${d} dakika`;
  return `${d} dakika ${saniye % 60} saniye`;
}
