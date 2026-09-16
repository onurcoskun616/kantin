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

  // Eski surumde counts.status yalnizca TASLAK/KESINLESMIS kabul ediyordu.
  // SQLite CHECK kisitini degistiremedigi icin tablo yeniden kurulur.
  relaxCountStatusCheck();
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

function relaxCountStatusCheck() {
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'counts'").get();
  if (!row || String(row.sql).includes("'SAYILDI'")) return;

  console.log('[SEMA] counts tablosu yeni durum degerleri icin yeniden kuruluyor...');
  const columns = db.prepare('PRAGMA table_info(counts)').all().map((c) => c.name);
  const shared = columns.join(', ');

  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('ALTER TABLE counts RENAME TO counts_eski');
    const schema = fs.readFileSync(path.join(ROOT, 'server', 'schema.sql'), 'utf8');
    const createSql = /CREATE TABLE IF NOT EXISTS counts \([\s\S]*?\n\);/.exec(schema);
    if (!createSql) throw new Error('schema.sql icinde counts tablosu bulunamadi.');
    db.exec(createSql[0]);
    db.exec(`INSERT INTO counts (${shared}) SELECT ${shared} FROM counts_eski`);
    db.exec('DROP TABLE counts_eski');
    db.exec('COMMIT');
    console.log('[SEMA] counts tablosu yukseltildi.');
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
