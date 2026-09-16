/**
 * Gunluk ciro girisi.
 * Bir kampus icin bir gunde tek kayit tutulur; guncelleme denetim izine yazilir.
 */
import { Router } from '../lib/router.js';
import { all, get, insert, run } from '../db.js';
import { notFound, badRequest, sendCsv, toCsv, conflict } from '../lib/http.js';
import { requireWrite, assertCampusAccess, campusFilter } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, date, bool, today, monthRange, arr } from '../lib/validate.js';
import { round2 } from '../lib/money.js';

export const revenueRoutes = new Router();

revenueRoutes.get('/', async (ctx) => {
  const f = campusFilter(ctx.user, 'r.campus_id', ctx.query.campusId);
  const params = [...f.params];
  let extra = '';
  if (ctx.query.month) {
    const { from, to } = monthRange(ctx.query.month);
    extra += ' AND r.revenue_date BETWEEN ? AND ?';
    params.push(from, to);
  } else {
    if (ctx.query.from) { extra += ' AND r.revenue_date >= ?'; params.push(ctx.query.from); }
    if (ctx.query.to) { extra += ' AND r.revenue_date <= ?'; params.push(ctx.query.to); }
  }

  const items = all(
    `SELECT r.*, k.name AS campus_name, u.full_name AS created_by_name, uu.full_name AS updated_by_name
       FROM daily_revenues r
       JOIN campuses k ON k.id = r.campus_id
       LEFT JOIN users u  ON u.id = r.created_by
       LEFT JOIN users uu ON uu.id = r.updated_by
      WHERE 1 = 1 ${f.clause} ${extra}
      ORDER BY r.revenue_date DESC, k.name LIMIT ?`,
    [...params, Number(ctx.query.limit || 400)]
  );

  const summary = items.reduce((acc, r) => {
    acc.total += r.total_amount;
    acc.cash += r.cash_amount;
    acc.card += r.card_amount;
    acc.credit += r.credit_amount;
    acc.schoolDays += r.is_school_day ? 1 : 0;
    return acc;
  }, { total: 0, cash: 0, card: 0, credit: 0, schoolDays: 0, dayCount: items.length });
  for (const k of ['total', 'cash', 'card', 'credit']) summary[k] = round2(summary[k]);
  summary.dailyAverage = summary.schoolDays > 0 ? round2(summary.total / summary.schoolDays) : 0;

  if (ctx.query.format === 'csv') {
    return sendCsv(ctx.res, 'gunluk-ciro.csv', toCsv(items, [
      { label: 'Tarih', key: 'revenue_date' },
      { label: 'Kampüs', key: 'campus_name' },
      { label: 'Nakit', value: (r) => tr(r.cash_amount) },
      { label: 'Kart', value: (r) => tr(r.card_amount) },
      { label: 'Veresiye / Kart Bakiyesi', value: (r) => tr(r.credit_amount) },
      { label: 'Diğer', value: (r) => tr(r.other_amount) },
      { label: 'Toplam', value: (r) => tr(r.total_amount) },
      { label: 'Z No', key: 'z_report_no' },
      { label: 'Okul Günü', value: (r) => (r.is_school_day ? 'Evet' : 'Hayir') },
      { label: 'Not', key: 'note' },
    ]));
  }
  return { items, summary };
});

/** Bir ayin gun gun ciro takvimi - eksik gunleri de gosterir. */
revenueRoutes.get('/calendar', async (ctx) => {
  const campusId = assertCampusAccess(ctx.user, ctx.query.campusId);
  const month = str(ctx.query.month, 'Ay', { required: true, max: 7 });
  const { from, to } = monthRange(month);
  const rows = all(
    'SELECT * FROM daily_revenues WHERE campus_id = ? AND revenue_date BETWEEN ? AND ? ORDER BY revenue_date',
    [campusId, from, to]
  );
  const byDate = new Map(rows.map((r) => [r.revenue_date, r]));

  const days = [];
  let cursor = from;
  while (cursor <= to) {
    const d = new Date(`${cursor}T00:00:00Z`);
    const weekday = d.getUTCDay(); // 0 pazar, 6 cumartesi
    const entry = byDate.get(cursor) || null;
    days.push({
      date: cursor,
      weekday,
      isWeekend: weekday === 0 || weekday === 6,
      entry,
      missing: !entry && weekday !== 0 && weekday !== 6 && cursor <= today(),
    });
    const next = new Date(d);
    next.setUTCDate(next.getUTCDate() + 1);
    cursor = next.toISOString().slice(0, 10);
  }

  const total = round2(rows.reduce((s, r) => s + r.total_amount, 0));
  return {
    month, from, to, days,
    summary: {
      total,
      entryCount: rows.length,
      missingCount: days.filter((d) => d.missing).length,
      schoolDays: rows.filter((r) => r.is_school_day).length,
      dailyAverage: rows.length ? round2(total / rows.filter((r) => r.is_school_day).length || 0) : 0,
    },
  };
});

revenueRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user);
  const d = parseRevenue(ctx.user, ctx.body);
  const existing = get('SELECT * FROM daily_revenues WHERE campus_id = ? AND revenue_date = ?', [d.campusId, d.revenueDate]);
  if (existing && !ctx.body.overwrite) {
    throw conflict(`${d.revenueDate} tarihi icin zaten ciro girilmis (${existing.total_amount} TL). Guncellemek icin duzenleyin.`);
  }
  assertRevenueEditable(d.campusId, d.revenueDate, ctx.user);

  let id;
  if (existing) {
    run(
      `UPDATE daily_revenues SET cash_amount = ?, card_amount = ?, credit_amount = ?, other_amount = ?,
              total_amount = ?, z_report_no = ?, is_school_day = ?, note = ?, updated_by = ?, updated_at = datetime('now')
        WHERE id = ?`,
      [d.cash, d.card, d.credit, d.other, d.total, d.zReportNo, d.isSchoolDay ? 1 : 0, d.note, ctx.user.id, existing.id]
    );
    id = existing.id;
    logAudit({ user: ctx.user, action: 'UPDATE', entity: 'daily_revenues', entityId: id, campusId: d.campusId,
      detail: { date: d.revenueDate, oldTotal: existing.total_amount, newTotal: d.total }, ip: ctx.ip });
  } else {
    id = insert(
      `INSERT INTO daily_revenues (campus_id, revenue_date, cash_amount, card_amount, credit_amount, other_amount,
                                   total_amount, z_report_no, is_school_day, note, created_by, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [d.campusId, d.revenueDate, d.cash, d.card, d.credit, d.other, d.total, d.zReportNo,
       d.isSchoolDay ? 1 : 0, d.note, ctx.user.id, ctx.user.id]
    );
    logAudit({ user: ctx.user, action: 'CREATE', entity: 'daily_revenues', entityId: id, campusId: d.campusId,
      detail: { date: d.revenueDate, total: d.total }, ip: ctx.ip });
  }
  return get('SELECT * FROM daily_revenues WHERE id = ?', [id]);
});

/** Toplu giris - bir haftalik/aylik ciroyu tek seferde girmek icin. */
revenueRoutes.post('/bulk', async (ctx) => {
  requireWrite(ctx.user);
  const items = arr(ctx.body.items, 'Kayitlar', { required: true, min: 1 });
  const result = { saved: 0, errors: [] };
  for (const [i, raw] of items.entries()) {
    try {
      const d = parseRevenue(ctx.user, { ...raw, campusId: raw.campusId ?? ctx.body.campusId });
      assertRevenueEditable(d.campusId, d.revenueDate, ctx.user);
      run(
        `INSERT INTO daily_revenues (campus_id, revenue_date, cash_amount, card_amount, credit_amount, other_amount,
                                     total_amount, z_report_no, is_school_day, note, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(campus_id, revenue_date) DO UPDATE SET
           cash_amount = excluded.cash_amount, card_amount = excluded.card_amount,
           credit_amount = excluded.credit_amount, other_amount = excluded.other_amount,
           total_amount = excluded.total_amount, z_report_no = excluded.z_report_no,
           is_school_day = excluded.is_school_day, note = excluded.note,
           updated_by = excluded.updated_by, updated_at = datetime('now')`,
        [d.campusId, d.revenueDate, d.cash, d.card, d.credit, d.other, d.total, d.zReportNo,
         d.isSchoolDay ? 1 : 0, d.note, ctx.user.id, ctx.user.id]
      );
      result.saved += 1;
    } catch (err) {
      result.errors.push({ row: i + 1, message: err.message });
    }
  }
  logAudit({ user: ctx.user, action: 'BULK_SAVE', entity: 'daily_revenues', detail: result, ip: ctx.ip });
  return result;
});

revenueRoutes.delete('/:id', async (ctx) => {
  requireWrite(ctx.user);
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM daily_revenues WHERE id = ?', [id]);
  if (!row) throw notFound('Ciro kaydi bulunamadi.');
  assertCampusAccess(ctx.user, row.campus_id);
  assertRevenueEditable(row.campus_id, row.revenue_date, ctx.user);
  run('DELETE FROM daily_revenues WHERE id = ?', [id]);
  logAudit({ user: ctx.user, action: 'DELETE', entity: 'daily_revenues', entityId: id, campusId: row.campus_id,
    detail: { date: row.revenue_date, total: row.total_amount }, ip: ctx.ip });
  return { ok: true };
});

function parseRevenue(user, body) {
  const campusId = assertCampusAccess(user, body.campusId);
  const revenueDate = date(body.revenueDate, 'Tarih', { required: true });
  if (revenueDate > today()) throw badRequest('Gelecek tarihli ciro girilemez.');
  const cash = num(body.cashAmount, 'Nakit', { min: 0, def: 0 }) ?? 0;
  const card = num(body.cardAmount, 'Kredi karti', { min: 0, def: 0 }) ?? 0;
  const credit = num(body.creditAmount, 'Veresiye/Ogrenci karti', { min: 0, def: 0 }) ?? 0;
  const other = num(body.otherAmount, 'Diger', { min: 0, def: 0 }) ?? 0;
  const total = round2(cash + card + credit + other);
  if (total <= 0 && !body.allowZero) throw badRequest('Toplam ciro sifirdan buyuk olmalidir. Okulun kapali oldugu gunler icin kayit girmeyin.');
  return {
    campusId, revenueDate, cash, card, credit, other, total,
    zReportNo: str(body.zReportNo, 'Z rapor no', { max: 40 }),
    isSchoolDay: bool(body.isSchoolDay, true),
    note: str(body.note, 'Not', { max: 300 }),
  };
}

/** Kesinlesmis sayim donemine ait ciro yalnizca yonetici tarafindan degistirilebilir. */
function assertRevenueEditable(campusId, revenueDate, user) {
  const locked = get(
    "SELECT id, count_date FROM counts WHERE campus_id = ? AND status = 'KESINLESMIS' AND count_date >= ? LIMIT 1",
    [campusId, revenueDate]
  );
  if (locked && !['ADMIN', 'GENEL_MUDURLUK'].includes(user.role)) {
    throw conflict(`${locked.count_date} tarihli kesinlesmis sayim bu gunu kapsiyor. Degisiklik icin genel mudurluge basvurun.`);
  }
}

const tr = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
