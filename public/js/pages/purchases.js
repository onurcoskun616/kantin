import { api } from '../api.js';
import { state, canWrite, canDeleteDocuments, campusName } from '../app.js';
import { el, card, stat, table, fmt, badge, modal, toast, confirmDialog, dateUtil, alertBox, empty, shortName, formModal } from '../ui.js';
import { createProductPicker } from '../urun-secici.js';
import { parseEFatura, matchProducts, matchSupplier, unitFromCode } from '../efatura.js';
import { parseKarekod, compareWithLines } from '../karekod.js';
import { openKarekodScanner } from '../karekod-tarayici.js';

export async function render(root) {
  const range = { from: dateUtil.thisMonth() + '-01', to: dateUtil.today() };
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const [data, unmatched] = await Promise.all([
      api.get('/api/purchases', { campusId: state.campusId, ...range }),
      // Faturada olup kayda alınmayan kalemler — tarih aralığından bağımsız,
      // çünkü çözülmemiş bir kalem eskidikçe daha çok önem kazanır
      api.get('/api/purchases/unmatched', { campusId: state.campusId })
        .catch(() => ({ items: [], openCount: 0, openTotal: 0 })),
    ]);
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
        canWrite("purchases") ? el('button.btn.btn-primary', { text: '+ Yeni Mal Girişi', onclick: () => openPurchaseForm(draw) }) : null,
      ]),
    ]));

    container.append(el('div.grid.grid-3', {}, [
      stat('Dönem Alım Tutarı', fmt.money(total), { sub: 'KDV dahil' }),
      stat('Belge Sayısı', String(data.items.length)),
      stat('Ortalama Belge', fmt.money(data.items.length ? total / data.items.length : 0)),
    ]));

    if (unmatched.items.length) container.append(unmatchedPanel(unmatched, draw));

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
        {
          label: 'Fatura', render: (r) => (r.attachment_count > 0
            ? badge(`📎 ${r.attachment_count}`, 'ok')
            : el('span.muted', { text: '—', title: 'Fatura dosyası eklenmemiş' })),
        },
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
      attachmentsSection(data),
    ],
    actions: [
      // İptal: belge kayıtta kalır, stok hareketi geri alınır. Düzeltme yolu.
      canWrite('purchases') && data.status !== 'IPTAL' ? el('button.btn', {
        text: 'Belgeyi İptal Et',
        onclick: async () => {
          const onay = await confirmDialog(
            'Belge iptal edilecek ve stok hareketleri geri alınacak. Belge listede '
            + '"İPTAL" olarak kalacak, e-Fatura numarası (ETTN) yeniden girilebilir hale gelecek.',
            { title: 'Belgeyi İptal Et', confirmText: 'İptal Et', danger: true }
          );
          if (!onay) return;
          try {
            await api.post(`/api/purchases/${data.id}/cancel`);
            toast('Belge iptal edildi.');
            document.querySelector('.modal-backdrop')?.remove();
            onChange();
          } catch (err) { toast(err.message, 'error'); }
        },
      }) : null,
      // Kalıcı silme: geri alınamaz, yalnızca yönetim.
      canDeleteDocuments() ? el('button.btn.btn-danger', {
        text: '🗑️ Kalıcı Olarak Sil',
        onclick: () => confirmDelete(data, onChange),
      }) : null,
    ].filter(Boolean),
  });
}

/**
 * Kalıcı silme onayı.
 *
 * Basit bir "emin misiniz?" yetmez: silme geri alınamaz ve faturanın
 * kendisi de diskten gider. Bu yüzden ne kaybedileceğini TEK TEK sayar ve
 * kullanıcıdan belge numarasını yazmasını ister.
 */
function confirmDelete(data, onChange) {
  const ekSayisi = data.attachments?.length ?? 0;
  const dogrulama = el('input', { placeholder: data.document_no || String(data.id) });
  const hata = el('div.alert.alert-danger', { hidden: true });
  const silBtn = el('button.btn.btn-danger', { text: 'Kalıcı Olarak Sil' });

  const m = modal({
    title: '🗑️ Belgeyi Kalıcı Olarak Sil',
    body: [
      hata,
      alertBox('danger', 'Bu işlem geri alınamaz',
        'Belge, satırları, stok hareketleri ve iliştirilmiş fatura dosyaları kalıcı olarak silinir. '
        + 'Yalnızca denetim günlüğünde bir kayıt kalır.'),
      el('p', { text: 'Silinecekler:' }),
      el('ul', { style: 'margin:0 0 12px;padding-left:18px;display:grid;gap:4px;font-size:13px' }, [
        el('li', { text: `Belge #${data.id}${data.document_no ? ' / ' + data.document_no : ''} — ${fmt.money(data.gross_total)}` }),
        el('li', { text: `${data.lines.length} ürün satırı ve bunların stok hareketleri` }),
        ekSayisi
          ? el('li', { text: `${ekSayisi} fatura dosyası (PDF/fotoğraf/XML) — diskten de silinir` })
          : el('li.muted', { text: 'İliştirilmiş fatura dosyası yok' }),
        data.efatura_uuid
          ? el('li', { text: 'e-Fatura numarası (ETTN) serbest kalır; aynı fatura yeniden girilebilir' })
          : null,
      ].filter(Boolean)),
      el('p.card-note', {
        text: 'Kayıt izini korumak istiyorsanız silmek yerine "Belgeyi İptal Et" kullanın.',
      }),
      el('label.field', {}, [
        el('span', { text: `Onaylamak için belge numarasını yazın: ${data.document_no || data.id}` }),
        dogrulama,
      ]),
    ],
    actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m.close() }), silBtn],
  });

  silBtn.addEventListener('click', async () => {
    const beklenen = String(data.document_no || data.id).trim();
    if (dogrulama.value.trim() !== beklenen) {
      hata.textContent = `Belge numarası eşleşmedi. "${beklenen}" yazmalısınız.`;
      hata.hidden = false;
      dogrulama.focus();
      return;
    }
    silBtn.disabled = true;
    silBtn.textContent = 'Siliniyor...';
    try {
      const r = await api.del(`/api/purchases/${data.id}`);
      m.close();
      document.querySelectorAll('.modal-backdrop').forEach((n) => n.remove());
      toast(`Belge silindi (${r.deletedLines} satır, ${r.deletedFiles} dosya).`);
      onChange();
    } catch (err) {
      hata.textContent = err.message;
      hata.hidden = false;
      silBtn.disabled = false;
      silBtn.textContent = 'Kalıcı Olarak Sil';
    }
  });
}

/* --------------------------- Yeni mal girişi ------------------------ */
async function openPurchaseForm(onDone) {
  const [suppliers, products, categories, stock] = await Promise.all([
    api.get('/api/suppliers'),
    api.get('/api/products', { campusId: state.campusId }),
    api.get('/api/products/categories'),
    // Stok, ürün seçicide "bu ürün zaten var mıydı" sorusunu cevaplar
    api.get('/api/stock', { campusId: state.campusId }).catch(() => ({ items: [] })),
  ]);

  /**
   * Seçili tedarikçinin ÖĞRENİLMİŞ ürün eşleştirmeleri.
   *
   * Aynı ürün her faturada aynı adla gelmiyor ("AYRAN 200 ML" / "KUTU
   * AYRAN"). Bir kez eşleştirilen ad burada saklı; sonraki faturalarda
   * kendiliğinden bulunur. Tedarikçi değişince liste yenilenir.
   */
  let aliases = [];
  async function loadAliases() {
    if (!supplierSelect.value) { aliases = []; return; }
    try {
      aliases = (await api.get('/api/products/aliases', { supplierId: supplierSelect.value })).items;
    } catch { aliases = []; }
  }

  const productMap = new Map(products.items.map((p) => [p.id, p]));
  const stockByProduct = new Map(stock.items.map((r) => [r.product_id, r.stock_qty]));
  const pickers = [];          // satırlardaki seçiciler: yeni ürün hepsine eklenir
  // Faturadan gelip KAYDA ALINMAYAN kalemler. Kullanıcı bir satırı sildiğinde
  // buraya düşer ve belgeyle birlikte kaydedilir; iz bırakmadan kaybolmaz.
  const droppedLines = [];
  const lines = [];
  const linesBody = el('tbody');
  const totalsBox = el('div.row', { style: 'justify-content:flex-end;gap:24px;font-weight:600' });

  const supplierSelect = el('select', {}, [
    el('option', { value: '' }, ['— tedarikçi seçin —']),
    ...suppliers.items.map((s) => el('option', { value: s.id }, [s.name])),
  ]);

  /**
   * Faturadaki tedarikçi sistemde yoksa buradan tanımlanır (10. madde).
   * Unvan ve VKN faturadan gelir; kullanıcı yeniden yazmaz.
   */
  function addSupplier(preset = {}, onAdded = null) {
    formModal({
      title: 'Yeni Tedarikçi',
      fields: [
        { name: 'name', label: 'Firma adı', value: preset.name || '', required: true },
        {
          name: 'taxNo', label: 'Vergi / TC no', value: preset.taxNo || '', required: true,
          hint: 'Zorunlu — 10 hane VKN veya 11 hane TCKN. Faturalar bu numarayla eşleşir.',
        },
        { name: 'taxOffice', label: 'Vergi dairesi', value: preset.taxOffice || '' },
        { name: 'phone', label: 'Telefon', value: '' },
      ],
      submitText: 'Tedarikçiyi Ekle',
      onSubmit: async (v) => {
        const yeni = await api.post('/api/suppliers', v);
        suppliers.items.push(yeni);
        supplierSelect.append(el('option', { value: yeni.id }, [yeni.name]));
        supplierSelect.value = String(yeni.id);
        toast(`${yeni.name} eklendi ve seçildi.`);
        onAdded?.(yeni);
      },
    });
  }

  supplierSelect.addEventListener('change', loadAliases);

  const newSupplierBtn = el('button.btn.btn-sm', {
    type: 'button', text: '+ Yeni', title: 'Listede olmayan tedarikçiyi buradan ekleyin',
    onclick: () => addSupplier({}),
  });
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
    drawKarekodCheck();
  }

  /**
   * Karekod okunduysa girilen satirlari faturanin beyan ettigi tutarlarla
   * her degisiklikte karsilastirir. Karekodda urun satiri olmadigi icin
   * asil fayda budur: yanlis yazilmis bir rakam, aylar sonra sayim farki
   * olarak degil, burada ortaya cikar.
   */
  function drawKarekodCheck() {
    if (!imported.karekod) { karekodBox.replaceChildren(); return; }
    const rep = compareWithLines(imported.karekod, lines);

    const rows = rep.rows.map((r) => ({
      ...r,
      durum: r.ok ? '✓' : (r.diff > 0 ? '▲ fazla' : '▼ eksik'),
    }));

    karekodBox.replaceChildren(card('Karekodla karşılaştırma', [
      table([
        { label: 'Kalem', value: (r) => r.label, wrap: true },
        { label: 'Faturada', num: true, value: (r) => fmt.money(r.invoice) },
        { label: 'Girilen', num: true, value: (r) => fmt.money(r.entered) },
        { label: 'Fark', num: true, value: (r) => (r.diff === 0 ? '—' : fmt.money(r.diff)) },
        { label: 'Durum', value: (r) => r.durum },
      ], rows, { rowClass: (r) => (r.ok ? '' : 'is-warn') }),
    ], {
      actions: [rep.ok
        ? badge('Fatura ile birebir uyuşuyor', 'ok')
        : badge(`${rep.issues.length} kalemde fark var`, 'warn')],
      note: rep.ok
        ? 'Girdiğiniz satırlar faturanın toplamlarıyla tutuyor.'
        : 'Fark varsa: eksik/fazla satır, yanlış miktar veya yanlış KDV oranı olabilir. '
          + 'Düzeltmeden kaydederseniz uyarı alırsınız.',
    }));
  }

  /**
   * preset ile cagrilinca (e-Fatura aktariminda) satir hazir doldurulur.
   * productId null birakilirsa satir "urun secilmedi" durumunda acilir:
   * faturada olup sistemde karsiligi bulunamayan kalemler boyle gelir ve
   * kullanici secene kadar belge kaydedilemez.
   */
  function addLine(preset = null) {
    const p0 = preset && typeof preset === 'object' ? preset : { productId: preset };
    const hasPreset = preset && typeof preset === 'object';
    const initialId = hasPreset ? (p0.productId ?? null) : (p0.productId ?? products.items[0]?.id);

    const line = {
      productId: initialId,
      quantity: p0.quantity ?? 1,
      unitPrice: p0.unitPrice ?? 0,
      vatRate: p0.vatRate ?? 10,
      discountPct: p0.discountPct ?? 0,
      net: 0, vat: 0,
      // Faturadan gelen ham bilgiler: eşleşmeyen satır ürün olarak
      // tanımlanırken bunlar forma önden yazılır (10. madde) ve belge
      // kaydedilirken eşleştirme bunlardan öğrenilir.
      sourceName: p0.sourceName || null,
      // Ikisi AYRI: barkod urun kartina yazilir (yalnizca GTIN gorunumlu
      // olan), tedarikcinin kendi stok kodu ise eslestirmeye ogretilir.
      sourceBarcode: p0.sourceBarcode || null,
      sourceCode: p0.sourceCode || null,
      sourceUnit: p0.sourceUnit || null,
      aliasFactor: p0.aliasFactor ?? 1,
      matchedBy: p0.matchedBy || null,
    };

    // Ürün seçimi: yazdıkça süzen, stoğu gösteren ve yerinde ürün
    // tanımlamaya izin veren seçici (bkz. urun-secici.js)
    const picker = createProductPicker({
      products: products.items,
      stockByProduct,
      value: initialId ?? null,
      onChange: () => syncProduct(),
      onCreateNew: (yazilan) => addProductFromLine(line, picker, yazilan),
    });
    pickers.push(picker);

    const qty = el('input.num', { type: 'number', step: '0.01', min: '0.001', value: String(line.quantity) });
    const price = el('input.num', { type: 'number', step: '0.01', min: '0', value: hasPreset ? String(line.unitPrice) : '' });
    const disc = el('input.num', { type: 'number', step: '0.01', min: '0', max: '100', value: String(line.discountPct) });
    const vatIn = el('input.num', { type: 'number', step: '0.1', min: '0', max: '100', value: hasPreset ? String(line.vatRate) : '' });
    const expiry = el('input', { type: 'date' });
    const totalCell = el('td.num');

    const syncProduct = () => {
      line.productId = picker.getValue();
      const p = productMap.get(line.productId);
      // Fatura satiri kendi fiyatini ve KDV'sini getirir; urun kartindaki
      // degerler yalnizca bos alanlari doldurmak icin kullanilir.
      if (p && !hasPreset) {
        if (!price.value || Number(price.value) === 0) price.value = p.purchase_price;
        vatIn.value = p.vat_rate;
      } else if (p && hasPreset && !vatIn.value) {
        vatIn.value = p.vat_rate;
      }
      picker.markMissing(!line.productId);
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
    [qty, price, disc, vatIn, expiry].forEach((n) => n.addEventListener('input', recalcLine));

    const tr = el('tr', {}, [
      el('td', { style: 'min-width:240px' }, [
        picker.node,
        line.sourceName
          ? el('small.muted', { style: 'display:block;margin-top:2px' }, [
            `Faturada: ${line.sourceName}`,
            // Öğrenilmiş bir eşleştirmeyle bulunduysa söyle: kullanıcı
            // "bunu ben seçmedim, nereden geldi" diye tereddüt etmesin.
            /öğrenilmiş/.test(line.matchedBy || '')
              ? el('span', { text: ' · öğrenilmiş eşleştirme', style: 'color:var(--success)' })
              : null,
            line.aliasFactor !== 1
              ? el('span', { text: ` · ×${line.aliasFactor} çevrildi`, style: 'color:var(--warning)' })
              : null,
          ])
          : null,
      ]),
      el('td', {}, [qty]), el('td', {}, [price]), el('td', {}, [disc]), el('td', {}, [vatIn]),
      el('td', {}, [expiry]), totalCell,
      el('td', {}, [el('button.icon-btn', {
        text: '✕', title: 'Satırı sil',
        onclick: () => {
          // Faturadan gelen bir kalem siliniyorsa kaydını tutarız: belge
          // toplamı ile fatura toplamı arasındaki fark sonradan
          // açıklanabilir olsun (bkz. "Eşleşmeyen Fatura Satırları").
          if (line.sourceName) {
            droppedLines.push({
              sourceName: line.sourceName,
              sourceCode: line.sourceCode || line.sourceBarcode || null,
              unitCode: line.sourceUnit || null,
              quantity: line.quantity,
              unitPrice: line.unitPrice,
              discountPct: line.discountPct,
              vatRate: line.vatRate,
            });
          }
          lines.splice(lines.indexOf(line), 1);
          tr.remove();
          recalcTotals();
        },
      })]),
    ]);
    lines.push(line);
    linesBody.append(tr);
    syncProduct();
    if (!initialId) picker.focus();
  }

  /**
   * Faturada olup sistemde olmayan kalemi ürün olarak tanımlar (10. madde).
   *
   * Alanlar faturadan doldurulur: ad, barkod, KDV oranı ve iskonto sonrası
   * gerçek birim maliyet. Satış fiyatını kullanıcı girer — onu fatura bilmez.
   */
  function addProductFromLine(line, picker, yazilanAd) {
    const ad = (yazilanAd || line.sourceName || '').trim();
    const birimMaliyet = line.quantity > 0
      ? Math.round((line.unitPrice * (1 - (line.discountPct || 0) / 100)) * 100) / 100
      : 0;

    formModal({
      title: 'Faturadaki Kalemi Ürün Olarak Tanımla',
      wide: true,
      fields: [
        { name: 'name', label: 'Ürün adı', value: ad, required: true },
        {
          name: 'barcode', label: 'Barkod', value: line.sourceBarcode || '',
          hint: line.sourceBarcode
            ? 'Faturadan okundu.'
            : (line.sourceCode
              ? `Faturada barkod yok; "${line.sourceCode}" tedarikçinin kendi stok kodudur ve `
                + 'barkod alanına yazılmaz. Raftaki ürünü okutup buraya ekleyebilirsiniz.'
              : 'Faturada barkod yoktu; sonra ekleyebilirsiniz.'),
        },
        {
          name: 'categoryId', label: 'Kategori', type: 'select', value: '',
          options: [{ value: '', label: '— seçiniz —' },
            ...categories.items.map((c) => ({ value: c.id, label: c.name }))],
        },
        {
          name: 'unit', label: 'Birim', type: 'select', value: line.sourceUnit || 'ADET',
          options: ['ADET', 'KG', 'LT', 'PAKET', 'KUTU', 'PORSIYON'].map((u) => ({ value: u, label: u })),
        },
        {
          name: 'productType', label: 'Ürün tipi', type: 'select', value: 'SATIN_ALINAN',
          options: [
            { value: 'SATIN_ALINAN', label: 'Satın alınan — raftan sayılır, doğrudan satılır' },
            { value: 'HAMMADDE', label: 'Hammadde — sayılır ama satılmaz' },
          ],
        },
        {
          name: 'purchasePrice', label: 'Alış fiyatı (KDV hariç)', type: 'number', step: '0.01', min: '0',
          value: birimMaliyet || '', required: true,
          hint: 'Faturadan geldi (iskonto düşülmüş birim maliyet).',
        },
        {
          name: 'salePrice', label: 'Satış fiyatı (KDV dahil)', type: 'number', step: '0.01', min: '0',
          value: '', required: true,
          hint: 'Öğrenciden tahsil edilecek raf fiyatı — faturada yoktur, siz belirlersiniz.',
        },
        {
          name: 'vatRate', label: 'KDV oranı (%)', type: 'number', step: '0.1', min: '0', max: '100',
          value: line.vatRate ?? 10, hint: 'Fatura satırındaki oran.',
        },
        { name: 'criticalStock', label: 'Kritik stok seviyesi', type: 'number', step: '1', min: '0', value: 0 },
      ],
      submitText: 'Ürünü Ekle ve Satıra Bağla',
      onSubmit: async (v) => {
        const yeni = await api.post('/api/products', v);
        productMap.set(yeni.id, yeni);
        // Diğer satırların seçicileri de yeni ürünü görsün
        for (const pk of pickers) pk.addProduct(yeni, pk === picker);
        toast(`${yeni.name} tanımlandı ve satıra bağlandı.`);
      },
    });
  }

  // e-Fatura aktarimindan gelen bilgiler: ETTN ve dosyanin kendisi.
  // Belge kaydedildikten sonra XML ayrica belgeye eklenir.
  // karekod: QR'dan okunan fatura ozeti (satir icermez, yalnizca toplamlar).
  const imported = { uuid: null, file: null, karekod: null };
  const importBox = el('div');
  const karekodBox = el('div');

  const xmlInput = el('input', { type: 'file', accept: '.xml,application/xml,text/xml', style: 'display:none' });
  const importBtn = el('button.btn', { text: '🧾 e-Fatura XML\'den Doldur', onclick: () => xmlInput.click() });
  xmlInput.addEventListener('change', async () => {
    const file = xmlInput.files?.[0];
    if (!file) return;
    importBtn.disabled = true;
    try {
      await importFromXml(file);
    } catch (err) {
      importBox.replaceChildren(alertBox('danger', 'e-Fatura okunamadı', err.message));
    } finally {
      xmlInput.value = '';
      importBtn.disabled = false;
    }
  });

  const qrBtn = el('button.btn', {
    text: '📷 Karekod Okut',
    title: 'Kağıt/PDF faturadaki karekodu okuyup başlığı doldurur ve girdiğiniz satırları denetler',
    onclick: async () => {
      const raw = await openKarekodScanner();
      if (!raw) return;
      try {
        importFromKarekod(raw);
      } catch (err) {
        importBox.replaceChildren(alertBox('danger', 'Karekod okunamadı',
          err.raw ? `${err.message} Okunan metin: ${err.raw.slice(0, 200)}` : err.message));
      }
    },
  });

  const saveBtn = el('button.btn.btn-primary', { text: 'Belgeyi Kaydet' });
  const m = modal({
    // Hangi kampuse mal girildigi basliktadir: stok O kampuse girer ve borc
    // O kampusun cari hesabina yazilir. Yanlis kampus secili oldugunda hata
    // iki yerde birden olusur ve sonradan ayiklanmasi zordur.
    title: `Yeni Mal Girişi — ${shortName(campusName())}`,
    wide: true,
    body: [
      errorBox,
      el('div.row', { style: 'justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' }, [
        el('small.muted', {
          text: `Mal ${shortName(campusName())} kampüsüne girecek, borç da bu kampüsün cari `
            + 'hesabına yazılacak. Faturayı elle girebilir, e-Fatura/e-Arşiv XML dosyasından '
            + 'otomatik doldurabilir ya da kağıt faturadaki karekodu okutabilirsiniz.',
        }),
        el('div.btn-row', {}, [importBtn, qrBtn, xmlInput]),
      ]),
      importBox,
      el('div.grid.grid-3', {}, [
        el('label.field', {}, [
          el('span', { text: 'Tedarikçi *' }),
          el('div.row', { style: 'gap:6px;align-items:stretch' }, [
            el('div', { style: 'flex:1;min-width:0' }, [supplierSelect]),
            newSupplierBtn,
          ]),
        ]),
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
      // Karsilastirma tam da karsilastirdigi toplamlarin altinda dursun
      karekodBox,
      el('label.field', {}, [el('span', { text: 'Not' }), noteInput]),
    ],
    actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m.close() }), saveBtn],
  });

  /**
   * XML'i okur, tedarikci ve urunleri eslestirir, formu doldurur.
   * Hicbir sey sessizce kaydedilmez: her satir ekranda gorunur, eslesmeyenler
   * isaretlenir ve kullanici onaylamadan belge olusmaz.
   */
  async function importFromXml(file) {
    const invoice = parseEFatura(await file.text());
    const { supplier, matchedBy } = matchSupplier(invoice.supplier, suppliers.items);

    // Baslik alanlari — ESLESTIRMEDEN ONCE tedarikci secilir ki o
    // tedarikcinin ogrenilmis ad eslestirmeleri kullanilabilsin.
    if (supplier) {
      supplierSelect.value = String(supplier.id);
      await loadAliases();
    }
    const matchedLines = matchProducts(invoice.lines, products.items, aliases);
    if (invoice.documentNo) docNo.value = invoice.documentNo;
    if (invoice.issueDate) docDate.value = invoice.issueDate;
    if (invoice.dueDate) dueDate.value = invoice.dueDate;
    imported.uuid = invoice.uuid || null;
    imported.file = file;

    // Satirlari bastan kur
    lines.length = 0;
    linesBody.replaceChildren();
    for (const line of matchedLines) {
      addLine({
        productId: line.product?.id ?? null,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountPct: line.discountPct,
        vatRate: line.vatRate,
        // Faturadaki ad/kod HER SATIRDA taşınır (eşleşmiş olsa bile):
        // kaydederken eşleştirme bundan öğrenilir/tazelenir.
        sourceName: line.name,
        sourceBarcode: line.barcode || null,
        sourceCode: line.supplierCode || line.barcode || null,
        sourceUnit: unitFromCode(line.unitCode),
        aliasFactor: line.aliasFactor,
        matchedBy: line.matchedBy,
        unmatched: !line.product,
      });
    }
    recalcTotals();

    // Ozet ve uyarilar
    const unmatched = matchedLines.filter((l) => !l.product);
    const mismatched = matchedLines.filter((l) => l.mismatch);
    const ogrenilmis = matchedLines.filter((l) => /öğrenilmiş/.test(l.matchedBy || ''));
    const cevrilen = matchedLines.filter((l) => l.convertedByFactor);
    const notes = [];

    notes.push(el('div.alert.alert-success', {}, [
      el('strong', { text: `Fatura okundu: ${invoice.documentNo || '(belge no yok)'} · ${matchedLines.length} kalem` }),
      `${invoice.supplier.name || 'Tedarikçi adı yok'}`
      + `${invoice.supplier.taxNo ? ` (VKN ${invoice.supplier.taxNo})` : ''} · `
      + `Mal bedeli ${fmt.money(invoice.computed.netTotal)} + KDV ${fmt.money(invoice.computed.vatTotal)} = `
      + `${fmt.money(invoice.computed.grossTotal)}`,
    ]));

    if (!supplier) {
      const ekleBtn = el('button.btn.btn-sm', {
        type: 'button',
        text: `+ "${invoice.supplier.name || 'Bu firmayı'}" tedarikçi olarak ekle`,
        onclick: () => addSupplier({
          name: invoice.supplier.name,
          taxNo: invoice.supplier.taxNo,
          taxOffice: invoice.supplier.taxOffice,
        }, () => {
          // Eklendikten sonra uyarı yerini onaya bıraksın
          uyariKutusu.replaceChildren(alertBox('success', 'Tedarikçi eklendi',
            `${invoice.supplier.name} tanımlandı ve seçildi. Bundan sonra bu firmanın `
            + 'faturaları VKN ile kendiliğinden eşleşecek.'));
        }),
      });
      const uyariKutusu = el('div', {}, [
        alertBox('warning', 'Tedarikçi eşleşmedi',
          `Faturadaki "${invoice.supplier.name}" (VKN ${invoice.supplier.taxNo || 'yok'}) sistemde bulunamadı. `
          + 'Listeden doğru tedarikçiyi seçebilir ya da faturadaki bilgilerle yeni kart açabilirsiniz.'),
        el('div.btn-row', { style: 'margin-top:8px' }, [ekleBtn]),
      ]);
      notes.push(uyariKutusu);
    } else if (matchedBy === 'unvan') {
      notes.push(alertBox('info', 'Tedarikçi unvandan eşleşti',
        `${supplier.name} seçildi. VKN ile eşleşmesi için tedarikçi kartına `
        + `${invoice.supplier.taxNo || 'VKN'} yazmanız daha güvenlidir.`));
    }

    if (ogrenilmis.length) {
      notes.push(alertBox('success', `${ogrenilmis.length} kalem önceki eşleştirmelerden bulundu`,
        'Bu tedarikçinin bu ürünleri daha önce eşleştirilmişti; faturadaki adları '
        + 'farklı olsa da doğru ürüne bağlandı. Yanlış bir eşleştirme görürseniz '
        + 'satırdan düzeltin — düzeltme de öğrenilir.'));
    }

    if (cevrilen.length) {
      notes.push(alertBox('warning', `${cevrilen.length} kalemde birim çevrimi yapıldı`,
        cevrilen.map((l) => `"${l.name}": faturada ${fmt.num(l.sourceQuantity)} × `
          + `${fmt.money(l.sourceUnitPrice)} → stokta ${fmt.num(l.quantity)} × ${fmt.money(l.unitPrice)}`).join(' · ')
        + '. Tedarikçi koli/paket satıyor, stok birimine çevrildi. Tutar değişmedi. '
        + 'Çarpan yanlışsa Tedarikçiler → Ürün Eşleştirmeleri ekranından düzeltin.'));
    }

    if (unmatched.length) {
      notes.push(alertBox('warning', `${unmatched.length} kalem eşleşmedi`,
        `Şu ürünler sistemde bulunamadı: ${unmatched.map((l) => `"${l.name}"`).join(', ')}. `
        + 'Aşağıdaki kırmızı satırlarda ürün kutusuna tıklayın: arayarak seçebilir ya da '
        + 'listenin sonundaki "+ yeni ürün tanımla" ile faturadaki bilgilerle kart açabilirsiniz. '
        + 'Kaleme karşılık gelen bir ürün yoksa satırı silin. '
        + 'BİR KEZ seçmeniz yeterli: belge kaydedilince eşleştirme öğrenilir ve bu '
        + 'tedarikçinin sonraki faturalarında bu kalem kendiliğinden bulunur.'));
    }
    if (mismatched.length) {
      notes.push(alertBox('warning', 'Satır tutarı uyuşmuyor',
        mismatched.map((l) => `"${l.name}": ${l.mismatch}`).join(' · ')
        + '. Faturada iskonto/vergi farklı hesaplanmış olabilir; satırı kontrol edin.'));
    }
    for (const w of invoice.warnings) notes.push(alertBox('warning', 'Fatura toplamı', w));

    if (invoice.computed.netTotal > 0) {
      notes.push(el('p.card-note', {
        text: 'Not: Birim fiyatlar KDV hariç aktarıldı. Alttaki genel toplam faturanın ödenecek tutarıyla '
          + 'aynı olmalı; değilse eşleşmeyen veya silinen satır vardır.',
      }));
    }
    importBox.replaceChildren(el('div.grid', { style: 'gap:8px' }, notes));
  }

  /**
   * Karekod (QR) ile baslik doldurma.
   *
   * Karekodda URUN SATIRI YOKTUR; GIB'in icerigi yalnizca baslik ve
   * toplamlardir. Bu yuzden satirlara dokunmayiz: kullanici elle girer,
   * drawKarekodCheck() girilenleri faturanin beyan ettigi matrah/KDV ile
   * her tus vurusunda karsilastirir.
   */
  function importFromKarekod(rawText) {
    const qr = parseKarekod(rawText);
    const { supplier, matchedBy } = matchSupplier({ taxNo: qr.taxNo, name: '' }, suppliers.items);

    if (supplier) supplierSelect.value = String(supplier.id);
    if (qr.documentNo) docNo.value = qr.documentNo;
    if (qr.issueDate) docDate.value = qr.issueDate;

    const oncekiEttn = imported.uuid;
    if (qr.uuid) imported.uuid = qr.uuid;
    imported.karekod = qr;

    const notes = [];
    notes.push(el('div.alert.alert-success', {}, [
      el('strong', {
        text: `Karekod okundu: ${qr.documentNo || '(belge no yok)'}`
          + `${qr.issueDate ? ' · ' + fmt.date(qr.issueDate) : ''}`,
      }),
      `Satici VKN/TCKN ${qr.taxNo || 'yok'}`
      + `${qr.scenario ? ' · ' + qr.scenario : ''}`
      + ` · Matrah ${fmt.money(qr.computed.base)} + KDV ${fmt.money(qr.computed.tax)} = `
      + `${fmt.money(qr.payable ?? qr.computed.gross)}`,
    ]));

    notes.push(alertBox('info', 'Ürün satırları karekodda yok',
      'Karekod yalnızca başlığı ve toplamları taşır. Satırları aşağıya elle girin; '
      + 'girdikleriniz anında faturanın toplamlarıyla karşılaştırılacak. Satırların da '
      + 'kendiliğinden dolması için faturanın XML dosyası gerekir.'));

    if (!supplier) {
      notes.push(alertBox('warning', 'Tedarikçi eşleşmedi',
        `VKN ${qr.taxNo || 'okunamadı'} ile eşleşen tedarikçi bulunamadı. Listeden doğru `
        + 'tedarikçiyi seçin; tedarikçi kartına VKN yazarsanız bir dahaki sefere kendiliğinden eşleşir.'));
    } else if (matchedBy === 'VKN') {
      notes.push(el('p.card-note', { text: `Tedarikçi VKN ile eşleşti: ${supplier.name}` }));
    }

    if (!qr.uuid) {
      notes.push(alertBox('warning', 'ETTN okunamadı',
        'Karekodda fatura numarası (ETTN) yok. Aynı faturanın ikinci kez girilmesini '
        + 'engelleyen kontrol bu belge için çalışmayacak.'));
    } else if (oncekiEttn && oncekiEttn !== qr.uuid) {
      notes.push(alertBox('warning', 'ETTN değişti',
        `Daha önce ${oncekiEttn} okunmuştu, karekodda ${qr.uuid} yazıyor. `
        + 'Farklı bir faturanın karekodunu okutmuş olabilirsiniz.'));
    }

    if (qr.vatByRate.length === 0) {
      notes.push(alertBox('warning', 'KDV kırılımı yok',
        'Karekodda KDV matrah/KDV tutarı okunamadı. Karşılaştırma yalnızca genel toplam '
        + 'üzerinden yapılabilecek.'));
    }
    for (const w of qr.warnings) notes.push(alertBox('warning', 'Karekod toplamı', w));

    importBox.replaceChildren(el('div.grid', { style: 'gap:8px' }, notes));
    recalcTotals();
  }

  addLine();
  recalcTotals();

  saveBtn.addEventListener('click', async () => {
    errorBox.hidden = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Kaydediliyor...';
    try {
      if (!supplierSelect.value) {
        throw new Error('Tedarikçi seçmelisiniz. Listede yoksa "+ Yeni" ile ekleyebilirsiniz.');
      }
      const payload = {
        campusId: state.campusId,
        supplierId: Number(supplierSelect.value),
        documentNo: docNo.value.trim(),
        documentDate: docDate.value,
        dueDate: dueDate.value || null,
        note: noteInput.value.trim(),
        efaturaUuid: imported.uuid || null,
        unmatchedLines: droppedLines,
        lines: lines.filter((l) => l.quantity > 0 && l.productId).map((l) => ({
          productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
          vatRate: l.vatRate, discountPct: l.discountPct, expiryDate: l.expiryDate,
          // Eşleştirmenin öğrenilmesi için: faturada bu kalem ne diyordu?
          sourceName: l.sourceName, sourceCode: l.sourceCode || l.sourceBarcode,
          aliasFactor: l.aliasFactor,
        })),
      };
      if (!payload.lines.length) throw new Error('En az bir ürün satırı girmelisiniz.');
      const unpicked = lines.filter((l) => l.quantity > 0 && !l.productId);
      if (unpicked.length) {
        throw new Error(
          `${unpicked.length} satırda ürün seçilmemiş`
          + `${unpicked[0].sourceName ? ` (ör. "${unpicked[0].sourceName}")` : ''}. `
          + 'Faturadaki bu kalemler için ürün seçin veya satırı silin.'
        );
      }
      // Karekod okunduysa girilen satirlar faturayla tutmali. Tutmuyorsa
      // kaydi engellemeyiz (faturada kantinle ilgisiz kalem olabilir) ama
      // kullanici farki gorerek onaylasin.
      if (imported.karekod) {
        const rep = compareWithLines(imported.karekod, payload.lines.map((l) => {
          const net = Math.round(l.quantity * l.unitPrice * (1 - (l.discountPct || 0) / 100) * 100) / 100;
          return { vatRate: l.vatRate, net, vat: Math.round(net * (l.vatRate / 100) * 100) / 100 };
        }));
        if (!rep.ok) {
          saveBtn.disabled = false;
          saveBtn.textContent = 'Belgeyi Kaydet';
          const onay = await confirmDialog(
            'Girdiğiniz satırlar faturanın karekoduyla uyuşmuyor: '
            + rep.issues.join(' · ')
            + '. Yine de kaydedilsin mi?',
            { title: 'Fatura ile fark var', confirmText: 'Farkı biliyorum, kaydet', danger: true }
          );
          if (!onay) return;
          saveBtn.disabled = true;
          saveBtn.textContent = 'Kaydediliyor...';
        }
      }

      const res = await api.post('/api/purchases', payload);

      // Aktarimda kullanilan XML belgenin eki olarak saklanir: rakamlarin
      // kaynagi belgeyle birlikte durur.
      if (imported.file) {
        try {
          await api.upload(`/api/purchases/${res.id}/attachments`, imported.file, { kind: 'EFATURA_XML' });
        } catch (err) {
          toast(`Belge kaydedildi ama XML eklenemedi: ${err.message}`, 'warning');
        }
      }

      m.close();
      toast(
        `Mal girişi kaydedildi. Toplam ${fmt.money(res.grossTotal)}`
        + (res.learnedAliases
          ? ` · ${res.learnedAliases} ürün eşleştirmesi öğrenildi; bu tedarikçinin sonraki faturalarında kendiliğinden bulunacak.`
          : '')
        + (res.unmatchedCount
          ? ` · Faturadan ${res.unmatchedCount} kalem kayda alınmadı, "Eşleşmeyen Fatura Satırları" panelinde bekliyor.`
          : ''),
        res.unmatchedCount ? 'warning' : 'success',
        res.unmatchedCount || res.learnedAliases ? 9000 : 4000,
      );
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


/* ===================== FATURA EKLERİ (dosya) ====================== */
/**
 * Belgeye iliştirilen fatura dosyaları.
 *
 * Dosya `public/` altında durmaz; her açılışta yetki kontrolünden geçer.
 * Bu yüzden basit bir bağlantı yerine token'lı fetch + blob kullanılır.
 */
function attachmentsSection(purchase) {
  const listBox = el('div');
  const fileInput = el('input', {
    type: 'file',
    accept: '.pdf,.jpg,.jpeg,.png,.webp,.xml,application/pdf,image/*,application/xml,text/xml',
    style: 'display:none',
  });
  const uploadBtn = el('button.btn.btn-sm', { text: '📎 Fatura Dosyası Ekle', onclick: () => fileInput.click() });

  const draw = (items) => {
    listBox.replaceChildren(items.length
      ? table([
        {
          label: 'Dosya',
          render: (r) => el('a.link', {
            text: `${r.kind === 'EFATURA_XML' ? '🧾 ' : '📄 '}${r.file_name}`,
            title: 'Yeni sekmede aç',
            onclick: (e) => { e.preventDefault(); openAttachment(purchase.id, r); },
          }),
          wrap: true,
        },
        { label: 'Tür', value: (r) => (r.kind === 'EFATURA_XML' ? 'e-Fatura XML' : 'Belge') },
        { label: 'Boyut', num: true, value: (r) => humanSize(r.byte_size) },
        { label: 'Yükleyen', value: (r) => r.uploaded_by_name || '—' },
        { label: 'Tarih', value: (r) => fmt.dateTime(r.created_at) },
        {
          label: 'Özet (SHA-256)',
          render: (r) => el('code', {
            text: r.sha256.slice(0, 12),
            title: `${r.sha256}\n\nBelgenin parmak izi. Dosya sonradan değişirse bu değer de değişir.`,
            style: 'font-size:11px',
          }),
        },
        {
          label: '',
          render: (r) => (isManagement()
            ? el('button.btn.btn-sm.btn-ghost', { text: 'Sil', onclick: () => removeAttachment(purchase.id, r, draw) })
            : el('span.muted', { text: '—', title: 'Fatura kanıtını yalnızca genel müdürlük kaldırabilir' })),
        },
      ], items)
      : empty('Bu belgeye fatura dosyası eklenmemiş.', '📎'));
  };

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    uploadBtn.disabled = true;
    uploadBtn.textContent = 'Yükleniyor...';
    try {
      const kind = /\.xml$/i.test(file.name) ? 'EFATURA_XML' : 'BELGE';
      const res = await api.upload(`/api/purchases/${purchase.id}/attachments`, file, { kind });
      draw(res.items);
      toast('Fatura dosyası eklendi.');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      fileInput.value = '';
      uploadBtn.disabled = false;
      uploadBtn.textContent = '📎 Fatura Dosyası Ekle';
    }
  });

  draw(purchase.attachments || []);
  return el('div', { style: 'margin-top:14px' }, [
    el('div.row', { style: 'justify-content:space-between;align-items:center;margin-bottom:8px' }, [
      el('strong', { text: 'Fatura Dosyaları', style: 'font-size:13px' }),
      canWrite("purchases") && purchase.status !== 'IPTAL' ? el('div', {}, [uploadBtn, fileInput]) : null,
    ]),
    listBox,
  ]);
}

async function openAttachment(purchaseId, row) {
  try {
    const blob = await api.fetchBlob(`/api/purchases/${purchaseId}/attachments/${row.id}`);
    const url = URL.createObjectURL(blob);
    const win = window.open(url, '_blank');
    if (!win) {
      // Açılır pencere engelliyse dosyayı indirmeye düşürüyoruz
      const a = el('a', { href: url, download: row.file_name });
      document.body.append(a);
      a.click();
      a.remove();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeAttachment(purchaseId, row, draw) {
  const ok = await confirmDialog(
    `"${row.file_name}" belgeden kaldırılacak. Fatura kanıtı olduğu için bu işlem denetim izine yazılır.`,
    { title: 'Fatura Dosyasını Sil', confirmText: 'Sil', danger: true }
  );
  if (!ok) return;
  try {
    const res = await api.del(`/api/purchases/${purchaseId}/attachments/${row.id}`);
    draw(res.items);
    toast('Dosya kaldırıldı.');
  } catch (err) {
    toast(err.message, 'error');
  }
}

const isManagement = () => ['ADMIN', 'GENEL_MUDURLUK'].includes(state.user?.role);

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}


/* ============ EŞLEŞMEYEN FATURA SATIRLARI (uyarı paneli) =========== */
/**
 * Faturada olup belgeye alınmamış kalemler.
 *
 * Bunlar sessizce kaybolursa fatura toplamı ile sistemdeki belge toplamı
 * arasındaki fark aylar sonra açıklanamaz hale gelir. Panel her birini
 * açık tutar; kullanıcı ya bir ürüne bağlar (kalem belgeye eklenir, stoğa
 * girer) ya da sebebini yazarak yok sayar.
 */
function unmatchedPanel(data, onChange) {
  const toplam = data.items.reduce((s, r) => s + r.gross_total, 0);
  return card(`⚠️ Eşleşmeyen Fatura Satırları (${data.items.length})`, [
    table([
      { label: 'Belge', value: (r) => `${r.document_no || '#' + r.purchase_id} · ${fmt.date(r.document_date)}` },
      { label: 'Tedarikçi', value: (r) => r.supplier_name, wrap: true },
      { label: 'Faturadaki ad', wrap: true, render: (r) => el('div', {}, [
        el('strong', { text: r.source_name }),
        r.source_code ? el('small.muted', { text: r.source_code, style: 'display:block' }) : null,
      ]) },
      { label: 'Miktar', num: true, value: (r) => fmt.num(r.quantity) },
      { label: 'Birim Fiyat', num: true, value: (r) => fmt.money(r.unit_price) },
      { label: 'KDV %', num: true, value: (r) => fmt.num(r.vat_rate) },
      { label: 'Tutar', num: true, render: (r) => el('strong', { text: fmt.money(r.gross_total) }) },
      {
        label: '',
        render: (r) => (canWrite('purchases')
          ? el('button.btn.btn-sm.btn-primary', { text: 'Sonuçlandır', onclick: () => resolveUnmatched(r, onChange) })
          : el('span.muted', { text: '—' })),
      },
    ], data.items, { rowClass: () => 'is-warn' }),
  ], {
    note: `Bu ${data.items.length} kalem faturada vardı ama belgeye alınmadı `
      + `(toplam ${fmt.money(toplam)}). Her birini ya bir ürüne bağlayın ya da `
      + 'sebebini yazarak yok sayın — aksi halde fatura ile belge tutarı arasındaki '
      + 'fark açıklanamaz kalır.',
    tight: true,
  });
}

/** Bir kalemi ürüne bağlar ya da sebebiyle yok sayar. */
async function resolveUnmatched(row, onChange) {
  const products = await api.get('/api/products', { campusId: row.campus_id });
  const stock = await api.get('/api/stock', { campusId: row.campus_id }).catch(() => ({ items: [] }));

  const picker = createProductPicker({
    products: products.items,
    stockByProduct: new Map(stock.items.map((r) => [r.product_id, r.stock_qty])),
    placeholder: 'Ürün arayın…',
  });
  const qty = el('input.num', { type: 'number', step: '0.01', min: '0.001', value: String(row.quantity) });
  const price = el('input.num', { type: 'number', step: '0.01', min: '0', value: String(row.unit_price) });
  const vat = el('input.num', { type: 'number', step: '0.1', min: '0', max: '100', value: String(row.vat_rate) });
  const note = el('input', { placeholder: 'Örn: nakliye bedeli, stok kalemi değil' });
  const hata = el('div.alert.alert-danger', { hidden: true });

  const baglaBtn = el('button.btn.btn-primary', { text: 'Ürüne Bağla ve Belgeye Ekle' });
  const yoksayBtn = el('button.btn', { text: 'Yok Say' });

  const m = modal({
    title: 'Eşleşmeyen Kalemi Sonuçlandır',
    body: [
      hata,
      el('dl.kv', {}, [
        el('dt', { text: 'Faturada' }), el('dd', { text: row.source_name }),
        el('dt', { text: 'Belge' }), el('dd', { text: `${row.document_no || '#' + row.purchase_id} · ${fmt.date(row.document_date)} · ${row.supplier_name}` }),
        el('dt', { text: 'Tutar' }), el('dd', { text: `${fmt.num(row.quantity)} × ${fmt.money(row.unit_price)} = ${fmt.money(row.gross_total)} (KDV dahil)` }),
      ]),
      alertBox('info', 'İki yoldan biri',
        'Kalem gerçekten alındıysa bir ürüne bağlayın: belgeye satır olarak eklenir ve stoğa girer. '
        + 'Stok kalemi değilse (nakliye, ambalaj, hizmet bedeli) sebebini yazıp yok sayın.'),
      el('label.field', {}, [el('span', { text: 'Ürün' }), picker.node]),
      el('div.grid.grid-3', {}, [
        el('label.field', {}, [el('span', { text: 'Miktar' }), qty]),
        el('label.field', {}, [el('span', { text: 'Birim fiyat (KDV hariç)' }), price]),
        el('label.field', {}, [el('span', { text: 'KDV %' }), vat]),
      ]),
      el('label.field', {}, [el('span', { text: 'Açıklama (yok sayarken zorunlu)' }), note]),
    ],
    actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m.close() }), yoksayBtn, baglaBtn],
  });

  const gonder = async (body, btn, etiket) => {
    hata.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Kaydediliyor...';
    try {
      const r = await api.post(`/api/purchases/unmatched/${row.id}/resolve`, body);
      m.close();
      toast(r.status === 'COZULDU'
        ? `Kalem belgeye eklendi (${fmt.money(r.grossTotal)}) ve stoğa girdi.`
        : 'Kalem yok sayıldı; kaydı denetim için saklandı.');
      onChange();
    } catch (err) {
      hata.textContent = err.message;
      hata.hidden = false;
      btn.disabled = false;
      btn.textContent = etiket;
    }
  };

  baglaBtn.addEventListener('click', () => {
    if (!picker.getValue()) {
      picker.markMissing(true);
      hata.textContent = 'Önce bir ürün seçin. Kalem stok ürünü değilse "Yok Say" kullanın.';
      hata.hidden = false;
      return;
    }
    gonder({
      productId: picker.getValue(),
      quantity: Number(qty.value) || 0,
      unitPrice: Number(price.value) || 0,
      vatRate: Number(vat.value) || 0,
      discountPct: row.discount_pct,
      note: note.value.trim() || null,
    }, baglaBtn, 'Ürüne Bağla ve Belgeye Ekle');
  });

  yoksayBtn.addEventListener('click', () => {
    if (!note.value.trim()) {
      hata.textContent = 'Yok saymak için sebep yazmalısınız. Bu kayıt denetimde okunacak.';
      hata.hidden = false;
      note.focus();
      return;
    }
    gonder({ ignore: true, note: note.value.trim() }, yoksayBtn, 'Yok Say');
  });
}
