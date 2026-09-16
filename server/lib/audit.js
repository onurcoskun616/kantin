import { insert, all } from '../db.js';

/**
 * Denetim izi kaydi. Kim, ne zaman, neyi degistirdi.
 * Sistemin denetim amacli kullanildigi dusunuldugunde en kritik tablolardandir.
 */
export function logAudit({ user, action, entity, entityId = null, campusId = null, detail = null, ip = null }) {
  insert(
    `INSERT INTO audit_logs (user_id, user_email, action, entity, entity_id, campus_id, detail, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      user?.id ?? null,
      user?.email ?? null,
      action,
      entity,
      entityId,
      campusId,
      detail ? (typeof detail === 'string' ? detail : JSON.stringify(detail)) : null,
      ip,
    ]
  );
}

export function listAudit({ limit = 200, offset = 0, entity = null, campusId = null } = {}) {
  const where = [];
  const params = [];
  if (entity) { where.push('entity = ?'); params.push(entity); }
  if (campusId) { where.push('campus_id = ?'); params.push(Number(campusId)); }
  const sql = `SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY id DESC LIMIT ? OFFSET ?`;
  return all(sql, [...params, Number(limit), Number(offset)]);
}
