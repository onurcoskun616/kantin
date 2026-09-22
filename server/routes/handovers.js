/**
 * CIRO TESLIM FISI
 *
 * Gunluk ciro sistemden ciktisi alinip kantin gorevlisi tarafindan on
 * muhasebeye imza karsiligi teslim edilir. Bu modul o belgeyi uretir.
 *
 * Belgenin denetim degeri, tutari DONDURMASINDAN gelir: fis olusturuldugu
 * anda o gunlerin cirosu belge uzerine yazilir ve saklanir. Imzalanan kagit
 * ile sistemdeki rakam sonradan ayrisirsa imza anlamini yitirecegi icin:
 *
 *   - Fise dahil gunlerin cirosunu kantin gorevlisi degistiremez
 *   - Genel mudurluk degistirirse fis 'FARKLI' olarak isaretlenir; kagittaki
 *     tutar ile sistemdeki tutar yan yana gorunur ve denetim izine yazilir
 *   - Fisi YALNIZCA sistem yoneticisi silebilir. Imzalanmis bir belgenin
 *     karsiligi sistemden gelisiguzel kaldirilamamali; ama yanlis donemle ya
 *     da yanlis kisi adina acilmis bir fis de sonsuza kadar duramaz. Silme
 *     gerekce ister, tam icerigiyle denetim izine yazilir ve fise dahil
 *     gunleri serbest birakir (yeniden teslim edilebilsinler).
 *
 * Dogrulama kodu: kagidin uzerindeki tutarin degistirilmedigini on muhasebenin
 * sisteme girmeden kontrol edebilmesi icin belge iceriginden uretilen kisa koddur.
 */
import crypto from 'node:crypto';
import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, badRequest, conflict } from '../lib/http.js';
import { requireWrite, requireRole, assertCampusAccess, campusFilter } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, date, today } from '../lib/validate.js';
import { round2, amountInWords } from '../lib/money.js';
import { config } from '../config.js';

export const handoverRoutes = new Router();

/* --------------------------- Dogrulama kodu ------------------------ */
/** Belge iceriginden uretilen, kagidin uzerine basilan kisa dogrulama kodu. */
function verificationCode({ documentNo, campusId, from, to, total }) {
  const payload = `${documentNo}|${campusId}|${from}|${to}|${total.toFixed(2)}`;
  const digest = crypto.createHmac('sha256', config.sessionSecret).update(payload).digest('base64url');
  // Karisabilecek karakterleri (0/O, 1/I/l) disarida birakiyoruz
  return digest.replace(/[^A-HJ-NP-Z2-9]/gi, '').toUpperCase().slice(0, 6);
}

/* ----------------------------- Listeleme --------------------------- */
handoverRoutes.get('/', async (ctx) => {
  const f = campusFilter(ctx.user, 'h.campus_id', ctx.query.campusId);
  const params = [...f.params];
  let extra = '';
  if (ctx.query.from) { extra += ' AND h.period_to >= ?'; params.push(ctx.query.from); }
  if (ctx.query.to) { extra += ' AND h.period_from <= ?'; params.push(ctx.query.to); }
  if (ctx.query.status) { extra += ' AND h.status = ?'; params.push(ctx.query.status); }

  const items = all(
    `SELECT h.*, k.name AS campus_name, k.code AS campus_code,
            u.full_name AS confirmed_by_name,
            (SELECT COALESCE(SUM(r.total_amount), 0) FROM daily_revenues r WHERE r.handover_id = h.id)
              AS current_total
       FROM revenue_handovers h
       JOIN campuses k ON k.id = h.campus_id
       LEFT JOIN users u ON u.id = h.received_by_user
      WHERE 1 = 1 ${f.clause} ${extra}
      ORDER BY h.period_from DESC, h.id DESC LIMIT ?`,
    [...params, Number(ctx.query.limit || 200)]
  );

  return {
    items: items.map(decorate),
    summary: {
      documentCount: items.length,
      totalAmount: round2(items.reduce((s, h) => s + h.total_amount, 0)),
      pendingConfirm: items.filter((h) => h.status === 'TESLIM_EDILDI').length,
      mismatched: items.filter((h) => h.status === 'FARKLI').length,
    },
  };
});

/** Fise dahil olmayan, ciro girilmis gunler — teslim edilmeyi bekleyenler. */
handoverRoutes.get('/pending', async (ctx) => {
  const f = campusFilter(ctx.user, 'r.campus_id', ctx.query.campusId);
  const rows = all(
    `SELECT r.campus_id, k.name AS campus_name, r.revenue_date, r.total_amount
       FROM daily_revenues r JOIN campuses k ON k.id = r.campus_id
      WHERE r.handover_id IS NULL ${f.clause}
      ORDER BY r.campus_id, r.revenue_date`,
    f.params
  );

  const byCampus = new Map();
  for (const row of rows) {
    const g = byCampus.get(row.campus_id) || {
      campusId: row.campus_id, campusName: row.campus_name, days: [], total: 0,
    };
    g.days.push({ date: row.revenue_date, amount: row.total_amount });
    g.total += row.total_amount;
    byCampus.set(row.campus_id, g);
  }

  return {
    items: [...byCampus.values()].map((g) => ({
      ...g,
      total: round2(g.total),
      dayCount: g.days.length,
      oldestDate: g.days[0]?.date ?? null,
      // Uzun sure teslim edilmemis ciro, kasada bekleyen nakit demektir
      waitingDays: g.days[0] ? daysBetween(g.days[0].date, today()) : 0,
    })),
    totalPending: round2(rows.reduce((s, r) => s + r.total_amount, 0)),
  };
});

/* ------------------------------ Detay ------------------------------ */
handoverRoutes.get('/:id', async (ctx) => {
  const header = get(
    `SELECT h.*, k.name AS campus_name, k.code AS campus_code, u.full_name AS confirmed_by_name
       FROM revenue_handovers h JOIN campuses k ON k.id = h.campus_id
       LEFT JOIN users u ON u.id = h.received_by_user
      WHERE h.id = ?`,
    [Number(ctx.params.id)]
  );
  if (!header) throw notFound('Teslim fisi bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);

  const days = all(
    `SELECT revenue_date, cash_amount, card_amount, credit_amount, other_amount, total_amount, z_report_no, note
       FROM daily_revenues WHERE handover_id = ? ORDER BY revenue_date`,
    [header.id]
  );
  const currentTotal = round2(days.reduce((s, d) => s + d.total_amount, 0));

  return {
    ...decorate({ ...header, current_total: currentTotal }),
    days,
    amountInWords: amountInWords(header.total_amount),
  };
});

/* --------------------------- Fis olusturma ------------------------- */
handoverRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user);
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const campus = get('SELECT * FROM campuses WHERE id = ?', [campusId]);

  const from = date(ctx.body.from, 'Baslangic tarihi', { required: true });
  const to = date(ctx.body.to, 'Bitis tarihi', { def: from }) ?? from;
  if (to < from) throw badRequest('Bitis tarihi baslangictan once olamaz.');
  if (to > today()) throw badRequest('Gelecek tarihli teslim fisi olusturulamaz.');

  const receivedByName = str(ctx.body.receivedByName, 'Teslim alan kisi', { required: true, max: 150, min: 3 });
  const note = str(ctx.body.note, 'Aciklama', { max: 300 });

  const rows = all(
    `SELECT * FROM daily_revenues
      WHERE campus_id = ? AND revenue_date BETWEEN ? AND ?
      ORDER BY revenue_date`,
    [campusId, from, to]
  );
  if (!rows.length) throw badRequest('Bu tarih araliginda ciro kaydi yok.');

  const already = rows.filter((r) => r.handover_id);
  if (already.length) {
    const doc = get('SELECT document_no FROM revenue_handovers WHERE id = ?', [already[0].handover_id]);
    throw conflict(
      `${already[0].revenue_date} tarihli ciro zaten ${doc?.document_no ?? '#' + already[0].handover_id} `
      + `numarali fise dahil. Ayni gun iki kez teslim edilemez.`
    );
  }

  const sum = (key) => round2(rows.reduce((s, r) => s + r[key], 0));
  const total = sum('total_amount');

  const handoverId = tx(() => {
    const documentNo = nextDocumentNo(campus, to);
    const code = verificationCode({ documentNo, campusId, from, to, total });

    const id = insert(
      `INSERT INTO revenue_handovers
         (campus_id, document_no, period_from, period_to, day_count,
          cash_amount, card_amount, credit_amount, other_amount, total_amount,
          verification_code, delivered_by, delivered_by_name, received_by_name, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [campusId, documentNo, from, to, rows.length,
       sum('cash_amount'), sum('card_amount'), sum('credit_amount'), sum('other_amount'), total,
       code, ctx.user.id, ctx.user.fullName, receivedByName, note]
    );
    for (const row of rows) run('UPDATE daily_revenues SET handover_id = ? WHERE id = ?', [id, row.id]);
    return id;
  });

  logAudit({
    user: ctx.user, action: 'CREATE', entity: 'revenue_handovers', entityId: handoverId, campusId,
    detail: { from, to, total, dayCount: rows.length, receivedByName }, ip: ctx.ip,
  });
  return getDetail(handoverId);
});

/* ------------------- On muhasebe sistemde onaylar ------------------- */
handoverRoutes.post('/:id/confirm', async (ctx) => {
  // MUHASEBE rolu genel yazma yetkisine sahip degildir; bu uc ona ACIKCA acilir
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK', 'MUHASEBE');
  const header = get('SELECT * FROM revenue_handovers WHERE id = ?', [Number(ctx.params.id)]);
  if (!header) throw notFound('Teslim fisi bulunamadi.');
  if (header.status === 'ONAYLANDI') throw conflict('Bu fis zaten onaylanmis.');

  const code = str(ctx.body.verificationCode, 'Dogrulama kodu', { required: true, max: 10 }).toUpperCase();
  if (code !== header.verification_code) {
    throw badRequest('Dogrulama kodu belgeyle eslesmiyor. Elinizdeki kagit sistemdeki kayitla ayni belge degil.');
  }

  run("UPDATE revenue_handovers SET status = 'ONAYLANDI', received_by_user = ?, received_at = datetime('now') WHERE id = ?",
    [ctx.user.id, header.id]);
  logAudit({
    user: ctx.user, action: 'CONFIRM_HANDOVER', entity: 'revenue_handovers', entityId: header.id,
    campusId: header.campus_id, detail: { documentNo: header.document_no, total: header.total_amount }, ip: ctx.ip,
  });
  return getDetail(header.id);
});

/* ------------------------------- Silme ------------------------------ */
/**
 * Teslim fisini KALICI olarak siler — yalnizca SISTEM YONETICISI.
 *
 * Neden bu kadar dar bir yetki?
 *   Fis, imzalanmis bir kagidin sistemdeki karsiligidir. Silinmesi o
 *   imzanin karsiligini ortadan kaldirir; genel mudurluk ya da on muhasebe
 *   icin bile fazla agir bir yetkidir. Ama yanlis donemle ya da yanlis kisi
 *   adina acilmis bir fisin da bir cikisi olmali: aksi halde o gunlerin
 *   cirosu sonsuza kadar kilitli kalir ve yeniden teslim edilemez.
 *
 * Silme sonrasi fise dahil gunler SERBEST KALIR (handover_id = NULL), yani
 * dogru fis yeniden olusturulabilir. Belgenin tam icerigi denetim izine
 * yazilir: silinen bir belgenin ne oldugu sonradan okunabilmelidir.
 */
handoverRoutes.delete('/:id', async (ctx) => {
  requireRole(ctx.user, 'ADMIN');
  const id = Number(ctx.params.id);
  const header = get('SELECT * FROM revenue_handovers WHERE id = ?', [id]);
  if (!header) throw notFound('Teslim fisi bulunamadi.');

  // Gerekce ZORUNLU: imzali bir belge sebepsiz silinmemeli.
  const reason = str(ctx.body.reason, 'Silme gerekcesi', { required: true, max: 300, min: 10 });
  // Yanlis fisin kazara silinmesine karsi: belge numarasi elle yazilir.
  const onay = str(ctx.body.documentNo, 'Belge numarasi', { required: true, max: 60 });
  if (onay.trim().toUpperCase() !== String(header.document_no).toUpperCase()) {
    throw badRequest(
      `Yazdiginiz belge numarasi bu fisle eslesmedi. Silmek icin "${header.document_no}" yazin.`
    );
  }

  const gunler = all(
    'SELECT id, revenue_date, total_amount FROM daily_revenues WHERE handover_id = ? ORDER BY revenue_date',
    [id]
  );

  tx(() => {
    // Gunler once serbest birakilir; fis satiri sonra gider.
    run('UPDATE daily_revenues SET handover_id = NULL WHERE handover_id = ?', [id]);
    run('DELETE FROM revenue_handovers WHERE id = ?', [id]);
  });

  logAudit({
    user: ctx.user, action: 'DELETE', entity: 'revenue_handovers', entityId: id,
    campusId: header.campus_id,
    detail: {
      gerekce: reason,
      documentNo: header.document_no,
      donem: `${header.period_from} - ${header.period_to}`,
      gunSayisi: header.day_count,
      tutar: header.total_amount,
      durum: header.status,
      teslimEden: header.delivered_by_name,
      teslimAlan: header.received_by_name,
      dogrulamaKodu: header.verification_code,
      serbestKalanGunler: gunler.map((g) => ({ tarih: g.revenue_date, tutar: g.total_amount })),
    },
    ip: ctx.ip,
  });
  return { ok: true, releasedDays: gunler.length, documentNo: header.document_no };
});

/* --------------------------- Belge dogrulama ----------------------- */
/** Elindeki kagidin belge no + kodunu girip tutari dogrulamak icin. */
handoverRoutes.get('/verify/:documentNo', async (ctx) => {
  const header = get(
    `SELECT h.*, k.name AS campus_name FROM revenue_handovers h
       JOIN campuses k ON k.id = h.campus_id WHERE h.document_no = ?`,
    [String(ctx.params.documentNo).toUpperCase()]
  );
  if (!header) throw notFound('Bu belge numarasi sistemde kayitli degil.');
  assertCampusAccess(ctx.user, header.campus_id);

  const code = String(ctx.query.code || '').toUpperCase();
  const matches = code === header.verification_code;
  const currentTotal = round2(get(
    'SELECT COALESCE(SUM(total_amount), 0) AS t FROM daily_revenues WHERE handover_id = ?', [header.id]
  ).t);

  return {
    documentNo: header.document_no,
    campusName: header.campus_name,
    period: { from: header.period_from, to: header.period_to },
    paperTotal: header.total_amount,
    systemTotal: currentTotal,
    codeMatches: matches,
    changedAfterHandover: round2(currentTotal - header.total_amount) !== 0,
    status: header.status,
    amountInWords: amountInWords(header.total_amount),
  };
});

/* ----------------------------- yardimcilar ------------------------- */
function decorate(row) {
  const difference = round2((row.current_total ?? row.total_amount) - row.total_amount);
  return {
    ...row,
    current_total: round2(row.current_total ?? row.total_amount),
    difference,
    has_mismatch: difference !== 0,
  };
}

function getDetail(id) {
  const header = get(
    `SELECT h.*, k.name AS campus_name, k.code AS campus_code, u.full_name AS confirmed_by_name
       FROM revenue_handovers h JOIN campuses k ON k.id = h.campus_id
       LEFT JOIN users u ON u.id = h.received_by_user WHERE h.id = ?`, [id]
  );
  const days = all(
    `SELECT revenue_date, cash_amount, card_amount, credit_amount, other_amount, total_amount, z_report_no, note
       FROM daily_revenues WHERE handover_id = ? ORDER BY revenue_date`, [id]
  );
  const currentTotal = round2(days.reduce((s, d) => s + d.total_amount, 0));
  return {
    ...decorate({ ...header, current_total: currentTotal }),
    days,
    amountInWords: amountInWords(header.total_amount),
  };
}

/** Kampus ve yila gore sirali belge no: IKT-2026-0001 */
function nextDocumentNo(campus, referenceDate) {
  const year = referenceDate.slice(0, 4);
  const prefix = `${campus.code}-${year}-`;
  const last = get(
    "SELECT document_no FROM revenue_handovers WHERE document_no LIKE ? ORDER BY document_no DESC LIMIT 1",
    [`${prefix}%`]
  );
  const next = last ? Number(last.document_no.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

function daysBetween(fromStr, toStr) {
  const a = new Date(`${fromStr}T00:00:00Z`);
  const b = new Date(`${toStr}T00:00:00Z`);
  return Math.max(0, Math.round((b - a) / 86400000));
}

/**
 * Bir ciro kaydi teslim fisine dahilse degistirilebilir mi?
 * Gorevli degistiremez; genel mudurluk degistirirse fis 'FARKLI' isaretlenir.
 */
export function handoverGuard(revenueRow, user) {
  if (!revenueRow?.handover_id) return null;
  const handover = get('SELECT * FROM revenue_handovers WHERE id = ?', [revenueRow.handover_id]);
  if (!handover) return null;

  if (!['ADMIN', 'GENEL_MUDURLUK'].includes(user.role)) {
    throw conflict(
      `${revenueRow.revenue_date} tarihli ciro, ${handover.document_no} numarali imzali teslim fisine dahil. `
      + 'Degisiklik icin genel mudurluge basvurun.'
    );
  }
  return handover;
}

/** Teslim edilmis ciro degistiginde fisi 'FARKLI' olarak isaretler. */
export function markHandoverMismatch(handover, user, detail) {
  if (!handover) return;
  run("UPDATE revenue_handovers SET status = 'FARKLI' WHERE id = ? AND status <> 'FARKLI'", [handover.id]);
  logAudit({
    user, action: 'HANDOVER_MISMATCH', entity: 'revenue_handovers', entityId: handover.id,
    campusId: handover.campus_id,
    detail: { documentNo: handover.document_no, paperTotal: handover.total_amount, ...detail },
  });
}
