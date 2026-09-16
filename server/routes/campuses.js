import { Router } from '../lib/router.js';
import { all, get, insert, run } from '../db.js';
import { notFound, conflict } from '../lib/http.js';
import { requireRole, requireWrite, seesAllCampuses, assertCampusAccess } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, bool } from '../lib/validate.js';

export const campusRoutes = new Router();

campusRoutes.get('/', async (ctx) => {
  const rows = seesAllCampuses(ctx.user)
    ? all('SELECT * FROM campuses ORDER BY name COLLATE NOCASE')
    : all('SELECT * FROM campuses WHERE id = ?', [ctx.user.campusId ?? 0]);
  return { items: rows };
});

campusRoutes.get('/:id', async (ctx) => {
  const id = assertCampusAccess(ctx.user, ctx.params.id);
  const row = get('SELECT * FROM campuses WHERE id = ?', [id]);
  if (!row) throw notFound('Kampus bulunamadi.');
  return row;
});

campusRoutes.post('/', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const data = parseCampus(ctx.body);
  if (get('SELECT id FROM campuses WHERE code = ?', [data.code])) {
    throw conflict('Bu kampus kodu zaten kayitli.');
  }
  const id = insert(
    `INSERT INTO campuses (code, name, address, phone, student_count, rent_share_pct, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [data.code, data.name, data.address, data.phone, data.studentCount, data.rentSharePct, data.isActive ? 1 : 0]
  );
  logAudit({ user: ctx.user, action: 'CREATE', entity: 'campuses', entityId: id, campusId: id, detail: data, ip: ctx.ip });
  return get('SELECT * FROM campuses WHERE id = ?', [id]);
});

campusRoutes.put('/:id', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  requireWrite(ctx.user);
  const id = Number(ctx.params.id);
  const existing = get('SELECT * FROM campuses WHERE id = ?', [id]);
  if (!existing) throw notFound('Kampus bulunamadi.');
  const data = parseCampus(ctx.body);
  const dup = get('SELECT id FROM campuses WHERE code = ? AND id <> ?', [data.code, id]);
  if (dup) throw conflict('Bu kampus kodu baska bir kampuse ait.');
  run(
    `UPDATE campuses SET code = ?, name = ?, address = ?, phone = ?, student_count = ?, rent_share_pct = ?, is_active = ?
      WHERE id = ?`,
    [data.code, data.name, data.address, data.phone, data.studentCount, data.rentSharePct, data.isActive ? 1 : 0, id]
  );
  logAudit({ user: ctx.user, action: 'UPDATE', entity: 'campuses', entityId: id, campusId: id, detail: data, ip: ctx.ip });
  return get('SELECT * FROM campuses WHERE id = ?', [id]);
});

function parseCampus(body) {
  return {
    code: str(body.code, 'Kampus kodu', { required: true, max: 20 }).toUpperCase(),
    name: str(body.name, 'Kampus adi', { required: true, max: 150 }),
    address: str(body.address, 'Adres', { max: 500 }),
    phone: str(body.phone, 'Telefon', { max: 40 }),
    studentCount: int(body.studentCount, 'Ogrenci sayisi', { min: 0, max: 100000, def: 0 }) ?? 0,
    rentSharePct: num(body.rentSharePct, 'Okul pay orani', { min: 0, max: 100, def: 0 }) ?? 0,
    isActive: bool(body.isActive, true),
  };
}
