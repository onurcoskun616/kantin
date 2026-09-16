import { api } from '../api.js';
import { state, navigate, canWrite, isManager } from '../app.js';
import {
  el, card, stat, table, fmt, badge, toast, formModal, confirmDialog,
  dateUtil, empty, alertBox, deltaCell, barChart, shortName,
} from '../ui.js';

/* ============================== Liste ============================== */
export async function render(root) {
  const data = await api.get('/api/counts', { campusId: state.campusId });
  root.replaceChildren();

  root.append(el('div.row', { style: 'justify-content:space-between' }, [
    el('div', {}, [
      el('h3', { text: 'Sayım (Envanter) Kayıtları' }),
      el('p.card-note', { text: 'Sayım, kantin denetiminin temelidir: kayıtlara göre olması gereken stok ile fiilen sayılan stok arasındaki fark, dönemin satışını verir.' }),
    ]),
    canWrite() ? el('button.btn.btn-primary', { text: '+ Yeni Sayım Başlat', onclick: () => startCount(root) }) : null,
  ]));

  const draft = data.items.find((c) => c.status === 'TASLAK');
  if (draft) {
    root.append(alertBox('info', 'Devam eden sayım var',
      el('span', {}, [
        `${fmt.date(draft.count_date)} tarihli sayım taslağı açık. `,
        el('a', { href: `#/countDetail/${draft.id}`, text: 'Sayıma devam et →' }),
      ])));
  }

  root.append(card(null, [
    table([
      { label: 'Tarih', value: (r) => fmt.date(r.count_date) },
      { label: 'Kampüs', value: (r) => shortName(r.campus_name) },
      { label: 'Dönem Başı', value: (r) => (r.period_start ? fmt.date(r.period_start) : 'Açılış') },
      { label: 'Durum', render: (r) => (r.status === 'KESINLESMIS' ? badge('Kesinleşti', 'ok') : badge('Taslak', 'warn')) },
      { label: 'Ürün', num: true, value: (r) => fmt.int(r.line_count) },
      { label: 'Beklenen Ciro', num: true, value: (r) => (r.status === 'KESINLESMIS' ? fmt.money(r.expected_revenue) : '—') },
      { label: 'Gerçekleşen Ciro', num: true, value: (r) => (r.status === 'KESINLESMIS' ? fmt.money(r.actual_revenue) : '—') },
      { label: 'Fark', num: true, render: (r) => (r.status === 'KESINLESMIS' ? deltaCell(r.difference) : el('span.muted', { text: '—' })) },
      { label: 'Fark %', num: true, render: (r) => (r.status === 'KESINLESMIS' ? deltaCell(r.difference_pct, fmt.pct) : el('span.muted', { text: '—' })) },
      { label: 'Kesinleştiren', value: (r) => r.finalized_by_name || '—' },
      { label: '', render: (r) => el('a.btn.btn-sm', { href: `#/countDetail/${r.id}`, text: r.status === 'TASLAK' ? 'Devam Et' : 'İncele' }) },
    ], data.items, {
      rowClass: (r) => (r.status === 'KESINLESMIS' && r.difference < -1 ? 'is-warn' : ''),
      emptyText: 'Henüz sayım yapılmamış. Denetimin başlaması için ilk sayımı girin.',
    }),
  ], { tight: true }));
}

function startCount(root) {
  formModal({
    title: 'Yeni Sayım Başlat',
    fields: [
      { name: 'countDate', label: 'Sayım tarihi', type: 'date', value: dateUtil.today(), required: true,
        hint: 'Sayımın fiilen yapıldığı gün. Bu tarihten önceki hareketler sayıma dahil edilir.' },
      { name: 'note', label: 'Açıklama', type: 'textarea', placeholder: 'Örn: Mart ayı dönem sonu sayımı' },
    ],
    submitText: 'Sayımı Oluştur',
    onSubmit: async (v) => {
      const count = await api.post('/api/counts', { ...v, campusId: state.campusId });
      toast(`Sayım fişi oluşturuldu (${count.lines.length} ürün).`);
      navigate('countDetail', [count.id]);
    },
  });
}

/* ============================== Detay ============================== */
export async function renderDetail(root, { params }) {
  const id = Number(params[0]);
  const [data, rec] = await Promise.all([
    api.get(`/api/counts/${id}`),
    api.get(`/api/counts/${id}/reconciliation`),
  ]);
  root.replaceChildren();

  const isDraft = data.status === 'TASLAK';
  const editable = isDraft && canWrite();

  /* --------------------------- Üst bilgi --------------------------- */
  root.append(el('div.row', { style: 'justify-content:space-between' }, [
    el('div', {}, [
      el('h3', {}, [`Sayım #${data.id} — ${fmt.date(data.count_date)} `, isDraft ? badge('Taslak', 'warn') : badge('Kesinleşti', 'ok')]),
      el('p.card-note', {
        text: `${shortName(data.campus_name)} · Dönem: ${data.period_start ? fmt.date(data.period_start) : 'açılıştan'} → ${fmt.date(data.count_date)}`
          + ` (${rec.period.dayCount} gün ciro girişi)`,
      }),
    ]),
    el('div.btn-row', {}, [
      el('a.btn', { href: '#/counts', text: '← Listeye dön' }),
      el('button.btn', { text: '⬇ Sayım Fişi (CSV)', onclick: () => api.download(`/api/counts/${id}`) }),
      el('button.btn', { text: '🖨 Yazdır', onclick: () => window.print() }),
      editable && isManager() ? el('button.btn.btn-success', { text: '✓ Sayımı Kesinleştir', onclick: () => finalize(root, id, rec) }) : null,
      editable ? el('button.btn.btn-ghost', { text: 'Sil', onclick: () => removeCount(root, id) }) : null,
    ]),
  ]));

  /* --------------------------- Mutabakat --------------------------- */
  const diff = rec.revenue.difference;
  const tone = diff === null ? '' : diff < -1 ? 'bad' : diff > 1 ? 'warn' : 'ok';
  root.append(el('div.grid.grid-4', {}, [
    stat('Beklenen Ciro', fmt.money(rec.revenue.expected), { sub: 'Sayım farkı × satış fiyatı' }),
    stat('Gerçekleşen Ciro', fmt.money(rec.revenue.actual), { sub: 'Girilen günlük cirolar' }),
    stat('Fark', fmt.money(diff), { tone, sub: rec.revenue.differencePct === null ? '—' : `${fmt.pct(rec.revenue.differencePct)} sapma` }),
    stat('Brüt Kâr', fmt.money(rec.profitability.grossProfit), {
      sub: `Maliyet ${fmt.money(rec.profitability.cogs)} · marj ${fmt.pct(rec.profitability.grossMarginPct)}`,
    }),
  ]));

  if (!isDraft) {
    if (diff < -1) {
      root.append(alertBox('danger', `${fmt.money(Math.abs(diff))} ciro açığı`,
        'Stoktan çıkan mal miktarının karşılığı kadar ciro kaydedilmemiş. Olası nedenler: kayıt dışı satış, eksik ciro beyanı, kaydedilmemiş fire/ikram, hatalı sayım veya eksik mal girişi. Fire kayıtlarını ve alım belgelerini kontrol edin.'));
    } else if (diff > Math.max(1, rec.revenue.expected * 0.03)) {
      root.append(alertBox('warning', `${fmt.money(diff)} ciro fazlası`,
        'Kaydedilen ciro, satıldığı hesaplanan mal tutarından yüksek. Genellikle eksik mal girişi (irsaliyesi işlenmemiş ürün) veya fiyat tanımı hatası anlamına gelir.'));
    } else {
      root.append(alertBox('success', 'Mutabakat sağlandı',
        'Sayım sonucu hesaplanan beklenen ciro ile girilen ciro örtüşüyor.'));
    }
  }

  /* ------------------------ Dönem özeti kartları ------------------- */
  root.append(el('div.grid.grid-2', {}, [
    card('Dönem Özeti', [
      el('dl.kv', {}, [
        el('dt', { text: 'Dönem' }), el('dd', { text: `${fmt.date(rec.period.from)} → ${fmt.date(rec.period.to)}` }),
        el('dt', { text: 'Ciro girilen gün' }), el('dd', { text: `${rec.period.dayCount} gün` }),
        el('dt', { text: 'Nakit' }), el('dd', { text: fmt.money(rec.revenue.cash) }),
        el('dt', { text: 'Kredi kartı' }), el('dd', { text: fmt.money(rec.revenue.card) }),
        el('dt', { text: 'Veresiye / öğrenci kartı' }), el('dd', { text: fmt.money(rec.revenue.credit) }),
        el('dt', { text: 'Dönem alımları' }), el('dd', { text: `${fmt.money(rec.purchases.grossTotal)} (${rec.purchases.documentCount} belge)` }),
        el('dt', { text: 'Fire maliyeti' }), el('dd', { text: `${fmt.money(rec.waste.costValue)} (${rec.waste.recordCount} kayıt)` }),
        el('dt', { text: 'Satılan mal maliyeti' }), el('dd', { text: fmt.money(rec.profitability.cogs) }),
        el('dt', { text: 'Teorik kâr (fiyat farkı)' }), el('dd', { text: fmt.money(rec.profitability.theoreticalProfit) }),
        ...(rec.perStudent ? [
          el('dt', { text: 'Öğrenci başına ciro' }), el('dd', { text: fmt.money(rec.perStudent.revenuePerStudent) }),
          el('dt', { text: 'Öğrenci başına günlük' }), el('dd', { text: fmt.money(rec.perStudent.dailyRevenuePerStudent) }),
        ] : []),
        ...(rec.schoolShare ? [
          el('dt', { text: `Okul payı (%${rec.schoolShare.pct})` }), el('dd', { text: fmt.money(rec.schoolShare.amount) }),
        ] : []),
      ]),
    ]),
    card('En Çok Satan Ürünler (tutar)', [
      barChart(rec.soldItems.slice(0, 10).map((i) => ({ label: i.product_name, value: Math.round(i.sold * i.sale_price * 100) / 100 }))),
    ]),
  ]));

  if (rec.topVariances.length && !isDraft) {
    root.append(card('En Büyük Stok Sapmaları', [
      table([
        { label: 'Ürün', value: (r) => r.product_name, wrap: true },
        { label: 'Olması Gereken', num: true, value: (r) => fmt.num(r.expected_qty) },
        { label: 'Sayılan', num: true, value: (r) => fmt.num(r.counted_qty) },
        { label: 'Fark (adet)', num: true, render: (r) => deltaCell(r.diff_qty, fmt.num) },
        { label: 'Fark (tutar)', num: true, render: (r) => deltaCell(r.variance_value) },
      ], rec.topVariances),
    ], { tight: true, note: 'Bu liste sayımdaki en büyük kalem bazlı sapmaları gösterir; denetimi bu ürünlerden başlatın.' }));
  }

  /* --------------------------- Sayım fişi -------------------------- */
  root.append(buildCountSheet(root, data, editable));
}

function buildCountSheet(root, data, editable) {
  const inputs = new Map();
  const searchInput = el('input.search-input', { type: 'search', placeholder: 'Ürün adı veya barkod ile ara / barkod okut...' });
  const progressBar = el('div', { style: 'width:0%' });
  const progressText = el('span.small.muted');

  const rows = data.lines.map((line) => {
    const input = el('input.num.count-line-input', {
      type: 'number', step: '0.01', min: '0',
      value: line.counted_qty ?? 0,
      disabled: !editable,
      dataset: { productId: line.product_id },
    });
    inputs.set(line.product_id, input);

    const diffCell = el('td.num');
    const soldCell = el('td.num');
    const valueCell = el('td.num');

    const recalc = () => {
      const counted = Number(String(input.value).replace(',', '.')) || 0;
      const diff = Math.round((counted - line.expected_qty) * 100) / 100;
      const sold = Math.round((line.expected_qty - counted) * 100) / 100;
      diffCell.replaceChildren(deltaCell(diff, fmt.num));
      soldCell.textContent = fmt.num(sold);
      valueCell.textContent = fmt.money(Math.round(sold * line.sale_price * 100) / 100);
      updateProgress();
    };
    input.addEventListener('input', recalc);

    const tr = el('tr', { dataset: { search: `${line.product_name} ${line.barcode || ''}`.toLowerCase() } }, [
      el('td', { text: line.barcode || '—', class: 'small muted' }),
      el('td.wrap', { text: line.product_name }),
      el('td.small.muted', { text: line.category_name || '—' }),
      el('td.num', { text: fmt.num(line.expected_qty) }),
      el('td', {}, [input]),
      diffCell, soldCell,
      el('td.num', { text: fmt.money(line.sale_price) }),
      valueCell,
    ]);
    recalc();
    return tr;
  });

  function updateProgress() {
    const filled = [...inputs.values()].filter((i) => i.value !== '' && Number(i.value) !== 0).length;
    const pct = data.lines.length ? Math.round((filled / data.lines.length) * 100) : 0;
    progressBar.style.width = `${pct}%`;
    progressText.textContent = `${filled} / ${data.lines.length} üründe miktar girildi`;
  }
  updateProgress();

  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    for (const tr of rows) tr.hidden = q && !tr.dataset.search.includes(q);
    // Barkod okuyucu tam eslesirse dogrudan o satira odaklan
    if (q.length >= 8) {
      const match = data.lines.find((l) => l.barcode === q);
      if (match) {
        const input = inputs.get(match.product_id);
        input?.focus();
        input?.select();
      }
    }
  });

  const saveBtn = el('button.btn.btn-primary', { text: '💾 Sayımı Kaydet', disabled: !editable });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Kaydediliyor...';
    try {
      const lines = [...inputs.entries()].map(([productId, input]) => ({
        productId,
        countedQty: Number(String(input.value).replace(',', '.')) || 0,
      }));
      await api.put(`/api/counts/${data.id}/lines`, { lines });
      toast('Sayım kaydedildi.');
      render0(root, data.id);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      saveBtn.disabled = !editable;
      saveBtn.textContent = '💾 Sayımı Kaydet';
    }
  });

  return card('Sayım Fişi', [
    el('div.filter-bar', { style: 'margin-bottom:12px' }, [
      searchInput,
      el('div', { style: 'flex:1;min-width:160px' }, [
        el('div.progress', {}, [progressBar]),
        el('div', { style: 'margin-top:4px' }, [progressText]),
      ]),
      editable ? saveBtn : badge('Kesinleşmiş sayım — değiştirilemez', 'ok'),
    ]),
    el('div.table-wrap', {}, [el('table.data.line-table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Barkod' }), el('th', { text: 'Ürün' }), el('th', { text: 'Kategori' }),
        el('th.num', { text: 'Olması Gereken' }), el('th', { text: 'Sayılan' }),
        el('th.num', { text: 'Fark' }), el('th.num', { text: 'Dönem Satışı' }),
        el('th.num', { text: 'Satış Fiyatı' }), el('th.num', { text: 'Satış Tutarı' }),
      ])]),
      el('tbody', {}, rows),
    ])]),
  ], {
    tight: false,
    note: editable
      ? 'Her ürün için rafta/depoda fiilen saydığınız miktarı girin. Barkod okuyucuyla arama kutusunu kullanarak hızlı ilerleyebilirsiniz.'
      : 'Bu sayım kesinleşmiştir; satırlar salt okunurdur.',
  });
}

async function finalize(root, id, rec) {
  const ok = await confirmDialog(
    `Sayım kesinleştirilecek. Bu işlem sonrası sayım satırları ve bu tarihten önceki stok hareketleri kilitlenir. `
    + `Beklenen ciro ${fmt.money(rec.revenue.expected)}, girilen ciro ${fmt.money(rec.revenue.actual)}. Devam edilsin mi?`,
    { title: 'Sayımı Kesinleştir', confirmText: 'Kesinleştir' }
  );
  if (!ok) return;
  try {
    await api.post(`/api/counts/${id}/finalize`);
    toast('Sayım kesinleştirildi.');
    render0(root, id);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeCount(root, id) {
  const ok = await confirmDialog('Sayım taslağı silinecek. Girilen miktarlar kaybolur. Emin misiniz?',
    { title: 'Sayımı Sil', confirmText: 'Sil', danger: true });
  if (!ok) return;
  await api.del(`/api/counts/${id}`);
  toast('Sayım silindi.');
  navigate('counts');
}

function render0(root, id) { renderDetail(root, { params: [id] }); }
