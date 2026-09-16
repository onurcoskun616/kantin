/**
 * Excel / CSV'den ürün listesi ve açılış stoğu içeri aktarma sihirbazı.
 * Dosya tarayıcıda çözümlenir, önizleme gösterilir, onay sonrası sunucuya gönderilir.
 */
import { api } from '../api.js';
import { state } from '../app.js';
import { el, modal, table, fmt, badge, toast, alertBox, dateUtil, shortName } from '../ui.js';
import { readWorkbook, mapColumns, normalizeHeader, toNumber, toText } from '../xlsx.js';

const PRODUCT_FIELDS = {
  barcode: ['barkod', 'barcode', 'barkod no', 'stok kodu'],
  name: ['urun adi', 'urun', 'urun ismi', 'malzeme adi', 'stok adi', 'ad'],
  categoryName: ['kategori', 'urun grubu', 'grup'],
  unit: ['birim', 'olcu birimi'],
  purchasePrice: ['alis fiyati', 'alis', 'alis fiyat', 'maliyet', 'alim fiyati'],
  salePrice: ['satis fiyati', 'satis', 'satis fiyat', 'raf fiyati'],
  vatRate: ['kdv orani', 'kdv'],
  criticalStock: ['kritik stok', 'minimum stok', 'min stok', 'kritik'],
  maxPrice: ['tavan fiyat', 'tavan'],
};

const OPENING_FIELDS = {
  barcode: ['barkod', 'barcode', 'stok kodu'],
  productName: ['urun adi', 'urun', 'ad'],
  campusCode: ['kampus kodu', 'kampus', 'sube'],
  quantity: ['miktar', 'adet', 'stok', 'sayilan'],
};

// Şablondaki örnek satırların barkodları (kullanıcı silmeyi unutursa uyaralım)
const TEMPLATE_EXAMPLES = new Set(['8690000000028', '8690000000011']);

export function openImportWizard(onDone) {
  const fileInput = el('input', { type: 'file', accept: '.xlsx,.csv,.txt' });
  const resultBox = el('div.grid', { style: 'gap:12px' });
  const importBtn = el('button.btn.btn-primary', { text: 'İçeri Aktar', disabled: true });
  let parsed = null;

  const m = modal({
    title: "Excel'den Ürün Listesi Aktar",
    wide: true,
    body: [
      alertBox('info', 'Nasıl çalışır?',
        el('span', {}, [
          'Şablonu indirip doldurun, sonra buradan yükleyin. Yükleme öncesi önizleme gösterilir, onaylamadan hiçbir kayıt oluşmaz. ',
          'Barkodu daha önce yüklenmiş ürünler yeni kayıt açmaz, mevcut ürün güncellenir — fiyat güncellemesi için de aynı şablonu kullanabilirsiniz.',
        ])),
      el('div.btn-row', {}, [
        el('a.btn', {
          href: '/sablonlar/urun-listesi-sablonu.xlsx',
          download: 'urun-listesi-sablonu.xlsx',
          text: '⬇ Boş Şablonu İndir (.xlsx)',
        }),
        el('a.btn.btn-ghost', {
          href: '/api/products?format=csv',
          text: '⬇ Mevcut Ürünleri İndir (.csv)',
          target: '_blank',
        }),
      ]),
      el('label.field', {}, [
        el('span', { text: 'Doldurduğunuz dosyayı seçin (.xlsx veya .csv)' }),
        fileInput,
      ]),
      resultBox,
    ],
    actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m.close() }), importBtn],
  });

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    resultBox.replaceChildren();
    importBtn.disabled = true;
    parsed = null;
    if (!file) return;

    resultBox.append(el('div.empty', { text: 'Dosya okunuyor...' }));
    try {
      parsed = await analyze(file);
      resultBox.replaceChildren(...renderPreview(parsed));
      importBtn.disabled = parsed.products.valid.length === 0;
    } catch (err) {
      resultBox.replaceChildren(alertBox('danger', 'Dosya okunamadı', err.message));
    }
  });

  importBtn.addEventListener('click', async () => {
    if (!parsed) return;
    importBtn.disabled = true;
    importBtn.textContent = 'Aktarılıyor...';
    try {
      const productResult = await api.post('/api/products/bulk-import', {
        items: parsed.products.valid,
      });

      let openingResult = null;
      const wantsOpening = parsed.openingCheckbox?.checked && parsed.opening.valid.length;
      if (wantsOpening) {
        openingResult = await api.post('/api/stock/opening-import', {
          date: parsed.openingDateInput.value || dateUtil.today(),
          items: parsed.opening.valid,
        });
      }

      m.close();
      showSummary(productResult, openingResult);
      onDone?.();
    } catch (err) {
      resultBox.prepend(alertBox('danger', 'Aktarım başarısız', err.message));
    } finally {
      importBtn.disabled = false;
      importBtn.textContent = 'İçeri Aktar';
    }
  });
}

/* --------------------------- Çözümleme ---------------------------- */
async function analyze(file) {
  const wb = await readWorkbook(file);

  const productSheet = pickSheet(wb, ['urun listesi', 'urunler', 'sheet1', 'csv'], PRODUCT_FIELDS, ['name']);
  if (!productSheet) {
    throw new Error('Ürün sütunları bulunamadı. Başlık satırında en azından "Ürün Adı", "Alış Fiyatı" ve "Satış Fiyatı" bulunmalıdır. Şablonu indirip kullanmanız en güvenlisidir.');
  }

  const products = extractProducts(productSheet);
  const openingSheet = pickSheet(wb, ['acilis stogu', 'acilis'], OPENING_FIELDS, ['campusCode', 'quantity']);
  const opening = openingSheet ? extractOpening(openingSheet) : { valid: [], errors: [], skipped: 0 };

  return { wb, products, opening, sheetName: productSheet.name, openingSheetName: openingSheet?.name ?? null };
}

function pickSheet(wb, preferredNames, fields, requiredFields) {
  const candidates = [...wb.sheetNames].sort((a, b) => {
    const rank = (n) => {
      const i = preferredNames.indexOf(normalizeHeader(n));
      return i === -1 ? 99 : i;
    };
    return rank(a) - rank(b);
  });

  for (const name of candidates) {
    const rows = wb.sheets[name];
    if (!rows?.length) continue;
    const { headerRow, map } = mapColumns(rows, fields);
    if (headerRow === -1) continue;
    if (!requiredFields.every((f) => map[f] !== undefined)) continue;
    return { name, rows, headerRow, map };
  }
  return null;
}

function extractProducts({ rows, headerRow, map }) {
  const valid = [];
  const errors = [];
  const seenBarcodes = new Map();
  let exampleRows = 0;

  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const cells = rows[r] || [];
    const pick = (field) => (map[field] === undefined ? '' : cells[map[field]]);
    const rowNo = r + 1;

    const name = toText(pick('name'));
    const barcode = toText(pick('barcode'));
    // Tamamen boş satırları sessizce atla
    if (!name && !barcode && !toText(pick('purchasePrice'))) continue;

    if (!name) { errors.push({ row: rowNo, message: 'Ürün adı boş.' }); continue; }

    const purchasePrice = toNumber(pick('purchasePrice'));
    const salePrice = toNumber(pick('salePrice'));
    if (purchasePrice === null) { errors.push({ row: rowNo, name, message: 'Alış fiyatı okunamadı.' }); continue; }
    if (salePrice === null) { errors.push({ row: rowNo, name, message: 'Satış fiyatı okunamadı.' }); continue; }
    if (purchasePrice < 0 || salePrice < 0) { errors.push({ row: rowNo, name, message: 'Fiyatlar negatif olamaz.' }); continue; }

    if (barcode) {
      if (seenBarcodes.has(barcode)) {
        errors.push({ row: rowNo, name, message: `Bu barkod ${seenBarcodes.get(barcode)}. satırda da var.` });
        continue;
      }
      seenBarcodes.set(barcode, rowNo);
      if (TEMPLATE_EXAMPLES.has(barcode)) exampleRows += 1;
    }

    const vatRate = toNumber(pick('vatRate'));
    const item = {
      __row: rowNo,
      barcode: barcode || null,
      name,
      categoryName: toText(pick('categoryName')) || null,
      unit: toText(pick('unit')).toLocaleUpperCase('tr') || 'ADET',
      purchasePrice,
      salePrice,
      vatRate: vatRate === null ? 10 : vatRate,
      criticalStock: toNumber(pick('criticalStock')) ?? 0,
      maxPrice: toNumber(pick('maxPrice')) ?? 0,
    };
    // Bilgilendirme amaçlı kâr hesabı (sunucu yeniden hesaplar)
    const saleNet = item.salePrice / (1 + item.vatRate / 100);
    item.__unitProfit = Math.round((saleNet - item.purchasePrice) * 100) / 100;
    item.__marginPct = saleNet > 0 ? Math.round((item.__unitProfit / saleNet) * 1000) / 10 : 0;
    valid.push(item);
  }
  return { valid, errors, exampleRows };
}

function extractOpening({ rows, headerRow, map }) {
  const valid = [];
  const errors = [];
  let skipped = 0;

  for (let r = headerRow + 1; r < rows.length; r += 1) {
    const cells = rows[r] || [];
    const pick = (field) => (map[field] === undefined ? '' : cells[map[field]]);
    const rowNo = r + 1;

    const campusCode = toText(pick('campusCode')).toLocaleUpperCase('tr');
    const barcode = toText(pick('barcode'));
    const productName = toText(pick('productName'));
    const quantity = toNumber(pick('quantity'));

    if (!campusCode && !barcode && !productName) continue;
    if (!campusCode) { errors.push({ row: rowNo, message: 'Kampüs kodu boş.' }); continue; }
    if (!barcode && !productName) { errors.push({ row: rowNo, message: 'Barkod veya ürün adı gerekli.' }); continue; }
    if (quantity === null) { errors.push({ row: rowNo, message: 'Miktar okunamadı.' }); continue; }
    if (quantity === 0) { skipped += 1; continue; }

    valid.push({ __row: rowNo, barcode: barcode || null, productName: productName || null, campusCode, quantity });
  }
  return { valid, errors, skipped };
}

/* ---------------------------- Önizleme ---------------------------- */
function renderPreview(parsed) {
  const { products, opening } = parsed;
  const nodes = [];

  const negatives = products.valid.filter((p) => p.__unitProfit < 0);
  const lowMargin = products.valid.filter((p) => p.__unitProfit >= 0 && p.__marginPct < 15);

  nodes.push(el('div.row', { style: 'gap:8px' }, [
    badge(`${products.valid.length} ürün okundu`, products.valid.length ? 'ok' : 'bad'),
    products.errors.length ? badge(`${products.errors.length} satır hatalı`, 'bad') : null,
    negatives.length ? badge(`${negatives.length} üründe zararına satış`, 'bad') : null,
    lowMargin.length ? badge(`${lowMargin.length} üründe marj %15 altı`, 'warn') : null,
    el('span.small.muted', { text: `Sayfa: ${parsed.sheetName}` }),
  ]));

  if (products.exampleRows) {
    nodes.push(alertBox('warning', 'Şablon örnek satırları duruyor',
      `Şablonla birlikte gelen ${products.exampleRows} örnek satır (yeşil renkli) hâlâ dosyada. Bunlar da ürün olarak eklenecek — istemiyorsanız Excel'de silip tekrar yükleyin.`));
  }

  if (negatives.length) {
    nodes.push(alertBox('danger', 'Zararına satış uyarısı',
      `${negatives.map((p) => p.name).slice(0, 5).join(', ')}${negatives.length > 5 ? ' ve diğerleri' : ''} için satış fiyatı, alış fiyatının altında kalıyor. Genellikle alış fiyatının KDV dahil, satış fiyatının KDV hariç yazılmasından kaynaklanır.`));
  }

  if (products.errors.length) {
    nodes.push(el('details', {}, [
      el('summary', { text: `${products.errors.length} hatalı satır — aktarılmayacak (tıklayın)`, style: 'cursor:pointer;font-weight:600;color:var(--danger)' }),
      table([
        { label: 'Satır', num: true, value: (r) => r.row },
        { label: 'Ürün', value: (r) => r.name || '—', wrap: true },
        { label: 'Sorun', value: (r) => r.message, wrap: true },
      ], products.errors.slice(0, 50)),
    ]));
  }

  nodes.push(el('div', {}, [
    el('p.card-note', { text: `Önizleme — ilk ${Math.min(products.valid.length, 20)} satır:` }),
    table([
      { label: 'Satır', num: true, value: (r) => r.__row },
      { label: 'Barkod', value: (r) => r.barcode || '—' },
      { label: 'Ürün', value: (r) => r.name, wrap: true },
      { label: 'Kategori', value: (r) => r.categoryName || '—' },
      { label: 'Birim', value: (r) => r.unit },
      { label: 'Alış', num: true, value: (r) => fmt.money(r.purchasePrice) },
      { label: 'Satış', num: true, value: (r) => fmt.money(r.salePrice) },
      { label: 'KDV', num: true, value: (r) => fmt.pct(r.vatRate) },
      { label: 'Birim Kâr', num: true, value: (r) => fmt.money(r.__unitProfit) },
      { label: 'Marj', num: true, value: (r) => fmt.pct(r.__marginPct) },
    ], products.valid.slice(0, 20), {
      rowClass: (r) => (r.__unitProfit < 0 ? 'is-critical' : r.__marginPct < 15 ? 'is-warn' : ''),
    }),
  ]));

  /* --------------------- Açılış stoğu bölümü -------------------- */
  const openingCheckbox = el('input', { type: 'checkbox' });
  const openingDateInput = el('input', { type: 'date', value: dateUtil.today(), style: 'max-width:180px' });
  parsed.openingCheckbox = openingCheckbox;
  parsed.openingDateInput = openingDateInput;

  if (opening.valid.length) {
    openingCheckbox.checked = true;
    const byCampus = opening.valid.reduce((acc, r) => {
      acc[r.campusCode] = (acc[r.campusCode] || 0) + 1;
      return acc;
    }, {});
    nodes.push(el('div', { style: 'border-top:1px solid var(--border);padding-top:12px' }, [
      el('label.inline-field', { style: 'gap:8px' }, [
        openingCheckbox,
        el('span', { style: 'color:var(--text);font-weight:600' }, [`Açılış stoklarını da aktar (${opening.valid.length} satır)`]),
      ]),
      el('p.card-note', {
        text: `Kampüslere göre: ${Object.entries(byCampus).map(([k, v]) => `${k}: ${v}`).join(' · ')}`
          + (opening.skipped ? ` · ${opening.skipped} satır miktarı 0 olduğu için atlanacak.` : ''),
      }),
      el('label.inline-field', {}, [el('span', { text: 'Açılış tarihi' }), openingDateInput]),
      opening.errors.length
        ? el('p.card-note', { style: 'color:var(--danger)', text: `${opening.errors.length} satır hatalı (satır ${opening.errors.slice(0, 5).map((e) => e.row).join(', ')}...) — atlanacak.` })
        : null,
    ]));
  } else if (parsed.openingSheetName) {
    nodes.push(el('p.card-note', { text: '"Açılış Stoğu" sekmesi boş — yalnızca ürünler aktarılacak.' }));
  }

  return nodes;
}

function showSummary(productResult, openingResult) {
  const lines = [
    el('dl.kv', {}, [
      el('dt', { text: 'Yeni eklenen ürün' }), el('dd', { text: String(productResult.created) }),
      el('dt', { text: 'Güncellenen ürün' }), el('dd', { text: String(productResult.updated) }),
      el('dt', { text: 'Yeni kategori' }), el('dd', { text: String(productResult.categoriesCreated ?? 0) }),
      ...(openingResult ? [
        el('dt', { text: 'Açılış stoğu girilen satır' }), el('dd', { text: String(openingResult.imported) }),
      ] : []),
    ]),
  ];

  const allErrors = [
    ...productResult.errors.map((e) => ({ ...e, kind: 'Ürün' })),
    ...(openingResult?.errors ?? []).map((e) => ({ ...e, kind: 'Açılış stoğu' })),
  ];
  if (allErrors.length) {
    lines.push(alertBox('warning', `${allErrors.length} satır aktarılamadı`,
      'Aşağıdaki satırları Excel\'de düzeltip dosyayı yeniden yükleyebilirsiniz; başarılı satırlar tekrar eklenmez, güncellenir.'));
    lines.push(table([
      { label: 'Tür', value: (r) => r.kind },
      { label: 'Satır', num: true, value: (r) => r.row },
      { label: 'Sorun', value: (r) => r.message, wrap: true },
    ], allErrors.slice(0, 50)));
  } else {
    lines.push(alertBox('success', 'Aktarım tamamlandı', 'Tüm satırlar başarıyla işlendi.'));
  }

  if (openingResult && Object.keys(openingResult.byCampus).length) {
    lines.push(el('p.card-note', {
      text: `Açılış stoğu girilen kampüsler: ${Object.entries(openingResult.byCampus).map(([k, v]) => `${shortName(k)} (${v} ürün)`).join(' · ')}`,
    }));
  }

  modal({ title: 'Aktarım Sonucu', body: lines, wide: allErrors.length > 0 });
  toast(`${productResult.created} ürün eklendi, ${productResult.updated} ürün güncellendi.`);
}
