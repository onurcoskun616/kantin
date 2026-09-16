/**
 * Ilk kurulum verisi.
 *  - Yonetici hesabi
 *  - 5 kampus
 *  - Temel kategoriler ve ornek urun listesi
 * Mevcut veriyi asla ezmez; yalnizca eksikse ekler.
 * `node server/seed.js --demo` ile ornek hareket verisi de uretir.
 */
import { config } from './config.js';
import { db, get, all, insert, run, migrate, tx } from './db.js';
import { hashPassword } from './lib/auth.js';

const CAMPUSES = [
  { code: 'IKT', name: 'Topkapı Okulları - İkitelli OSB Kampüsü', studentCount: 0 },
  { code: 'IST', name: 'Topkapı Okulları - İstanbul OSB Kampüsü', studentCount: 0 },
  { code: 'ESN', name: 'Topkapı Okulları - Esenyurt Kampüsü', studentCount: 0 },
  { code: 'KRC', name: 'Topkapı Okulları - Kıraç Kampüsü', studentCount: 0 },
  { code: 'CRL', name: 'Topkapı Okulları - Çorlu Kampüsü', studentCount: 0 },
];

// Kurulumda bu listeyi kendi kampüs adlarınızla değiştirin veya uygulamadaki
// "Kampüsler" ekranından düzenleyin.

const CATEGORIES = [
  'Su ve İçecek', 'Süt ve Süt Ürünleri', 'Sandviç ve Unlu Mamul', 'Kuruyemiş ve Kuru Meyve',
  'Bisküvi ve Kek', 'Taze Meyve', 'Sıcak İçecek', 'Kırtasiye', 'Diğer',
];

// KDV oranlari Turkiye gida perakendesine gore ornek degerlerdir; kendi
// muhasebenizle dogrulayip guncelleyiniz.
const PRODUCTS = [
  ['8690000000011', 'Su 500 ml',              'Su ve İçecek',              4.00,  6.00, 10],
  ['8690000000028', 'Ayran 200 ml',           'Süt ve Süt Ürünleri',       8.50, 13.00,  1],
  ['8690000000035', 'Süt 200 ml',             'Süt ve Süt Ürünleri',       9.00, 14.00,  1],
  ['8690000000042', 'Meyve Suyu 200 ml',      'Su ve İçecek',             10.00, 16.00, 10],
  ['8690000000059', 'Tost',                   'Sandviç ve Unlu Mamul',    18.00, 35.00, 10],
  ['8690000000066', 'Poğaça',                 'Sandviç ve Unlu Mamul',     9.00, 16.00,  1],
  ['8690000000073', 'Simit',                  'Sandviç ve Unlu Mamul',     7.00, 12.00,  1],
  ['8690000000080', 'Sandviç (Ton Balıklı)',  'Sandviç ve Unlu Mamul',    26.00, 45.00, 10],
  ['8690000000097', 'Kek (Kakaolu)',          'Bisküvi ve Kek',            7.50, 13.00, 10],
  ['8690000000103', 'Bisküvi',                'Bisküvi ve Kek',            6.00, 11.00, 10],
  ['8690000000110', 'Fındık 30 g',            'Kuruyemiş ve Kuru Meyve',  14.00, 24.00,  1],
  ['8690000000127', 'Kuru Üzüm 40 g',         'Kuruyemiş ve Kuru Meyve',   9.00, 16.00,  1],
  ['8690000000134', 'Elma (adet)',            'Taze Meyve',                6.00, 10.00,  1],
  ['8690000000141', 'Muz (adet)',             'Taze Meyve',                9.00, 15.00,  1],
  ['8690000000158', 'Çay (bardak)',           'Sıcak İçecek',              2.50,  8.00, 10],
  ['8690000000165', 'Salep (bardak)',         'Sıcak İçecek',              9.00, 20.00, 10],
  ['8690000000172', 'Kurşun Kalem',           'Kırtasiye',                 4.00,  8.00, 20],
  ['8690000000189', 'Defter A4',              'Kırtasiye',                22.00, 40.00, 20],
];

const SUPPLIERS = [
  ['Anadolu Gıda Dağıtım A.Ş.', '0212 000 00 01'],
  ['Marmara Süt ve Süt Ürünleri Ltd.', '0212 000 00 02'],
  ['Güneş Unlu Mamuller', '0212 000 00 03'],
  ['Öz Kuruyemiş Toptan', '0212 000 00 04'],
];

/**
 * @param {{withExamples?: boolean}} options
 *   withExamples false ise ornek urun ve tedarikci listesi eklenmez
 *   (gercek kullanima gecerken tercih edilmelidir).
 */
export function ensureSeedData({ withExamples = true } = {}) {
  const userCount = get('SELECT COUNT(*) AS c FROM users').c;
  if (userCount === 0) {
    const id = insert(
      'INSERT INTO users (email, full_name, password_hash, role) VALUES (?, ?, ?, ?)',
      [config.admin.email.toLowerCase(), config.admin.name, hashPassword(config.admin.password), 'ADMIN']
    );
    console.log(`[KURULUM] Yonetici hesabi olusturuldu: ${config.admin.email} (id=${id})`);
    console.log('[KURULUM] Ilk girisin ardindan parolayi mutlaka degistirin.');
  }

  if (get('SELECT COUNT(*) AS c FROM campuses').c === 0) {
    for (const c of CAMPUSES) {
      insert('INSERT INTO campuses (code, name, student_count) VALUES (?, ?, ?)', [c.code, c.name, c.studentCount]);
    }
    console.log(`[KURULUM] ${CAMPUSES.length} kampus eklendi.`);
  }

  if (get('SELECT COUNT(*) AS c FROM categories').c === 0) {
    CATEGORIES.forEach((name, i) => insert('INSERT INTO categories (name, sort_order) VALUES (?, ?)', [name, i]));
  }

  if (!withExamples) {
    console.log('[KURULUM] Ornek urun ve tedarikci listesi atlandi (--bos).');
    return;
  }

  if (get('SELECT COUNT(*) AS c FROM products').c === 0) {
    const catMap = new Map(all('SELECT id, name FROM categories').map((c) => [c.name, c.id]));
    for (const [barcode, name, category, purchase, sale, vat] of PRODUCTS) {
      insert(
        `INSERT INTO products (barcode, name, category_id, unit, purchase_price, sale_price, vat_rate, critical_stock)
         VALUES (?, ?, ?, 'ADET', ?, ?, ?, ?)`,
        [barcode, name, catMap.get(category) ?? null, purchase, sale, vat, 20]
      );
    }
    console.log(`[KURULUM] ${PRODUCTS.length} ornek urun eklendi.`);
  }

  if (get('SELECT COUNT(*) AS c FROM suppliers').c === 0) {
    for (const [name, phone] of SUPPLIERS) insert('INSERT INTO suppliers (name, phone) VALUES (?, ?)', [name, phone]);
  }
}

/* --------------------------- Demo verisi --------------------------- */
function generateDemo() {
  const campuses = all('SELECT * FROM campuses');
  const products = all('SELECT * FROM products WHERE is_active = 1');
  const suppliers = all('SELECT * FROM suppliers');
  const admin = get("SELECT * FROM users WHERE role = 'ADMIN' LIMIT 1");
  if (!campuses.length || !products.length) return;
  if (get('SELECT COUNT(*) AS c FROM stock_movements').c > 0) {
    console.log('[DEMO] Hareket verisi zaten var, atlandi.');
    return;
  }

  const end = new Date();
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 60);
  const iso = (d) => d.toISOString().slice(0, 10);

  tx(() => {
    for (const campus of campuses) {
      // Acilis stogu
      for (const p of products) {
        insert(
          `INSERT INTO stock_movements (campus_id, product_id, movement_type, quantity, unit_cost, movement_date, ref_type, note, created_by)
           VALUES (?, ?, 'ACILIS', ?, ?, ?, 'opening', 'Demo acilis stogu', ?)`,
          [campus.id, p.id, 120 + Math.floor(Math.random() * 80), p.purchase_price, iso(start), admin?.id ?? null]
        );
      }

      // Haftalik alimlar
      for (let w = 0; w < 8; w += 1) {
        const d = new Date(start);
        d.setUTCDate(d.getUTCDate() + w * 7 + 1);
        if (d > end) break;
        const supplier = suppliers[w % suppliers.length];
        const picked = products.filter(() => Math.random() < 0.5);
        if (!picked.length) continue;
        let net = 0;
        const pid = insert(
          `INSERT INTO purchases (campus_id, supplier_id, document_no, document_date, net_total, vat_total, gross_total, status, created_by)
           VALUES (?, ?, ?, ?, 0, 0, 0, 'ONAYLI', ?)`,
          [campus.id, supplier.id, `DEMO-${campus.code}-${w + 1}`, iso(d), admin?.id ?? null]
        );
        let vat = 0;
        for (const p of picked) {
          const qty = 40 + Math.floor(Math.random() * 60);
          const lineNet = Math.round(qty * p.purchase_price * 100) / 100;
          const lineVat = Math.round(lineNet * (p.vat_rate / 100) * 100) / 100;
          net += lineNet; vat += lineVat;
          insert(
            `INSERT INTO purchase_lines (purchase_id, product_id, quantity, unit_price, vat_rate, net_total, vat_total, gross_total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [pid, p.id, qty, p.purchase_price, p.vat_rate, lineNet, lineVat, lineNet + lineVat]
          );
          insert(
            `INSERT INTO stock_movements (campus_id, product_id, movement_type, quantity, unit_cost, movement_date, ref_type, ref_id, created_by)
             VALUES (?, ?, 'ALIS', ?, ?, ?, 'purchase', ?, ?)`,
            [campus.id, p.id, qty, p.purchase_price, iso(d), pid, admin?.id ?? null]
          );
        }
        run('UPDATE purchases SET net_total = ?, vat_total = ?, gross_total = ? WHERE id = ?',
          [Math.round(net * 100) / 100, Math.round(vat * 100) / 100, Math.round((net + vat) * 100) / 100, pid]);
      }

      // Gunluk ciro (hafta ici)
      const base = campus.student_count * 22;
      for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
        const wd = d.getUTCDay();
        if (wd === 0 || wd === 6) continue;
        const total = Math.round(base * (0.8 + Math.random() * 0.4) * 100) / 100;
        const cash = Math.round(total * 0.55 * 100) / 100;
        const card = Math.round(total * 0.35 * 100) / 100;
        const credit = Math.round((total - cash - card) * 100) / 100;
        insert(
          `INSERT INTO daily_revenues (campus_id, revenue_date, cash_amount, card_amount, credit_amount, total_amount, created_by, updated_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [campus.id, iso(d), cash, card, credit, total, admin?.id ?? null, admin?.id ?? null]
        );
      }
    }
  });
  console.log('[DEMO] Ornek alim ve ciro verisi olusturuldu. Sayimlari uygulamadan girebilirsiniz.');
}

// Dogrudan calistirildiginda
if (process.argv[1] && process.argv[1].endsWith('seed.js')) {
  migrate();
  if (process.argv.includes('--reset')) {
    const tables = ['audit_logs', 'sessions', 'count_lines', 'counts', 'transfer_lines', 'transfers',
      'waste_records', 'supplier_payments', 'purchase_lines', 'purchases', 'stock_movements',
      'daily_revenues', 'price_history', 'campus_products', 'products', 'categories', 'suppliers',
      'campuses', 'users', 'settings'];
    db.exec('PRAGMA foreign_keys = OFF');
    for (const t of tables) run(`DELETE FROM ${t}`);
    run("DELETE FROM sqlite_sequence");
    db.exec('PRAGMA foreign_keys = ON');
    console.log('[RESET] Tum veriler silindi.');
  }
  ensureSeedData({ withExamples: !process.argv.includes('--bos') });
  if (process.argv.includes('--demo')) generateDemo();
  console.log('Tamamlandi.');
}
