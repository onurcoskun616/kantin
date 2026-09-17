/**
 * Demo veri üretici.
 *
 * Veriler rastgele değil, tutarlı üretilir: satış miktarları önce belirlenir,
 * stok ve ciro bunlardan türetilir. Böylece sayım mutabakatı gerçek bir hikâye
 * anlatır — bir kampüste ciro açığı, bir kampüste eksik mal girişi görünür.
 *
 * Tohumlu rastgelelik kullanıldığı için herkes aynı demo verisini görür.
 */

/** Deterministik sözde-rastgele sayı üreteci (mulberry32). */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const iso = (d) => d.toISOString().slice(0, 10);
const dayOffset = (days) => {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
const isWeekday = (dateStr) => {
  const wd = new Date(`${dateStr}T00:00:00Z`).getUTCDay();
  return wd !== 0 && wd !== 6;
};
function eachDay(fromStr, toStr) {
  const out = [];
  let cursor = new Date(`${fromStr}T00:00:00Z`);
  const end = new Date(`${toStr}T00:00:00Z`);
  while (cursor <= end) {
    out.push(iso(cursor));
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return out;
}
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

/* ------------------------------ Sabitler --------------------------- */
const CAMPUSES = [
  { code: 'IKT', name: 'Topkapı Okulları - İkitelli OSB Kampüsü', student_count: 640, rent_share_pct: 0, ratios: [1.001, 0.998] },
  { code: 'IST', name: 'Topkapı Okulları - İstanbul OSB Kampüsü', student_count: 520, rent_share_pct: 0, ratios: [0.996, 1.004] },
  { code: 'ESN', name: 'Topkapı Okulları - Esenyurt Kampüsü', student_count: 780, rent_share_pct: 8, ratios: [0.972, 0.958] },
  { code: 'KRC', name: 'Topkapı Okulları - Kıraç Kampüsü', student_count: 430, rent_share_pct: 0, ratios: [1.021, 1.016] },
  { code: 'CRL', name: 'Topkapı Okulları - Çorlu Kampüsü', student_count: 360, rent_share_pct: 0, ratios: [0.999, 1.002] },
];

const CATEGORIES = [
  'Su ve İçecek', 'Süt ve Süt Ürünleri', 'Sandviç ve Unlu Mamul', 'Kuruyemiş ve Kuru Meyve',
  'Bisküvi ve Kek', 'Taze Meyve', 'Sıcak İçecek', 'Dondurma', 'Kırtasiye',
];

// [barkod, ad, kategori, alış(KDV hariç), satış(KDV dahil), KDV%, kritik stok,
//  günlük satış hızı (100 öğrenci başına adet), ürün tipi]
// URETILEN ürünler kantinde hazırlanır: raftan sayılamaz, stok tutulmaz;
// dönem satış adedi sayım ekranında ayrıca beyan edilir.
const PRODUCTS = [
  ['8690000000011', 'Su 500 ml',              'Su ve İçecek',            4.00,  6.00, 10, 60, 14.0],
  ['8690000000042', 'Meyve Suyu 200 ml',      'Su ve İçecek',           10.00, 16.00, 10, 40,  6.5],
  ['8690000000219', 'Soda 200 ml',            'Su ve İçecek',            7.50, 12.00, 10, 30,  2.4],
  ['8690000000028', 'Ayran 200 ml',           'Süt ve Süt Ürünleri',     8.50, 13.00,  1, 48,  8.2],
  ['8690000000035', 'Süt 200 ml',             'Süt ve Süt Ürünleri',     9.00, 14.00,  1, 40,  4.1],
  ['8690000000226', 'Kefir 200 ml',           'Süt ve Süt Ürünleri',    11.00, 17.00,  1, 24,  1.3],
  ['8690000000059', 'Tost',                   'Sandviç ve Unlu Mamul',  18.00, 35.00, 10,  0,  7.8, 'URETILEN'],
  ['8690000000066', 'Poğaça',                 'Sandviç ve Unlu Mamul',   9.00, 16.00,  1, 30,  9.4],
  ['8690000000073', 'Simit',                  'Sandviç ve Unlu Mamul',   7.00, 12.00,  1, 40, 10.6],
  ['8690000000080', 'Sandviç (Ton Balıklı)',  'Sandviç ve Unlu Mamul',  26.00, 45.00, 10, 12,  3.2],
  ['8690000000233', 'Açma',                   'Sandviç ve Unlu Mamul',   8.00, 14.00,  1, 30,  5.1],
  ['8690000000097', 'Kek (Kakaolu)',          'Bisküvi ve Kek',          7.50, 13.00, 10, 36,  5.6],
  ['8690000000103', 'Bisküvi',                'Bisküvi ve Kek',          6.00, 11.00, 10, 48,  6.8],
  ['8690000000240', 'Kraker',                 'Bisküvi ve Kek',          5.50, 10.00, 10, 36,  4.3],
  ['8690000000110', 'Fındık 30 g',            'Kuruyemiş ve Kuru Meyve',14.00, 24.00,  1, 20,  1.8],
  ['8690000000127', 'Kuru Üzüm 40 g',         'Kuruyemiş ve Kuru Meyve', 9.00, 16.00,  1, 20,  1.4],
  ['8690000000134', 'Elma (adet)',            'Taze Meyve',              6.00, 10.00,  1, 24,  2.6],
  ['8690000000141', 'Muz (adet)',             'Taze Meyve',              9.00, 15.00,  1, 24,  3.1],
  ['8690000000158', 'Çay (bardak)',           'Sıcak İçecek',            2.50,  8.00, 10,  0,  5.4, 'URETILEN'],
  ['8690000000165', 'Salep (bardak)',         'Sıcak İçecek',            9.00, 20.00, 10,  0,  1.2, 'URETILEN'],
  ['8690000000257', 'Dondurma (külah)',       'Dondurma',               12.00, 22.00, 10, 20,  2.2],
  ['8690000000172', 'Kurşun Kalem',           'Kırtasiye',               4.00,  8.00, 20, 20,  0.9],
  ['8690000000189', 'Defter A4',              'Kırtasiye',              22.00, 40.00, 20, 10,  0.4],
];

const SUPPLIERS = [
  ['Anadolu Gıda Dağıtım A.Ş.', '0212 555 01 01', 'Bakırköy', '1234567890'],
  ['Marmara Süt ve Süt Ürünleri Ltd.', '0212 555 01 02', 'Avcılar', '2345678901'],
  ['Güneş Unlu Mamuller', '0212 555 01 03', 'Esenyurt', '3456789012'],
  ['Öz Kuruyemiş Toptan', '0282 555 01 04', 'Çorlu', '4567890123'],
];

const USERS = [
  ['mudur@topkapiokullari.com', 'Ayşe Demir', 'GENEL_MUDURLUK', null],
  ['ikitelli.yonetici@topkapiokullari.com', 'Mehmet Yılmaz', 'KAMPUS_YONETICISI', 'IKT'],
  ['ikitelli.kantin@topkapiokullari.com', 'Zeynep Kaya', 'KANTIN_GOREVLISI', 'IKT'],
  ['esenyurt.yonetici@topkapiokullari.com', 'Fatma Şahin', 'KAMPUS_YONETICISI', 'ESN'],
  ['esenyurt.kantin@topkapiokullari.com', 'Ali Çelik', 'KANTIN_GOREVLISI', 'ESN'],
  ['denetci@topkapiokullari.com', 'Hasan Aydın', 'DENETCI', null],
];

const WASTE_REASONS = ['SKT', 'KIRILMA', 'BOZULMA', 'IKRAM'];

// Sayıma katılan ikinci kişiler (iki imza kuralı)
const WITNESS_NAMES = ['Serpil Aydın', 'Murat Koç', 'Elif Yıldız'];

/* --------------------------- Veri üretimi -------------------------- */
export function buildDemoData() {
  const random = rng(20260916);
  const ids = {};
  const nextId = (key) => { ids[key] = (ids[key] || 0) + 1; return ids[key]; };

  const db = {
    campuses: [], categories: [], suppliers: [], products: [], campus_products: [],
    movements: [], purchases: [], purchase_lines: [], supplier_payments: [],
    supplier_returns: [], supplier_return_lines: [],
    waste: [], transfers: [], transfer_lines: [],
    counts: [], count_lines: [], production_sales: [],
    revenues: [], users: [], audit_logs: [], price_history: [],
  };

  /* Kampüsler */
  const campusByCode = {};
  for (const c of CAMPUSES) {
    const row = {
      id: nextId('campus'), code: c.code, name: c.name, address: null, phone: null,
      student_count: c.student_count, rent_share_pct: c.rent_share_pct, is_active: 1,
      created_at: `${iso(dayOffset(-90))} 08:00:00`,
    };
    db.campuses.push(row);
    campusByCode[c.code] = row;
  }

  /* Kategoriler */
  const categoryByName = {};
  CATEGORIES.forEach((name, i) => {
    const row = { id: nextId('category'), name, sort_order: i, is_active: 1 };
    db.categories.push(row);
    categoryByName[name] = row;
  });

  /* Tedarikçiler */
  SUPPLIERS.forEach(([name, phone, taxOffice, taxNo]) => {
    db.suppliers.push({
      id: nextId('supplier'), name, phone, tax_office: taxOffice, tax_no: taxNo,
      email: null, address: null, note: null, is_active: 1, created_at: `${iso(dayOffset(-90))} 08:00:00`,
    });
  });

  /* Ürünler */
  const rates = new Map();
  PRODUCTS.forEach(([barcode, name, category, purchase, sale, vat, critical, rate, type = 'SATIN_ALINAN']) => {
    const row = {
      id: nextId('product'), barcode, name, category_id: categoryByName[category].id,
      unit: 'ADET', product_type: type,
      purchase_price: purchase, sale_price: sale, vat_rate: vat,
      critical_stock: type === 'URETILEN' ? 0 : critical,
      meb_approved: 1, max_price: 0, track_expiry: 0, is_active: 1,
      created_at: `${iso(dayOffset(-90))} 08:00:00`, updated_at: `${iso(dayOffset(-90))} 08:00:00`,
    };
    db.products.push(row);
    rates.set(row.id, rate);
  });

  /* Kullanıcılar */
  db.users.push({
    id: nextId('user'), email: 'admin@topkapiokullari.com', full_name: 'Sistem Yöneticisi',
    role: 'ADMIN', campus_id: null, is_active: 1, last_login_at: `${iso(dayOffset(0))} 08:12:00`,
    created_at: `${iso(dayOffset(-90))} 08:00:00`,
  });
  USERS.forEach(([email, fullName, role, code]) => {
    db.users.push({
      id: nextId('user'), email, full_name: fullName, role,
      campus_id: code ? campusByCode[code].id : null, is_active: 1,
      last_login_at: `${iso(dayOffset(-1))} 16:30:00`, created_at: `${iso(dayOffset(-85))} 09:00:00`,
    });
  });
  const adminId = 1;

  /* ------------------ Dönemler ------------------ */
  // -75 açılış · -48 1. sayım · -20 2. sayım · bugüne kadar açık dönem
  const openingDate = iso(dayOffset(-75));
  const countDates = [iso(dayOffset(-48)), iso(dayOffset(-20))];
  const today = iso(dayOffset(0));

  const periods = [
    { from: iso(dayOffset(-75)), to: countDates[0] },
    { from: iso(dayOffset(-47)), to: countDates[1] },
    { from: iso(dayOffset(-19)), to: today },
  ];

  const addMovement = (m) => {
    db.movements.push({
      id: nextId('movement'), unit_cost: 0, ref_type: null, ref_id: null, note: null,
      created_by: adminId, created_at: `${m.movement_date} 09:00:00`, ...m,
    });
  };

  // Stoğu tutulan (sayılabilir) ürünler ile kantinde hazırlananlar ayrılır
  const stocked = db.products.filter((p) => p.product_type === 'SATIN_ALINAN');
  const produced = db.products.filter((p) => p.product_type === 'URETILEN');

  for (const campus of db.campuses) {
    const conf = CAMPUSES.find((c) => c.code === campus.code);
    const scale = campus.student_count / 100;
    const stock = new Map();

    /* Açılış stoğu */
    for (const p of stocked) {
      const weekly = rates.get(p.id) * scale * 5;
      const qty = Math.max(6, Math.round(weekly * 1.4 * (0.9 + random() * 0.2)));
      stock.set(p.id, qty);
      addMovement({
        campus_id: campus.id, product_id: p.id, movement_type: 'ACILIS', quantity: qty,
        unit_cost: p.purchase_price, movement_date: openingDate, ref_type: 'opening',
        note: 'Sisteme geçiş açılış stoğu',
      });
    }

    periods.forEach((period, periodIndex) => {
      const days = eachDay(period.from, period.to);
      const schoolDays = days.filter(isWeekday);

      /* Haftalık alımlar */
      const purchaseDays = schoolDays.filter((_, i) => i % 5 === 1);
      const plannedSales = new Map();
      for (const p of db.products) {
        const qty = Math.round(rates.get(p.id) * scale * schoolDays.length * (0.92 + random() * 0.16));
        plannedSales.set(p.id, qty);
      }
      // Kantinde hazırlanan ürünlerin dönem cirosu (sayımla doğrulanamayan kısım)
      const productionRevenue = produced.reduce((s2, p) => s2 + plannedSales.get(p.id) * p.sale_price, 0);

      purchaseDays.forEach((day, wIndex) => {
        const supplier = db.suppliers[wIndex % db.suppliers.length];
        const picked = stocked.filter((_, i) => (i + wIndex) % 2 === 0);
        if (!picked.length) return;

        const purchase = {
          id: nextId('purchase'), campus_id: campus.id, supplier_id: supplier.id,
          document_no: `${campus.code}-${day.replace(/-/g, '').slice(2)}`,
          document_date: day, net_total: 0, vat_total: 0, gross_total: 0,
          paid_amount: 0, due_date: null, status: 'ONAYLI', note: null,
          created_by: adminId, created_at: `${day} 10:00:00`,
        };
        let net = 0;
        let vat = 0;
        for (const p of picked) {
          const share = plannedSales.get(p.id) / Math.max(1, purchaseDays.length / 2);
          const qty = Math.max(6, Math.round(share * 1.08));
          const lineNet = round2(qty * p.purchase_price);
          const lineVat = round2(lineNet * (p.vat_rate / 100));
          net += lineNet; vat += lineVat;
          db.purchase_lines.push({
            id: nextId('purchase_line'), purchase_id: purchase.id, product_id: p.id,
            quantity: qty, unit_price: p.purchase_price, vat_rate: p.vat_rate, discount_pct: 0,
            net_total: lineNet, vat_total: lineVat, gross_total: round2(lineNet + lineVat), expiry_date: null,
          });
          addMovement({
            campus_id: campus.id, product_id: p.id, movement_type: 'ALIS', quantity: qty,
            unit_cost: p.purchase_price, movement_date: day, ref_type: 'purchase', ref_id: purchase.id,
          });
          stock.set(p.id, (stock.get(p.id) || 0) + qty);
        }
        purchase.net_total = round2(net);
        purchase.vat_total = round2(vat);
        purchase.gross_total = round2(net + vat);
        db.purchases.push(purchase);
      });

      /* Fire kayıtları */
      const wasteCount = periodIndex === 2 ? 2 : 3;
      for (let i = 0; i < wasteCount; i += 1) {
        const p = stocked[Math.floor(random() * stocked.length)];
        const day = schoolDays[Math.floor(random() * schoolDays.length)];
        const qty = 1 + Math.floor(random() * 5);
        db.waste.push({
          id: nextId('waste'), campus_id: campus.id, product_id: p.id, quantity: qty,
          reason: WASTE_REASONS[Math.floor(random() * WASTE_REASONS.length)],
          waste_date: day, unit_cost: p.purchase_price, note: null,
          created_by: adminId, created_at: `${day} 15:00:00`,
        });
        addMovement({
          campus_id: campus.id, product_id: p.id, movement_type: 'FIRE', quantity: -qty,
          unit_cost: p.purchase_price, movement_date: day, ref_type: 'waste', ref_id: ids.waste,
        });
        stock.set(p.id, (stock.get(p.id) || 0) - qty);
      }

      /* Son dönem henüz sayılmadı: ciro gir, sayımı kullanıcı yapsın */
      if (periodIndex === 2) {
        const expected = [...plannedSales.entries()]
          .reduce((sum, [pid, qty]) => sum + qty * db.products.find((p) => p.id === pid).sale_price, 0);
        distributeRevenue(db, nextId, campus, schoolDays, expected * conf.ratios[1], random, adminId);
        return;
      }


      /* Sayım: satılan miktar kadar stok eksilir */
      const countDate = period.to;
      // Sayımı kampüs görevlisi kilitler, yönetim kesinleştirir (iki imza kuralı)
      const staff = db.users.find((u) => u.campus_id === campus.id && u.role === 'KANTIN_GOREVLISI');
      const approver = db.users.find((u) => u.role === 'GENEL_MUDURLUK') ?? { id: adminId };

      const count = {
        id: nextId('count'), campus_id: campus.id, count_date: countDate,
        period_start: periodIndex === 0 ? null : periods[periodIndex].from,
        count_type: 'DONEM', status: 'KESINLESMIS', is_blind: 1,
        note: periodIndex === 0 ? 'İlk dönem sayımı' : 'Dönem sonu sayımı',
        witness_name: WITNESS_NAMES[periodIndex % WITNESS_NAMES.length],
        expected_revenue: 0, actual_revenue: 0, cogs_total: 0, production_revenue: 0,
        reopened_count: 0,
        created_by: staff?.id ?? adminId,
        submitted_by: staff?.id ?? adminId,
        submitted_at: `${countDate} 17:10:00`,
        finalized_by: approver.id, finalized_at: `${countDate} 17:30:00`,
        created_at: `${countDate} 16:00:00`,
      };

      let expectedRevenue = 0;
      let cogs = 0;
      for (const p of stocked) {
        const expectedQty = stock.get(p.id) || 0;
        const sold = Math.min(plannedSales.get(p.id), Math.max(0, expectedQty - 2));
        const countedQty = expectedQty - sold;
        const salesValue = round2(sold * p.sale_price);
        const costValue = round2(sold * p.purchase_price);
        expectedRevenue += salesValue;
        cogs += costValue;

        db.count_lines.push({
          id: nextId('count_line'), count_id: count.id, product_id: p.id,
          expected_qty: expectedQty, counted_qty: countedQty, diff_qty: -sold, sold_qty: sold,
          purchase_price: p.purchase_price, sale_price: p.sale_price, vat_rate: p.vat_rate,
          sales_value: salesValue, cost_value: costValue,
        });
        if (sold > 0) {
          addMovement({
            campus_id: campus.id, product_id: p.id, movement_type: 'SATIS', quantity: -sold,
            unit_cost: p.purchase_price, movement_date: countDate, ref_type: 'count', ref_id: count.id,
            note: 'Sayım ile hesaplanan dönem satışı',
          });
        }
        stock.set(p.id, countedQty);
      }

      // Üretilen ürünler: beyan edilen dönem adetleri
      for (const p of produced) {
        const qty = plannedSales.get(p.id);
        const salesValue = round2(qty * p.sale_price);
        const costValue = round2(qty * p.purchase_price);
        db.production_sales.push({
          id: nextId('production_sale'), count_id: count.id, product_id: p.id, quantity: qty,
          purchase_price: p.purchase_price, sale_price: p.sale_price, vat_rate: p.vat_rate,
          sales_value: salesValue, cost_value: costValue,
        });
        expectedRevenue += salesValue;
        cogs += costValue;
      }

      const actual = distributeRevenue(
        db, nextId, campus, schoolDays, expectedRevenue * conf.ratios[periodIndex], random, adminId
      );
      count.expected_revenue = round2(expectedRevenue);
      count.actual_revenue = round2(actual);
      count.cogs_total = round2(cogs);
      count.production_revenue = round2(productionRevenue);
      db.counts.push(count);

      db.audit_logs.push({
        id: nextId('audit'), user_id: adminId, user_email: 'admin@topkapiokullari.com',
        action: 'FINALIZE', entity: 'counts', entity_id: count.id, campus_id: campus.id,
        detail: JSON.stringify({ expectedRevenue: round2(expectedRevenue), actualRevenue: round2(actual) }),
        ip: '10.0.0.5', created_at: `${countDate} 17:30:00`,
      });
    });
  }

  /* Kampüsler arası bir transfer örneği */
  const transferDate = iso(dayOffset(-9));
  const transfer = {
    id: nextId('transfer'), from_campus_id: campusByCode.IKT.id, to_campus_id: campusByCode.KRC.id,
    transfer_date: transferDate, note: 'Kıraç kantininde su bitti, İkitelli deposundan gönderildi.',
    created_by: adminId, created_at: `${transferDate} 11:00:00`,
  };
  db.transfers.push(transfer);
  const water = db.products.find((p) => p.product_type === 'SATIN_ALINAN');
  db.transfer_lines.push({
    id: nextId('transfer_line'), transfer_id: transfer.id, product_id: water.id,
    quantity: 48, unit_cost: water.purchase_price,
  });
  addMovement({
    campus_id: transfer.from_campus_id, product_id: water.id, movement_type: 'TRANSFER_CIKIS',
    quantity: -48, unit_cost: water.purchase_price, movement_date: transferDate,
    ref_type: 'transfer', ref_id: transfer.id,
  });
  addMovement({
    campus_id: transfer.to_campus_id, product_id: water.id, movement_type: 'TRANSFER_GIRIS',
    quantity: 48, unit_cost: water.purchase_price, movement_date: transferDate,
    ref_type: 'transfer', ref_id: transfer.id,
  });

  /* Örnek iadeler — fire ile farkını göstermek için iki ayrı kampüste */
  const RETURN_SAMPLES = [
    {
      code: 'IKT', product: 'Süt 200 ml', supplier: 'Marmara', qty: 24, days: -11, reason: 'BOZUK',
      note: 'Soğuk zincir bozulmuş, parti kabul edilmedi.',
    },
    {
      code: 'ESN', product: 'Meyve Suyu 200 ml', supplier: 'Anadolu', qty: 12, days: -6, reason: 'SKT',
      note: 'Raf ömrü 3 gün kalmış ürünler geri gönderildi.',
    },
    {
      code: 'IKT', product: 'Kraker', supplier: 'Anadolu', qty: 18, days: -4, reason: 'HASARLI',
      note: 'Koli ezilmiş, paketler yırtık.',
    },
  ];

  for (const sample of RETURN_SAMPLES) {
    const campus = campusByCode[sample.code];
    const product = db.products.find((p) => p.name === sample.product);
    const supplier = db.suppliers.find((s2) => s2.name.includes(sample.supplier)) ?? db.suppliers[0];
    if (!campus || !product) continue;

    const day = iso(dayOffset(sample.days));
    const net = round2(sample.qty * product.purchase_price);
    const vat = round2(net * (product.vat_rate / 100));
    const ret = {
      id: nextId('supplier_return'), campus_id: campus.id, supplier_id: supplier.id,
      purchase_id: null, document_no: `IADE-${campus.code}-${String(ids.supplier_return).padStart(2, '0')}`,
      return_date: day, reason: sample.reason,
      net_total: net, vat_total: vat, gross_total: round2(net + vat),
      note: sample.note, created_by: adminId, created_at: `${day} 09:30:00`,
    };
    db.supplier_returns.push(ret);
    db.supplier_return_lines.push({
      id: nextId('supplier_return_line'), return_id: ret.id, product_id: product.id,
      quantity: sample.qty, unit_price: product.purchase_price, vat_rate: product.vat_rate,
      net_total: net, vat_total: vat, gross_total: round2(net + vat),
    });
    addMovement({
      campus_id: campus.id, product_id: product.id, movement_type: 'IADE', quantity: -sample.qty,
      unit_cost: product.purchase_price, movement_date: day,
      ref_type: 'return', ref_id: ret.id, note: `Tedarikçiye iade - ${sample.reason}`,
    });
  }

  /* Tedarikçi ödemeleri */
  for (const supplier of db.suppliers) {
    const total = db.purchases
      .filter((p) => p.supplier_id === supplier.id)
      .reduce((s, p) => s + p.gross_total, 0);
    const day = iso(dayOffset(-12));
    db.supplier_payments.push({
      id: nextId('payment'), supplier_id: supplier.id, campus_id: null, purchase_id: null,
      amount: round2(total * 0.7), payment_date: day, method: 'HAVALE',
      note: 'Dönem ödemesi', created_by: adminId, created_at: `${day} 14:00:00`,
    });
  }

  /* Denetim izine birkaç örnek kayıt */
  db.audit_logs.push(
    {
      id: nextId('audit'), user_id: adminId, user_email: 'admin@topkapiokullari.com',
      action: 'LOGIN', entity: 'users', entity_id: adminId, campus_id: null, detail: null,
      ip: '10.0.0.5', created_at: `${iso(dayOffset(0))} 08:12:00`,
    },
    {
      id: nextId('audit'), user_id: 5, user_email: 'esenyurt.kantin@topkapiokullari.com',
      action: 'LOGIN_FAILED', entity: 'users', entity_id: null, campus_id: null,
      detail: JSON.stringify({ email: 'esenyurt.kantin@topkapiokullari.com' }),
      ip: '10.0.0.41', created_at: `${iso(dayOffset(-1))} 16:28:00`,
    },
  );
  db.audit_logs.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));

  db._ids = ids;
  return db;
}

/** Beklenen ciroyu okul günlerine dağıtır ve günlük ciro kayıtları üretir. */
function distributeRevenue(db, nextId, campus, schoolDays, target, random, adminId) {
  if (!schoolDays.length || target <= 0) return 0;
  const weights = schoolDays.map(() => 0.85 + random() * 0.3);
  const weightSum = weights.reduce((a, b) => a + b, 0);
  let total = 0;

  schoolDays.forEach((day, i) => {
    const amount = round2((target * weights[i]) / weightSum);
    if (amount <= 0) return;
    const cash = round2(amount * (0.5 + random() * 0.1));
    const card = round2(amount * 0.3);
    const credit = round2(amount - cash - card);
    total += amount;
    db.revenues.push({
      id: nextId('revenue'), campus_id: campus.id, revenue_date: day,
      cash_amount: cash, card_amount: card, credit_amount: credit < 0 ? 0 : credit,
      other_amount: 0, total_amount: amount, z_report_no: null, is_school_day: 1, note: null,
      created_by: adminId, updated_by: adminId,
      created_at: `${day} 17:00:00`, updated_at: `${day} 17:00:00`,
    });
  });
  return total;
}

export { iso, dayOffset, eachDay, isWeekday, round2 };
