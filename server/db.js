/**
 * SQLite erisim katmani.
 *
 * Node 22+ ile gelen yerlesik `node:sqlite` kullanilir; boylece projenin
 * hicbir npm bagimliligi yoktur. Baska bir surucuye gecilmek istenirse
 * yalnizca bu dosyadaki `db` nesnesinin degistirilmesi yeterlidir.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new DatabaseSync(config.dbPath);

db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');
db.exec('PRAGMA busy_timeout = 5000');

export function migrate() {
  const sql = fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
  // ONCE eksik sutunlar: schema.sql yeni sutunlar uzerinde indeks kurabiliyor
  // (or. purchases.efatura_uuid). Eski bir veritabaninda tablo zaten var
  // oldugu icin CREATE TABLE IF NOT EXISTS sutunu eklemez ve indeks
  // "no such column" ile patlardi. Bos veritabaninda bu cagri hicbir sey
  // yapmaz (tablolar henuz yok).
  addMissingColumns();
  dropOutdatedIndexes();
  db.exec(sql);
  upgradeExistingSchema();
  repairDanglingReferences();
}

/**
 * Tanimi degisen indeksler.
 *
 * `CREATE INDEX IF NOT EXISTS` var olan bir indeksi GUNCELLEMEZ; tanim
 * degistiyse eskisi once dusurulmelidir. Dusurulen indeks hemen ardindan
 * schema.sql tarafindan yeni tanimiyla kurulur.
 */
function dropOutdatedIndexes() {
  // Iptal edilen fatura tekillik kisitindan cikarildi (IPTAL belgenin ETTN'si
  // yeniden girilebilmeli). Eski tanimda bu kosul yok.
  dropIndexUnless('idx_purchases_efatura', 'IPTAL');
}

/** Saklanan tanimda `mustContain` yoksa indeksi dusurur. */
function dropIndexUnless(name, mustContain) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name);
  if (!row || String(row.sql || '').includes(mustContain)) return;
  db.exec(`DROP INDEX IF EXISTS ${name}`);
  console.log(`[SEMA] ${name} indeksi yeni tanimiyla kurulacak.`);
}

/* ------------------------- Sema yukseltmeleri ----------------------- */
/**
 * schema.sql yalnizca eksik tablolari olusturur; zaten var olan tablolara
 * dokunmaz. Bu yuzden onceki surumlerden gelen veritabanlari icin sutun
 * eklemeleri burada, tekrar calistirilabilir bicimde yapilir.
 */
function upgradeExistingSchema() {
  addMissingColumns();

  // SQLite CHECK kisitlarini ALTER ile degistiremedigi icin ilgili tablolar
  // yeniden kurulur. Veri korunur; islem tek transaction icindedir.
  rebuildIfMissing('counts', "'SAYILDI'");      // TASLAK/KESINLESMIS -> + SAYILDI
  rebuildIfMissing('products', "'HAMMADDE'");   // SATIN_ALINAN/URETILEN -> + HAMMADDE
  rebuildIfMissing('users', "'MUHASEBE'");      // roller -> + MUHASEBE (on muhasebe)
  backfillProductPrices();
  tightenPaymentCampus();
}

/**
 * Tedarikci odemelerini KAMPUSE baglar (cari hesap kampus bazlidir).
 *
 * Eski surumde `supplier_payments.campus_id` bos birakilabiliyordu. Kampussuz
 * bir odeme hangi kampusun borcunu kapattigini soylemez; bes kampusun bakiyesi
 * o odeme yuzunden birbirine karisir. Once bos satirlar cikarilabildigi
 * kadar doldurulur, sonra sutun ZORUNLU hale getirilir.
 *
 * Cikarilamayan satir kalirsa sutun eski haliyle BIRAKILIR. Bilinmeyen bir
 * kampusa "en yakin tahmin"le para yazmak, bos birakmaktan daha kotudur:
 * yanlis kampusun bakiyesi sessizce duzelmis gorunur. Kullanici o odemeleri
 * arayuzde "kampus atanmamis" uyarisiyla gorur; duzelttikten sonraki ilk
 * acilista sutun kendiliginden zorunlu olur.
 */
function tightenPaymentCampus() {
  if (!tableExists('supplier_payments') || !tableExists('purchases')) return;
  const sutun = db.prepare('PRAGMA table_info(supplier_payments)').all()
    .find((c) => c.name === 'campus_id');
  if (!sutun || sutun.notnull) return;   // zaten zorunlu

  // 1) Odeme bir alim belgesine baglanmissa kampus o belgeden gelir.
  db.exec(`
    UPDATE supplier_payments SET campus_id = (
      SELECT p.campus_id FROM purchases p WHERE p.id = supplier_payments.purchase_id)
     WHERE campus_id IS NULL AND purchase_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM purchases p WHERE p.id = supplier_payments.purchase_id)`);

  // 2) Tedarikciden yalnizca TEK kampus alim yapmissa odeme de onundur.
  db.exec(`
    UPDATE supplier_payments SET campus_id = (
      SELECT MIN(p.campus_id) FROM purchases p
       WHERE p.supplier_id = supplier_payments.supplier_id AND p.status <> 'IPTAL')
     WHERE campus_id IS NULL
       AND (SELECT COUNT(DISTINCT p.campus_id) FROM purchases p
             WHERE p.supplier_id = supplier_payments.supplier_id AND p.status <> 'IPTAL') = 1`);

  const kalan = db.prepare('SELECT COUNT(*) AS n FROM supplier_payments WHERE campus_id IS NULL').get().n;
  if (kalan) {
    console.log(
      `[SEMA] ${kalan} tedarikci odemesinin kampusu belirlenemedi; kampus alani `
      + 'simdilik zorunlu yapilmadi. Tedarikciler ekranindan atayin.'
    );
    return;
  }
  rebuildTable('supplier_payments');
  console.log('[SEMA] Tedarikci odemeleri kampuse baglandi (cari hesap kampus bazli).');
}

/**
 * Mevcut satis fiyatlarini TARIHLI fiyat listesine tasir (9. madde).
 *
 * Fiyat listesi sonradan eklendi; eski urunlerin hic satiri yok. Cozumleme
 * sutuna dustugu icin davranis dogru ama fiyat takvimi bos gorunur ve
 * "bu fiyat ne zamandan beri gecerli" sorusu cevapsiz kalir. Her urun icin
 * BIR KEZ, urunun olusturuldugu tarihten gecerli bir satir yazariz.
 *
 * Tekrar calistirilabilir: zaten satiri olan urune dokunmaz.
 */
function backfillProductPrices() {
  if (!tableExists('product_prices') || !tableExists('products')) return;

  const urunler = db.prepare(
    `SELECT p.id, p.sale_price, DATE(p.created_at) AS gun
       FROM products p
      WHERE NOT EXISTS (SELECT 1 FROM product_prices pp WHERE pp.product_id = p.id AND pp.campus_id IS NULL)`
  ).all();
  for (const u of urunler) {
    db.prepare(
      `INSERT INTO product_prices (product_id, campus_id, sale_price, effective_from, note)
       VALUES (?, NULL, ?, ?, 'Mevcut fiyat (listeye aktarildi)')`
    ).run(u.id, u.sale_price ?? 0, u.gun || '2000-01-01');
  }

  // Kampuse ozel fiyatlar da listeye tasinir
  const kampus = tableExists('campus_products') ? db.prepare(
    `SELECT cp.campus_id, cp.product_id, cp.sale_price, DATE(p.created_at) AS gun
       FROM campus_products cp JOIN products p ON p.id = cp.product_id
      WHERE cp.sale_price IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM product_prices pp
                         WHERE pp.product_id = cp.product_id AND pp.campus_id = cp.campus_id)`
  ).all() : [];
  for (const k of kampus) {
    db.prepare(
      `INSERT INTO product_prices (product_id, campus_id, sale_price, effective_from, note)
       VALUES (?, ?, ?, ?, 'Mevcut kampus fiyati (listeye aktarildi)')`
    ).run(k.product_id, k.campus_id, k.sale_price, k.gun || '2000-01-01');
  }

  const toplam = urunler.length + kampus.length;
  if (toplam) console.log(`[SEMA] ${toplam} satis fiyati tarihli fiyat listesine aktarildi.`);
}

/** Eski veritabanlarina sonradan eklenen sutunlar. Tekrar calistirilabilir. */
function addMissingColumns() {
  addColumn('products', 'product_type', "TEXT NOT NULL DEFAULT 'SATIN_ALINAN'");
  addColumn('counts', 'count_type', "TEXT NOT NULL DEFAULT 'DONEM'");
  addColumn('counts', 'is_opening', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('counts', 'is_blind', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('counts', 'witness_name', 'TEXT');
  addColumn('counts', 'production_revenue', 'REAL NOT NULL DEFAULT 0');
  addColumn('counts', 'reopened_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('counts', 'submitted_by', 'INTEGER');
  addColumn('counts', 'submitted_at', 'TEXT');
  addColumn('count_lines', 'recipe_qty', 'REAL NOT NULL DEFAULT 0');
  addColumn('daily_revenues', 'handover_id', 'INTEGER');
  addColumn('purchases', 'efatura_uuid', 'TEXT');
}

function columnExists(table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

function addColumn(table, column, definition) {
  if (!tableExists(table) || columnExists(table, column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[SEMA] ${table}.${column} sutunu eklendi.`);
}

function tableExists(table) {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
}

/**
 * Tablonun saklanan CREATE ifadesinde `sentinel` yoksa, tabloyu schema.sql'deki
 * guncel tanimiyla yeniden kurar ve ortak sutunlardaki veriyi tasir.
 * CHECK kisiti degisiklikleri icin gereklidir (SQLite ALTER ile desteklemez).
 */
function rebuildIfMissing(table, sentinel) {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!row || String(row.sql).includes(sentinel)) return;

  console.log(`[SEMA] ${table} tablosu yeniden kuruluyor (${sentinel} destegi)...`);
  rebuildTable(table);
}

/**
 * Tabloyu schema.sql'deki guncel tanimiyla yeniden kurar, ortak sutunlardaki
 * veriyi tasir.
 *
 * DIKKAT — `legacy_alter_table` kapali olsaydi SQLite, RENAME sirasinda
 * DIGER tablolarin yabanci anahtar tanimlarini da yeni ada cevirirdi:
 * `users` -> `users_eski` yapildiginda `sessions` ve `audit_logs` kalici
 * olarak `REFERENCES "users_eski"` yazar, gecici tablo silinince de o
 * tablolara hicbir kayit eklenemezdi (no such table: main.users_eski).
 * Bu yuzden yeniden kurma suresince eski davranis acilir.
 */
function rebuildTable(table) {
  const oldColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const schema = fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`);
  const createSql = pattern.exec(schema);
  if (!createSql) throw new Error(`schema.sql icinde ${table} tablosu bulunamadi.`);

  const tempName = `${table}_eski`;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('PRAGMA legacy_alter_table = ON');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${tempName}`);
    db.exec(createSql[0]);
    // Yalnizca her iki tanimda da bulunan sutunlar tasinir
    const newColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const shared = oldColumns.filter((c) => newColumns.includes(c)).join(', ');
    db.exec(`INSERT INTO ${table} (${shared}) SELECT ${shared} FROM ${tempName}`);
    db.exec(`DROP TABLE ${tempName}`);
    // Indeksler tabloyla birlikte yeniden adlandirilip gecici tabloyla
    // DUSER; schema.sql'deki tanimlariyla hemen geri kurulur. Aksi halde
    // bir sonraki acilisa kadar indekssiz calisirdik.
    for (const stmt of schema.match(
      new RegExp(`CREATE (?:UNIQUE )?INDEX IF NOT EXISTS [^;]*?\\bON ${table}\\s*\\([^;]*?\\);`, 'g')
    ) || []) db.exec(stmt);
    db.exec('COMMIT');
    console.log(`[SEMA] ${table} tablosu yukseltildi.`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA legacy_alter_table = OFF');
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/**
 * Yukaridaki hatadan zarar gormus veritabanlarini onarir.
 *
 * Eski surumlerde tablo yeniden kurma islemi `legacy_alter_table` acmadan
 * yapiliyordu; boyle bir veritabaninda bazi tablolar artik var olmayan
 * `<tablo>_eski` tablolarina referans verir ve o tablolara yazilamaz
 * (or. giris yapilamaz, cunku `sessions` yazilamaz). Bozuk tanimli
 * tablolari schema.sql'deki dogru tanimlariyla yeniden kurarak duzeltiriz;
 * veri korunur.
 */
function repairDanglingReferences() {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all();
  for (const row of rows) {
    const refs = [...String(row.sql || '').matchAll(/REFERENCES\s+"?([A-Za-z0-9_]+)_eski"?/g)];
    // Yalnizca GERCEKTEN var olmayan bir tabloya referans varsa mudahale ederiz
    if (!refs.length || refs.some((m) => tableExists(`${m[1]}_eski`))) continue;
    console.log(`[SEMA] ${row.name} tablosundaki bozuk referans onariliyor (${refs[0][1]}_eski).`);
    rebuildTable(row.name);
  }
}

/** Tek satir dondurur (duz nesne olarak) veya null. */
export function get(sql, params = []) {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } : null;
}

/** Tum satirlari duz nesne dizisi olarak dondurur. */
export function all(sql, params = []) {
  return db.prepare(sql).all(...params).map((r) => ({ ...r }));
}

/** INSERT/UPDATE/DELETE calistirir. */
export function run(sql, params = []) {
  return db.prepare(sql).run(...params);
}

/** Son eklenen kaydin id degerini dondurur. */
export function insert(sql, params = []) {
  return Number(run(sql, params).lastInsertRowid);
}

/** Fonksiyonu tek bir islem (transaction) icinde calistirir. */
export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* yoksay */ }
    throw err;
  }
}

export function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    [key, String(value)]
  );
}
