/** Fire/zayiat ve kampüsler arası transfer sayfaları. */
import { api } from '../api.js';
import { state, canWrite } from '../app.js';
import { el, card, stat, table, fmt, badge, modal, toast, formModal, dateUtil, WASTE_REASONS, empty, shortName} from '../ui.js';

/* ============================== Fire =============================== */
export async function renderWaste(root) {
  const range = { from: dateUtil.thisMonth() + '-01', to: dateUtil.today() };
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const [list, report] = await Promise.all([
      api.get('/api/waste', { campusId: state.campusId, ...range }),
      api.get('/api/reports/waste', { campusId: state.campusId, ...range }),
    ]);
    container.replaceChildren();

    const fromInput = el('input', { type: 'date', value: range.from });
    const toInput = el('input', { type: 'date', value: range.to });
    fromInput.addEventListener('change', () => { range.from = fromInput.value; draw(); });
    toInput.addEventListener('change', () => { range.to = toInput.value; draw(); });

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div.filter-bar', {}, [
        el('label.field', {}, [el('span', { text: 'Başlangıç' }), fromInput]),
        el('label.field', {}, [el('span', { text: 'Bitiş' }), toInput]),
      ]),
      canWrite() ? el('button.btn.btn-primary', { text: '+ Fire Kaydı', onclick: () => openWasteForm(draw) }) : null,
    ]));

    container.append(el('div.grid.grid-3', {}, [
      stat('Dönem Fire Maliyeti', fmt.money(report.totalCost), { tone: report.totalCost > 0 ? 'warn' : 'ok' }),
      stat('Kayıt Sayısı', String(list.items.length)),
      stat('En Yüksek Neden', report.byReason[0] ? WASTE_REASONS[report.byReason[0].reason] : '—', {
        sub: report.byReason[0] ? fmt.money(report.byReason[0].cost) : '',
      }),
    ]));

    container.append(el('div.alert.alert-info', {}, [
      el('strong', { text: 'Fire kaydı neden önemli?' }),
      'Bozulan, kırılan, son kullanma tarihi geçen veya ikram edilen ürünler kaydedilmezse sayımda eksik çıkar ve kayıp/kaçak gibi görünür. Her zayiatı aynı gün kaydedin.',
    ]));

    container.append(el('div.grid.grid-2', {}, [
      card('Nedene Göre Dağılım', [
        table([
          { label: 'Neden', value: (r) => WASTE_REASONS[r.reason] || r.reason },
          { label: 'Miktar', num: true, value: (r) => fmt.num(r.qty) },
          { label: 'Maliyet', num: true, value: (r) => fmt.money(r.cost) },
          { label: 'Kayıt', num: true, value: (r) => r.records },
        ], report.byReason, { emptyText: 'Bu dönemde fire kaydı yok.' }),
      ], { tight: true }),
      card('En Çok Fire Veren Ürünler', [
        table([
          { label: 'Ürün', value: (r) => r.product_name, wrap: true },
          { label: 'Miktar', num: true, value: (r) => fmt.num(r.qty) },
          { label: 'Maliyet', num: true, value: (r) => fmt.money(r.cost) },
        ], report.byProduct.slice(0, 12), { emptyText: 'Kayıt yok.' }),
      ], { tight: true }),
    ]));

    container.append(card('Fire Kayıtları', [
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.waste_date) },
        ...(state.campuses.length > 1 ? [{ label: 'Kampüs', value: (r) => shortName(r.campus_name) }] : []),
        { label: 'Ürün', value: (r) => r.product_name, wrap: true },
        { label: 'Miktar', num: true, value: (r) => `${fmt.num(r.quantity)} ${r.unit}` },
        { label: 'Neden', render: (r) => badge(WASTE_REASONS[r.reason] || r.reason, r.reason === 'SKT' ? 'warn' : '') },
        { label: 'Maliyet', num: true, value: (r) => fmt.money(r.cost_value) },
        { label: 'Kaydeden', value: (r) => r.created_by_name || '—' },
        { label: 'Not', value: (r) => r.note || '—', wrap: true },
      ], list.items, { emptyText: 'Fire kaydı bulunmuyor.' }),
    ], { tight: true }));
  }
}

async function openWasteForm(onDone) {
  const products = await api.get('/api/products', { campusId: state.campusId });
  formModal({
    title: 'Fire / Zayiat Kaydı',
    fields: [
      { name: 'productId', label: 'Ürün', type: 'select', required: true,
        options: products.items.map((p) => ({ value: p.id, label: `${p.name}${p.barcode ? ' · ' + p.barcode : ''}` })) },
      { name: 'quantity', label: 'Miktar', type: 'number', step: '0.01', min: '0.01', required: true },
      { name: 'reason', label: 'Neden', type: 'select', required: true,
        options: Object.entries(WASTE_REASONS).map(([value, label]) => ({ value, label })) },
      { name: 'wasteDate', label: 'Tarih', type: 'date', value: dateUtil.today(), required: true },
      { name: 'note', label: 'Açıklama', type: 'textarea', placeholder: 'Örn: Dolap arızası nedeniyle bozulan ürünler' },
    ],
    submitText: 'Fire Kaydet',
    onSubmit: async (v) => {
      await api.post('/api/waste', { ...v, campusId: state.campusId });
      toast('Fire kaydedildi ve stoktan düşüldü.');
      onDone();
    },
  });
}

/* ============================ Transferler ========================== */
export async function renderTransfers(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/transfers');
    container.replaceChildren();

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div', {}, [
        el('h3', { text: 'Kampüsler Arası Transfer' }),
        el('p.card-note', { text: 'Bir kampüsten diğerine gönderilen ürünler. Transfer kaydedilmezse gönderen kampüste kayıp, alan kampüste fazla görünür.' }),
      ]),
      canWrite() ? el('button.btn.btn-primary', { text: '+ Yeni Transfer', onclick: () => openTransferForm(draw) }) : null,
    ]));

    container.append(card(null, [
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.transfer_date) },
        { label: 'Gönderen', value: (r) => shortName(r.from_campus_name) },
        { label: 'Alan', value: (r) => shortName(r.to_campus_name) },
        { label: 'Kalem', num: true, value: (r) => r.line_count },
        { label: 'Kaydeden', value: (r) => r.created_by_name || '—' },
        { label: 'Not', value: (r) => r.note || '—', wrap: true },
        { label: '', render: (r) => el('button.btn.btn-sm', { text: 'Detay', onclick: () => showTransfer(r.id) }) },
      ], data.items, { emptyText: 'Transfer kaydı yok.' }),
    ], { tight: true }));
  }
}

async function showTransfer(id) {
  const data = await api.get(`/api/transfers/${id}`);
  modal({
    title: `Transfer #${data.id} — ${fmt.date(data.transfer_date)}`,
    body: [
      el('p', { text: `${shortName(data.from_campus_name)} → ${shortName(data.to_campus_name)}` }),
      table([
        { label: 'Ürün', value: (r) => r.product_name, wrap: true },
        { label: 'Miktar', num: true, value: (r) => `${fmt.num(r.quantity)} ${r.unit}` },
        { label: 'Birim Maliyet', num: true, value: (r) => fmt.money(r.unit_cost) },
        { label: 'Tutar', num: true, value: (r) => fmt.money(r.quantity * r.unit_cost) },
      ], data.lines),
    ],
  });
}

async function openTransferForm(onDone) {
  const products = await api.get('/api/products', { campusId: state.campusId });
  const targets = state.campuses.filter((c) => c.id !== state.campusId);
  if (!targets.length) { toast('Transfer için en az iki kampüs gerekir.', 'warning'); return; }

  const lines = [];
  const body = el('tbody');
  const targetSelect = el('select', {}, targets.map((c) => el('option', { value: c.id }, [shortName(c.name)])));
  const dateInput = el('input', { type: 'date', value: dateUtil.today() });
  const noteInput = el('input', { placeholder: 'Açıklama' });
  const errorBox = el('div.alert.alert-danger', { hidden: true });

  function addLine() {
    const line = { productId: products.items[0]?.id, quantity: 1 };
    const select = el('select', {}, products.items.map((p) => el('option', { value: p.id }, [p.name])));
    const qty = el('input.num', { type: 'number', step: '0.01', min: '0.01', value: '1' });
    select.addEventListener('change', () => { line.productId = Number(select.value); });
    qty.addEventListener('input', () => { line.quantity = Number(qty.value) || 0; });
    const tr = el('tr', {}, [
      el('td', { style: 'min-width:220px' }, [select]),
      el('td', {}, [qty]),
      el('td', {}, [el('button.icon-btn', { text: '✕', onclick: () => { lines.splice(lines.indexOf(line), 1); tr.remove(); } })]),
    ]);
    lines.push(line);
    body.append(tr);
  }

  const saveBtn = el('button.btn.btn-primary', { text: 'Transferi Kaydet' });
  const m = modal({
    title: 'Kampüsler Arası Transfer',
    wide: true,
    body: [
      errorBox,
      el('div.grid.grid-3', {}, [
        el('label.field', {}, [el('span', { text: 'Gönderen' }), el('input', { value: shortName(state.campuses.find((c) => c.id === state.campusId)?.name || ''), disabled: true })]),
        el('label.field', {}, [el('span', { text: 'Alan Kampüs *' }), targetSelect]),
        el('label.field', {}, [el('span', { text: 'Tarih *' }), dateInput]),
      ]),
      el('div.table-wrap', {}, [el('table.data.line-table', {}, [
        el('thead', {}, [el('tr', {}, [el('th', { text: 'Ürün' }), el('th', { text: 'Miktar' }), el('th')])]),
        body,
      ])]),
      el('div.btn-row', {}, [el('button.btn.btn-sm', { text: '+ Satır Ekle', onclick: addLine })]),
      el('label.field', {}, [el('span', { text: 'Not' }), noteInput]),
    ],
    actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m.close() }), saveBtn],
  });
  addLine();

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    saveBtn.disabled = true;
    try {
      await api.post('/api/transfers', {
        fromCampusId: state.campusId,
        toCampusId: Number(targetSelect.value),
        transferDate: dateInput.value,
        note: noteInput.value.trim(),
        lines: lines.filter((l) => l.quantity > 0),
      });
      m.close();
      toast('Transfer kaydedildi.');
      onDone();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
    }
  });
}

