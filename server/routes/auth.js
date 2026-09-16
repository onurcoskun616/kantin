import { Router } from '../lib/router.js';
import { get, run, all } from '../db.js';
import { badRequest, unauthorized } from '../lib/http.js';
import { verifyPassword, hashPassword, createSession, destroySession, requireAuth } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str } from '../lib/validate.js';

export const authRoutes = new Router();

authRoutes.post('/login', async (ctx) => {
  const email = str(ctx.body.email, 'E-posta', { required: true, max: 160 }).toLowerCase();
  const password = String(ctx.body.password || '');
  if (!password) throw badRequest('Parola zorunludur.');

  const user = get('SELECT * FROM users WHERE lower(email) = ?', [email]);
  // Kullanici yoksa da ayni sureyi harcayalim (kullanici sayimi sizdirmamak icin)
  const ok = user ? verifyPassword(password, user.password_hash) : verifyPassword(password, hashPassword('gecersiz-parola'));
  if (!user || !ok) {
    logAudit({ user: null, action: 'LOGIN_FAILED', entity: 'users', detail: { email }, ip: ctx.ip });
    throw unauthorized('E-posta veya parola hatali.');
  }
  if (!user.is_active) throw unauthorized('Hesabiniz pasif durumda. Yonetici ile gorusun.');

  const { token, expiresAt } = createSession(user.id, { userAgent: ctx.req.headers['user-agent'], ip: ctx.ip });
  run("UPDATE users SET last_login_at = datetime('now') WHERE id = ?", [user.id]);
  logAudit({ user, action: 'LOGIN', entity: 'users', entityId: user.id, ip: ctx.ip });

  return {
    token,
    expiresAt,
    user: publicUser(user),
  };
});

authRoutes.post('/logout', async (ctx) => {
  if (ctx.user) {
    destroySession(ctx.user.sessionToken);
    logAudit({ user: ctx.user, action: 'LOGOUT', entity: 'users', entityId: ctx.user.id, ip: ctx.ip });
  }
  return { ok: true };
});

authRoutes.get('/me', async (ctx) => {
  requireAuth(ctx.user);
  const user = get('SELECT * FROM users WHERE id = ?', [ctx.user.id]);
  const campuses = ctx.user.campusId
    ? all('SELECT id, code, name, student_count FROM campuses WHERE id = ? AND is_active = 1', [ctx.user.campusId])
    : all('SELECT id, code, name, student_count FROM campuses WHERE is_active = 1 ORDER BY name');
  return { user: publicUser(user), campuses };
});

authRoutes.post('/change-password', async (ctx) => {
  requireAuth(ctx.user);
  const current = String(ctx.body.currentPassword || '');
  const next = String(ctx.body.newPassword || '');
  const user = get('SELECT * FROM users WHERE id = ?', [ctx.user.id]);
  if (!verifyPassword(current, user.password_hash)) throw badRequest('Mevcut parola hatali.');
  if (next.length < 8) throw badRequest('Yeni parola en az 8 karakter olmalidir.');
  run('UPDATE users SET password_hash = ? WHERE id = ?', [hashPassword(next), user.id]);
  run('DELETE FROM sessions WHERE user_id = ? AND token <> ?', [user.id, ctx.user.sessionToken]);
  logAudit({ user: ctx.user, action: 'CHANGE_PASSWORD', entity: 'users', entityId: user.id, ip: ctx.ip });
  return { ok: true };
});

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    fullName: u.full_name,
    role: u.role,
    campusId: u.campus_id,
    lastLoginAt: u.last_login_at ?? null,
  };
}
