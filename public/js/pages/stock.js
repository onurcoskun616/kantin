import { api } from '../api.js';
import { state, canWrite } from '../app.js';
import { el, card, stat, table, fmt, badge, modal, toast, formModal, empty, deltaCell, shortName } from '../ui.js';

export async function render(root) {
  const filters = { search: '', categoryId: '', onlyCritical: false };
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const [data, cats] = await Promise.all([
      api.get('/api/stock', { campusId: state.campusId, ...filters, onlyCritical: filters.onlyCritical ? '1' : '' }),
      api.get('/api/products/categories'),
    ]);
    container.replaceChildren();

    const s = data.summary;
    container.append(el('div.grid.grid-4', {}, [
      stat('Stoktaki Ürün Çeşidi', fmt.int(s.productCount)),
      stat('Stok Maliyet Değeri', fmt.money(s.costValue), { sub: 'Alış fiyatı × miktar' }),
      stat('Stok Satış Değeri', fmt.money(s.saleValue), { sub: `Potansiyel kâr ${fmt.money(s.saleValue - s.costValue)}` }),
      stat('Kritik Seviye', fmt.int(s.criticalCount), { tone: s.criticalCount > 0 ? 'warn' : 'ok', sub: s.negativeCount ? `${s.negativeCount} üründe eksi stok!` : 'Sipariş gerekebilir' }),
    ]));

    const searchInput = el('input.search-input', { type: 'search', placeholder: 'Ürün / barkod ara...', value: filters.search });
    searchInput.addEventListener('input', debounce(() => { filters.search = searchInput.value; draw(); }, 350));
    const catSelect = el('select', {}, [
      el('option', { value: '' }, ['Tüm kategoriler']),
      ...cats.items.map((c) => el('option', { value: c.id, selected: String(c.id) === filters.categoryId }, [c.name])),
    ]);
    catSelect.addEventListener('change', () => { filters.categoryId = catSelect.value; draw(); });
    const criticalToggle = el('input', { type: 'checkbox' });
    criticalToggle.checked = filters.onlyCritical;
    criticalToggle.addEventListener('change', () => { filters.onlyCritical = criticalToggle.checked; draw(); });

    container.append(card(null, [
      el('div.filter-bar', {}, [
        searchInput,
        catSelect,
        el('label.inline-field', {}, [criticalToggle, el('span', { text: 'Sadece kritik stok' })]),
        el('div', { style: 'flex:1' }),
        canWrite() ? el('button.btn', { text: '📥 Açılış Stoğu Gir', onclick: () => openOpening(draw) }) : null,
        el('button.btn', { text: '⬇ Excel (CSV)', onclick: () => api.download('/api/stock', { campusId: state.campusId, ...filters }) }),
      ]),
    ]));

    container.append(card(`Stok Durumu — ${shortCampus()}`, [
      table([
        { label: 'Barkod', value: (r) => r.barcode || '—' },
        { label: 'Ürün', value: (r) => r.name, wrap: true },
        { label: 'Kategori', value: (r) => r.category_name || '—' },
        { label: 'Stok', num: true, render: (r) => el(r.stock_qty < 0 ? 'strong.neg' : 'strong', { text: fmt.num(r.stock_qty) }) },
        { label: 'Kritik', num: true, value: (r) => (r.critical_stock ? fmt.num(r.critical_stock) : '—') },
        { label: 'Alış (KDV hariç)', num: true, value: (r) => fmt.money(r.purchase_price) },
        { label: 'Satış (KDV dahil)', num: true, value: (r) => fmt.money(r.sale_price) },
        { label: 'Birim Kâr', num: true, render: (r) => deltaCell(r.profit.unitProfit) },
        { label: 'Kâr Marjı', num: true, render: (r) => marginBadge(r.profit.marginPct) },
        { label: 'Stok Maliyeti', num: true, value: (r) => fmt.money(r.stock_cost_value) },
        { label: '', render: (r) => el('button.btn.btn-sm', { text: 'Hareketler', onclick: () => showLedger(r) }) },
      ], data.items, {
        rowClass: (r) => (r.stock_qty < 0 ? 'is-critical' : r.is_critical ? 'is-warn' : ''),
        emptyText: 'Bu filtrelere uyan ürün yok.',
      }),
    ], { tight: true }));
  }
}

function marginBadge(pct) {
  if (pct === null || pct === undefined) return el('span.muted', { text: '—' });
  const tone = pct < 0 ? 'bad' : pct < 20 ? 'warn' : 'ok';
  return badge(fmt.pct(pct), tone);
}

const MOVEMENT_LABELS = {
  ACILIS: 'Açılış stoğu', ALIS: 'Mal girişi (alım)', IADE: 'Tedarikçiye iade',
  FIRE: 'Fire / zayiat', TRANSFER_GIRIS: 'Transfer girişi', TRANSFER_CIKIS: 'Transfer çıkışı',
  SATIS: 'Satış (sayımdan)', SAYIM_FAZLA: 'Sayım fazlası',
};

async function showLedger(product) {
  const data = await api.get('/api/stock/movements', { campusId: state.campusId, productId: product.product_id });
  let running = 0;
  const rows = [...data.items].reverse().map((m) => { running += m.quantity; return { ...m, running: Math.round(running * 100) / 100 }; }).reverse();

  modal({
    title: `Stok Hareketleri — ${product.name}`,
    wide: true,
    body: [
      el('p.card-note', { text: 'Her stok rakamının arkasında belge bulunur. Liste en yeniden eskiye doğrudur.' }),
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.movement_date) },
        { label: 'Hareket', value: (r) => MOVEMENT_LABELS[r.movement_type] || r.movement_type },
        { label: 'Miktar', num: true, render: (r) => deltaCell(r.quantity, fmt.num) },
        { label: 'Kalan', num: true, value: (r) => fmt.num(r.running) },
        { label: 'Birim Maliyet', num: true, value: (r) => fmt.money(r.unit_cost) },
        { label: 'Belge', value: (r) => (r.ref_type ? `${r.ref_type} #${r.ref_id ?? ''}` : '—') },
        { label: 'Kullanıcı', value: (r) => r.created_by_name || '—' },
        { label: 'Not', value: (r) => r.note || '—', wrap: true },
      ], rows, { emptyText: 'Bu ürün için hareket kaydı yok.' }),
    ],
  });
}

async function openOpening(onDone) {
  const products = await api.get('/api/products', { campusId: state.campusId });
  const inputs = new Map();
  const rows = products.items.map((p) => {
    const input = el('input.num', { type: 'number', step: '0.01', min: '0', placeholder: '0' });
    inputs.set(p.id, input);
    return el('tr', {}, [
      el('td', { text: p.barcode || '—', class: 'small muted' }),
      el('td.wrap', { text: p.name }),
      el('td', {}, [input]),
    ]);
  });

  const m = formModal({
    title: 'Açılış Stoğu Girişi',
    wide: true,
    fields: [{ name: 'date', label: 'Açılış tarihi', type: 'date', value: new Date().toISOString().slice(0, 10), required: true }],
    submitText: 'Açılış Stoğunu Kaydet',
    onSubmit: async (v) => {
      const lines = [...inputs.entries()]
        .map(([productId, input]) => ({ productId, quantity: Number(String(input.value).replace(',', '.')) || 0 }))
        .filter((l) => l.quantity > 0);
      if (!lines.length) throw new Error('En az bir ürün için miktar girin.');
      await api.post('/api/stock/opening', { campusId: state.campusId, date: v.date, lines });
      toast(`${lines.length} ürün için açılış stoğu kaydedildi.`);
      onDone();
    },
  });
  m.box.querySelector('.modal-body').append(
    el('p.card-note', { text: 'Sisteme ilk geçişte mevcut rafınızı buradan girin. Sadece miktar girdiğiniz ürünler kaydedilir.' }),
    el('div.table-wrap', {}, [el('table.data.line-table', {}, [
      el('thead', {}, [el('tr', {}, [el('th', { text: 'Barkod' }), el('th', { text: 'Ürün' }), el('th', { text: 'Miktar' })])]),
      el('tbody', {}, rows),
    ])]),
  );
}

function shortCampus() {
  return shortName(state.campuses.find((c) => c.id === state.campusId)?.name || '');
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
