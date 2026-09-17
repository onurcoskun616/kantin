import { api } from '../api.js';
import { state, canWrite, navigate } from '../app.js';
import { el, card, stat, table, fmt, badge, toast, formModal, confirmDialog, dateUtil, empty, alertBox } from '../ui.js';

export async function render(root) {
  const month = state.month;
  const [calendar, list] = await Promise.all([
    api.get('/api/revenues/calendar', { campusId: state.campusId, month }),
    api.get('/api/revenues', { campusId: state.campusId, month }),
  ]);
  root.replaceChildren();

  const monthInput = el('input', { type: 'month', value: month, style: 'width:170px' });
  monthInput.addEventListener('change', () => { state.month = monthInput.value; render(root); });

  root.append(el('div.row', { style: 'justify-content:space-between' }, [
    el('label.inline-field', {}, [el('span', { text: 'Dönem' }), monthInput]),
    el('div.btn-row', {}, [
      canWrite() ? el('button.btn.btn-primary', { text: '+ Ciro Gir', onclick: () => openForm(root, dateUtil.today()) }) : null,
      canWrite() ? el('button.btn', { text: '⚡ Toplu Giriş', onclick: () => openBulk(root, calendar) }) : null,
      el('button.btn', { text: '⬇ Excel (CSV)', onclick: () => api.download('/api/revenues', { campusId: state.campusId, month }) }),
    ]),
  ]));

  const s = list.summary;
  root.append(el('div.grid.grid-5', {}, [
    stat('Aylık Ciro', fmt.money(s.total)),
    stat('Günlük Ortalama', fmt.money(s.dailyAverage), { sub: `${s.schoolDays} okul günü` }),
    stat('Nakit / Kart', `${pct(s.cash, s.total)} / ${pct(s.card, s.total)}`, { sub: `${fmt.money(s.cash)} · ${fmt.money(s.card)}` }),
    stat('Eksik Gün', String(calendar.summary.missingCount), {
      tone: calendar.summary.missingCount > 0 ? 'bad' : 'ok',
      sub: 'Hafta içi ciro girilmemiş gün',
    }),
    stat('Ön Muhasebeye Teslim Edilmemiş', fmt.money(s.undelivered), {
      tone: s.undelivered > 0 ? 'bad' : 'ok',
      sub: s.undelivered > 0 ? `${s.undeliveredDays} gün · teslim fişi kesilmemiş` : 'Tüm günler teslim edildi',
    }),
  ]));

  if (calendar.summary.missingCount > 0) {
    root.append(alertBox('warning', 'Eksik ciro girişi var',
      'Aşağıdaki takvimde kırmızı görünen günlerde ciro girilmemiş. Sayım mutabakatının doğru çalışması için tüm okul günlerinin girilmesi gerekir.'));
  }

  if (s.undelivered > 0) {
    const box = alertBox('warning', 'Teslim edilmemiş ciro var',
      `Bu dönemde ${s.undeliveredDays} günün cirosu (${fmt.money(s.undelivered)}) henüz ön muhasebeye `
      + 'imza karşılığı teslim edilmemiş. Teslim fişi kesilene kadar bu tutar kasada bekliyor sayılır.');
    box.append(el('div', { style: 'margin-top:8px' }, [
      el('button.btn.btn-sm', { text: 'Teslim Fişi Ekranına Git', onclick: () => navigate('handovers') }),
    ]));
    root.append(box);
  }

  /* ----------------------------- Takvim ----------------------------- */
  root.append(card(`${fmt.monthName(month)} Ciro Takvimi`, [buildCalendar(root, calendar)], {
    note: 'Bir güne tıklayarak ciro girebilir veya düzeltebilirsiniz.',
  }));

  /* --------------------------- Kayıt listesi ------------------------ */
  root.append(card('Ciro Kayıtları', [
    table([
      { label: 'Tarih', value: (r) => fmt.date(r.revenue_date) },
      { label: 'Gün', value: (r) => new Date(`${r.revenue_date}T00:00:00`).toLocaleDateString('tr-TR', { weekday: 'short' }) },
      ...(state.campuses.length > 1 && !state.campusId ? [{ label: 'Kampüs', value: (r) => r.campus_name }] : []),
      { label: 'Nakit', num: true, value: (r) => fmt.money(r.cash_amount) },
      { label: 'Kart', num: true, value: (r) => fmt.money(r.card_amount) },
      { label: 'Veresiye', num: true, value: (r) => fmt.money(r.credit_amount) },
      { label: 'Diğer', num: true, value: (r) => fmt.money(r.other_amount) },
      { label: 'Toplam', num: true, render: (r) => el('strong', { text: fmt.money(r.total_amount) }) },
      { label: 'Z No', value: (r) => r.z_report_no || '—' },
      { label: 'Kaydeden', value: (r) => r.updated_by_name || r.created_by_name || '—' },
      {
        label: 'Teslim', render: (r) => (r.handover_no
          ? el('a.link', { text: r.handover_no, href: `#/handovers`, title: 'İmzalı teslim fişine dahil' })
          : badge('teslim edilmedi', 'warn')),
      },
      {
        label: '', render: (r) => {
          if (!canWrite()) return '—';
          // Imzali fise dahil gunu yalnizca genel mudurluk degistirebilir
          const locked = !!r.handover_no && !['ADMIN', 'GENEL_MUDURLUK'].includes(state.user.role);
          if (locked) return el('span.muted', { text: '🔒 imzalı', title: `${r.handover_no} numaralı teslim fişine dahil` });
          return el('div.btn-row', {}, [
            el('button.btn.btn-sm', { text: 'Düzenle', onclick: () => openForm(root, r.revenue_date, r) }),
            el('button.btn.btn-sm.btn-ghost', { text: 'Sil', onclick: () => remove(root, r) }),
          ]);
        },
      },
    ], list.items, { emptyText: 'Bu dönemde ciro kaydı yok.' }),
  ], { tight: true }));
}

function buildCalendar(root, calendar) {
  const grid = el('div', { style: 'display:grid;grid-template-columns:repeat(7,1fr);gap:6px' });
  const headers = ['Pzt', 'Sal', 'Çar', 'Per', 'Cum', 'Cmt', 'Paz'];
  for (const h of headers) {
    grid.append(el('div.small.muted', { text: h, style: 'text-align:center;font-weight:700;padding:4px 0' }));
  }
  // Ilk gunun haftanin kacinci gunu oldugunu bul (Pazartesi = 0)
  const firstWeekday = (new Date(`${calendar.from}T00:00:00Z`).getUTCDay() + 6) % 7;
  for (let i = 0; i < firstWeekday; i += 1) grid.append(el('div'));

  for (const day of calendar.days) {
    const total = day.entry?.total_amount ?? null;
    const bg = day.missing ? 'var(--danger-soft)' : day.entry ? 'var(--success-soft)' : 'var(--surface-2)';
    const border = day.missing ? 'var(--danger)' : 'var(--border)';
    const cell = el('button', {
      style: `border:1px solid ${border};background:${bg};border-radius:8px;padding:7px 6px;cursor:pointer;
              text-align:left;font-family:inherit;display:grid;gap:2px;min-height:62px;color:var(--text);opacity:${day.isWeekend && !day.entry ? .5 : 1}`,
      title: day.missing ? 'Ciro girilmemiş' : '',
      onclick: () => (canWrite() ? openForm(root, day.date, day.entry) : null),
    }, [
      el('div', { text: String(Number(day.date.slice(8, 10))), style: 'font-weight:700;font-size:13px' }),
      el('div.small', {
        text: total !== null ? fmt.money(total) : (day.isWeekend ? '' : day.missing ? 'eksik' : ''),
        style: 'font-size:10.5px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis',
      }),
    ]);
    grid.append(cell);
  }
  return grid;
}

function openForm(root, date, existing = null) {
  formModal({
    title: existing ? `Ciro Düzenle — ${fmt.date(date)}` : `Günlük Ciro Girişi — ${fmt.date(date)}`,
    fields: [
      { name: 'revenueDate', label: 'Tarih', type: 'date', value: date, required: true },
      { name: 'cashAmount', label: 'Nakit (TL)', type: 'number', step: '0.01', min: '0', value: existing?.cash_amount ?? '' },
      { name: 'cardAmount', label: 'Kredi Kartı / POS (TL)', type: 'number', step: '0.01', min: '0', value: existing?.card_amount ?? '' },
      { name: 'creditAmount', label: 'Veresiye / Öğrenci Kartı (TL)', type: 'number', step: '0.01', min: '0', value: existing?.credit_amount ?? '' },
      { name: 'otherAmount', label: 'Diğer (TL)', type: 'number', step: '0.01', min: '0', value: existing?.other_amount ?? '' },
      { name: 'zReportNo', label: 'Z Rapor / Kasa Fiş No (varsa)', value: existing?.z_report_no ?? '',
        hint: 'Yazar kasa kullanıyorsanız Z raporu numarası. Kullanmıyorsanız boş bırakın veya gün sonu kasa föyü numarasını yazın.' },
      { name: 'isSchoolDay', label: 'Normal okul günü', type: 'checkbox', value: existing ? !!existing.is_school_day : true },
      { name: 'note', label: 'Not', type: 'textarea', value: existing?.note ?? '' },
    ],
    submitText: 'Kaydet',
    onSubmit: async (v) => {
      await api.post('/api/revenues', { ...v, campusId: state.campusId, overwrite: true });
      toast('Ciro kaydedildi.');
      render(root);
    },
  });
}

function openBulk(root, calendar) {
  const missing = calendar.days.filter((d) => !d.isWeekend && d.date <= dateUtil.today());
  const inputs = new Map();
  const rows = missing.map((d) => {
    const input = el('input', {
      type: 'number', step: '0.01', min: '0', class: 'num',
      value: d.entry?.total_amount ?? '',
      placeholder: '0,00',
    });
    inputs.set(d.date, input);
    return el('tr', {}, [
      el('td', { text: fmt.date(d.date) }),
      el('td', { text: new Date(`${d.date}T00:00:00`).toLocaleDateString('tr-TR', { weekday: 'long' }) }),
      el('td', {}, [input]),
      el('td', {}, [d.entry ? badge('Girilmiş', 'ok') : badge('Eksik', 'bad')]),
    ]);
  });

  formModal({
    title: `Toplu Ciro Girişi — ${fmt.monthName(calendar.month)}`,
    wide: true,
    fields: [],
    submitText: 'Tümünü Kaydet',
    onSubmit: async () => {
      const items = [];
      for (const [date, input] of inputs) {
        const value = Number(String(input.value).replace(',', '.'));
        if (!input.value || !Number.isFinite(value) || value <= 0) continue;
        items.push({ revenueDate: date, cashAmount: value, campusId: state.campusId });
      }
      if (!items.length) throw new Error('Kaydedilecek tutar girilmedi.');
      const res = await api.post('/api/revenues/bulk', { items, campusId: state.campusId });
      toast(`${res.saved} gün kaydedildi.${res.errors.length ? ` ${res.errors.length} satır hatalı.` : ''}`,
        res.errors.length ? 'warning' : 'success');
      render(root);
    },
  }).box.querySelector('.modal-body').append(
    el('p.card-note', { text: 'Toplam tutarı girin; ödeme türü kırılımını daha sonra düzenleyebilirsiniz. Boş bıraktığınız günler atlanır.' }),
    el('div.table-wrap', {}, [el('table.data.line-table', {}, [
      el('thead', {}, [el('tr', {}, [el('th', { text: 'Tarih' }), el('th', { text: 'Gün' }), el('th', { text: 'Toplam Ciro (TL)' }), el('th', { text: 'Durum' })])]),
      el('tbody', {}, rows),
    ])]),
  );
}

async function remove(root, row) {
  const ok = await confirmDialog(
    `${fmt.date(row.revenue_date)} tarihli ${fmt.money(row.total_amount)} tutarındaki ciro kaydı silinecek. Emin misiniz?`,
    { title: 'Ciro Kaydını Sil', confirmText: 'Sil', danger: true }
  );
  if (!ok) return;
  await api.del(`/api/revenues/${row.id}`);
  toast('Kayıt silindi.');
  render(root);
}

function pct(part, whole) {
  if (!whole) return '—';
  return `%${Math.round((part / whole) * 100)}`;
}
