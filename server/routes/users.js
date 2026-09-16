import { Router } from '../lib/router.js';
import { all, get, insert, run } from '../db.js';
import { notFound, conflict, badRequest } from '../lib/http.js';
import { requireRole, hashPassword, ROLES } from '../lib/auth.js';
import { logAudit, listAudit } from '../lib/audit.js';
import { str, int, bool, oneOf } from '../lib/validate.js';
import { publicUser } from './auth.js';

export const userRoutes = new Router();

userRoutes.get('/', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const items = all(
    `SELECT u.*, k.name AS campus_name FROM users u
       LEFT JOIN campuses k ON k.id = u.campus_id ORDER BY u.full_name COLLATE NOCASE`
  );
  return { items: items.map((u) => ({ ...publicUser(u), campusName: u.campus_name, isActive: !!u.is_active })), roles: ROLES };
});

userRoutes.post('/', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const d = parse(ctx.body);
  if (get('SELECT id FROM users WHERE lower(email) = ?', [d.email])) throw conflict('Bu e-posta zaten kayitli.');
  const password = String(ctx.body.password || '');
  if (password.length < 8) throw badRequest('Parola en az 8 karakter olmalidir.');

  const id = insert(
    'INSERT INTO users (email, full_name, password_hash, role, campus_id, is_active) VALUES (?, ?, ?, ?, ?, ?)',
    [d.email, d.fullName, hashPassword(password), d.role, d.campusId, d.isActive ? 1 : 0]
  );
  logAudit({ user: ctx.user, action: 'CREATE', entity: 'users', entityId: id, detail: { email: d.email, role: d.role }, ip: ctx.ip });
  return publicUser(get('SELECT * FROM users WHERE id = ?', [id]));
});

userRoutes.put('/:id', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const id = Number(ctx.params.id);
  const existing = get('SELECT * FROM users WHERE id = ?', [id]);
  if (!existing) throw notFound('Kullanici bulunamadi.');
  const d = parse(ctx.body);
  const dup = get('SELECT id FROM users WHERE lower(email) = ? AND id <> ?', [d.email, id]);
  if (dup) throw conflict('Bu e-posta baska bir kullaniciya ait.');
  if (existing.id === ctx.user.id && !d.isActive) throw badRequest('Kendi hesabinizi pasife alamazsiniz.');

  run('UPDATE users SET email = ?, full_name = ?, role = ?, campus_id = ?, is_active = ? WHERE id = ?',
    [d.email, d.fullName, d.role, d.campusId, d.isActive ? 1 : 0, id]);
  if (!d.isActive) run('DELETE FROM sessions WHERE user_id = ?', [id]);
  logAudit({ user: ctx.user, action: 'UPDATE', entity: 'users', entityId: id, detail: d, ip: ctx.ip });
  return publicUser(get('SELECT * FROM users WHERE id = ?', [id]));
});

userRoutes.post('/:id/reset-password', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const id = Number(ctx.params.id);
  if (!get('SELECT id FROM users WHERE id = ?', [id])) throw notFound('Kullanici bulunamadi.');
  const password = String(ctx.body.password || '');
  if (password.length < 8) throw badRequest('Parola en az 8 karakter olmalidir.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(password), id]);
  run('DELETE FROM sessions WHERE user_id = ?', [id]);
  logAudit({ user: ctx.user, action: 'RESET_PASSWORD', entity: 'users', entityId: id, ip: ctx.ip });
  return { ok: true };
});

function parse(body) {
  const role = oneOf(body.role, 'Rol', ROLES, { required: true });
  const campusId = int(body.campusId, 'Kampus', { def: null });
  if (['KAMPUS_YONETICISI', 'KANTIN_GOREVLISI'].includes(role) && !campusId) {
    throw badRequest('Kampus yoneticisi ve kantin gorevlisi icin kampus secilmelidir.');
  }
  return {
    email: str(body.email, 'E-posta', { required: true, max: 160 }).toLowerCase(),
    fullName: str(body.fullName, 'Ad soyad', { required: true, max: 150 }),
    role,
    campusId: ['ADMIN', 'GENEL_MUDURLUK', 'DENETCI'].includes(role) ? null : campusId,
    isActive: bool(body.isActive, true),
  };
}

/* ---------------------------- Denetim izi -------------------------- */
export const auditRoutes = new Router();

auditRoutes.get('/', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK', 'DENETCI');
  return {
    items: listAudit({
      limit: Math.min(Number(ctx.query.limit || 200), 1000),
      offset: Number(ctx.query.offset || 0),
      entity: ctx.query.entity || null,
      campusId: ctx.query.campusId || null,
    }),
  };
});
