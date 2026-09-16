import { badRequest } from './http.js';

export function str(value, field, { required = false, max = 500, min = 0 } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (required) throw badRequest(`"${field}" alani zorunludur.`);
    return null;
  }
  const s = String(value).trim();
  if (s.length > max) throw badRequest(`"${field}" en fazla ${max} karakter olabilir.`);
  if (s.length < min) throw badRequest(`"${field}" en az ${min} karakter olmalidir.`);
  return s;
}

export function num(value, field, { required = false, min = -Infinity, max = Infinity, def = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`"${field}" alani zorunludur.`);
    return def;
  }
  const n = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(n)) throw badRequest(`"${field}" sayisal olmalidir.`);
  if (n < min) throw badRequest(`"${field}" en az ${min} olabilir.`);
  if (n > max) throw badRequest(`"${field}" en fazla ${max} olabilir.`);
  return n;
}

export function int(value, field, opts = {}) {
  const n = num(value, field, opts);
  if (n === null) return null;
  if (!Number.isInteger(n)) throw badRequest(`"${field}" tam sayi olmalidir.`);
  return n;
}

export function bool(value, def = false) {
  if (value === undefined || value === null || value === '') return def;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'evet', 'on', 'yes'].includes(String(value).toLowerCase());
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function date(value, field, { required = false, def = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`"${field}" alani zorunludur.`);
    return def;
  }
  const s = String(value).trim().slice(0, 10);
  if (!DATE_RE.test(s)) throw badRequest(`"${field}" YYYY-AA-GG formatinda olmalidir.`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) throw badRequest(`"${field}" gecerli bir tarih degil.`);
  return s;
}

export function oneOf(value, field, allowed, { required = false, def = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`"${field}" alani zorunludur.`);
    return def;
  }
  const s = String(value).trim();
  if (!allowed.includes(s)) {
    throw badRequest(`"${field}" su degerlerden biri olmalidir: ${allowed.join(', ')}`);
  }
  return s;
}

export function arr(value, field, { required = false, min = 0 } = {}) {
  if (!Array.isArray(value)) {
    if (required) throw badRequest(`"${field}" bir liste olmalidir.`);
    return [];
  }
  if (value.length < min) throw badRequest(`"${field}" en az ${min} satir icermelidir.`);
  return value;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Bir ayin ilk ve son gununu dondurur. Ornek: monthRange('2026-03') */
export function monthRange(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  if (!m) throw badRequest('Ay degeri YYYY-AA formatinda olmalidir.');
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw badRequest('Ay 01-12 arasinda olmalidir.');
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return { from: `${m[1]}-${m[2]}-01`, to: `${m[1]}-${m[2]}-${String(last).padStart(2, '0')}` };
}
