/**
 * Tedarikçiye iade.
 *
 * Fire ile karıştırılmaması için ekranda da ayrım vurgulanır:
 * fire maliyeti kantinde kalır, iade tedarikçinin cari hesabından düşer.
 */
import { api } from '../api.js';
import { state, canWrite } from '../app.js';
import {
  el, card, stat, table, fmt, badge, modal, toast, confirmDialog,
  dateUtil, alertBox, shortName,
} from '../ui.js';

export const RETURN_REASONS = {
  BOZUK: 'Bozuk / ayıplı mal',
  SKT: 'SKT geçmiş gelmiş',
  YANLIS_URUN: 'Yanlış ürün gönderilmiş',
  FAZLA_GONDERIM: 'Fazla gönderim',
  HASARLI: 'Nakliyede hasar',
  DIGER: 'Diğer',
};

export async function render(root) {
  const range = { from: dateUtil.thisMonth() + '-01', to: dateUtil.today() };
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/returns', { campusId: state.campusId, ...range });
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
      canWrite() ? el('button.btn.btn-primary', { text: '+ Yeni İade', onclick: () => openForm(draw) }) : null,
    ]));

    container.append(alertBox('info', 'İade mi, fire mi?',
      'Mal tedarikçiye geri gidiyorsa İADE\'dir: maliyeti size yazılmaz, tedarikçinin cari hesabından düşer. '
      + 'Mal sizde bozulduysa/kırıldıysa FİRE\'dir: maliyeti kantinde kalır. '
      + 'İkisi de stoktan aynı şekilde düşer — fark, maliyetin kime yazıldığıdır.'));

    const s = data.summary;
    container.append(el('div.grid.grid-3', {}, [
      stat('Dönem İade Tutarı', fmt.money(s.grossTotal), { sub: 'KDV dahil · cari hesaptan düşer' }),
      stat('Belge Sayısı', String(s.documentCount)),
      stat('En Sık Neden', data.byReason[0] ? RETURN_REASONS[data.byReason[0].reason] : '—', {
        sub: data.byReason[0] ? fmt.money(data.byReason[0].total) : '',
        tone: data.byReason[0] ? 'warn' : '',
      }),
    ]));

    if (data.byReason.length) {
      container.append(card('Nedene Göre Dağılım', [
        table([
          { label: 'Neden', value: (r) => RETURN_REASONS[r.reason] || r.reason },
          { label: 'Belge', num: true, value: (r) => r.document_count },
          { label: 'Tutar', num: true, value: (r) => fmt.money(r.total) },
        ], data.byReason),
      ], {
        tight: true,
        note: 'Bir tedarikçide "bozuk mal" iadeleri tekrarlıyorsa, tedarikçiyle konuşmanız gereken bir konu vardır.',
      }));
    }

    container.append(card('İade Belgeleri', [
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.return_date) },
        { label: 'Belge No', value: (r) => r.document_no || '—' },
        { label: 'Tedarikçi', value: (r) => r.supplier_name, wrap: true },
        ...(state.campuses.length > 1 ? [{ label: 'Kampüs', value: (r) => shortName(r.campus_name) }] : []),
        { label: 'Neden', render: (r) => badge(RETURN_REASONS[r.reason] || r.reason, 'warn') },
        { label: 'Kalem', num: true, value: (r) => r.line_count },
        { label: 'Net', num: true, value: (r) => fmt.money(r.net_total) },
        { label: 'Toplam', num: true, render: (r) => el('strong', { text: fmt.money(r.gross_total) }) },
        { label: 'İlgili Alım', value: (r) => r.purchase_document_no || '—' },
        { label: 'Giren', value: (r) => r.created_by_name || '—' },
        { label: '', render: (r) => el('button.btn.btn-sm', { text: 'Detay', onclick: () => showDetail(r.id, draw) }) },
      ], data.items, { emptyText: 'Bu dönemde iade kaydı yok.' }),
    ], { tight: true }));
  }
}

async function showDetail(id, onChange) {
  const data = await api.get(`/api/returns/${id}`);
  const m = modal({
    title: `İade Belgesi #${data.id}`,
    wide: true,
    body: [
      el('dl.kv', {}, [
        el('dt', { text: 'Tedarikçi' }), el('dd', { text: data.supplier_name }),
        el('dt', { text: 'Belge no / tarih' }), el('dd', { text: `${data.document_no || '—'} · ${fmt.date(data.return_date)}` }),
        el('dt', { text: 'Kampüs' }), el('dd', { text: shortName(data.campus_name) }),
        el('dt', { text: 'Neden' }), el('dd', { text: RETURN_REASONS[data.reason] || data.reason }),
        el('dt', { text: 'İlgili alım belgesi' }), el('dd', { text: data.purchase_document_no || '—' }),
        el('dt', { text: 'Toplam' }), el('dd', { text: fmt.money(data.gross_total) }),
      ]),
      table([
        { label: 'Ürün', value: (r) => r.product_name, wrap: true },
        { label: 'Miktar', num: true, value: (r) => `${fmt.num(r.quantity)} ${r.unit}` },
        { label: 'Birim Fiyat', num: true, value: (r) => fmt.money(r.unit_price) },
        { label: 'KDV %', num: true, value: (r) => fmt.num(r.vat_rate) },
        { label: 'Net', num: true, value: (r) => fmt.money(r.net_total) },
        { label: 'Toplam', num: true, value: (r) => fmt.money(r.gross_total) },
      ], data.lines),
      data.note ? el('p.card-note', { text: `Not: ${data.note}` }) : null,
    ],
    actions: canWrite() ? [
      el('button.btn.btn-danger', {
        text: 'Belgeyi Sil',
        onclick: async () => {
          const ok = await confirmDialog(
            'İade belgesi silinecek ve stok hareketleri geri alınacak. Emin misiniz?',
            { title: 'İade Belgesini Sil', confirmText: 'Sil', danger: true }
          );
          if (!ok) return;
          try {
            await api.del(`/api/returns/${data.id}`);
            toast('İade belgesi silindi.');
            m.close();
            onChange();
          } catch (err) { toast(err.message, 'error'); }
        },
      }),
    ] : [],
  });
}

/* --------------------------- Yeni iade formu ------------------------ */
async function openForm(onDone) {
  const [suppliers, products] = await Promise.all([
    api.get('/api/suppliers'),
    api.get('/api/products', { campusId: state.campusId }),
  ]);
  if (!suppliers.items.length) { toast('Önce en az bir tedarikçi tanımlamalısınız.', 'warning'); return; }

  // Üretilen ürünler tedarikçiden gelmediği için iade edilemez
  const returnable = products.items.filter((p) => p.product_type !== 'URETILEN');
  if (!returnable.length) { toast('İade edilebilecek ürün bulunamadı.', 'warning'); return; }
  const productMap = new Map(returnable.map((p) => [p.id, p]));

  const lines = [];
  const linesBody = el('tbody');
  const totalsBox = el('div.row', { style: 'justify-content:flex-end;gap:24px;font-weight:600' });

  const supplierSelect = el('select', {}, suppliers.items.map((s) => el('option', { value: s.id }, [s.name])));
  const purchaseSelect = el('select', {}, [el('option', { value: '' }, ['— seçiniz (isteğe bağlı) —'])]);
  const docNo = el('input', { placeholder: 'İade irsaliye no' });
  const dateInput = el('input', { type: 'date', value: dateUtil.today(), max: dateUtil.today() });
  const reasonSelect = el('select', {}, Object.entries(RETURN_REASONS).map(([v, l]) => el('option', { value: v }, [l])));
  const noteInput = el('textarea', { placeholder: 'Açıklama (isteğe bağlı)' });
  const errorBox = el('div.alert.alert-danger', { hidden: true });

  function recalcTotals() {
    let net = 0; let vat = 0;
    for (const l of lines) { net += l.net; vat += l.vat; }
    totalsBox.replaceChildren(
      el('span', { text: `Net: ${fmt.money(net)}` }),
      el('span', { text: `KDV: ${fmt.money(vat)}` }),
      el('span', { text: `İade Toplamı: ${fmt.money(net + vat)}`, style: 'font-size:15px' }),
    );
  }

  function addLine(preset = null) {
    const line = {
      productId: preset?.productId ?? returnable[0]?.id,
      quantity: preset?.quantity ?? 1,
      unitPrice: preset?.unitPrice ?? 0,
      vatRate: preset?.vatRate ?? 10,
      net: 0, vat: 0,
    };
    const select = el('select', {}, returnable.map((p) =>
      el('option', { value: p.id, selected: p.id === line.productId }, [`${p.name}${p.barcode ? ' · ' + p.barcode : ''}`])));
    const qty = el('input.num', { type: 'number', step: '0.01', min: '0.001', value: String(line.quantity) });
    const price = el('input.num', { type: 'number', step: '0.01', min: '0' });
    const vatIn = el('input.num', { type: 'number', step: '0.1', min: '0', max: '100' });
    const stockCell = el('td.num.small.muted');
    const totalCell = el('td.num');

    const syncProduct = () => {
      const p = productMap.get(Number(select.value));
      line.productId = Number(select.value);
      if (p) {
        if (!price.value || Number(price.value) === 0) price.value = p.effective_purchase_price;
        vatIn.value = p.vat_rate;
      }
      recalcLine();
    };
    const recalcLine = () => {
      line.quantity = Number(qty.value) || 0;
      line.unitPrice = Number(price.value) || 0;
      line.vatRate = Number(vatIn.value) || 0;
      line.net = Math.round(line.quantity * line.unitPrice * 100) / 100;
      line.vat = Math.round(line.net * (line.vatRate / 100) * 100) / 100;
      totalCell.textContent = fmt.money(line.net + line.vat);
      recalcTotals();
    };
    [qty, price, vatIn].forEach((n) => n.addEventListener('input', recalcLine));
    select.addEventListener('change', syncProduct);

    const tr = el('tr', {}, [
      el('td', { style: 'min-width:220px' }, [select]),
      el('td', {}, [qty]), el('td', {}, [price]), el('td', {}, [vatIn]),
      stockCell, totalCell,
      el('td', {}, [el('button.icon-btn', {
        text: '✕', title: 'Satırı sil',
        onclick: () => { lines.splice(lines.indexOf(line), 1); tr.remove(); recalcTotals(); },
      })]),
    ]);
    lines.push(line);
    linesBody.append(tr);
    if (preset) { price.value = preset.unitPrice; vatIn.value = preset.vatRate; }
    syncProduct();
    return select;
  }

  // Tedarikçi seçilince o tedarikçinin son alım belgeleri listelenir
  async function loadPurchases() {
    const res = await api.get('/api/purchases', {
      campusId: state.campusId, supplierId: supplierSelect.value, limit: 30,
    });
    purchaseSelect.replaceChildren(el('option', { value: '' }, ['— seçiniz (isteğe bağlı) —']));
    for (const p of res.items.filter((x) => x.status !== 'IPTAL')) {
      purchaseSelect.append(el('option', { value: p.id },
        [`${fmt.date(p.document_date)} · ${p.document_no || 'no yok'} · ${fmt.money(p.gross_total)}`]));
    }
  }
  supplierSelect.addEventListener('change', loadPurchases);
  await loadPurchases();

  // Alım belgesi seçilirse satırlar oradan doldurulur (fiyatlar birebir eşleşsin)
  purchaseSelect.addEventListener('change', async () => {
    if (!purchaseSelect.value) return;
    const purchase = await api.get(`/api/purchases/${purchaseSelect.value}`);
    lines.length = 0;
    linesBody.replaceChildren();
    for (const l of purchase.lines) {
      if (!productMap.has(l.product_id)) continue;
      addLine({ productId: l.product_id, quantity: l.quantity, unitPrice: l.unit_price, vatRate: l.vat_rate });
    }
    if (!lines.length) addLine();
    recalcTotals();
    toast('Satırlar alım belgesinden dolduruldu. İade edilmeyen kalemleri silin, miktarları düzeltin.');
  });

  const saveBtn = el('button.btn.btn-primary', { text: 'İadeyi Kaydet' });
  const m = modal({
    title: 'Tedarikçiye İade',
    wide: true,
    body: [
      errorBox,
      el('div.grid.grid-3', {}, [
        el('label.field', {}, [el('span', { text: 'Tedarikçi *' }), supplierSelect]),
        el('label.field', {}, [
          el('span', { text: 'İlgili alım belgesi' }), purchaseSelect,
          el('small', { text: 'Seçerseniz satırlar ve fiyatlar o belgeden doldurulur.' }),
        ]),
        el('label.field', {}, [el('span', { text: 'İade nedeni *' }), reasonSelect]),
        el('label.field', {}, [el('span', { text: 'İade irsaliye no' }), docNo]),
        el('label.field', {}, [el('span', { text: 'İade tarihi *' }), dateInput]),
      ]),
      el('div.table-wrap', {}, [el('table.data.line-table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'Ürün' }), el('th', { text: 'Miktar' }),
          el('th', { text: 'Birim Fiyat (KDV hariç)' }), el('th', { text: 'KDV %' }),
          el('th.num', { text: '' }), el('th.num', { text: 'Tutar' }), el('th'),
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
        purchaseId: purchaseSelect.value ? Number(purchaseSelect.value) : null,
        documentNo: docNo.value.trim(),
        returnDate: dateInput.value,
        reason: reasonSelect.value,
        note: noteInput.value.trim(),
        lines: lines.filter((l) => l.quantity > 0).map((l) => ({
          productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice, vatRate: l.vatRate,
        })),
      };
      if (!payload.lines.length) throw new Error('En az bir ürün satırı girmelisiniz.');
      const res = await api.post('/api/returns', payload);
      m.close();
      toast(`İade kaydedildi. Toplam ${fmt.money(res.grossTotal)} tedarikçi hesabından düşüldü.`);

      if (res.stockWarnings?.length) {
        modal({
          title: '⚠️ Stokta Görünenden Fazla İade',
          body: [
            el('p', { text: 'Aşağıdaki ürünlerde iade miktarı, kayıtlardaki stoktan fazla. İade kaydedildi ancak stok eksiye düşmüş olabilir — mal girişlerini kontrol edin:' }),
            table([
              { label: 'Ürün', value: (r) => r.name, wrap: true },
              { label: 'İade', num: true, value: (r) => fmt.num(r.quantity) },
              { label: 'Kayıtlı Stok', num: true, value: (r) => fmt.num(r.stock) },
            ], res.stockWarnings),
          ],
        });
      }
      onDone();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'İadeyi Kaydet';
    }
  });
}
