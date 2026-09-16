import { api } from '../api.js';
import { state } from '../app.js';
import { el, card, stat, table, fmt, badge, barChart, deltaCell, dateUtil, empty, alertBox, shortName} from '../ui.js';

const TABS = [
  { id: 'productSales', label: 'Ürün Satış ve Kârlılık' },
  { id: 'monthly', label: 'Aylık Özet ve Denetim' },
  { id: 'comparison', label: 'Kampüs Karşılaştırma' },
  { id: 'critical', label: 'Kritik Stok / Sipariş' },
  { id: 'suppliers', label: 'Tedarikçi Alımları' },
];

export async function render(root) {
  let active = 'productSales';
  const range = { from: dateUtil.monthsAgo(3) + '-01', to: dateUtil.today() };

  const body = el('div.grid');
  const fromInput = el('input', { type: 'date', value: range.from });
  const toInput = el('input', { type: 'date', value: range.to });
  fromInput.addEventListener('change', () => { range.from = fromInput.value; draw(); });
  toInput.addEventListener('change', () => { range.to = toInput.value; draw(); });

  const tabBar = el('div.tabs', {}, TABS.map((t) =>
    el(`button.tab${t.id === active ? '.active' : ''}`, {
      text: t.label, dataset: { tab: t.id },
      onclick: () => {
        active = t.id;
        tabBar.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === active));
        draw();
      },
    })));

  root.replaceChildren(
    el('div.filter-bar', {}, [
      el('label.field', {}, [el('span', { text: 'Başlangıç' }), fromInput]),
      el('label.field', {}, [el('span', { text: 'Bitiş' }), toInput]),
      el('div', { style: 'flex:1' }),
      el('div.small.muted', { text: 'Satış rakamları kesinleşmiş sayımlardan hesaplanır.' }),
    ]),
    tabBar,
    body,
  );
  await draw();

  async function draw() {
    body.replaceChildren(el('div.empty', { text: 'Yükleniyor...' }));
    try {
      const fn = { productSales, monthly, comparison, critical, suppliers }[active];
      const node = await fn(range);
      body.replaceChildren(...[].concat(node));
    } catch (err) {
      body.replaceChildren(el('div.alert.alert-danger', { text: err.message }));
    }
  }
}

/* -------------------- Ürün satış ve kârlılık ---------------------- */
async function productSales(range) {
  const data = await api.get('/api/reports/product-sales', { campusId: state.campusId, ...range });
  if (!data.items.length) {
    return alertBox('info', 'Veri yok',
      'Bu dönem için kesinleşmiş sayım bulunmuyor. Satış adetleri sayımlardan hesaplandığı için önce bir sayım kesinleştirin.');
  }
  const t = data.totals;
  return [
    el('div.grid.grid-4', {}, [
      stat('Satılan Toplam Adet', fmt.int(t.soldQty)),
      stat('Ciro (KDV dahil)', fmt.money(t.salesValue)),
      stat('Satılan Mal Maliyeti', fmt.money(t.costValue)),
      stat('Brüt Kâr', fmt.money(t.profit), { tone: 'ok', sub: `Marj ${fmt.pct(t.marginPct)}` }),
    ]),
    el('div.grid.grid-2', {}, [
      card('Ciroya En Çok Katkı Yapan 10 Ürün', [
        barChart(data.items.slice(0, 10).map((i) => ({ label: i.product_name, value: i.sales_value }))),
      ]),
      card('En Çok Kâr Getiren 10 Ürün', [
        barChart([...data.items].sort((a, b) => b.profit - a.profit).slice(0, 10)
          .map((i) => ({ label: i.product_name, value: i.profit }))),
      ]),
    ]),
    card('Ürün Bazlı Satış Dökümü', [
      table([
        { label: 'Ürün', value: (r) => r.product_name, wrap: true },
        { label: 'Kategori', value: (r) => r.category_name || '—' },
        { label: 'Satılan Adet', num: true, value: (r) => fmt.num(r.sold_qty) },
        { label: 'Ort. Alış', num: true, value: (r) => fmt.money(r.avg_purchase_price) },
        { label: 'Ort. Satış', num: true, value: (r) => fmt.money(r.avg_sale_price) },
        { label: 'Birim Kâr', num: true, render: (r) => deltaCell(r.unit_profit) },
        { label: 'Ciro', num: true, value: (r) => fmt.money(r.sales_value) },
        { label: 'Maliyet', num: true, value: (r) => fmt.money(r.cost_value) },
        { label: 'Kâr', num: true, render: (r) => deltaCell(r.profit) },
        { label: 'Marj', num: true, render: (r) => marginBadge(r.margin_pct) },
      ], data.items, { rowClass: (r) => (r.profit < 0 ? 'is-critical' : '') }),
    ], {
      tight: true,
      actions: [el('button.btn.btn-sm', {
        text: '⬇ Excel (CSV)',
        onclick: () => api.download('/api/reports/product-sales', { campusId: state.campusId, ...range }),
      })],
    }),
  ];
}

/* ----------------------- Aylık özet ve denetim --------------------- */
async function monthly(range) {
  const data = await api.get('/api/reports/monthly', { campusId: state.campusId, ...range });
  return [
    alertBox('info', 'Bu rapor nasıl okunur?',
      '"Beklenen Ciro", o ay kesinleşen sayımlarda stoktan eksilen mal miktarının satış fiyatıyla çarpımıdır. '
      + '"Fark" eksi ise girilen ciro, satıldığı hesaplanan maldan düşüktür — kayıt dışı satış veya eksik ciro beyanı işareti olabilir.'),
    card('Aylık Kampüs Özeti', [
      table([
        { label: 'Ay', value: (r) => fmt.monthName(r.month) },
        { label: 'Kampüs', value: (r) => shortName(r.campusName) },
        { label: 'Ciro', num: true, value: (r) => fmt.money(r.revenue) },
        { label: 'Okul Günü', num: true, value: (r) => r.schoolDays },
        { label: 'Günlük Ort.', num: true, value: (r) => fmt.money(r.dailyAverage) },
        { label: 'Nakit', num: true, value: (r) => fmt.money(r.cash) },
        { label: 'Kart', num: true, value: (r) => fmt.money(r.card) },
        { label: 'Satılan Adet', num: true, value: (r) => (r.soldQty === null ? '—' : fmt.int(r.soldQty)) },
        { label: 'Beklenen Ciro', num: true, value: (r) => (r.expectedRevenue === null ? '—' : fmt.money(r.expectedRevenue)) },
        { label: 'Fark', num: true, render: (r) => (r.difference === null ? el('span.muted', { text: '—' }) : deltaCell(r.difference)) },
        { label: 'Fark %', num: true, render: (r) => (r.differencePct === null ? el('span.muted', { text: '—' }) : deltaCell(r.differencePct, fmt.pct)) },
        { label: 'Alım', num: true, value: (r) => fmt.money(r.purchaseTotal) },
      ], data.items, {
        rowClass: (r) => (r.difference !== null && r.difference < -1 ? 'is-warn' : ''),
        emptyText: 'Bu dönemde ciro kaydı yok.',
      }),
    ], {
      tight: true,
      actions: [el('button.btn.btn-sm', {
        text: '⬇ Excel (CSV)',
        onclick: () => api.download('/api/reports/monthly', { campusId: state.campusId, ...range }),
      })],
    }),
    data.items.length ? card('Aylık Ciro Trendi', [
      barChart(
        Object.entries(data.items.reduce((acc, r) => {
          acc[r.month] = (acc[r.month] || 0) + r.revenue;
          return acc;
        }, {})).sort(([a], [b]) => a.localeCompare(b)).map(([m, v]) => ({ label: fmt.monthName(m), value: Math.round(v * 100) / 100 })),
      ),
    ]) : null,
  ];
}

/* ----------------------- Kampüs karşılaştırma ---------------------- */
async function comparison(range) {
  const data = await api.get('/api/reports/campus-comparison', range);
  return [
    card('Kampüs Karşılaştırması', [
      table([
        { label: 'Kampüs', value: (r) => shortName(r.campusName), wrap: true },
        { label: 'Öğrenci', num: true, value: (r) => fmt.int(r.studentCount) },
        { label: 'Ciro', num: true, value: (r) => fmt.money(r.revenue) },
        { label: 'Okul Günü', num: true, value: (r) => r.schoolDays },
        { label: 'Günlük Ort.', num: true, value: (r) => fmt.money(r.dailyAverage) },
        { label: 'Öğr. Başına', num: true, value: (r) => fmt.money(r.revenuePerStudent) },
        { label: 'Öğr. Günlük', num: true, value: (r) => fmt.money(r.dailyPerStudent) },
        { label: 'Satılan Adet', num: true, value: (r) => fmt.int(r.soldQty) },
        { label: 'Brüt Kâr', num: true, render: (r) => (r.grossProfit === null ? el('span.muted', { text: '—' }) : deltaCell(r.grossProfit)) },
        { label: 'Marj', num: true, render: (r) => marginBadge(r.grossMarginPct) },
        { label: 'Sayım Farkı', num: true, render: (r) => (r.difference === null ? el('span.muted', { text: '—' }) : deltaCell(r.difference)) },
        { label: 'Fire', num: true, value: (r) => fmt.money(r.wasteCost) },
        { label: 'Okul Payı', num: true, value: (r) => (r.schoolShare === null ? '—' : fmt.money(r.schoolShare)) },
      ], data.items, { rowClass: (r) => (r.difference !== null && r.difference < -1 ? 'is-warn' : '') }),
    ], {
      tight: true,
      actions: [el('button.btn.btn-sm', { text: '⬇ Excel (CSV)', onclick: () => api.download('/api/reports/campus-comparison', range) })],
    }),
    el('div.grid.grid-2', {}, [
      card('Öğrenci Başına Günlük Harcama', [
        barChart([...data.items].sort((a, b) => (b.dailyPerStudent || 0) - (a.dailyPerStudent || 0))
          .map((r) => ({ label: shortName(r.campusName), value: r.dailyPerStudent || 0 }))),
      ], { note: 'Kampüsler arasındaki büyük farklar fiyat politikası, ürün çeşidi veya kayıt disiplini farkına işaret eder.' }),
      card('Brüt Kâr Marjı (%)', [
        barChart([...data.items].map((r) => ({ label: shortName(r.campusName), value: r.grossMarginPct || 0 })),
          { formatter: fmt.pct }),
      ]),
    ]),
  ];
}

/* --------------------------- Kritik stok --------------------------- */
async function critical() {
  const data = await api.get('/api/reports/critical-stock');
  return card('Kritik Stok ve Önerilen Sipariş', [
    table([
      { label: 'Kampüs', value: (r) => shortName(r.campusName) },
      { label: 'Ürün', value: (r) => r.productName, wrap: true },
      { label: 'Barkod', value: (r) => r.barcode || '—' },
      { label: 'Mevcut Stok', num: true, render: (r) => el(r.stockQty <= 0 ? 'strong.neg' : 'strong', { text: fmt.num(r.stockQty) }) },
      { label: 'Kritik Seviye', num: true, value: (r) => fmt.num(r.criticalStock) },
      { label: 'Önerilen Sipariş', num: true, render: (r) => el('strong', { text: `${fmt.num(r.suggestedOrder)} ${r.unit}` }) },
    ], data.items, {
      rowClass: (r) => (r.stockQty <= 0 ? 'is-critical' : 'is-warn'),
      emptyText: 'Kritik seviyede ürün yok. 👍',
    }),
  ], { tight: true, note: 'Önerilen sipariş = kritik seviyenin iki katına tamamlayacak miktar.' });
}

/* ------------------------ Tedarikçi alımları ----------------------- */
async function suppliers(range) {
  const data = await api.get('/api/reports/purchases-by-supplier', { campusId: state.campusId, ...range });
  return [
    el('div.grid.grid-3', {}, [
      stat('Dönem Toplam Alım', fmt.money(data.total)),
      stat('Tedarikçi Sayısı', String(data.items.length)),
      stat('En Büyük Tedarikçi', data.items[0]?.supplier_name ?? '—', { sub: data.items[0] ? fmt.money(data.items[0].gross_total) : '' }),
    ]),
    card('Tedarikçi Bazlı Alım', [
      table([
        { label: 'Tedarikçi', value: (r) => r.supplier_name, wrap: true },
        { label: 'Belge', num: true, value: (r) => r.document_count },
        { label: 'Net', num: true, value: (r) => fmt.money(r.net_total) },
        { label: 'KDV', num: true, value: (r) => fmt.money(r.vat_total) },
        { label: 'Toplam', num: true, render: (r) => el('strong', { text: fmt.money(r.gross_total) }) },
        { label: 'Pay', num: true, value: (r) => (data.total ? fmt.pct(Math.round((r.gross_total / data.total) * 1000) / 10) : '—') },
      ], data.items, { emptyText: 'Bu dönemde alım yok.' }),
    ], { tight: true }),
    data.items.length ? card('Alım Dağılımı', [
      barChart(data.items.map((r) => ({ label: r.supplier_name, value: r.gross_total }))),
    ]) : null,
  ];
}

function marginBadge(pct) {
  if (pct === null || pct === undefined) return el('span.muted', { text: '—' });
  const tone = pct < 0 ? 'bad' : pct < 20 ? 'warn' : 'ok';
  return badge(fmt.pct(pct), tone);
}
