import { api } from '../api.js';
import { state, canWrite } from '../app.js';
import { el, card, stat, table, fmt, badge, modal, toast, confirmDialog, dateUtil, alertBox, empty, shortName} from '../ui.js';

export async function render(root) {
  const range = { from: dateUtil.thisMonth() + '-01', to: dateUtil.today() };
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/purchases', { campusId: state.campusId, ...range });
    container.replaceChildren();

    const fromInput = el('input', { type: 'date', value: range.from });
    const toInput = el('input', { type: 'date', value: range.to });
    fromInput.addEventListener('change', () => { range.from = fromInput.value; draw(); });
    toInput.addEventListener('change', () => { range.to = toInput.value; draw(); });

    const total = data.items.reduce((s, r) => s + r.gross_total, 0);

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div.filter-bar', {}, [
        el('label.field', {}, [el('span', { text: 'Başlangıç' }), fromInput]),
        el('label.field', {}, [el('span', { text: 'Bitiş' }), toInput]),
      ]),
      el('div.btn-row', {}, [
        canWrite() ? el('button.btn.btn-primary', { text: '+ Yeni Mal Girişi', onclick: () => openPurchaseForm(draw) }) : null,
      ]),
    ]));

    container.append(el('div.grid.grid-3', {}, [
      stat('Dönem Alım Tutarı', fmt.money(total), { sub: 'KDV dahil' }),
      stat('Belge Sayısı', String(data.items.length)),
      stat('Ortalama Belge', fmt.money(data.items.length ? total / data.items.length : 0)),
    ]));

    container.append(card('Alım Belgeleri (İrsaliye / Fatura)', [
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.document_date) },
        { label: 'Belge No', value: (r) => r.document_no || '—' },
        { label: 'Tedarikçi', value: (r) => r.supplier_name, wrap: true },
        ...(state.campuses.length > 1 ? [{ label: 'Kampüs', value: (r) => shortName(r.campus_name) }] : []),
        { label: 'Kalem', num: true, value: (r) => r.line_count },
        { label: 'Net', num: true, value: (r) => fmt.money(r.net_total) },
        { label: 'KDV', num: true, value: (r) => fmt.money(r.vat_total) },
        { label: 'Toplam', num: true, render: (r) => el('strong', { text: fmt.money(r.gross_total) }) },
        { label: 'Durum', render: (r) => (r.status === 'IPTAL' ? badge('İptal', 'bad') : badge('Onaylı', 'ok')) },
        { label: 'Giren', value: (r) => r.created_by_name || '—' },
        { label: '', render: (r) => el('button.btn.btn-sm', { text: 'Detay', onclick: () => showDetail(r.id, draw) }) },
      ], data.items, { emptyText: 'Bu dönemde alım belgesi yok.' }),
    ], { tight: true }));
  }
}

async function showDetail(id, onChange) {
  const data = await api.get(`/api/purchases/${id}`);
  modal({
    title: `Alım Belgesi #${data.id}`,
    wide: true,
    body: [
      el('dl.kv', {}, [
        el('dt', { text: 'Tedarikçi' }), el('dd', { text: data.supplier_name }),
        el('dt', { text: 'Belge no / tarih' }), el('dd', { text: `${data.document_no || '—'} · ${fmt.date(data.document_date)}` }),
        el('dt', { text: 'Kampüs' }), el('dd', { text: shortName(data.campus_name) }),
        el('dt', { text: 'Vade' }), el('dd', { text: data.due_date ? fmt.date(data.due_date) : '—' }),
        el('dt', { text: 'Toplam' }), el('dd', { text: fmt.money(data.gross_total) }),
      ]),
      table([
        { label: 'Ürün', value: (r) => r.product_name, wrap: true },
        { label: 'Miktar', num: true, value: (r) => `${fmt.num(r.quantity)} ${r.unit}` },
        { label: 'Birim Fiyat', num: true, value: (r) => fmt.money(r.unit_price) },
        { label: 'İsk. %', num: true, value: (r) => fmt.num(r.discount_pct) },
        { label: 'KDV %', num: true, value: (r) => fmt.num(r.vat_rate) },
        { label: 'Net', num: true, value: (r) => fmt.money(r.net_total) },
        { label: 'Toplam', num: true, value: (r) => fmt.money(r.gross_total) },
        { label: 'SKT', value: (r) => (r.expiry_date ? fmt.date(r.expiry_date) : '—') },
      ], data.lines),
      data.note ? el('p.card-note', { text: `Not: ${data.note}` }) : null,
    ],
    actions: canWrite() && data.status !== 'IPTAL' ? [
      el('button.btn.btn-danger', {
        text: 'Belgeyi İptal Et',
        onclick: async () => {
          const ok = await confirmDialog('Belge iptal edilecek ve stok hareketleri geri alınacak. Emin misiniz?',
            { title: 'Belgeyi İptal Et', confirmText: 'İptal Et', danger: true });
          if (!ok) return;
          try {
            await api.post(`/api/purchases/${data.id}/cancel`);
            toast('Belge iptal edildi.');
            document.querySelector('.modal-backdrop')?.remove();
            onChange();
          } catch (err) { toast(err.message, 'error'); }
        },
      }),
    ] : [],
  });
}

/* --------------------------- Yeni mal girişi ------------------------ */
async function openPurchaseForm(onDone) {
  const [suppliers, products] = await Promise.all([
    api.get('/api/suppliers'),
    api.get('/api/products', { campusId: state.campusId }),
  ]);
  if (!suppliers.items.length) {
    toast('Önce en az bir tedarikçi tanımlamalısınız.', 'warning');
    return;
  }

  const productMap = new Map(products.items.map((p) => [p.id, p]));
  const lines = [];
  const linesBody = el('tbody');
  const totalsBox = el('div.row', { style: 'justify-content:flex-end;gap:24px;font-weight:600' });

  const supplierSelect = el('select', {}, suppliers.items.map((s) => el('option', { value: s.id }, [s.name])));
  const docNo = el('input', { placeholder: 'İrsaliye / fatura no' });
  const docDate = el('input', { type: 'date', value: dateUtil.today() });
  const dueDate = el('input', { type: 'date' });
  const noteInput = el('textarea', { placeholder: 'Açıklama (isteğe bağlı)' });
  const errorBox = el('div.alert.alert-danger', { hidden: true });

  function recalcTotals() {
    let net = 0; let vat = 0;
    for (const l of lines) { net += l.net; vat += l.vat; }
    totalsBox.replaceChildren(
      el('span', { text: `Net: ${fmt.money(net)}` }),
      el('span', { text: `KDV: ${fmt.money(vat)}` }),
      el('span', { text: `Genel Toplam: ${fmt.money(net + vat)}`, style: 'font-size:15px' }),
    );
  }

  function addLine(presetId = null) {
    const line = { productId: presetId ?? products.items[0]?.id, quantity: 1, unitPrice: 0, vatRate: 10, discountPct: 0, net: 0, vat: 0 };
    const select = el('select', {}, products.items.map((p) =>
      el('option', { value: p.id, selected: p.id === line.productId }, [`${p.name}${p.barcode ? ' · ' + p.barcode : ''}`])));
    const qty = el('input.num', { type: 'number', step: '0.01', min: '0.001', value: '1' });
    const price = el('input.num', { type: 'number', step: '0.01', min: '0' });
    const disc = el('input.num', { type: 'number', step: '0.01', min: '0', max: '100', value: '0' });
    const vatIn = el('input.num', { type: 'number', step: '0.1', min: '0', max: '100' });
    const expiry = el('input', { type: 'date' });
    const totalCell = el('td.num');

    const syncProduct = () => {
      const p = productMap.get(Number(select.value));
      line.productId = Number(select.value);
      if (p) {
        if (!price.value || Number(price.value) === 0) price.value = p.purchase_price;
        vatIn.value = p.vat_rate;
      }
      recalcLine();
    };
    const recalcLine = () => {
      line.quantity = Number(qty.value) || 0;
      line.unitPrice = Number(price.value) || 0;
      line.discountPct = Number(disc.value) || 0;
      line.vatRate = Number(vatIn.value) || 0;
      line.expiryDate = expiry.value || null;
      line.net = Math.round(line.quantity * line.unitPrice * (1 - line.discountPct / 100) * 100) / 100;
      line.vat = Math.round(line.net * (line.vatRate / 100) * 100) / 100;
      totalCell.textContent = fmt.money(line.net + line.vat);
      recalcTotals();
    };
    [select, qty, price, disc, vatIn, expiry].forEach((n) => n.addEventListener('input', recalcLine));
    select.addEventListener('change', syncProduct);

    const tr = el('tr', {}, [
      el('td', { style: 'min-width:220px' }, [select]),
      el('td', {}, [qty]), el('td', {}, [price]), el('td', {}, [disc]), el('td', {}, [vatIn]),
      el('td', {}, [expiry]), totalCell,
      el('td', {}, [el('button.icon-btn', {
        text: '✕', title: 'Satırı sil',
        onclick: () => { lines.splice(lines.indexOf(line), 1); tr.remove(); recalcTotals(); },
      })]),
    ]);
    lines.push(line);
    linesBody.append(tr);
    syncProduct();
    select.focus();
  }

  const saveBtn = el('button.btn.btn-primary', { text: 'Belgeyi Kaydet' });
  const m = modal({
    title: 'Yeni Mal Girişi (İrsaliye / Fatura)',
    wide: true,
    body: [
      errorBox,
      el('div.grid.grid-3', {}, [
        el('label.field', {}, [el('span', { text: 'Tedarikçi *' }), supplierSelect]),
        el('label.field', {}, [el('span', { text: 'Belge No' }), docNo]),
        el('label.field', {}, [el('span', { text: 'Belge Tarihi *' }), docDate]),
        el('label.field', {}, [el('span', { text: 'Vade Tarihi' }), dueDate]),
      ]),
      el('div.table-wrap', {}, [el('table.data.line-table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Ürün' }), el('th', { text: 'Miktar' }), el('th', { text: 'Birim Fiyat (KDV hariç)' }),
          el('th', { text: 'İsk %' }), el('th', { text: 'KDV %' }), el('th', { text: 'SKT' }),
          el('th.num', { text: 'Tutar' }), el('th'),
        ])]),
        linesBody,
      ])]),
      el('div.btn-row', {}, [el('button.btn.btn-sm', { text: '+ Satır Ekle', onclick: () => addLine() })]),
      totalsBox,
      el('label.field', {}, [el('span', { text: 'Not' }), noteInput]),
    ],
    actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m.close() }), saveBtn],
  });

  addLine();
  recalcTotals();

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Kaydediliyor...';
    try {
      const payload = {
        campusId: state.campusId,
        supplierId: Number(supplierSelect.value),
        documentNo: docNo.value.trim(),
        documentDate: docDate.value,
        dueDate: dueDate.value || null,
        note: noteInput.value.trim(),
        lines: lines.filter((l) => l.quantity > 0).map((l) => ({
          productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
          vatRate: l.vatRate, discountPct: l.discountPct, expiryDate: l.expiryDate,
        })),
      };
      if (!payload.lines.length) throw new Error('En az bir ürün satırı girmelisiniz.');
      const res = await api.post('/api/purchases', payload);
      m.close();
      toast(`Mal girişi kaydedildi. Toplam ${fmt.money(res.grossTotal)}`);
      if (res.priceAlerts?.length) {
        modal({
          title: '⚠️ Alış Fiyatı Artışı Tespit Edildi',
          body: [
            el('p', { text: 'Aşağıdaki ürünlerde tedarikçi fiyatı %10\'dan fazla arttı. Satış fiyatlarını gözden geçirmeniz önerilir:' }),
            table([
              { label: 'Ürün', value: (r) => r.productName, wrap: true },
              { label: 'Eski Alış', num: true, value: (r) => fmt.money(r.oldPrice) },
              { label: 'Yeni Alış', num: true, value: (r) => fmt.money(r.newPrice) },
              { label: 'Artış', num: true, value: (r) => fmt.pct(r.increasePct) },
            ], res.priceAlerts),
          ],
        });
      }
      onDone();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Belgeyi Kaydet';
    }
  });
}

