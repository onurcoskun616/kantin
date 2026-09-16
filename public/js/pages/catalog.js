/** Ürün kataloğu, fiyat/kâr yönetimi ve tedarikçiler. */
import { api } from '../api.js';
import { state, canWrite } from '../app.js';
import { el, card, stat, table, fmt, badge, modal, toast, formModal, deltaCell, alertBox, empty, shortName} from '../ui.js';

/* ============================== Ürünler ============================= */
export async function renderProducts(root) {
  const filters = { search: '', categoryId: '' };
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const [data, cats, priceControl] = await Promise.all([
      api.get('/api/products', { campusId: state.campusId, ...filters }),
      api.get('/api/products/categories'),
      api.get('/api/reports/price-control', { campusId: state.campusId }),
    ]);
    container.replaceChildren();

    const searchInput = el('input.search-input', { type: 'search', placeholder: 'Ürün / barkod ara...', value: filters.search });
    searchInput.addEventListener('input', debounce(() => { filters.search = searchInput.value; draw(); }, 350));
    const catSelect = el('select', {}, [
      el('option', { value: '' }, ['Tüm kategoriler']),
      ...cats.items.map((c) => el('option', { value: c.id, selected: String(c.id) === filters.categoryId }, [c.name])),
    ]);
    catSelect.addEventListener('change', () => { filters.categoryId = catSelect.value; draw(); });

    container.append(el('div.filter-bar', {}, [
      searchInput, catSelect,
      el('div', { style: 'flex:1' }),
      canWrite() ? el('button.btn.btn-primary', { text: '+ Yeni Ürün', onclick: () => openProductForm(cats.items, null, draw) }) : null,
      canWrite() ? el('button.btn', {
        text: '📊 Excel\'den Aktar',
        onclick: async () => {
          const { openImportWizard } = await import('./import.js');
          openImportWizard(draw);
        },
      }) : null,
      canWrite() ? el('button.btn', { text: '🏷️ Kategoriler', onclick: () => openCategories(cats.items, draw) }) : null,
      el('button.btn', { text: '⬇ Excel (CSV)', onclick: () => api.download('/api/products', { campusId: state.campusId, ...filters }) }),
    ]));

    const avgMargin = data.items.length
      ? data.items.reduce((s, p) => s + (p.profit.marginPct || 0), 0) / data.items.length : 0;
    container.append(el('div.grid.grid-4', {}, [
      stat('Ürün Sayısı', fmt.int(data.items.length)),
      stat('Ortalama Kâr Marjı', fmt.pct(Math.round(avgMargin * 100) / 100)),
      stat('Fiyat Uyarısı', String(priceControl.items.length), { tone: priceControl.items.length ? 'warn' : 'ok', sub: 'Zararına satış / düşük marj / tavan aşımı' }),
      stat('Kategori', String(cats.items.length)),
    ]));

    if (priceControl.items.length) {
      container.append(card('⚠️ Fiyat Denetimi Uyarıları', [
        table([
          { label: 'Ürün', value: (r) => r.name, wrap: true },
          { label: 'Alış', num: true, value: (r) => fmt.money(r.effective_purchase_price) },
          { label: 'Satış', num: true, value: (r) => fmt.money(r.effective_sale_price) },
          { label: 'Birim Kâr', num: true, render: (r) => deltaCell(r.profit.unitProfit) },
          { label: 'Marj', num: true, value: (r) => fmt.pct(r.profit.marginPct) },
          { label: 'Sorun', render: (r) => el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap' }, r.issues.map((i) => badge(i, 'warn'))), wrap: true },
        ], priceControl.items, { emptyText: 'Uyarı yok.' }),
      ], { tight: true, note: `Kâr marjı %${priceControl.minMargin} altında kalan, zararına satılan veya tavan fiyatı aşan ürünler listelenir.` }));
    }

    container.append(card('Ürün Listesi ve Kârlılık', [
      table([
        { label: 'Barkod', value: (r) => r.barcode || '—' },
        { label: 'Ürün', value: (r) => r.name, wrap: true },
        { label: 'Kategori', value: (r) => r.category_name || '—' },
        { label: 'Alış (KDV hariç)', num: true, value: (r) => fmt.money(r.effective_purchase_price) },
        { label: 'Satış (KDV dahil)', num: true, value: (r) => fmt.money(r.effective_sale_price) },
        { label: 'KDV', num: true, value: (r) => fmt.pct(r.vat_rate) },
        { label: 'Satış (KDV hariç)', num: true, value: (r) => fmt.money(r.profit.saleNet) },
        { label: 'Birim Kâr', num: true, render: (r) => deltaCell(r.profit.unitProfit) },
        { label: 'Kâr Marjı', num: true, render: (r) => marginBadge(r.profit.marginPct) },
        { label: 'Maliyet Üzeri', num: true, value: (r) => fmt.pct(r.profit.markupPct) },
        { label: 'Kampüs Fiyatı', render: (r) => (r.campus_sale_price !== null && r.campus_sale_price !== undefined ? badge('Özel', 'info') : el('span.muted', { text: '—' })) },
        { label: 'Durum', render: (r) => (r.is_active ? badge('Aktif', 'ok') : badge('Pasif')) },
        {
          label: '', render: (r) => (canWrite() ? el('div.btn-row', {}, [
            el('button.btn.btn-sm', { text: 'Düzenle', onclick: () => openProductForm(cats.items, r, draw) }),
            el('button.btn.btn-sm', { text: 'Kampüs Fiyatı', onclick: () => openCampusPrice(r, draw) }),
          ]) : '—'),
        },
      ], data.items, {
        rowClass: (r) => (r.profit.unitProfit < 0 ? 'is-critical' : r.profit.marginPct < 15 ? 'is-warn' : ''),
        emptyText: 'Ürün bulunamadı.',
      }),
    ], { tight: true, note: 'Kâr marjı = birim kâr / KDV hariç satış fiyatı. Maliyet üzeri kâr = birim kâr / alış fiyatı.' }));
  }
}

function marginBadge(pct) {
  if (pct === null || pct === undefined) return el('span.muted', { text: '—' });
  const tone = pct < 0 ? 'bad' : pct < 20 ? 'warn' : 'ok';
  return badge(fmt.pct(pct), tone);
}

function openProductForm(categories, product, onDone) {
  const isEdit = !!product;
  formModal({
    title: isEdit ? `Ürün Düzenle — ${product.name}` : 'Yeni Ürün',
    wide: true,
    fields: [
      { name: 'name', label: 'Ürün adı', value: product?.name ?? '', required: true },
      { name: 'barcode', label: 'Barkod', value: product?.barcode ?? '', hint: 'Sayımda hızlı arama için okutabilirsiniz.' },
      { name: 'categoryId', label: 'Kategori', type: 'select', value: product?.category_id ?? '',
        options: [{ value: '', label: '— seçiniz —' }, ...categories.map((c) => ({ value: c.id, label: c.name }))] },
      { name: 'unit', label: 'Birim', type: 'select', value: product?.unit ?? 'ADET',
        options: ['ADET', 'KG', 'LT', 'PAKET', 'KUTU', 'PORSIYON'].map((u) => ({ value: u, label: u })) },
      { name: 'purchasePrice', label: 'Alış fiyatı (KDV hariç)', type: 'number', step: '0.01', min: '0', value: product?.purchase_price ?? '', required: true,
        hint: 'Tedarikçi faturasındaki birim fiyat.' },
      { name: 'salePrice', label: 'Satış fiyatı (KDV dahil)', type: 'number', step: '0.01', min: '0', value: product?.sale_price ?? '', required: true,
        hint: 'Öğrenciden tahsil edilen raf fiyatı.' },
      { name: 'vatRate', label: 'KDV oranı (%)', type: 'number', step: '0.1', min: '0', max: '100', value: product?.vat_rate ?? 10 },
      { name: 'maxPrice', label: 'Tavan fiyat (TL)', type: 'number', step: '0.01', min: '0', value: product?.max_price ?? 0,
        hint: 'Resmî tarife/okul kararıyla belirlenen üst sınır. 0 = sınır yok.' },
      { name: 'criticalStock', label: 'Kritik stok seviyesi', type: 'number', step: '1', min: '0', value: product?.critical_stock ?? 0,
        hint: 'Bu miktarın altına inince panelde uyarı verilir.' },
      { name: 'mebApproved', label: 'Okul kantin yönetmeliğine uygun ürün', type: 'checkbox', value: product ? !!product.meb_approved : true },
      { name: 'trackExpiry', label: 'Son kullanma tarihi takip edilsin', type: 'checkbox', value: product ? !!product.track_expiry : false },
      { name: 'isActive', label: 'Aktif', type: 'checkbox', value: product ? !!product.is_active : true },
    ],
    submitText: isEdit ? 'Güncelle' : 'Ürünü Ekle',
    onSubmit: async (v) => {
      if (isEdit) await api.put(`/api/products/${product.id}`, v);
      else await api.post('/api/products', v);
      toast(isEdit ? 'Ürün güncellendi.' : 'Ürün eklendi.');
      onDone();
    },
  });
}

function openCampusPrice(product, onDone) {
  const campusName = state.campuses.find((c) => c.id === state.campusId)?.name ?? '';
  formModal({
    title: `Kampüs Fiyatı — ${product.name}`,
    fields: [
      { name: 'purchasePrice', label: `Alış fiyatı (${shortName(campusName)})`, type: 'number', step: '0.01', min: '0',
        value: product.campus_purchase_price ?? '', hint: `Boş bırakılırsa katalog fiyatı (${fmt.money(product.purchase_price)}) kullanılır.` },
      { name: 'salePrice', label: `Satış fiyatı (${shortName(campusName)})`, type: 'number', step: '0.01', min: '0',
        value: product.campus_sale_price ?? '', hint: `Boş bırakılırsa katalog fiyatı (${fmt.money(product.sale_price)}) kullanılır.` },
      { name: 'criticalStock', label: 'Kritik stok', type: 'number', step: '1', min: '0', value: product.campus_critical_stock ?? '' },
    ],
    submitText: 'Kaydet',
    onSubmit: async (v) => {
      await api.put(`/api/products/${product.id}/campus-price/${state.campusId}`, v);
      toast('Kampüs fiyatı güncellendi.');
      onDone();
    },
  });
}

function openCategories(categories, onDone) {
  const list = el('div.grid', { style: 'gap:8px' });
  const refresh = () => {
    list.replaceChildren(...categories.map((c) => el('div.row', { style: 'justify-content:space-between;align-items:center' }, [
      el('span', { text: c.name }),
      canWrite() ? el('button.btn.btn-sm', {
        text: 'Yeniden adlandır',
        onclick: () => formModal({
          title: 'Kategori Düzenle',
          fields: [{ name: 'name', label: 'Kategori adı', value: c.name, required: true }],
          onSubmit: async (v) => { await api.put(`/api/products/categories/${c.id}`, v); toast('Güncellendi.'); onDone(); },
        }),
      }) : null,
    ])));
  };
  refresh();

  modal({
    title: 'Kategoriler',
    body: [
      list,
      canWrite() ? el('button.btn.btn-primary', {
        text: '+ Kategori Ekle',
        onclick: () => formModal({
          title: 'Yeni Kategori',
          fields: [{ name: 'name', label: 'Kategori adı', required: true }],
          onSubmit: async (v) => { await api.post('/api/products/categories', v); toast('Kategori eklendi.'); onDone(); },
        }),
      }) : null,
    ],
  });
}

/* ============================ Tedarikçiler ========================== */
export async function renderSuppliers(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/suppliers');
    container.replaceChildren();

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('h3', { text: 'Tedarikçiler' }),
      canWrite() ? el('button.btn.btn-primary', { text: '+ Yeni Tedarikçi', onclick: () => openSupplierForm(null, draw) }) : null,
    ]));

    container.append(card(null, [
      table([
        { label: 'Tedarikçi', value: (r) => r.name, wrap: true },
        { label: 'Telefon', value: (r) => r.phone || '—' },
        { label: 'Vergi No', value: (r) => r.tax_no || '—' },
        { label: 'E-posta', value: (r) => r.email || '—' },
        { label: 'Durum', render: (r) => (r.is_active ? badge('Aktif', 'ok') : badge('Pasif')) },
        {
          label: '', render: (r) => el('div.btn-row', {}, [
            el('button.btn.btn-sm', { text: 'Cari Hesap', onclick: () => showSupplier(r.id, draw) }),
            canWrite() ? el('button.btn.btn-sm', { text: 'Düzenle', onclick: () => openSupplierForm(r, draw) }) : null,
          ]),
        },
      ], data.items, { emptyText: 'Tedarikçi kaydı yok.' }),
    ], { tight: true }));
  }
}

async function showSupplier(id, onDone) {
  const data = await api.get(`/api/suppliers/${id}`);
  modal({
    title: `${data.name} — Cari Hesap`,
    wide: true,
    body: [
      el('div.grid.grid-3', {}, [
        stat('Toplam Alım', fmt.money(data.balance.totalPurchase)),
        stat('Toplam Ödeme', fmt.money(data.balance.totalPaid)),
        stat('Bakiye (Borç)', fmt.money(data.balance.debt), { tone: data.balance.debt > 0 ? 'warn' : 'ok' }),
      ]),
      canWrite() ? el('button.btn.btn-primary', {
        text: '+ Ödeme Kaydet',
        onclick: () => formModal({
          title: 'Tedarikçiye Ödeme',
          fields: [
            { name: 'amount', label: 'Tutar (TL)', type: 'number', step: '0.01', min: '0.01', required: true },
            { name: 'paymentDate', label: 'Tarih', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
            { name: 'method', label: 'Ödeme şekli', type: 'select', options: ['NAKIT', 'HAVALE', 'CEK', 'KART'].map((m) => ({ value: m, label: m })) },
            { name: 'note', label: 'Açıklama' },
          ],
          onSubmit: async (v) => {
            await api.post(`/api/suppliers/${id}/payments`, { ...v, campusId: state.campusId });
            toast('Ödeme kaydedildi.');
            document.querySelector('.modal-backdrop')?.remove();
            onDone();
          },
        }),
      }) : null,
      el('h4', { text: 'Alım Belgeleri', style: 'font-size:13px;color:var(--text-muted)' }),
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.document_date) },
        { label: 'Belge No', value: (r) => r.document_no || '—' },
        { label: 'Kampüs', value: (r) => shortName(r.campus_name) },
        { label: 'Tutar', num: true, value: (r) => fmt.money(r.gross_total) },
      ], data.purchases, { emptyText: 'Alım kaydı yok.' }),
      el('h4', { text: 'Ödemeler', style: 'font-size:13px;color:var(--text-muted)' }),
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.payment_date) },
        { label: 'Tutar', num: true, value: (r) => fmt.money(r.amount) },
        { label: 'Şekil', value: (r) => r.method },
        { label: 'Not', value: (r) => r.note || '—', wrap: true },
      ], data.payments, { emptyText: 'Ödeme kaydı yok.' }),
    ],
  });
}

function openSupplierForm(supplier, onDone) {
  formModal({
    title: supplier ? 'Tedarikçi Düzenle' : 'Yeni Tedarikçi',
    fields: [
      { name: 'name', label: 'Firma adı', value: supplier?.name ?? '', required: true },
      { name: 'phone', label: 'Telefon', value: supplier?.phone ?? '' },
      { name: 'email', label: 'E-posta', type: 'email', value: supplier?.email ?? '' },
      { name: 'taxOffice', label: 'Vergi dairesi', value: supplier?.tax_office ?? '' },
      { name: 'taxNo', label: 'Vergi / TC no', value: supplier?.tax_no ?? '' },
      { name: 'address', label: 'Adres', type: 'textarea', value: supplier?.address ?? '' },
      { name: 'note', label: 'Not', type: 'textarea', value: supplier?.note ?? '' },
      { name: 'isActive', label: 'Aktif', type: 'checkbox', value: supplier ? !!supplier.is_active : true },
    ],
    submitText: supplier ? 'Güncelle' : 'Ekle',
    onSubmit: async (v) => {
      if (supplier) await api.put(`/api/suppliers/${supplier.id}`, v);
      else await api.post('/api/suppliers', v);
      toast('Kaydedildi.');
      onDone();
    },
  });
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
