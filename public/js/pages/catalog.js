/** Ürün kataloğu, fiyat/kâr yönetimi ve tedarikçiler. */
import { api } from '../api.js';
import { state, canWrite, campusName } from '../app.js';
import { el, card, stat, table, fmt, badge, modal, toast, formModal, deltaCell, alertBox, empty, shortName, dateUtil, confirmDialog } from '../ui.js';
import { createProductPicker } from '../urun-secici.js';

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
      canWrite("products") ? el('button.btn.btn-primary', { text: '+ Yeni Ürün', onclick: () => openProductForm(cats.items, null, draw) }) : null,
      canWrite("products") ? el('button.btn', {
        text: '📊 Excel\'den Aktar',
        onclick: async () => {
          const { openImportWizard } = await import('./import.js');
          openImportWizard(draw);
        },
      }) : null,
      canWrite("products") ? el('button.btn', { text: '🏷️ Kategoriler', onclick: () => openCategories(cats.items, draw) }) : null,
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
        { label: 'Tip', render: (r) => PRODUCT_TYPE_BADGE[r.product_type]?.() ?? el('span.muted', { text: 'Satın alınan' }) },
        { label: 'Kampüs Fiyatı', render: (r) => (r.campus_sale_price !== null && r.campus_sale_price !== undefined ? badge('Özel', 'info') : el('span.muted', { text: '—' })) },
        {
          label: 'Yaklaşan Fiyat',
          render: (r) => (r.next_price_date
            ? badge(fmt.date(r.next_price_date), 'warn')
            : el('span.muted', { text: '—' })),
        },
        { label: 'Durum', render: (r) => (r.is_active ? badge('Aktif', 'ok') : badge('Pasif')) },
        {
          label: '', render: (r) => (canWrite("products") ? el('div.btn-row', {}, [
            el('button.btn.btn-sm', { text: 'Düzenle', onclick: () => openProductForm(cats.items, r, draw) }),
            el('button.btn.btn-sm', { text: 'Kampüs Fiyatı', onclick: () => openCampusPrice(r, draw) }),
            el('button.btn.btn-sm', { text: '🗓️ Fiyat Takvimi', onclick: () => openPriceCalendar(r, draw) }),
            r.product_type === 'URETILEN' ? el('button.btn.btn-sm', {
              text: '📋 Reçete',
              onclick: async () => {
                const { openEditor } = await import('./recipes.js');
                openEditor(r.id, draw);
              },
            }) : null,
          ]) : '—'),
        },
      ], data.items, {
        rowClass: (r) => (r.profit.unitProfit < 0 ? 'is-critical' : r.profit.marginPct < 15 ? 'is-warn' : ''),
        emptyText: 'Ürün bulunamadı.',
      }),
    ], { tight: true, note: 'Kâr marjı = birim kâr / KDV hariç satış fiyatı. Maliyet üzeri kâr = birim kâr / alış fiyatı.' }));
  }
}

const PRODUCT_TYPE_BADGE = {
  SATIN_ALINAN: () => el('span.muted', { text: 'Satın alınan' }),
  HAMMADDE: () => badge('Hammadde', 'info'),
  URETILEN: () => badge('Üretilen', 'warn'),
};

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
      { name: 'productType', label: 'Ürün tipi', type: 'select', value: product?.product_type ?? 'SATIN_ALINAN',
        options: [
          { value: 'SATIN_ALINAN', label: 'Satın alınan — raftan sayılır, doğrudan satılır' },
          { value: 'HAMMADDE', label: 'Hammadde — sayılır ama satılmaz (ekmek, kaşar, çay)' },
          { value: 'URETILEN', label: 'Üretilen — kantinde hazırlanır (tost, çay, poğaça)' },
        ],
        hint: 'Hammadde sayıma girer ama satılmaz; tüketimi reçeteden hesaplanır. '
          + 'Üretilen ürünler stoktan ve sayımdan çıkarılır; dönem satış adedi sayım ekranında beyan edilir.' },
      // ALIŞ FİYATI BURADA GİRİLMEZ (4. ve 7. madde): faturadan veya açılış
      // stoğu girişinden gelir. Elle tutulan bir alış fiyatı, faturayla
      // güncellenen gerçek maliyetin yanında sessizce eskiyordu.
      {
        name: '__alisBilgi', type: 'info',
        label: 'Alış fiyatı',
        value: alisFiyatiAciklamasi(product),
      },
      { name: 'salePrice', label: 'Satış fiyatı (KDV dahil)', type: 'number', step: '0.01', min: '0',
        value: product?.effective_sale_price ?? product?.sale_price ?? '', required: true,
        hint: 'Öğrenciden tahsil edilen raf fiyatı.' },
      // Fiyatlar TARİHTEN İTİBAREN geçerlidir (9. madde): ileri tarih
      // verirseniz bugünkü fiyat değişmez, günü gelince kendiliğinden geçer.
      { name: 'effectiveDate', label: 'Satış fiyatı geçerlilik tarihi', type: 'date', value: dateUtil.today(),
        hint: 'İleri tarih verirseniz fiyat o gün yürürlüğe girer; bugünkü satışlar '
          + 'eski fiyattan devam eder. Geçmiş tarih, o günden sonraki raporları etkiler.' },
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

/**
 * FİYAT TAKVİMİ — bir ürünün tarih bazlı satış fiyatları (9. madde).
 *
 * Satış fiyatı bir tarihten itibaren geçerlidir. Burada geçmişte hangi
 * fiyatın uygulandığı görülür, ileri tarihli fiyat tanımlanır ve henüz
 * yürürlüğe girmemiş bir fiyat iptal edilebilir. Yürürlüğe girmiş fiyat
 * silinemez: o dönemin kârlılığını açıklayan kayıttır.
 */
async function openPriceCalendar(product, onDone) {
  const govde = el('div');
  const hata = el('div.alert.alert-danger', { hidden: true });

  const fiyat = el('input.num', { type: 'number', step: '0.01', min: '0', placeholder: '0,00' });
  const tarih = el('input', { type: 'date', value: dateUtil.today() });
  const kapsam = el('select', {}, [
    el('option', { value: '' }, ['Tüm kampüsler (katalog)']),
    ...state.campuses.map((c) => el('option', { value: c.id, selected: c.id === state.campusId },
      [`Yalnızca ${shortName(c.name)}`])),
  ]);
  const aciklama = el('input', { placeholder: 'Örn: tedarikçi zammı, tarife değişikliği' });
  const ekleBtn = el('button.btn.btn-primary', { text: 'Fiyatı Tanımla' });

  async function yenile() {
    const data = await api.get(`/api/products/${product.id}/prices`);
    govde.replaceChildren(table([
      { label: 'Geçerlilik', render: (r) => el('div', {}, [
        el('strong', { text: fmt.date(r.effective_from) }),
        r.is_future ? badge('Yürürlüğe girmedi', 'warn') : null,
      ]) },
      { label: 'Kapsam', value: (r) => (r.campus_name ? shortName(r.campus_name) : 'Tüm kampüsler') },
      { label: 'Satış (KDV dahil)', num: true, render: (r) => el('strong', { text: fmt.money(r.sale_price) }) },
      { label: 'Açıklama', value: (r) => r.note || '—', wrap: true },
      { label: 'Giren', value: (r) => r.created_by_name || '—' },
      {
        label: '',
        render: (r) => (r.is_future && canWrite('products')
          ? el('button.btn.btn-sm.btn-danger', {
            text: 'İptal',
            onclick: async () => {
              try {
                await api.del(`/api/products/${product.id}/prices/${r.id}`);
                toast('İleri tarihli fiyat iptal edildi.');
                await yenile();
                onDone?.();
              } catch (err) { toast(err.message, 'error'); }
            },
          })
          : el('span.muted', { text: '—', title: 'Yürürlüğe girmiş fiyat silinemez' })),
      },
    ], data.items, { emptyText: 'Henüz fiyat tanımı yok.' }));
  }

  const m = modal({
    title: `🗓️ Fiyat Takvimi — ${product.name}`,
    wide: true,
    body: [
      hata,
      alertBox('info', 'Satış fiyatı tarihten itibaren geçerlidir',
        'İleri tarihli fiyat girerseniz bugünkü satışlar eski fiyattan devam eder, '
        + 'belirttiğiniz gün kendiliğinden yürürlüğe girer. Geçmişe dönük raporlar da '
        + 'o dönemde geçerli olan fiyatı kullanır.'),
      canWrite('products') ? el('div.grid.grid-4', { style: 'align-items:end' }, [
        el('label.field', {}, [el('span', { text: 'Satış fiyatı (KDV dahil)' }), fiyat]),
        el('label.field', {}, [el('span', { text: 'Geçerlilik tarihi' }), tarih]),
        el('label.field', {}, [el('span', { text: 'Kapsam' }), kapsam]),
        el('div', {}, [ekleBtn]),
      ]) : null,
      canWrite('products') ? el('label.field', {}, [el('span', { text: 'Açıklama' }), aciklama]) : null,
      govde,
    ],
    actions: [el('button.btn', { text: 'Kapat', onclick: () => m.close() })],
  });

  ekleBtn.addEventListener('click', async () => {
    hata.hidden = true;
    const deger = Number(fiyat.value);
    if (!(deger > 0)) {
      hata.textContent = 'Satış fiyatı girin.';
      hata.hidden = false;
      return;
    }
    ekleBtn.disabled = true;
    try {
      await api.post(`/api/products/${product.id}/prices`, {
        salePrice: deger,
        effectiveFrom: tarih.value || dateUtil.today(),
        campusId: kapsam.value ? Number(kapsam.value) : null,
        note: aciklama.value.trim() || null,
      });
      fiyat.value = '';
      aciklama.value = '';
      toast(tarih.value > dateUtil.today()
        ? `Fiyat ${fmt.date(tarih.value)} tarihinde yürürlüğe girecek.`
        : 'Fiyat tanımlandı.');
      await yenile();
      onDone?.();
    } catch (err) {
      hata.textContent = err.message;
      hata.hidden = false;
    } finally {
      ekleBtn.disabled = false;
    }
  });

  await yenile();
}

/** Ürün kartında alış fiyatının nereden geldiğini anlatan satır. */
function alisFiyatiAciklamasi(product) {
  if (!product) {
    return 'Alış fiyatı ürün kartında tutulmaz; ilk mal girişiyle (fatura veya '
      + 'açılış stoğu) kendiliğinden oluşur.';
  }
  const fiyat = product.effective_purchase_price ?? product.purchase_price ?? 0;
  if (product.purchase_price_source === 'ALIM' && product.last_purchase_date) {
    return `${fmt.money(fiyat)} — ${fmt.date(product.last_purchase_date)} tarihli mal girişinden `
      + '(iskonto düşülmüş gerçek maliyet). Değiştirmek için yeni bir alım belgesi girin.';
  }
  if (fiyat > 0) {
    return `${fmt.money(fiyat)} — başlangıç değeri. Bu ürün için henüz mal girişi yapılmadı; `
      + 'ilk fatura girildiğinde gerçek maliyetle değişecek.';
  }
  return 'Henüz mal girişi yapılmadı, alış fiyatı oluşmadı. Kâr hesabı ilk faturadan sonra anlam kazanır.';
}

function openCampusPrice(product, onDone) {
  const campusName = state.campuses.find((c) => c.id === state.campusId)?.name ?? '';
  formModal({
    title: `Kampüs Fiyatı — ${product.name}`,
    fields: [
      // Kampüs alış fiyatı da elle girilmez: o kampüse en son hangi fiyatla
      // mal girdiyse maliyet odur. Aynı ürün Esenyurt'a başka, Çorlu'ya
      // başka fiyata gelebilir ve stok değeri buna göre oluşur.
      {
        name: '__alisBilgi', type: 'info', label: `Alış fiyatı (${shortName(campusName)})`,
        value: alisFiyatiAciklamasi(product),
      },
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
      canWrite("products") ? el('button.btn.btn-sm', {
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
      canWrite("products") ? el('button.btn.btn-primary', {
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

/* ============================ Tedarikçiler ==========================
 *
 * Tedarikçi KARTI tüm kampüslerde ortaktır: tek firma, tek VKN, tek adres.
 * Her kampüs için ayrı "Anadolu Gıda" kartı açmak e-Fatura eşleştirmesini
 * ve öğrenilmiş ürün eşleştirmelerini böler.
 *
 * Tedarikçi HESABI ortak değildir: mal hangi kampüse girdiyse borç o
 * kampüsündür, ödemeyi de o kampüs yapar. Bu yüzden listede görünen bakiye
 * her zaman ÜSTTEKİ KAMPÜS SEÇİCİDE seçili kampüsün bakiyesidir.
 * ------------------------------------------------------------------- */
export async function renderSuppliers(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const data = await api.get('/api/suppliers', { campusId: state.campusId });
    const kampusli = !!data.scope?.campusId;
    container.replaceChildren();

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('h3', { text: 'Tedarikçiler' }),
      el('div.btn-row', {}, [
        el('button.btn', { text: '🔗 Ürün Eşleştirmeleri', onclick: () => openAliases(null, draw) }),
        canWrite('suppliers') ? el('button.btn.btn-primary', { text: '+ Yeni Tedarikçi', onclick: () => openSupplierForm(null, draw) }) : null,
      ]),
    ]));

    const borclular = data.items.filter((r) => (r.campus_debt || 0) > 0.005);
    const toplamBorc = borclular.reduce((t, r) => t + r.campus_debt, 0);
    if (kampusli) {
      container.append(card(null, [
        el('div.grid.grid-3', {}, [
          stat('Kampüs', shortName(data.scope.campusName), { sub: 'Bakiyeler bu kampüse aittir' }),
          stat('Borçlu Olunan Firma', String(borclular.length), { sub: `${data.items.length} tedarikçiden` }),
          stat('Toplam Borç', fmt.money(toplamBorc), { tone: toplamBorc > 0 ? 'warn' : 'ok' }),
        ]),
        el('p.card-note', {
          text: 'Tedarikçi kartı tüm kampüslerde ortaktır; cari hesabı değildir. '
            + 'Mal hangi kampüse girdiyse borç o kampüsündür, ödemeyi de o kampüs yapar. '
            + 'Başka bir kampüsün bakiyesi için yukarıdaki kampüs seçiciyi değiştirin.',
        }),
      ], { tight: true }));
    }

    container.append(card(null, [
      table([
        { label: 'Tedarikçi', value: (r) => r.name, wrap: true },
        { label: 'Vergi No', value: (r) => r.tax_no || '—' },
        { label: 'Telefon', value: (r) => r.phone || '—' },
        ...(kampusli ? [
          {
            label: `${shortName(data.scope.campusName)} Alım`, num: true,
            value: (r) => (r.campus_purchase ? fmt.money(r.campus_purchase) : '—'),
          },
          {
            label: `${shortName(data.scope.campusName)} Bakiye`, num: true,
            render: (r) => (Math.abs(r.campus_debt || 0) < 0.005
              ? el('span.muted', { text: '—' })
              : badge(fmt.money(r.campus_debt), r.campus_debt > 0 ? 'warn' : 'ok')),
          },
        ] : []),
        { label: 'Durum', render: (r) => (r.is_active ? badge('Aktif', 'ok') : badge('Pasif')) },
        {
          label: '', render: (r) => el('div.btn-row', {}, [
            el('button.btn.btn-sm', { text: 'Cari Hesap', onclick: () => showSupplier(r.id, draw) }),
            el('button.btn.btn-sm', { text: '🔗 Eşleştirmeler', onclick: () => openAliases(r, draw) }),
            canWrite('suppliers') ? el('button.btn.btn-sm', { text: 'Düzenle', onclick: () => openSupplierForm(r, draw) }) : null,
          ]),
        },
      ], data.items, { emptyText: 'Tedarikçi kaydı yok.' }),
    ], { tight: true }));
  }
}

/**
 * TEDARİKÇİ ÜRÜN EŞLEŞTİRMELERİ
 *
 * Aynı ürün her faturada aynı adla gelmez: bir tedarikçi "AYRAN 200 ML",
 * öteki "KUTU AYRAN" yazar. Bir kez eşleştirilen ad burada saklanır ve
 * sonraki faturalarda kendiliğinden bulunur.
 *
 * Bu ekran o listeyi gösterir: yanlış bir eşleştirmeyi düzeltmek, koli/paket
 * çarpanını ayarlamak ve artık kullanılmayan kaydı silmek için.
 */
async function openAliases(supplier, onDone) {
  const govde = el('div');
  const arama = el('input', { type: 'search', placeholder: 'Faturadaki ad, kod veya ürün ara…' });
  const products = await api.get('/api/products');

  async function yenile() {
    const data = await api.get('/api/products/aliases', {
      supplierId: supplier?.id ?? undefined,
      search: arama.value.trim() || undefined,
    });

    govde.replaceChildren(table([
      {
        label: 'Faturada geçen ad', wrap: true,
        render: (r) => el('div', {}, [
          el('strong', { text: r.source_name || '—' }),
          r.source_code ? el('small.muted', { text: r.source_code, style: 'display:block' }) : null,
        ]),
      },
      { label: 'Tedarikçi', value: (r) => (r.supplier_name ? shortName(r.supplier_name) : 'Tüm tedarikçiler') },
      {
        label: 'Bizdeki ürün', wrap: true,
        render: (r) => el('div', {}, [
          el('strong', { text: r.product_name }),
          r.product_barcode ? el('small.muted', { text: r.product_barcode, style: 'display:block' }) : null,
        ]),
      },
      {
        label: 'Çevrim', num: true,
        render: (r) => (Number(r.factor) === 1
          ? el('span.muted', { text: '1 : 1' })
          : badge(`1 fatura = ${fmt.num(r.factor)} ${r.product_unit || 'birim'}`, 'warn')),
      },
      {
        // Kac faturada kullanildi + en son ne zaman. Tek sutunda: islem
        // dugmeleri ekranin disinda kalmasin.
        label: 'Kullanım', num: true,
        render: (r) => el('div', {}, [
          el('strong', { text: fmt.int(r.use_count) }),
          r.last_used_at
            ? el('small.muted', { text: fmt.date(r.last_used_at.slice(0, 10)), style: 'display:block' })
            : null,
        ]),
      },
      {
        label: '',
        render: (r) => (canWrite('products')
          ? el('div.btn-row', {}, [
            el('button.btn.btn-sm', { text: 'Düzelt', onclick: () => duzelt(r) }),
            el('button.btn.btn-sm.btn-danger', {
              text: 'Sil',
              onclick: async () => {
                const onay = await confirmDialog(
                  `"${r.source_name || r.source_code}" → ${r.product_name} eşleştirmesi silinecek. `
                  + 'Geçmiş belgeler etkilenmez; yalnızca bundan sonraki faturalarda bu kalem '
                  + 'yeniden elle eşleştirilir.',
                  { title: 'Eşleştirmeyi Sil', confirmText: 'Sil', danger: true }
                );
                if (!onay) return;
                try {
                  await api.del(`/api/products/aliases/${r.id}`);
                  toast('Eşleştirme silindi.');
                  await yenile();
                } catch (err) { toast(err.message, 'error'); }
              },
            }),
          ])
          : el('span.muted', { text: '—' })),
      },
    ], data.items, {
      emptyText: supplier
        ? 'Bu tedarikçi için henüz eşleştirme öğrenilmedi. İlk faturayı girdiğinizde oluşacak.'
        : 'Henüz eşleştirme yok. Fatura girdikçe kendiliğinden oluşur.',
    }));
  }

  /** Yanlış eşleşen kalemi doğru ürüne bağlar ya da çarpanı düzeltir. */
  function duzelt(row) {
    const picker = createProductPicker({
      products: products.items,
      value: row.product_id,
      placeholder: 'Ürün arayın…',
    });
    const carpan = el('input.num', { type: 'number', step: '0.01', min: '0.01', value: String(row.factor) });
    const hata = el('div.alert.alert-danger', { hidden: true });
    const kaydet = el('button.btn.btn-primary', { text: 'Kaydet' });

    const m2 = modal({
      title: 'Eşleştirmeyi Düzelt',
      body: [
        hata,
        el('dl.kv', {}, [
          el('dt', { text: 'Faturada geçen ad' }), el('dd', { text: row.source_name || row.source_code }),
          el('dt', { text: 'Tedarikçi' }), el('dd', { text: row.supplier_name || 'Tüm tedarikçiler' }),
        ]),
        el('label.field', {}, [el('span', { text: 'Bizdeki ürün' }), picker.node]),
        el('label.field', {}, [
          el('span', { text: 'Çevrim çarpanı' }),
          carpan,
          el('small', {
            text: '1 fatura birimi kaç stok birimine karşılık geliyor? Tedarikçi koli '
              + 'satıyor ve 1 koli 24 adetse 24 yazın. Miktar çarpılır, birim fiyat '
              + 'bölünür; belge tutarı değişmez. Aynı birimse 1 bırakın.',
          }),
        ]),
      ],
      actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m2.close() }), kaydet],
    });

    kaydet.addEventListener('click', async () => {
      hata.hidden = true;
      if (!picker.getValue()) {
        hata.textContent = 'Bir ürün seçin.';
        hata.hidden = false;
        return;
      }
      kaydet.disabled = true;
      try {
        await api.put(`/api/products/aliases/${row.id}`, {
          productId: picker.getValue(),
          factor: Number(carpan.value) || 1,
        });
        m2.close();
        toast('Eşleştirme güncellendi.');
        await yenile();
      } catch (err) {
        hata.textContent = err.message;
        hata.hidden = false;
        kaydet.disabled = false;
      }
    });
  }

  arama.addEventListener('input', () => { clearTimeout(arama.__t); arama.__t = setTimeout(yenile, 300); });

  const m = modal({
    title: supplier ? `🔗 Ürün Eşleştirmeleri — ${supplier.name}` : '🔗 Tedarikçi Ürün Eşleştirmeleri',
    wide: true,
    body: [
      alertBox('info', 'Eşleştirme bir kez yapılır',
        'Aynı ürün her faturada aynı adla gelmez — bir tedarikçi "AYRAN 200 ML", '
        + 'öteki "KUTU AYRAN" yazabilir. Fatura girerken doğru ürünü bir kez '
        + 'seçtiğinizde sistem bunu öğrenir; o tedarikçinin sonraki faturalarında '
        + 'aynı kalem kendiliğinden bulunur. Burası öğrenilenlerin listesidir.'),
      el('label.field', {}, [el('span', { text: 'Ara' }), arama]),
      govde,
    ],
    actions: [el('button.btn', { text: 'Kapat', onclick: () => { m.close(); onDone?.(); } })],
  });

  await yenile();
}

/**
 * CARİ HESAP — KAMPÜS BAZLI
 *
 * Üstte seçili kampüsün hesabı, altında tüm kampüslerin dökümü vardır.
 * Tek bir toplam rakam yanıltıcıdır: aynı firmaya Esenyurt borçluyken
 * Çorlu fazla ödeme yapmış olabilir ve toplam "borç yok" der.
 */
async function showSupplier(id, onDone) {
  const data = await api.get(`/api/suppliers/${id}`, { campusId: state.campusId });
  const kapsam = data.scope || { campusId: null, campusName: 'Tüm kampüsler' };
  const cokKampus = (data.campusBalances || []).length > 1;

  modal({
    title: `${data.name} — Cari Hesap (${shortName(kapsam.campusName)})`,
    wide: true,
    body: [
      el('div.grid.grid-4', {}, [
        stat('Toplam Alım', fmt.money(data.balance.totalPurchase)),
        stat('İade', fmt.money(data.balance.totalReturn), {
          sub: data.balance.totalReturn > 0 ? `Net alım ${fmt.money(data.balance.netPurchase)}` : 'İade yok',
          tone: data.balance.totalReturn > 0 ? 'warn' : '',
        }),
        stat('Toplam Ödeme', fmt.money(data.balance.totalPaid)),
        stat('Bakiye (Borç)', fmt.money(data.balance.debt), { tone: data.balance.debt > 0 ? 'warn' : 'ok' }),
      ]),
      el('p.card-note', {
        text: kapsam.campusId
          ? `Bakiye = Alım − İade − Ödeme. Bu rakamlar yalnızca ${shortName(kapsam.campusName)} `
            + 'kampüsüne aittir; her kampüsün bu firmayla ayrı hesabı vardır.'
          : 'Bakiye = Alım − İade − Ödeme. Bu rakam TÜM kampüslerin toplamıdır; '
            + 'ödeme yaparken hangi kampüs adına olduğunu seçmeniz gerekir.',
      }),

      /* --- Kampüs kampüs döküm --- */
      ...(cokKampus ? [
        el('h4', { text: 'Kampüs Hesapları', style: 'font-size:13px;color:var(--text-muted)' }),
        table([
          { label: 'Kampüs', value: (r) => shortName(r.campusName) },
          { label: 'Alım', num: true, value: (r) => fmt.money(r.totalPurchase) },
          { label: 'İade', num: true, value: (r) => (r.totalReturn ? fmt.money(r.totalReturn) : '—') },
          { label: 'Ödeme', num: true, value: (r) => fmt.money(r.totalPaid) },
          {
            label: 'Bakiye', num: true,
            render: (r) => (Math.abs(r.debt) < 0.005
              ? el('span.muted', { text: '—' })
              : badge(fmt.money(r.debt), r.debt > 0 ? 'warn' : 'ok')),
          },
          { label: 'Son Alım', value: (r) => (r.lastPurchaseDate ? fmt.date(r.lastPurchaseDate) : '—') },
        ], data.campusBalances, {
          emptyText: 'Bu firmayla hiçbir kampüsün hesabı yok.',
          rowClass: (r) => (r.campusId === kapsam.campusId ? 'row-active' : ''),
        }),
      ] : []),

      /* --- Kampüsü atanmamış eski ödemeler --- */
      ...(data.unassignedPayments?.length ? [
        alertBox('warning', 'Kampüsü atanmamış ödeme var',
          `${data.unassignedPayments.length} ödeme hiçbir kampüsün bakiyesine girmiyor. `
          + 'Aşağıdan hangi kampüs adına yapıldığını seçin.'),
        table([
          { label: 'Tarih', value: (r) => fmt.date(r.payment_date) },
          { label: 'Tutar', num: true, value: (r) => fmt.money(r.amount) },
          { label: 'Şekil', value: (r) => r.method },
          {
            label: '', render: (r) => (canWrite('suppliers') ? el('button.btn.btn-sm', {
              text: 'Kampüse Ata',
              onclick: () => atamaPenceresi(id, r, onDone),
            }) : null),
          },
        ], data.unassignedPayments),
      ] : []),

      canWrite('suppliers') ? el('button.btn.btn-primary', {
        text: '+ Ödeme Kaydet',
        onclick: () => odemePenceresi(id, data, kapsam, onDone),
      }) : null,

      el('h4', { text: 'Hesap Ekstresi', style: 'font-size:13px;color:var(--text-muted)' }),
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.date) },
        {
          label: 'İşlem', render: (r) => badge(
            { ALIM: 'Alım', IADE: 'İade', ODEME: 'Ödeme' }[r.kind] || r.kind,
            r.kind === 'ALIM' ? 'warn' : 'ok'
          ),
        },
        { label: 'Belge / Şekil', value: (r) => r.ref || '—', wrap: true },
        ...(kapsam.campusId ? [] : [{ label: 'Kampüs', value: (r) => shortName(campusName(r.campusId)) }]),
        { label: 'Borç', num: true, value: (r) => (r.debit ? fmt.money(r.debit) : '—') },
        { label: 'Alacak', num: true, value: (r) => (r.credit ? fmt.money(r.credit) : '—') },
        { label: 'Bakiye', num: true, value: (r) => fmt.money(r.balance) },
      ], data.ledger || [], { emptyText: 'Bu kampüste bu firmayla hareket yok.' }),

      el('h4', { text: 'Alım Belgeleri', style: 'font-size:13px;color:var(--text-muted)' }),
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.document_date) },
        { label: 'Belge No', value: (r) => r.document_no || '—' },
        { label: 'Kampüs', value: (r) => shortName(r.campus_name) },
        { label: 'Tutar', num: true, value: (r) => fmt.money(r.gross_total) },
      ], data.purchases, { emptyText: 'Alım kaydı yok.' }),
      ...(data.returns?.length ? [
        el('h4', { text: 'İadeler', style: 'font-size:13px;color:var(--text-muted)' }),
        table([
          { label: 'Tarih', value: (r) => fmt.date(r.return_date) },
          { label: 'Belge No', value: (r) => r.document_no || '—' },
          { label: 'Kampüs', value: (r) => shortName(r.campus_name) },
          { label: 'Neden', value: (r) => r.reason },
          { label: 'Tutar', num: true, value: (r) => fmt.money(r.gross_total) },
        ], data.returns),
      ] : []),
      el('h4', { text: 'Ödemeler', style: 'font-size:13px;color:var(--text-muted)' }),
      table([
        { label: 'Tarih', value: (r) => fmt.date(r.payment_date) },
        { label: 'Kampüs', value: (r) => (r.campus_name ? shortName(r.campus_name) : '⚠ atanmamış') },
        { label: 'Tutar', num: true, value: (r) => fmt.money(r.amount) },
        { label: 'Şekil', value: (r) => r.method },
        { label: 'Not', value: (r) => r.note || '—', wrap: true },
      ], data.payments, { emptyText: 'Ödeme kaydı yok.' }),
    ],
  });
}

/**
 * Ödeme kaydı.
 *
 * Kampüs seçimi ZORUNLUDUR ve ön tanımlı değer seçili kampüstür: ödeme
 * hangi kampüsün borcunu kapattığını söylemezse beş kampüsün bakiyesi
 * birbirine karışır.
 */
function odemePenceresi(id, data, kapsam, onDone) {
  // Kampus listesi hesap dokumunden gelir (borclar da yazar). Firmayla hic
  // hareketi olmayan bir kurulumda dokum bos kalabilir; o zaman kullanicinin
  // gorebildigi kampuslere duseriz, yoksa form secenegi olmayan bir acilir
  // listeyle kilitlenirdi.
  const secenekler = ((data.campusBalances || []).length
    ? data.campusBalances.map((r) => ({
      value: String(r.campusId),
      label: `${shortName(r.campusName)}${r.debt > 0.005 ? ` — borç ${fmt.money(r.debt)}` : ''}`,
    }))
    : state.campuses.map((c) => ({ value: String(c.id), label: shortName(c.name) })));
  formModal({
    title: `${data.name} — Ödeme`,
    fields: [
      {
        name: 'campusId', label: 'Hangi kampüs adına?', type: 'select', required: true,
        value: String(kapsam.campusId || state.campusId || secenekler[0]?.value || ''),
        options: secenekler,
        hint: 'Ödeme yalnızca seçilen kampüsün borcunu kapatır.',
      },
      { name: 'amount', label: 'Tutar (TL)', type: 'number', step: '0.01', min: '0.01', required: true },
      { name: 'paymentDate', label: 'Tarih', type: 'date', value: new Date().toISOString().slice(0, 10), required: true },
      { name: 'method', label: 'Ödeme şekli', type: 'select', options: ['NAKIT', 'HAVALE', 'CEK', 'KART'].map((m) => ({ value: m, label: m })) },
      { name: 'note', label: 'Açıklama' },
    ],
    onSubmit: async (v) => {
      await api.post(`/api/suppliers/${id}/payments`, { ...v, campusId: Number(v.campusId) });
      toast('Ödeme kaydedildi.');
      document.querySelector('.modal-backdrop')?.remove();
      onDone();
    },
  });
}

/** Kampüsü belirsiz kalmış eski bir ödemeyi bir kampüse bağlar. */
function atamaPenceresi(supplierId, odeme, onDone) {
  formModal({
    title: `${fmt.money(odeme.amount)} — Kampüse Ata`,
    fields: [{
      name: 'campusId', label: 'Bu ödeme hangi kampüs adına yapıldı?', type: 'select', required: true,
      value: String(state.campusId || ''),
      options: state.campuses.map((c) => ({ value: String(c.id), label: shortName(c.name) })),
    }],
    submitText: 'Ata',
    onSubmit: async (v) => {
      await api.put(`/api/suppliers/${supplierId}/payments/${odeme.id}/campus`, { campusId: Number(v.campusId) });
      toast('Ödeme kampüse bağlandı.');
      document.querySelector('.modal-backdrop')?.remove();
      onDone();
    },
  });
}

function openSupplierForm(supplier, onDone) {
  formModal({
    title: supplier ? 'Tedarikçi Düzenle' : 'Yeni Tedarikçi',
    fields: [
      { name: 'name', label: 'Firma adı', value: supplier?.name ?? '', required: true },
      // VKN zorunlu: e-Fatura eşleştirmesi ve mükerrer firma engeli buna dayanır
      {
        name: 'taxNo', label: 'Vergi / TC no', value: supplier?.tax_no ?? '', required: true,
        hint: 'Zorunlu — 10 hane VKN veya 11 hane TCKN. Faturalar bu numarayla '
          + 'eşleşir; aynı numara ikinci bir firmaya verilemez.',
      },
      { name: 'taxOffice', label: 'Vergi dairesi', value: supplier?.tax_office ?? '' },
      { name: 'phone', label: 'Telefon', value: supplier?.phone ?? '' },
      { name: 'email', label: 'E-posta', type: 'email', value: supplier?.email ?? '' },
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
