import crypto from 'node:crypto';
import { config } from '../config.js';
import { get, run, all } from '../db.js';
import { forbidden, unauthorized, badRequest } from './http.js';

/* ----------------------------- Parola ----------------------------- */
// scrypt (Node yerlesik) ile parola ozeti. Format: scrypt$N$r$p$salt$hash
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

export function hashPassword(plain) {
  if (typeof plain !== 'string' || plain.length < 8) {
    throw badRequest('Parola en az 8 karakter olmalidir.');
  }
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(plain.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(plain, stored) {
  try {
    const [scheme, N, r, p, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const actual = crypto.scryptSync(String(plain).normalize('NFKC'), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

/* ---------------------------- Oturum ------------------------------ */
export function createSession(userId, { userAgent = '', ip = '' } = {}) {
  const raw = crypto.randomBytes(32).toString('base64url');
  const token = `${raw}.${signToken(raw)}`;
  const expiresAt = new Date(Date.now() + config.sessionTtlHours * 3600_000).toISOString();
  run(
    'INSERT INTO sessions (token, user_id, user_agent, ip, expires_at) VALUES (?, ?, ?, ?, ?)',
    [raw, userId, String(userAgent).slice(0, 250), String(ip).slice(0, 64), expiresAt]
  );
  return { token, expiresAt };
}

function signToken(raw) {
  return crypto.createHmac('sha256', config.sessionSecret).update(raw).digest('base64url');
}

export function resolveSession(token) {
  if (!token || typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot === -1) return null;
  const raw = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = signToken(raw);
  if (sig.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  const row = get(
    `SELECT s.token, s.expires_at, u.id, u.email, u.full_name, u.role, u.campus_id, u.is_active
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?`,
    [raw]
  );
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    run('DELETE FROM sessions WHERE token = ?', [raw]);
    return null;
  }
  if (!row.is_active) return null;
  return {
    sessionToken: raw,
    id: row.id,
    email: row.email,
    fullName: row.full_name,
    role: row.role,
    campusId: row.campus_id,
  };
}

export function destroySession(rawToken) {
  run('DELETE FROM sessions WHERE token = ?', [rawToken]);
}

export function purgeExpiredSessions() {
  run("DELETE FROM sessions WHERE expires_at < datetime('now')");
}

/* ---------------------------- Yetki ------------------------------- */
export const ROLES = [
  'ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI', 'KANTIN_GOREVLISI', 'MUHASEBE', 'DENETCI',
];

const ALL_CAMPUS_ROLES = ['ADMIN', 'GENEL_MUDURLUK', 'MUHASEBE', 'DENETCI'];

// DENETCI hicbir kaydi degistiremez.
const READ_ONLY_ROLES = ['DENETCI'];

/**
 * ON MUHASEBE (MUHASEBE) rolu "veri girisi" rolusdur: belge girer, ONAYLAMAZ.
 *
 * Yazabilecegi alanlar burada ACIKCA sayilir. Varsayilan KAPALIDIR: bir uc
 * `requireWrite(user)` derken alan adi vermezse MUHASEBE oraya yazamaz.
 * Boylece sonradan eklenen bir uc yanlislikla acilmis olmaz.
 *
 * Bilerek DISARIDA birakilanlar:
 *   counts    - sayim kesinlestirme mutabakatin kendisidir
 *   stock     - stok duzeltme/fire/transfer bir duzeltmedir, veri girisi degil
 *   recipes   - urun receteleri maliyeti belirler
 *   campuses  - kurulus tanimi
 *   handovers - teslim fisi OLUSTURMA kantinin isidir; MUHASEBE yalnizca
 *               ONAYLAR ve bu yetki ilgili ucta requireRole ile verilir
 */
const MUHASEBE_WRITE_AREAS = ['purchases', 'suppliers', 'returns', 'products', 'revenues'];

/** Kullanici tum kampusleri gorebiliyor mu? */
export function seesAllCampuses(user) {
  return ALL_CAMPUS_ROLES.includes(user.role);
}

export function requireAuth(user) {
  if (!user) throw unauthorized();
  return user;
}

export function requireRole(user, ...roles) {
  requireAuth(user);
  if (!roles.includes(user.role)) throw forbidden();
  return user;
}

/**
 * Yazma yetkisi kontrolu.
 *
 * @param user
 * @param area MUHASEBE rolunun yazabilecegi alan adi (bkz. MUHASEBE_WRITE_AREAS).
 *             Verilmezse MUHASEBE reddedilir - guvenli varsayilan.
 */
export function requireWrite(user, area = null) {
  requireAuth(user);
  if (READ_ONLY_ROLES.includes(user.role)) {
    throw forbidden('Denetci rolu salt okunurdur, kayit degistiremez.');
  }
  if (user.role === 'MUHASEBE' && !(area && MUHASEBE_WRITE_AREAS.includes(area))) {
    throw forbidden(
      'On muhasebe rolu bu kaydi degistiremez. Yetkiniz: fatura/mal girisi, '
      + 'tedarikci ve odemeler, iadeler, urun karti ve fiyatlar, gunluk ciro girisi. '
      + 'Sayim kesinlestirme, stok duzeltme ve tanimlar disaridadir.'
    );
  }
  return user;
}

/** Bir rolun verilen alana yazip yazamayacagi (arayuzu gizlemek icin). */
export function canWriteArea(user, area) {
  if (!user || READ_ONLY_ROLES.includes(user.role)) return false;
  if (user.role === 'MUHASEBE') return MUHASEBE_WRITE_AREAS.includes(area);
  return true;
}

/**
 * Kullanicinin erisebilecegi kampus id listesi.
 * Tum kampusleri goren roller icin null doner (filtre uygulanmaz).
 */
export function allowedCampusIds(user) {
  if (seesAllCampuses(user)) return null;
  return user.campusId ? [user.campusId] : [];
}

/** Istenen kampus uzerinde islem yapilabilir mi? */
export function assertCampusAccess(user, campusId) {
  requireAuth(user);
  const id = Number(campusId);
  if (!Number.isInteger(id) || id <= 0) throw badRequest('Gecerli bir kampus secilmelidir.');
  if (seesAllCampuses(user)) return id;
  if (user.campusId !== id) throw forbidden('Yalnizca kendi kampusunuz icin islem yapabilirsiniz.');
  return id;
}

/**
 * Sorgulara eklenecek kampus filtresi uretir.
 * @returns {{clause: string, params: number[]}}
 */
export function campusFilter(user, column = 'campus_id', requestedCampusId = null) {
  const requested = requestedCampusId ? Number(requestedCampusId) : null;
  if (seesAllCampuses(user)) {
    return requested
      ? { clause: ` AND ${column} = ?`, params: [requested] }
      : { clause: '', params: [] };
  }
  if (!user.campusId) return { clause: ' AND 1 = 0', params: [] };
  if (requested && requested !== user.campusId) throw forbidden('Bu kampusu goruntuleme yetkiniz yok.');
  return { clause: ` AND ${column} = ?`, params: [user.campusId] };
}

export function listUsersOfCampus(campusId) {
  return all('SELECT id, email, full_name, role FROM users WHERE campus_id = ? AND is_active = 1', [campusId]);
}
