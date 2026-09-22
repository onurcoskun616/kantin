/**
 * Reçete (BOM) yönetimi.
 *
 * Reçete iki işe yarar:
 *   1. Üretilen ürünün gerçek maliyeti (tahmin değil, hammadde toplamı)
 *   2. Sayımda çapraz kontrol — beyan edilen üretim adedinin gerektirdiği
 *      hammadde, o hammaddenin sayım farkından düşülür
 */
import { api } from '../api.js';
import { state, canWrite } from '../app.js';
import {
  el, card, stat, table, fmt, badge, modal, toast, confirmDialog, alertBox, deltaCell,
} from '../ui.js';

export async function render(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/recipes', { campusId: state.campusId });
    container.replaceChildren();

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div', {}, [
        el('h3', { text: 'Reçeteler' }),
        el('p.card-note', { text: 'Kantinde hazırlanan ürünlerin içeriği. Reçete tanımlıysa maliyet tahmin değil, hammadde toplamıdır; sayımda hammadde tüketimi otomatik hesaba katılır.' }),
      ]),
    ]));

    const withRecipe = data.items.filter((i) => i.has_recipe);
    const avgMargin = withRecipe.length
      ? withRecipe.reduce((s, i) => s + (i.profit.marginPct || 0), 0) / withRecipe.length : 0;

    container.append(el('div.grid.grid-3', {}, [
      stat('Üretilen Ürün', String(data.items.length)),
      stat('Reçetesi Eksik', String(data.withoutRecipe), {
        tone: data.withoutRecipe > 0 ? 'warn' : 'ok',
        sub: data.withoutRecipe > 0 ? 'Maliyeti tahmine dayalı' : 'Hepsinin reçetesi var',
      }),
      stat('Ortalama Kâr Marjı', fmt.pct(Math.round(avgMargin * 100) / 100), { sub: 'Reçeteli ürünler' }),
    ]));

    if (data.withoutRecipe > 0) {
      container.append(alertBox('warning', `${data.withoutRecipe} üründe reçete tanımlı değil`,
        'Bu ürünlerin maliyeti elle girilen tahmine dayanıyor ve sayımda hammadde tüketimleri hesaba katılmıyor. '
        + 'Reçete tanımlandığında hem kâr marjı gerçek olur hem de "beyan edilen tost sayısı kadar ekmek tükenmiş mi?" '
        + 'sorusu otomatik yanıtlanır.'));
    }

    container.append(card('Üretilen Ürünler', [
      table([
        { label: 'Ürün', value: (r) => r.name, wrap: true },
        { label: 'Kategori', value: (r) => r.category_name || '—' },
        { label: 'Reçete', render: (r) => (r.has_recipe ? badge(`${r.item_count} içerik`, 'ok') : badge('Tanımsız', 'warn')) },
        { label: 'Üretim', num: true, value: (r) => (r.has_recipe ? `${fmt.num(r.yield_quantity)} adet` : '—') },
        { label: 'Birim Maliyet', num: true, render: (r) => el(r.has_recipe ? 'strong' : 'span.muted', { text: fmt.money(r.unit_cost) }) },
        { label: 'Tahmin', num: true, value: (r) => fmt.money(r.estimated_cost) },
        { label: 'Sapma', num: true, render: (r) => (r.cost_gap === null ? el('span.muted', { text: '—' }) : deltaCell(r.cost_gap)) },
        { label: 'Satış', num: true, value: (r) => fmt.money(r.sale_price) },
        { label: 'Birim Kâr', num: true, render: (r) => deltaCell(r.profit.unitProfit) },
        { label: 'Marj', num: true, render: (r) => marginBadge(r.profit.marginPct) },
        {
          label: '', render: (r) => (canWrite()
            ? el('button.btn.btn-sm', { text: r.has_recipe ? 'Düzenle' : 'Reçete Tanımla', onclick: () => openEditor(r.id, draw) })
            : el('button.btn.btn-sm', { text: 'İncele', onclick: () => openEditor(r.id, draw) })),
        },
      ], data.items, {
        rowClass: (r) => (!r.has_recipe ? 'is-warn' : r.profit.unitProfit < 0 ? 'is-critical' : ''),
        emptyText: 'Üretilen ürün tanımlı değil. Ürünler ekranından bir ürünü "Üretilen" tipine alın.',
      }),
    ], {
      tight: true,
      note: '"Sapma", reçeteden çıkan gerçek maliyet ile ürün kartındaki tahmin arasındaki farktır. Büyük sapma, fiyatlamanızın yanlış varsayıma dayandığını gösterir.',
    }));
  }
}

function marginBadge(pct) {
  if (pct === null || pct === undefined) return el('span.muted', { text: '—' });
  const tone = pct < 0 ? 'bad' : pct < 20 ? 'warn' : 'ok';
  return badge(fmt.pct(pct), tone);
}

/* --------------------------- Reçete editörü ------------------------- */
export async function openEditor(productId, onDone) {
  const data = await api.get(`/api/recipes/${productId}`, { campusId: state.campusId });
  const editable = canWrite();

  const rows = [];
  const body = el('tbody');
  const summaryBox = el('div.grid', { style: 'gap:6px' });
  const errorBox = el('div.alert.alert-danger', { hidden: true });

  const yieldInput = el('input.num', {
    type: 'number', step: '0.01', min: '0.001', value: String(data.yieldQuantity || 1), disabled: !editable,
  });
  const noteInput = el('input', { value: data.note ?? '', placeholder: 'Örn: 1 demlik = 40 bardak', disabled: !editable });

  function recalc() {
    const yieldQty = Number(yieldInput.value) || 1;
    let batch = 0;
    for (const r of rows) {
      r.line.quantity = Number(r.qty.value) || 0;
      const price = r.priceOf();
      r.cost = r.line.quantity * price;
      batch += r.cost;
      r.costCell.textContent = fmt.money(r.cost);
      r.perUnitCell.textContent = `${fmt.num(Math.round((r.line.quantity / yieldQty) * 10000) / 10000)}`;
    }
    const unitCost = batch / yieldQty;
    // Hammadde maliyetleri KDV DAHİL tutulur (alış KDV'si indirilmiyor),
    // satış fiyatı da KDV dahildir. Satışı netleştirip KDV dahil maliyetle
    // karşılaştırmak KDV'yi İKİ KEZ aleyhe saymak olurdu.
    // Bkz. server/lib/money.js — productProfit ile aynı hesap.
    const salePrice = data.product.sale_price;
    const saleNet = salePrice / (1 + data.product.vat_rate / 100);
    const unitProfit = salePrice - unitCost;
    const marginPct = salePrice > 0 ? (unitProfit / salePrice) * 100 : 0;

    summaryBox.replaceChildren(
      el('div.grid.grid-4', {}, [
        stat('Parti Maliyeti', fmt.money(batch), { sub: `${fmt.num(yieldQty)} adet üretir` }),
        stat('Birim Maliyet', fmt.money(Math.round(unitCost * 100) / 100)),
        stat('Birim Kâr', fmt.money(Math.round(unitProfit * 100) / 100), {
          tone: unitProfit < 0 ? 'bad' : '',
          sub: `Satış ${fmt.money(salePrice)} − maliyet ${fmt.money(Math.round(unitCost * 100) / 100)}`
            + ` · içindeki KDV ${fmt.money(Math.round((salePrice - saleNet) * 100) / 100)}`,
        }),
        stat('Kâr Marjı', fmt.pct(Math.round(marginPct * 10) / 10), {
          tone: marginPct < 0 ? 'bad' : marginPct < 20 ? 'warn' : 'ok',
        }),
      ]),
    );
    if (unitProfit < 0) {
      summaryBox.append(alertBox('danger', 'Zararına satış',
        'Hammadde maliyeti satış fiyatının üzerinde. Satış fiyatını veya reçeteyi gözden geçirin.'));
    }
  }

  function addRow(item = null) {
    const line = {
      ingredientId: item?.ingredient_id ?? data.candidates[0]?.id,
      quantity: item?.quantity ?? 1,
    };
    const select = el('select', { disabled: !editable }, data.candidates.map((c) =>
      el('option', { value: c.id, selected: c.id === line.ingredientId },
        [`${c.name} (${c.unit})${c.product_type === 'HAMMADDE' ? ' · hammadde' : ''}`])));
    const qty = el('input.num', {
      type: 'number', step: '0.0001', min: '0.0001', value: String(line.quantity), disabled: !editable,
    });
    const perUnitCell = el('td.num.small.muted');
    const costCell = el('td.num');

    const entry = {
      line, qty, perUnitCell, costCell,
      priceOf: () => data.candidates.find((c) => c.id === Number(select.value))?.purchase_price ?? 0,
    };
    select.addEventListener('change', () => { line.ingredientId = Number(select.value); recalc(); });
    qty.addEventListener('input', recalc);

    const unitCell = el('td.small.muted', {
      text: data.candidates.find((c) => c.id === line.ingredientId)?.unit ?? '',
    });
    select.addEventListener('change', () => {
      unitCell.textContent = data.candidates.find((c) => c.id === Number(select.value))?.unit ?? '';
    });

    const tr = el('tr', {}, [
      el('td', { style: 'min-width:220px' }, [select]),
      el('td', {}, [qty]), unitCell, perUnitCell, costCell,
      el('td', {}, editable ? [el('button.icon-btn', {
        text: '✕', title: 'Satırı sil',
        onclick: () => { rows.splice(rows.indexOf(entry), 1); tr.remove(); recalc(); },
      })] : []),
    ]);
    rows.push(entry);
    body.append(tr);
  }

  const saveBtn = el('button.btn.btn-primary', { text: 'Reçeteyi Kaydet' });
  const actions = [el('button.btn', { text: 'Kapat', onclick: () => m.close() })];
  if (editable) {
    if (data.hasRecipe) {
      actions.unshift(el('button.btn.btn-ghost', {
        text: 'Reçeteyi Sil',
        onclick: async () => {
          const ok = await confirmDialog(
            'Reçete silinecek. Ürünün maliyeti tekrar elle girilen tahmine döner ve sayımda hammadde tüketimi hesaba katılmaz.',
            { title: 'Reçeteyi Sil', confirmText: 'Sil', danger: true }
          );
          if (!ok) return;
          try {
            await api.del(`/api/recipes/${productId}`);
            toast('Reçete silindi.');
            m.close();
            onDone?.();
          } catch (err) { toast(err.message, 'error'); }
        },
      }));
    }
    actions.push(saveBtn);
  }

  const m = modal({
    title: `Reçete — ${data.product.name}`,
    wide: true,
    body: [
      errorBox,
      alertBox('info', 'Reçete ne işe yarar?',
        'Birincisi: ürünün maliyeti tahmin değil, içindeki hammaddelerin toplamı olur. '
        + 'İkincisi: sayımda "beyan edilen 400 tost için ne kadar ekmek tükenmeliydi?" sorusu otomatik hesaplanır '
        + 've bu miktar ekmeğin sayım farkından düşülür — böylece üretimde kullanılan mal "satılmış" görünmez.'),
      el('div.grid.grid-2', {}, [
        el('label.field', {}, [
          el('span', { text: 'Bu reçete kaç adet üretir? *' }), yieldInput,
          el('small', { text: 'Örn: 1 tost için 1 yazın. 1 demlik çay 40 bardak veriyorsa 40 yazın.' }),
        ]),
        el('label.field', {}, [el('span', { text: 'Açıklama' }), noteInput]),
      ]),
      el('div.table-wrap', {}, [el('table.data.line-table', {}, [
        el('thead', {}, [el('tr', {}, [
          el('th', { text: 'İçerik' }), el('th', { text: 'Miktar (parti için)' }),
          el('th', { text: 'Birim' }), el('th.num', { text: '1 Adet İçin' }), el('th.num', { text: 'Maliyet' }), el('th'),
        ])]),
        body,
      ])]),
      editable ? el('div.btn-row', {}, [el('button.btn.btn-sm', { text: '+ İçerik Ekle', onclick: () => { addRow(); recalc(); } })]) : null,
      summaryBox,
    ],
    actions,
  });

  if (data.items.length) data.items.forEach((item) => addRow(item));
  else addRow();
  yieldInput.addEventListener('input', recalc);
  recalc();

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Kaydediliyor...';
    try {
      const payload = {
        yieldQuantity: Number(yieldInput.value) || 1,
        note: noteInput.value.trim(),
        items: rows
          .filter((r) => r.line.quantity > 0)
          .map((r) => ({ ingredientId: r.line.ingredientId, quantity: r.line.quantity })),
      };
      if (!payload.items.length) throw new Error('En az bir içerik satırı girmelisiniz.');
      const res = await api.put(`/api/recipes/${productId}`, payload);
      m.close();
      toast(`Reçete kaydedildi. Birim maliyet ${fmt.money(res.unitCost)}, kâr marjı ${fmt.pct(res.profit.marginPct)}.`);
      onDone?.();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Reçeteyi Kaydet';
    }
  });
}
