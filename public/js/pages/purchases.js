import { api } from '../api.js';
import { state, canWrite, canDeleteDocuments } from '../app.js';
import { el, card, stat, table, fmt, badge, modal, toast, confirmDialog, dateUtil, alertBox, empty, shortName} from '../ui.js';
import { parseEFatura, matchProducts, matchSupplier } from '../efatura.js';
import { parseKarekod, compareWithLines } from '../karekod.js';
import { openKarekodScanner } from '../karekod-tarayici.js';

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
        canWrite("purchases") ? el('button.btn.btn-primary', { text: '+ Yeni Mal Girişi', onclick: () => openPurchaseForm(draw) }) : null,
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
      sourceName: p0.sourceName || null,   // faturadaki ad (eslesmeyen satirlar icin)
    };

    const select = el('select', {}, [
      el('option', { value: '', selected: initialId === null }, ['— ürün seçin —']),
      ...products.items.map((p) =>
        el('option', { value: p.id, selected: p.id === initialId }, [`${p.name}${p.barcode ? ' · ' + p.barcode : ''}`])),
    ]);
    const qty = el('input.num', { type: 'number', step: '0.01', min: '0.001', value: String(line.quantity) });
    const price = el('input.num', { type: 'number', step: '0.01', min: '0', value: hasPreset ? String(line.unitPrice) : '' });
    const disc = el('input.num', { type: 'number', step: '0.01', min: '0', max: '100', value: String(line.discountPct) });
    const vatIn = el('input.num', { type: 'number', step: '0.1', min: '0', max: '100', value: hasPreset ? String(line.vatRate) : '' });
    const expiry = el('input', { type: 'date' });
    const totalCell = el('td.num');

    const syncProduct = () => {
      line.productId = select.value ? Number(select.value) : null;
      const p = productMap.get(line.productId);
      // Fatura satiri kendi fiyatini ve KDV'sini getirir; urun kartindaki
      // degerler yalnizca bos alanlari doldurmak icin kullanilir.
      if (p && !hasPreset) {
        if (!price.value || Number(price.value) === 0) price.value = p.purchase_price;
        vatIn.value = p.vat_rate;
      } else if (p && hasPreset && !vatIn.value) {
        vatIn.value = p.vat_rate;
      }
      select.classList.toggle('needs-pick', !select.value);
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
      el('td', { style: 'min-width:220px' }, [
        select,
        line.sourceName ? el('small.muted', { text: `Faturada: ${line.sourceName}`, style: 'display:block;margin-top:2px' }) : null,
      ]),
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
    title: 'Yeni Mal Girişi (İrsaliye / Fatura)',
    wide: true,
    body: [
      errorBox,
      el('div.row', { style: 'justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap' }, [
        el('small.muted', {
          text: 'Faturayı elle girebilir, e-Fatura/e-Arşiv XML dosyasından otomatik doldurabilir '
            + 'ya da kağıt faturadaki karekodu okutabilirsiniz.',
        }),
        el('div.btn-row', {}, [importBtn, qrBtn, xmlInput]),
      ]),
      importBox,
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
    const matchedLines = matchProducts(invoice.lines, products.items);
    const { supplier, matchedBy } = matchSupplier(invoice.supplier, suppliers.items);

    // Baslik alanlari
    if (supplier) supplierSelect.value = String(supplier.id);
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
        sourceName: line.product ? null : line.name,
      });
    }
    recalcTotals();

    // Ozet ve uyarilar
    const unmatched = matchedLines.filter((l) => !l.product);
    const mismatched = matchedLines.filter((l) => l.mismatch);
    const notes = [];

    notes.push(el('div.alert.alert-success', {}, [
      el('strong', { text: `Fatura okundu: ${invoice.documentNo || '(belge no yok)'} · ${matchedLines.length} kalem` }),
      `${invoice.supplier.name || 'Tedarikçi adı yok'}`
      + `${invoice.supplier.taxNo ? ` (VKN ${invoice.supplier.taxNo})` : ''} · `
      + `Mal bedeli ${fmt.money(invoice.computed.netTotal)} + KDV ${fmt.money(invoice.computed.vatTotal)} = `
      + `${fmt.money(invoice.computed.grossTotal)}`,
    ]));

    if (!supplier) {
      notes.push(alertBox('warning', 'Tedarikçi eşleşmedi',
        `Faturadaki "${invoice.supplier.name}" (VKN ${invoice.supplier.taxNo || 'yok'}) sistemde bulunamadı. `
        + 'Listeden doğru tedarikçiyi seçin. Tedarikçi kartına VKN yazarsanız bir dahaki sefere kendiliğinden eşleşir.'));
    } else if (matchedBy === 'unvan') {
      notes.push(alertBox('info', 'Tedarikçi unvandan eşleşti',
        `${supplier.name} seçildi. VKN ile eşleşmesi için tedarikçi kartına `
        + `${invoice.supplier.taxNo || 'VKN'} yazmanız daha güvenlidir.`));
    }

    if (unmatched.length) {
      notes.push(alertBox('warning', `${unmatched.length} kalem eşleşmedi`,
        `Şu ürünler sistemde bulunamadı: ${unmatched.map((l) => `"${l.name}"`).join(', ')}. `
        + 'Aşağıdaki satırlarda karşılık gelen ürünü seçin, satırı silin veya önce ürünü tanımlayın.'));
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
      const payload = {
        campusId: state.campusId,
        supplierId: Number(supplierSelect.value),
        documentNo: docNo.value.trim(),
        documentDate: docDate.value,
        dueDate: dueDate.value || null,
        note: noteInput.value.trim(),
        efaturaUuid: imported.uuid || null,
        lines: lines.filter((l) => l.quantity > 0 && l.productId).map((l) => ({
          productId: l.productId, quantity: l.quantity, unitPrice: l.unitPrice,
          vatRate: l.vatRate, discountPct: l.discountPct, expiryDate: l.expiryDate,
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
