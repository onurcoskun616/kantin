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
  db.exec(sql);
  upgradeExistingSchema();
}

/* ------------------------- Sema yukseltmeleri ----------------------- */
/**
 * schema.sql yalnizca eksik tablolari olusturur; zaten var olan tablolara
 * dokunmaz. Bu yuzden onceki surumlerden gelen veritabanlari icin sutun
 * eklemeleri burada, tekrar calistirilabilir bicimde yapilir.
 */
function upgradeExistingSchema() {
  addColumn('products', 'product_type', "TEXT NOT NULL DEFAULT 'SATIN_ALINAN'");
  addColumn('counts', 'count_type', "TEXT NOT NULL DEFAULT 'DONEM'");
  addColumn('counts', 'is_blind', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('counts', 'witness_name', 'TEXT');
  addColumn('counts', 'production_revenue', 'REAL NOT NULL DEFAULT 0');
  addColumn('counts', 'reopened_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('counts', 'submitted_by', 'INTEGER');
  addColumn('counts', 'submitted_at', 'TEXT');
  addColumn('count_lines', 'recipe_qty', 'REAL NOT NULL DEFAULT 0');
  addColumn('daily_revenues', 'handover_id', 'INTEGER');

  // SQLite CHECK kisitlarini ALTER ile degistiremedigi icin ilgili tablolar
  // yeniden kurulur. Veri korunur; islem tek transaction icindedir.
  rebuildIfMissing('counts', "'SAYILDI'");      // TASLAK/KESINLESMIS -> + SAYILDI
  rebuildIfMissing('products', "'HAMMADDE'");   // SATIN_ALINAN/URETILEN -> + HAMMADDE
  rebuildIfMissing('users', "'MUHASEBE'");      // roller -> + MUHASEBE (on muhasebe)
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
  const oldColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);

  const schema = fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
  const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\);`);
  const createSql = pattern.exec(schema);
  if (!createSql) throw new Error(`schema.sql icinde ${table} tablosu bulunamadi.`);

  const tempName = `${table}_eski`;
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`ALTER TABLE ${table} RENAME TO ${tempName}`);
    db.exec(createSql[0]);
    // Yalnizca her iki tanimda da bulunan sutunlar tasinir
    const newColumns = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    const shared = oldColumns.filter((c) => newColumns.includes(c)).join(', ');
    db.exec(`INSERT INTO ${table} (${shared}) SELECT ${shared} FROM ${tempName}`);
    db.exec(`DROP TABLE ${tempName}`);
    db.exec('COMMIT');
    console.log(`[SEMA] ${table} tablosu yukseltildi.`);
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
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
