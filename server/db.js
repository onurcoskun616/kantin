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
