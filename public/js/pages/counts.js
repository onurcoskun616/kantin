import { api } from '../api.js';
import { state, navigate, canWrite, isManager } from '../app.js';
import {
  el, card, stat, table, fmt, badge, toast, formModal, confirmDialog,
  dateUtil, empty, alertBox, deltaCell, barChart, shortName, modal,
} from '../ui.js';

const STATUS_BADGE = {
  TASLAK: () => badge('Taslak', 'warn'),
  SAYILDI: () => badge('Sayıldı — onay bekliyor', 'info'),
  KESINLESMIS: () => badge('Kesinleşti', 'ok'),
};

/* ============================== Liste ============================== */
export async function render(root) {
  const data = await api.get('/api/counts', { campusId: state.campusId });
  root.replaceChildren();

  root.append(el('div.row', { style: 'justify-content:space-between' }, [
    el('div', {}, [
      el('h3', { text: 'Sayım (Envanter) Kayıtları' }),
      el('p.card-note', { text: 'Sayım, kantin denetiminin temelidir: kayıtlara göre olması gereken stok ile fiilen sayılan stok arasındaki fark, dönemin satışını verir.' }),
    ]),
    canWrite() ? el('div.btn-row', {}, [
      el('button.btn.btn-primary', { text: '+ Dönem Sayımı', onclick: () => startCount(root, 'DONEM') }),
      el('button.btn', { text: '🔍 Habersiz Nokta Sayımı', onclick: () => startCount(root, 'NOKTA') }),
    ]) : null,
  ]));

  const open = data.items.find((c) => c.status === 'TASLAK' || c.status === 'SAYILDI');
  if (open) {
    root.append(alertBox('info', 'Devam eden sayım var',
      el('span', {}, [
        `${fmt.date(open.count_date)} tarihli ${open.count_type === 'NOKTA' ? 'nokta' : 'dönem'} sayımı `,
        open.status === 'TASLAK' ? 'henüz tamamlanmadı. ' : 'kilitlendi, onay bekliyor. ',
        el('a', { href: `#/countDetail/${open.id}`, text: 'Sayıma git →' }),
      ])));
  }

  root.append(card(null, [
    table([
      { label: 'Tarih', value: (r) => fmt.date(r.count_date) },
      { label: 'Tip', render: (r) => (r.count_type === 'NOKTA' ? badge('Nokta', 'info') : badge('Dönem')) },
      { label: 'Kampüs', value: (r) => shortName(r.campus_name) },
      { label: 'Dönem Başı', value: (r) => (r.count_type === 'NOKTA' ? '—' : (r.period_start ? fmt.date(r.period_start) : 'Açılış')) },
      { label: 'Durum', render: (r) => (STATUS_BADGE[r.status] || (() => badge(r.status)))() },
      { label: 'Ürün', num: true, value: (r) => fmt.int(r.line_count) },
      { label: 'Sayan', value: (r) => r.submitted_by_name || '—' },
      { label: 'Katılan', value: (r) => r.witness_name || '—' },
      { label: 'Onaylayan', value: (r) => r.finalized_by_name || '—' },
      { label: 'Beklenen Ciro', num: true, value: (r) => (isSettled(r) ? fmt.money(r.expected_revenue) : '—') },
      { label: 'Gerçekleşen', num: true, value: (r) => (isSettled(r) ? fmt.money(r.actual_revenue) : '—') },
      { label: 'Fark', num: true, render: (r) => (isSettled(r) ? deltaCell(r.difference) : el('span.muted', { text: '—' })) },
      { label: '', render: (r) => el('a.btn.btn-sm', { href: `#/countDetail/${r.id}`, text: r.status === 'KESINLESMIS' ? 'İncele' : 'Devam Et' }) },
    ], data.items, {
      rowClass: (r) => (isSettled(r) && r.difference < -1 ? 'is-warn' : ''),
      emptyText: 'Henüz sayım yapılmamış. Denetimin başlaması için ilk sayımı girin.',
    }),
  ], { tight: true }));
}

const isSettled = (r) => r.status === 'KESINLESMIS' && r.count_type === 'DONEM';

/* -------------------------- Yeni sayım açma ------------------------ */
async function startCount(root, countType) {
  if (countType === 'DONEM') {
    formModal({
      title: 'Yeni Dönem Sayımı',
      fields: [
        { name: 'countDate', label: 'Sayım tarihi', type: 'date', value: dateUtil.today(), required: true,
          hint: 'Sayımın fiilen yapıldığı gün. Bu tarihe kadarki tüm hareketler sayıma dahil edilir.' },
        { name: 'note', label: 'Açıklama', type: 'textarea', placeholder: 'Örn: Mart ayı dönem sonu sayımı' },
      ],
      submitText: 'Sayımı Başlat',
      onSubmit: async (v) => {
        const count = await api.post('/api/counts', { ...v, campusId: state.campusId, countType: 'DONEM' });
        toast(`Kör sayım açıldı (${count.lines.length} ürün). Olması gereken miktarlar gizlidir.`);
        navigate('countDetail', [count.id]);
      },
    });
    return;
  }

  // Nokta sayımı: hangi ürünlerin sayılacağı seçilir
  const products = await api.get('/api/stock', { campusId: state.campusId });
  const candidates = [...products.items]
    .sort((a, b) => b.stock_cost_value - a.stock_cost_value);
  const checks = new Map();

  const rows = candidates.map((p) => {
    const box = el('input', { type: 'checkbox' });
    checks.set(p.product_id, box);
    return el('tr', {}, [
      el('td', {}, [box]),
      el('td.wrap', { text: p.name }),
      el('td.small.muted', { text: p.category_name || '—' }),
      el('td.num', { text: fmt.money(p.stock_cost_value) }),
    ]);
  });

  const m = formModal({
    title: 'Habersiz Nokta Sayımı',
    wide: true,
    fields: [
      { name: 'countDate', label: 'Sayım tarihi', type: 'date', value: dateUtil.today(), required: true },
      { name: 'note', label: 'Açıklama', type: 'textarea', placeholder: 'Örn: Eylül ayı habersiz ara kontrolü' },
    ],
    submitText: 'Nokta Sayımını Başlat',
    onSubmit: async (v) => {
      const productIds = [...checks.entries()].filter(([, box]) => box.checked).map(([id]) => id);
      if (!productIds.length) throw new Error('En az bir ürün seçin.');
      const count = await api.post('/api/counts', {
        ...v, campusId: state.campusId, countType: 'NOKTA', productIds,
      });
      toast(`Nokta sayımı açıldı (${productIds.length} ürün).`);
      navigate('countDetail', [count.id]);
    },
  });

  const top10 = el('button.btn.btn-sm', {
    text: 'En değerli 10 ürünü seç',
    onclick: () => {
      [...checks.values()].forEach((b) => { b.checked = false; });
      candidates.slice(0, 10).forEach((p) => { checks.get(p.product_id).checked = true; });
    },
  });

  m.box.querySelector('.modal-body').append(
    alertBox('info', 'Nokta sayımı nedir?',
      'Dönem sayımını beklemeden, seçtiğiniz birkaç üründe habersiz yapılan ara kontroldür. '
      + 'Stoğa dokunmaz, dönemi kapatmaz — silinemez bir tespit kaydı bırakır. '
      + 'Ayda bir, yüksek cirolu ürünlerde yapılması caydırıcılığı yüksektir.'),
    el('div.btn-row', {}, [top10]),
    el('div.table-wrap', { style: 'max-height:340px;overflow-y:auto' }, [el('table.data.line-table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '' }), el('th', { text: 'Ürün' }),
        el('th', { text: 'Kategori' }), el('th.num', { text: 'Stok Değeri' }),
      ])]),
      el('tbody', {}, rows),
    ])]),
  );
}

/* ============================== Detay ============================== */
export async function renderDetail(root, { params }) {
  const id = Number(params[0]);
  const [data, rec] = await Promise.all([
    api.get(`/api/counts/${id}`),
    api.get(`/api/counts/${id}/reconciliation`),
  ]);
  root.replaceChildren();

  const isSpot = data.count_type === 'NOKTA';
  const isDraft = data.status === 'TASLAK';
  const isSubmitted = data.status === 'SAYILDI';
  const editable = isDraft && canWrite();
  const reload = () => renderDetail(root, { params: [id] });

  /* --------------------------- Üst bilgi --------------------------- */
  root.append(el('div.row', { style: 'justify-content:space-between' }, [
    el('div', {}, [
      el('h3', {}, [
        `${isSpot ? 'Nokta Sayımı' : 'Sayım'} #${data.id} — ${fmt.date(data.count_date)} `,
        (STATUS_BADGE[data.status] || (() => badge(data.status)))(),
        data.blind_active ? el('span', { style: 'margin-left:6px' }, [badge('Kör sayım', 'info')]) : null,
      ]),
      el('p.card-note', {
        text: `${shortName(data.campus_name)} · `
          + (isSpot
            ? 'Habersiz ara kontrol — stoğa ve döneme etki etmez.'
            : `Dönem: ${data.period_start ? fmt.date(data.period_start) : 'açılıştan'} → ${fmt.date(data.count_date)}`)
          + (data.witness_name ? ` · Sayıma katılan: ${data.witness_name}` : '')
          + (data.reopened_count ? ` · ${data.reopened_count} kez yeniden açıldı` : ''),
      }),
    ]),
    el('div.btn-row', {}, [
      el('a.btn', { href: '#/counts', text: '← Listeye dön' }),
      data.blind_active ? null : el('button.btn', { text: '⬇ Sayım Fişi (CSV)', onclick: () => api.download(`/api/counts/${id}`) }),
      data.blind_active ? null : el('button.btn', { text: '🖨 Yazdır', onclick: () => window.print() }),
      ...finalizeActions(data, reload),
      editable ? el('button.btn.btn-ghost', { text: 'Sil', onclick: () => removeCount(id) }) : null,
    ]),
  ]));

  /* --------------------- Kör sayım: kilitlenmemiş ------------------- */
  if (data.blind_active) {
    root.append(alertBox('info', 'Kör sayım açık',
      'Olması gereken miktarlar bilerek gizlenmiştir — sayan kişi hedef rakamı göremez. '
      + 'Miktarları girip "Sayımı Kilitle" dediğinizde sapmalar açılır ve satırlar değiştirilemez hale gelir.'));
    root.append(buildCountSheet(root, data, true, reload));
    if (!isSpot && data.production.length) root.append(buildProductionSheet(data, true, reload));
    return;
  }

  /* --------------------------- Mutabakat --------------------------- */
  if (isSpot) {
    root.append(buildSpotSummary(data, rec));
  } else {
    root.append(buildReconciliation(data, rec));
  }

  /* ------------------------ Dönem özeti / grafik -------------------- */
  if (!isSpot) {
    root.append(el('div.grid.grid-2', {}, [
      card('Dönem Özeti', [periodSummary(rec)]),
      card('En Çok Satan Ürünler (tutar)', [
        barChart(rec.soldItems.slice(0, 10).map((i) => ({
          label: i.product_name, value: Math.round(i.sold * i.sale_price * 100) / 100,
        }))),
      ]),
    ]));
  }

  if (rec.topVariances?.length) {
    root.append(card(isSpot ? 'Tespit Edilen Sapmalar' : 'En Büyük Stok Sapmaları', [
      table([
        { label: 'Ürün', value: (r) => r.product_name, wrap: true },
        { label: 'Olması Gereken', num: true, value: (r) => fmt.num(r.expected_qty) },
        { label: 'Sayılan', num: true, value: (r) => fmt.num(r.counted_qty) },
        { label: 'Fark (adet)', num: true, render: (r) => deltaCell(r.diff_qty, fmt.num) },
        { label: 'Fark (tutar)', num: true, render: (r) => deltaCell(r.variance_value) },
      ], rec.topVariances),
    ], {
      tight: true,
      note: isSpot
        ? 'Eksi fark, son dönem sayımından bu yana raftan çıkan miktardır — bir kısmı satış olabilir. Satışla açıklanamayan büyüklükler incelenmelidir.'
        : 'Bu liste sayımdaki en büyük kalem bazlı sapmaları gösterir; denetimi bu ürünlerden başlatın.',
    }));
  }

  /* ---------------------- Üretilen ürün satışları ------------------- */
  if (!isSpot && data.production.length) {
    root.append(buildProductionSheet(data, false, reload));
  }

  root.append(buildCountSheet(root, data, false, reload));
}

/* ------------------------- Üst düğme grubu -------------------------- */
function finalizeActions(data, reload) {
  const out = [];
  if (data.status === 'TASLAK' && canWrite()) {
    out.push(el('button.btn.btn-success', { text: '🔒 Sayımı Kilitle', onclick: () => submitCount(data, reload) }));
  }
  if (data.status === 'SAYILDI' && data.count_type === 'DONEM' && isManager()) {
    if (data.can_finalize) {
      out.push(el('button.btn.btn-success', { text: '✓ Kesinleştir', onclick: () => finalize(data, reload) }));
    } else {
      out.push(el('button.btn', {
        disabled: true,
        title: 'Sayımı kilitleyen kişi kendi sayımını kesinleştiremez.',
        text: '✓ Kesinleştir (başka yetkili onaylamalı)',
      }));
    }
  }
  if (data.status === 'SAYILDI' && ['ADMIN', 'GENEL_MUDURLUK'].includes(state.user.role)) {
    out.push(el('button.btn.btn-ghost', { text: 'Yeniden Aç', onclick: () => reopen(data, reload) }));
  }
  return out;
}

/* --------------------------- Mutabakat kartı ------------------------ */
function buildReconciliation(data, rec) {
  const diff = rec.revenue.difference;
  const tone = diff === null ? '' : diff < -1 ? 'bad' : diff > 1 ? 'warn' : 'ok';
  const wrap = el('div.grid');

  wrap.append(el('div.grid.grid-4', {}, [
    stat('Beklenen Ciro', fmt.money(rec.revenue.expected), {
      sub: rec.revenue.production > 0
        ? `Sayımdan ${fmt.money(rec.revenue.counted)} + üretim ${fmt.money(rec.revenue.production)}`
        : 'Sayım farkı × satış fiyatı',
    }),
    stat('Gerçekleşen Ciro', fmt.money(rec.revenue.actual), { sub: 'Girilen günlük cirolar' }),
    stat('Fark', fmt.money(diff), {
      tone, sub: rec.revenue.differencePct === null ? '—' : `${fmt.pct(rec.revenue.differencePct)} sapma`,
    }),
    stat('Brüt Kâr', fmt.money(rec.profitability.grossProfit), {
      sub: `Maliyet ${fmt.money(rec.profitability.cogs)} · marj ${fmt.pct(rec.profitability.grossMarginPct)}`,
    }),
  ]));

  if (data.status === 'KESINLESMIS') {
    if (diff < -1) {
      wrap.append(alertBox('danger', `${fmt.money(Math.abs(diff))} ciro açığı`,
        'Stoktan çıkan malın karşılığı kadar ciro kaydedilmemiş. Olası nedenler: kayıt dışı satış, eksik ciro beyanı, '
        + 'kaydedilmemiş fire/ikram, hatalı sayım veya eksik mal girişi. Fire kayıtlarını ve alım belgelerini kontrol edin.'));
    } else if (diff > Math.max(1, rec.revenue.expected * 0.03)) {
      wrap.append(alertBox('warning', `${fmt.money(diff)} ciro fazlası`,
        'Kaydedilen ciro, satıldığı hesaplanan mal tutarından yüksek. Genellikle eksik mal girişi '
        + '(irsaliyesi işlenmemiş ürün) veya fiyat tanımı hatası anlamına gelir.'));
    } else {
      wrap.append(alertBox('success', 'Mutabakat sağlandı',
        'Sayım sonucu hesaplanan beklenen ciro ile girilen ciro örtüşüyor.'));
    }
  } else {
    wrap.append(alertBox('info', 'Sayım kilitlendi, onay bekliyor',
      'Sapmalar aşağıda görünüyor. Kesinleştirme, sayımı kilitleyen kişiden farklı bir yetkili tarafından yapılmalıdır. '
      + 'Kesinleştirilene kadar stok hareketleri yazılmaz.'));
  }

  if (rec.revenue.production > 0) {
    wrap.append(alertBox('warning', `Beklenen cironun ${fmt.pct(rec.production.sharePct)}'i beyana dayalı`,
      `Üretilen ürünler (tost, çay vb.) raftan sayılamadığı için ${fmt.money(rec.revenue.production)} tutarındaki `
      + 'kısım sayımla değil, girilen adetlerle hesaplanmıştır. Bu kısım denetim açısından zayıftır; '
      + 'girdi tüketimiyle (ekmek, kaşar, çay) karşılaştırarak kontrol edin.'));
  }
  return wrap;
}

function buildSpotSummary(data, rec) {
  const wrap = el('div.grid');
  const outValue = rec.topVariances.reduce((s, r) => s + Math.min(0, r.variance_value), 0);
  wrap.append(el('div.grid.grid-4', {}, [
    stat('Sayılan Ürün', fmt.int(data.lines.length)),
    stat('Sapma Görülen', fmt.int(rec.topVariances.length), {
      tone: rec.topVariances.length ? 'warn' : 'ok',
    }),
    stat('Raftan Çıkan Tutar', fmt.money(Math.abs(outValue)), { sub: 'Son dönem sayımından bu yana' }),
    stat('Dönemde Girilen Ciro', fmt.money(rec.revenue.actual), { sub: `${rec.period.dayCount} gün (tüm ürünler)` }),
  ]));
  wrap.append(alertBox('info', 'Nokta sayımı nasıl okunur?',
    'Bu kontrol yalnızca seçilen ürünleri kapsar; girilen ciro ise tüm ürünleri içerir. Bu yüzden doğrudan '
    + '"fark" hesaplanmaz. Bakılacak şey şudur: bir üründe raftan çıkan miktar, o dönemde o üründen '
    + 'satılabilecek makul miktarın çok üzerinde mi? Öyleyse dönem sayımını beklemeden inceleyin. '
    + 'Bu kayıt silinemez; sonraki dönem sayımıyla karşılaştırılabilir.'));
  return wrap;
}

function periodSummary(rec) {
  return el('dl.kv', {}, [
    el('dt', { text: 'Dönem' }), el('dd', { text: `${fmt.date(rec.period.from)} → ${fmt.date(rec.period.to)}` }),
    el('dt', { text: 'Ciro girilen gün' }), el('dd', { text: `${rec.period.dayCount} gün` }),
    el('dt', { text: 'Nakit' }), el('dd', { text: fmt.money(rec.revenue.cash) }),
    el('dt', { text: 'Kredi kartı' }), el('dd', { text: fmt.money(rec.revenue.card) }),
    el('dt', { text: 'Veresiye / öğrenci kartı' }), el('dd', { text: fmt.money(rec.revenue.credit) }),
    el('dt', { text: 'Sayımdan gelen beklenen ciro' }), el('dd', { text: fmt.money(rec.revenue.counted) }),
    el('dt', { text: 'Üretilen üründen beyan' }), el('dd', { text: fmt.money(rec.revenue.production) }),
    el('dt', { text: 'Dönem alımları' }), el('dd', { text: `${fmt.money(rec.purchases.grossTotal)} (${rec.purchases.documentCount} belge)` }),
    el('dt', { text: 'Fire maliyeti' }), el('dd', { text: `${fmt.money(rec.waste.costValue)} (${rec.waste.recordCount} kayıt)` }),
    el('dt', { text: 'Satılan mal maliyeti' }), el('dd', { text: fmt.money(rec.profitability.cogs) }),
    ...(rec.count.submittedByName ? [
      el('dt', { text: 'Sayımı yapan' }), el('dd', { text: rec.count.submittedByName }),
    ] : []),
    ...(rec.count.witnessName ? [
      el('dt', { text: 'Sayıma katılan' }), el('dd', { text: rec.count.witnessName }),
    ] : []),
    ...(rec.count.finalizedByName ? [
      el('dt', { text: 'Kesinleştiren' }), el('dd', { text: rec.count.finalizedByName }),
    ] : []),
    ...(rec.perStudent ? [
      el('dt', { text: 'Öğrenci başına ciro' }), el('dd', { text: fmt.money(rec.perStudent.revenuePerStudent) }),
      el('dt', { text: 'Öğrenci başına günlük' }), el('dd', { text: fmt.money(rec.perStudent.dailyRevenuePerStudent) }),
    ] : []),
    ...(rec.schoolShare ? [
      el('dt', { text: `Okul payı (%${rec.schoolShare.pct})` }), el('dd', { text: fmt.money(rec.schoolShare.amount) }),
    ] : []),
  ]);
}

/* ---------------------------- Sayım fişi ---------------------------- */
function buildCountSheet(root, data, blind, reload) {
  const inputs = new Map();
  const searchInput = el('input.search-input', { type: 'search', placeholder: 'Ürün adı veya barkod ile ara / barkod okut...' });
  const progressBar = el('div', { style: 'width:0%' });
  const progressText = el('span.small.muted');
  const editable = data.status === 'TASLAK' && canWrite();

  const rows = data.lines.map((line) => {
    const input = el('input.num.count-line-input', {
      type: 'number', step: '0.01', min: '0',
      value: line.counted_qty ?? 0,
      disabled: !editable,
      dataset: { productId: line.product_id },
    });
    inputs.set(line.product_id, input);

    const cells = [
      el('td', { text: line.barcode || '—', class: 'small muted' }),
      el('td.wrap', { text: line.product_name }),
      el('td.small.muted', { text: line.category_name || '—' }),
      el('td', {}, [input]),
    ];

    if (!blind) {
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
      };
      input.addEventListener('input', recalc);
      cells.splice(3, 0, el('td.num', { text: fmt.num(line.expected_qty) }));
      cells.push(diffCell, soldCell, el('td.num', { text: fmt.money(line.sale_price) }), valueCell);
      recalc();
    }

    input.addEventListener('input', updateProgress);
    return el('tr', { dataset: { search: `${line.product_name} ${line.barcode || ''}`.toLowerCase() } }, cells);
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
    if (q.length >= 8) {
      const match = data.lines.find((l) => l.barcode === q);
      if (match) { inputs.get(match.product_id)?.focus(); inputs.get(match.product_id)?.select(); }
    }
  });

  const saveBtn = el('button.btn.btn-primary', { text: '💾 Kaydet', disabled: !editable });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Kaydediliyor...';
    try {
      await api.put(`/api/counts/${data.id}/lines`, {
        lines: [...inputs.entries()].map(([productId, input]) => ({
          productId, countedQty: Number(String(input.value).replace(',', '.')) || 0,
        })),
      });
      toast('Sayım kaydedildi. Kilitlemeden önce istediğiniz kadar düzeltebilirsiniz.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      saveBtn.disabled = !editable;
      saveBtn.textContent = '💾 Kaydet';
    }
  });

  const headers = blind
    ? ['Barkod', 'Ürün', 'Kategori', 'Sayılan']
    : ['Barkod', 'Ürün', 'Kategori', 'Olması Gereken', 'Sayılan', 'Fark', 'Dönem Satışı', 'Satış Fiyatı', 'Satış Tutarı'];

  return card(blind ? 'Sayım Fişi — Kör Sayım' : 'Sayım Fişi', [
    el('div.filter-bar', { style: 'margin-bottom:12px' }, [
      searchInput,
      el('div', { style: 'flex:1;min-width:160px' }, [
        el('div.progress', {}, [progressBar]),
        el('div', { style: 'margin-top:4px' }, [progressText]),
      ]),
      editable ? saveBtn : null,
      editable ? el('button.btn.btn-success', { text: '🔒 Sayımı Kilitle', onclick: () => submitCount(data, reload, inputs) }) : null,
      !editable && data.status !== 'TASLAK' ? badge(data.status === 'SAYILDI' ? 'Kilitli — değiştirilemez' : 'Kesinleşmiş sayım', 'ok') : null,
    ]),
    el('div.table-wrap', {}, [el('table.data.line-table', {}, [
      el('thead', {}, [el('tr', {}, headers.map((h, i) =>
        el(i >= 3 && h !== 'Sayılan' ? 'th.num' : 'th', { text: h })))]),
      el('tbody', {}, rows),
    ])]),
  ], {
    note: blind
      ? 'Rafta/depoda fiilen saydığınız miktarı girin. Olması gereken miktar kasıtlı olarak gizlidir — sayımın bağımsız olması için. Barkod okuyucuyla arama kutusunu kullanarak hızlı ilerleyebilirsiniz.'
      : (editable ? 'Her ürün için fiilen saydığınız miktarı girin.' : 'Bu sayım kilitlenmiştir; satırlar salt okunurdur.'),
  });
}

/* --------------------- Üretilen ürün satış beyanı -------------------- */
function buildProductionSheet(data, blindPhase, reload) {
  const editable = data.status === 'TASLAK' && canWrite();
  const inputs = new Map();

  const rows = data.production.map((row) => {
    const input = el('input.num', {
      type: 'number', step: '1', min: '0', value: row.quantity ?? 0, disabled: !editable,
    });
    inputs.set(row.product_id, input);
    const valueCell = el('td.num', { text: fmt.money(row.quantity * row.sale_price) });
    input.addEventListener('input', () => {
      valueCell.textContent = fmt.money((Number(input.value) || 0) * row.sale_price);
    });
    return el('tr', {}, [
      el('td.wrap', { text: row.product_name }),
      el('td.num', { text: fmt.money(row.sale_price) }),
      el('td', {}, [input]),
      valueCell,
    ]);
  });

  const saveBtn = el('button.btn.btn-primary', { text: '💾 Adetleri Kaydet', disabled: !editable });
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    try {
      await api.put(`/api/counts/${data.id}/production`, {
        lines: [...inputs.entries()].map(([productId, input]) => ({
          productId, quantity: Number(String(input.value).replace(',', '.')) || 0,
        })),
      });
      toast('Üretim satış adetleri kaydedildi.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      saveBtn.disabled = !editable;
    }
  });

  return card('Üretilen Ürün Satışları (beyan)', [
    alertBox('warning', 'Bu kalemler sayımla doğrulanamaz',
      'Tost, çay, poğaça gibi kantinde hazırlanan ürünler raftan sayılamaz. Dönem içinde kaç adet satıldığını '
      + 'buraya girin — mutabakatta ayrı bir kalem olarak gösterilir. Günlük çetele tutmanız, bu rakamın '
      + 'güvenilirliğini belirler.'),
    el('div.table-wrap', {}, [el('table.data.line-table', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Ürün' }), el('th.num', { text: 'Satış Fiyatı' }),
        el('th', { text: 'Dönem Adedi' }), el('th.num', { text: 'Tutar' }),
      ])]),
      el('tbody', {}, rows),
    ])]),
    editable ? el('div.btn-row', { style: 'margin-top:10px' }, [saveBtn]) : null,
  ], { tight: false });
}

/* ------------------------------ Eylemler ---------------------------- */
async function submitCount(data, reload, inputs = null) {
  formModal({
    title: 'Sayımı Kilitle',
    fields: [
      { name: 'witnessName', label: 'Sayıma katılan kişi (ad soyad)', required: true,
        hint: 'Sayım tek kişiyle yapılmamalıdır. Rafı sizinle birlikte sayan kişinin adını yazın; bu ad kayda geçer ve değiştirilemez.' },
    ],
    submitText: 'Kilitle ve Sapmaları Aç',
    onSubmit: async (v) => {
      // Ekranda kaydedilmemiş miktar kalmasın
      if (inputs) {
        await api.put(`/api/counts/${data.id}/lines`, {
          lines: [...inputs.entries()].map(([productId, input]) => ({
            productId, countedQty: Number(String(input.value).replace(',', '.')) || 0,
          })),
        });
      }
      await api.post(`/api/counts/${data.id}/submit`, { witnessName: v.witnessName });
      toast('Sayım kilitlendi. Sapmalar açıldı, satırlar artık değiştirilemez.');
      reload();
    },
  });
}

async function finalize(data, reload) {
  const ok = await confirmDialog(
    'Sayım kesinleştirilecek: stok hareketleri yazılacak ve bu tarihten önceki kayıtlar kilitlenecek. '
    + 'Sapmaları incelediğinizi teyit ediyor musunuz?',
    { title: 'Sayımı Kesinleştir', confirmText: 'Kesinleştir' }
  );
  if (!ok) return;
  try {
    await api.post(`/api/counts/${data.id}/finalize`);
    toast('Sayım kesinleştirildi.');
    reload();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function reopen(data, reload) {
  formModal({
    title: 'Sayımı Yeniden Aç',
    fields: [
      { name: 'reason', label: 'Gerekçe', type: 'textarea', required: true,
        hint: 'Bu gerekçe denetim izine yazılır ve silinemez. Sayımın kaç kez açıldığı raporda görünür.' },
    ],
    submitText: 'Yeniden Aç',
    onSubmit: async (v) => {
      await api.post(`/api/counts/${data.id}/reopen`, { reason: v.reason });
      toast('Sayım yeniden açıldı. İşlem denetim izine kaydedildi.');
      reload();
    },
  });
}

async function removeCount(id) {
  const ok = await confirmDialog('Sayım taslağı silinecek. Girilen miktarlar kaybolur. Emin misiniz?',
    { title: 'Sayımı Sil', confirmText: 'Sil', danger: true });
  if (!ok) return;
  await api.del(`/api/counts/${id}`);
  toast('Sayım silindi.');
  navigate('counts');
}
