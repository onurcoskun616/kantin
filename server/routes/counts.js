/**
 * SAYIM (envanter) modulu - sistemin denetim cekirdegi.
 *
 * Donem satisi   = (kayitlara gore olmasi gereken stok) - (fiilen sayilan stok)
 * Beklenen ciro  = SUM(donem satisi x satis fiyati) + uretilen urun satislari
 * Fark           = Gerceklesen ciro (gunluk ciro girisleri) - Beklenen ciro
 *
 * Denetim kontrolleri (bkz. docs/DENETIM-KONTROLLERI.md):
 *   1. KOR SAYIM      Miktar girilirken "olmasi gereken" gizlidir. Sayan kisi
 *                     hedef rakami goremez; sapmalar ancak kilitledikten sonra acilir.
 *   2. IKI IMZA       Sayimi kilitleyen ile kesinlestiren ayni kisi olamaz;
 *                     sayima katilan ikinci kisinin adi kayda gecer.
 *   3. URETILEN URUN  Tost/cay gibi raftan sayilamayan urunler ayri kalemdir;
 *                     beyan edilen adetler mutabakatta ayrica gosterilir.
 *                     Recete tanimliysa: beyan edilen adedin gerektirdigi
 *                     hammadde, o hammaddenin sayim farkindan DUSULUR; geriye
 *                     kalan aciklanamayan tuketimdir (bkz. lib/recipe.js).
 *   4. NOKTA SAYIMI   Habersiz ara sayim. Stoga dokunmaz, donemi kapatmaz;
 *                     silinemez bir tespit kaydi birakir.
 *
 * Durumlar: TASLAK -> SAYILDI -> KESINLESMIS
 */
import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, badRequest, conflict, forbidden, sendCsv, toCsv } from '../lib/http.js';
import { requireWrite, assertCampusAccess, campusFilter, requireRole } from '../lib/auth.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, date, arr, today, oneOf } from '../lib/validate.js';
import { stockSnapshot, addMovement, effectivePrices } from '../lib/stock.js';
import { round2, round4, netFromGross, pctOf } from '../lib/money.js';
import { recipeConsumption, recipeUnitCost } from '../lib/recipe.js';

export const countRoutes = new Router();

/* ----------------------------- Listeleme --------------------------- */
countRoutes.get('/', async (ctx) => {
  const f = campusFilter(ctx.user, 'c.campus_id', ctx.query.campusId);
  const extra = ctx.query.type ? ' AND c.count_type = ?' : '';
  const params = [...f.params];
  if (ctx.query.type) params.push(ctx.query.type);

  const items = all(
    `SELECT c.*, k.name AS campus_name,
            u.full_name  AS created_by_name,
            su.full_name AS submitted_by_name,
            fu.full_name AS finalized_by_name,
            (SELECT COUNT(*) FROM count_lines l WHERE l.count_id = c.id) AS line_count
       FROM counts c
       JOIN campuses k ON k.id = c.campus_id
       LEFT JOIN users u  ON u.id = c.created_by
       LEFT JOIN users su ON su.id = c.submitted_by
       LEFT JOIN users fu ON fu.id = c.finalized_by
      WHERE 1 = 1 ${f.clause} ${extra}
      ORDER BY c.count_date DESC, c.id DESC LIMIT ?`,
    [...params, Number(ctx.query.limit || 100)]
  );
  return { items: items.map(withVariance) };
});

/* ------------------------ Yeni sayim (taslak) ---------------------- */
countRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user);
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const countType = oneOf(ctx.body.countType, 'Sayim tipi', ['DONEM', 'NOKTA'], { def: 'DONEM' });
  const countDate = date(ctx.body.countDate, 'Sayim tarihi', { def: today() });
  const note = str(ctx.body.note, 'Aciklama', { max: 500 });
  // Kor sayim varsayilandir. Kapatmak bilincli bir yonetim karari oldugu icin
  // yalnizca genel mudurluk/admin tarafindan ve denetim izine yazilarak yapilabilir.
  let isBlind = true;
  if (ctx.body.isBlind === false) {
    requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
    isBlind = false;
  }

  if (countDate > today()) throw badRequest('Gelecek tarihli sayim olusturulamaz.');

  const openDraft = get(
    "SELECT id FROM counts WHERE campus_id = ? AND count_type = ? AND status IN ('TASLAK','SAYILDI')",
    [campusId, countType]
  );
  if (openDraft) {
    throw conflict(`Bu kampuste tamamlanmamis bir ${countType === 'NOKTA' ? 'nokta' : 'donem'} sayimi var (#${openDraft.id}). Once onu tamamlayin veya silin.`);
  }

  let periodStart = null;
  if (countType === 'DONEM') {
    const last = lastFinalizedCount(campusId);
    if (last && countDate <= last.count_date) {
      throw badRequest(`Son kesinlesmis sayim ${last.count_date} tarihli. Sayim tarihi bundan sonra olmalidir.`);
    }
    periodStart = last ? addDays(last.count_date, 1) : null;
  }

  // Nokta sayiminda yalnizca secilen urunler sayilir
  const selectedIds = countType === 'NOKTA'
    ? arr(ctx.body.productIds, 'Urunler', { required: true, min: 1 }).map((id) => Number(id))
    : null;

  const countId = tx(() => {
    const id = insert(
      `INSERT INTO counts (campus_id, count_date, period_start, count_type, status, is_blind, note, created_by)
       VALUES (?, ?, ?, ?, 'TASLAK', ?, ?, ?)`,
      [campusId, countDate, periodStart, countType, isBlind ? 1 : 0, note, ctx.user.id]
    );

    const snapshot = stockSnapshot(campusId, { untilDate: countDate })
      .filter((p) => !selectedIds || selectedIds.includes(p.product_id));
    if (!snapshot.length) throw badRequest('Sayilacak urun bulunamadi.');

    for (const p of snapshot) {
      insert(
        `INSERT INTO count_lines (count_id, product_id, expected_qty, counted_qty, diff_qty, sold_qty,
                                  purchase_price, sale_price, vat_rate)
         VALUES (?, ?, ?, 0, 0, 0, ?, ?, ?)`,
        [id, p.product_id, p.stock_qty, p.purchase_price, p.sale_price, p.vat_rate]
      );
    }

    // Donem sayiminda uretilen urunler icin beyan satirlari hazirlanir
    if (countType === 'DONEM') {
      for (const p of producedProducts(campusId)) {
        insert(
          `INSERT INTO production_sales (count_id, product_id, quantity, purchase_price, sale_price, vat_rate)
           VALUES (?, ?, 0, ?, ?, ?)`,
          [id, p.id, p.purchase_price, p.sale_price, p.vat_rate]
        );
      }
    }
    return id;
  });

  logAudit({
    user: ctx.user, action: 'CREATE', entity: 'counts', entityId: countId, campusId,
    detail: { countDate, countType, isBlind }, ip: ctx.ip,
  });
  return loadCount(countId, ctx.user);
});

/* --------------------------- Sayim detayi -------------------------- */
countRoutes.get('/:id', async (ctx) => {
  const data = loadCount(Number(ctx.params.id), ctx.user);
  assertCampusAccess(ctx.user, data.campus_id);

  if (ctx.query.format === 'csv') {
    if (data.blind_active) throw conflict('Kor sayim tamamlanmadan fis disari aktarilamaz.');
    return sendCsv(ctx.res, `sayim-${data.id}.csv`, toCsv(data.lines, [
      { label: 'Barkod', key: 'barcode' },
      { label: 'Ürün', key: 'product_name' },
      { label: 'Birim', key: 'unit' },
      { label: 'Olması Gereken', value: (r) => tr(r.expected_qty) },
      { label: 'Sayılan', value: (r) => tr(r.counted_qty) },
      { label: 'Fark', value: (r) => tr(r.diff_qty) },
      { label: 'Dönem Satışı', value: (r) => tr(r.sold_qty) },
      { label: 'Satış Fiyatı', value: (r) => tr(r.sale_price) },
      { label: 'Satış Tutarı', value: (r) => tr(r.sales_value) },
      { label: 'Maliyet', value: (r) => tr(r.cost_value) },
    ]));
  }
  return data;
});

/* ----------------------- Sayilan miktar girisi --------------------- */
countRoutes.put('/:id/lines', async (ctx) => {
  requireWrite(ctx.user);
  const header = requireDraft(ctx, 'Sayim satirlari');
  const lines = arr(ctx.body.lines, 'Satirlar', { required: true, min: 1 });

  let updated = 0;
  tx(() => {
    for (const [i, raw] of lines.entries()) {
      const productId = int(raw.productId, `Satir ${i + 1} urun`, { required: true });
      const countedQty = num(raw.countedQty, `Satir ${i + 1} sayilan`, { required: true, min: 0 });
      const existing = get('SELECT * FROM count_lines WHERE count_id = ? AND product_id = ?', [header.id, productId]);
      if (!existing) {
        // Sayim fisi acildiktan sonra eklenen urun
        const snap = stockSnapshot(header.campus_id, { untilDate: header.count_date })
          .find((p) => p.product_id === productId);
        if (!snap) throw badRequest(`Satir ${i + 1}: urun bulunamadi.`);
        insert(
          `INSERT INTO count_lines (count_id, product_id, expected_qty, counted_qty, diff_qty, sold_qty,
                                    purchase_price, sale_price, vat_rate)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
          [header.id, productId, snap.stock_qty, countedQty, round2(countedQty - snap.stock_qty),
           snap.purchase_price, snap.sale_price, snap.vat_rate]
        );
      } else {
        run('UPDATE count_lines SET counted_qty = ?, diff_qty = ? WHERE id = ?',
          [countedQty, round2(countedQty - existing.expected_qty), existing.id]);
      }
      updated += 1;
    }
  });
  return { ok: true, updated };
});

/* ------------------ Uretilen urun satis beyani --------------------- */
countRoutes.put('/:id/production', async (ctx) => {
  requireWrite(ctx.user);
  const header = requireDraft(ctx, 'Uretim satislari');
  if (header.count_type !== 'DONEM') throw badRequest('Uretim satisi yalnizca donem sayiminda girilir.');
  const lines = arr(ctx.body.lines, 'Satirlar', { required: true, min: 1 });

  tx(() => {
    for (const [i, raw] of lines.entries()) {
      const productId = int(raw.productId, `Satir ${i + 1} urun`, { required: true });
      const quantity = num(raw.quantity, `Satir ${i + 1} adet`, { required: true, min: 0 });
      const prices = effectivePrices(header.campus_id, productId);
      if (!prices) throw badRequest(`Satir ${i + 1}: urun bulunamadi.`);
      run(
        `INSERT INTO production_sales (count_id, product_id, quantity, purchase_price, sale_price, vat_rate)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(count_id, product_id) DO UPDATE SET quantity = excluded.quantity`,
        [header.id, productId, quantity, prices.purchase_price, prices.sale_price, prices.vat_rate]
      );
    }
  });
  return { ok: true, updated: lines.length };
});

/* --------------------- Sayimi kilitle (kor sayim) ------------------- */
countRoutes.post('/:id/submit', async (ctx) => {
  requireWrite(ctx.user);
  const header = requireDraft(ctx, 'Sayim');
  const witnessName = str(ctx.body.witnessName, 'Sayima katilan kisi', { required: true, max: 150, min: 3 });

  const emptyLines = get(
    'SELECT COUNT(*) AS c FROM count_lines WHERE count_id = ? AND counted_qty = 0', [header.id]
  ).c;
  const totalLines = get('SELECT COUNT(*) AS c FROM count_lines WHERE count_id = ?', [header.id]).c;
  if (emptyLines === totalLines) throw badRequest('Hicbir urun icin miktar girilmemis.');

  tx(() => {
    // Sapmalari acmadan once satirlari kendi icinde tutarli hale getir
    for (const line of all('SELECT * FROM count_lines WHERE count_id = ?', [header.id])) {
      run('UPDATE count_lines SET diff_qty = ? WHERE id = ?',
        [round2(line.counted_qty - line.expected_qty), line.id]);
    }
    run(
      `UPDATE counts SET status = 'SAYILDI', witness_name = ?, submitted_by = ?, submitted_at = datetime('now')
        WHERE id = ?`,
      [witnessName, ctx.user.id, header.id]
    );
  });

  logAudit({
    user: ctx.user, action: 'SUBMIT_COUNT', entity: 'counts', entityId: header.id, campusId: header.campus_id,
    detail: { witnessName, emptyLines, totalLines }, ip: ctx.ip,
  });
  return loadCount(header.id, ctx.user);
});

/* ----------------------------- Kesinlestir -------------------------- */
countRoutes.post('/:id/finalize', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI');
  const header = get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.id)]);
  if (!header) throw notFound('Sayim bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);

  if (header.count_type === 'NOKTA') {
    throw badRequest('Nokta sayimi kesinlestirilmez; kilitlendiginde tamamlanir.');
  }
  if (header.status === 'KESINLESMIS') throw conflict('Sayim zaten kesinlesmis.');
  if (header.status !== 'SAYILDI') {
    throw conflict('Once sayimi kilitleyin ("Sayimi Kilitle"). Kesinlestirme kilitlenmis sayim uzerinde yapilir.');
  }
  // IKI IMZA: sayan ile onaylayan ayni kisi olamaz
  if (header.submitted_by && header.submitted_by === ctx.user.id) {
    throw forbidden(
      'Sayimi kilitleyen kisi kendi sayimini kesinlestiremez. Kesinlestirmeyi baska bir yetkili yapmalidir.'
    );
  }

  const result = tx(() => {
    const snap = new Map(
      stockSnapshot(header.campus_id, { untilDate: header.count_date, onlyActive: false })
        .map((p) => [p.product_id, p])
    );

    // RECETE: beyan edilen uretim adetlerinin gerektirdigi hammadde tuketimi.
    // Bu miktar hammaddenin sayim farkindan dusulur; aksi halde uretimde
    // kullanilan mal "satilmis" sayilip beklenen ciroyu sisirir.
    const productionRows = all('SELECT * FROM production_sales WHERE count_id = ?', [header.id]);
    const consumption = recipeConsumption(header.campus_id, productionRows);

    let expectedRevenue = 0;
    let cogsTotal = 0;

    for (const line of all('SELECT * FROM count_lines WHERE count_id = ?', [header.id])) {
      const expected = round2(snap.has(line.product_id) ? snap.get(line.product_id).stock_qty : line.expected_qty);
      const counted = round2(line.counted_qty);
      const diff = round2(counted - expected);
      const recipeQty = round4(consumption.get(line.product_id) || 0);
      // Dogrudan satis: toplam cikistan recete tuketimi dusuldukten sonrasi
      const sold = round2(expected - recipeQty - counted);
      const salesValue = round2(sold * line.sale_price);
      const costValue = round2(sold * line.purchase_price);

      run(
        `UPDATE count_lines SET expected_qty = ?, diff_qty = ?, recipe_qty = ?, sold_qty = ?,
                sales_value = ?, cost_value = ?
          WHERE id = ?`,
        [expected, diff, recipeQty, sold, salesValue, costValue, line.id]
      );
      expectedRevenue += salesValue;
      cogsTotal += costValue;

      if (diff !== 0) {
        addMovement({
          campusId: header.campus_id,
          productId: line.product_id,
          type: diff < 0 ? 'SATIS' : 'SAYIM_FAZLA',
          quantity: diff,
          unitCost: line.purchase_price,
          date: header.count_date,
          refType: 'count',
          refId: header.id,
          note: diff < 0 ? 'Sayim ile hesaplanan donem satisi' : 'Sayimda fazla cikan',
          userId: ctx.user.id,
        });
      }
    }

    // Uretilen urunler: beyan edilen adetler.
    // Maliyet recete varsa hammadde toplamindan, yoksa elle girilen tahminden gelir.
    // Hammaddenin kendi satir maliyeti zaten recipe_qty kadar dusuldugu icin
    // cift sayim olmaz.
    let productionRevenue = 0;
    for (const row of productionRows) {
      const cost = recipeUnitCost(header.campus_id, row.product_id);
      const unitCost = cost.hasRecipe ? cost.unitCost : row.purchase_price;
      const salesValue = round2(row.quantity * row.sale_price);
      const costValue = round2(row.quantity * unitCost);
      run('UPDATE production_sales SET purchase_price = ?, sales_value = ?, cost_value = ? WHERE id = ?',
        [round4(unitCost), salesValue, costValue, row.id]);
      productionRevenue += salesValue;
      cogsTotal += costValue;
    }
    expectedRevenue += productionRevenue;

    const actualRevenue = periodRevenue(header.campus_id, header.period_start, header.count_date);
    run(
      `UPDATE counts SET status = 'KESINLESMIS', finalized_by = ?, finalized_at = datetime('now'),
              expected_revenue = ?, actual_revenue = ?, cogs_total = ?, production_revenue = ?
        WHERE id = ?`,
      [ctx.user.id, round2(expectedRevenue), round2(actualRevenue), round2(cogsTotal),
       round2(productionRevenue), header.id]
    );
    return {
      expectedRevenue: round2(expectedRevenue),
      actualRevenue: round2(actualRevenue),
      productionRevenue: round2(productionRevenue),
    };
  });

  logAudit({
    user: ctx.user, action: 'FINALIZE', entity: 'counts', entityId: header.id, campusId: header.campus_id,
    detail: { ...result, submittedBy: header.submitted_by, witness: header.witness_name }, ip: ctx.ip,
  });
  return loadCount(header.id, ctx.user);
});

/* ----------------------- Sayimi yeniden ac -------------------------- */
countRoutes.post('/:id/reopen', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const header = get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.id)]);
  if (!header) throw notFound('Sayim bulunamadi.');
  if (header.status !== 'SAYILDI') throw conflict('Yalnizca kilitlenmis, henuz kesinlesmemis sayim yeniden acilabilir.');
  const reason = str(ctx.body.reason, 'Gerekce', { required: true, max: 300, min: 5 });

  run(
    `UPDATE counts SET status = 'TASLAK', submitted_by = NULL, submitted_at = NULL,
            reopened_count = reopened_count + 1 WHERE id = ?`,
    [header.id]
  );
  logAudit({
    user: ctx.user, action: 'REOPEN_COUNT', entity: 'counts', entityId: header.id, campusId: header.campus_id,
    detail: { reason, previousSubmitter: header.submitted_by }, ip: ctx.ip,
  });
  return loadCount(header.id, ctx.user);
});

/* ------------------------------ Silme ------------------------------ */
countRoutes.delete('/:id', async (ctx) => {
  requireWrite(ctx.user);
  const header = get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.id)]);
  if (!header) throw notFound('Sayim bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  if (header.status === 'KESINLESMIS') throw conflict('Kesinlesmis sayim silinemez.');
  if (header.status === 'SAYILDI') {
    throw conflict('Kilitlenmis sayim silinemez. Duzeltme gerekiyorsa genel mudurluk sayimi yeniden acabilir.');
  }
  run('DELETE FROM counts WHERE id = ?', [header.id]);
  logAudit({ user: ctx.user, action: 'DELETE', entity: 'counts', entityId: header.id, campusId: header.campus_id, ip: ctx.ip });
  return { ok: true };
});

/* ------------------------- Mutabakat raporu ------------------------ */
countRoutes.get('/:id/reconciliation', async (ctx) => {
  const data = loadCount(Number(ctx.params.id), ctx.user);
  assertCampusAccess(ctx.user, data.campus_id);

  // KOR SAYIM: kilitlenene kadar hicbir beklenen deger disari verilmez
  if (data.blind_active) {
    return {
      blind: true,
      count: {
        id: data.id, campusId: data.campus_id, campusName: data.campus_name,
        countDate: data.count_date, periodStart: data.period_start,
        status: data.status, countType: data.count_type,
      },
      progress: data.progress,
    };
  }

  const isSpot = data.count_type === 'NOKTA';
  const from = data.period_start || firstMovementDate(data.campus_id) || data.count_date;
  const to = data.count_date;

  const revenue = get(
    `SELECT COALESCE(SUM(total_amount), 0) AS total,
            COALESCE(SUM(cash_amount), 0)  AS cash,
            COALESCE(SUM(card_amount), 0)  AS card,
            COALESCE(SUM(credit_amount), 0) AS credit,
            COUNT(*) AS day_count,
            COALESCE(SUM(is_school_day), 0) AS school_days
       FROM daily_revenues WHERE campus_id = ? AND revenue_date BETWEEN ? AND ?`,
    [data.campus_id, from, to]
  );
  const purchases = get(
    `SELECT COALESCE(SUM(net_total), 0) AS net, COALESCE(SUM(gross_total), 0) AS gross, COUNT(*) AS doc_count
       FROM purchases WHERE campus_id = ? AND status <> 'IPTAL' AND document_date BETWEEN ? AND ?`,
    [data.campus_id, from, to]
  );
  const waste = get(
    `SELECT COALESCE(SUM(quantity * unit_cost), 0) AS cost, COUNT(*) AS record_count
       FROM waste_records WHERE campus_id = ? AND waste_date BETWEEN ? AND ?`,
    [data.campus_id, from, to]
  );
  // Iade, fire gibi maliyet degildir: tedarikci alacaklandirir. Ayri gosterilir.
  const returns = get(
    `SELECT COALESCE(SUM(gross_total), 0) AS gross, COALESCE(SUM(net_total), 0) AS net, COUNT(*) AS document_count
       FROM supplier_returns WHERE campus_id = ? AND return_date BETWEEN ? AND ?`,
    [data.campus_id, from, to]
  );
  const campus = get('SELECT * FROM campuses WHERE id = ?', [data.campus_id]);

  const finalized = data.status === 'KESINLESMIS';

  // RECETE: kesinlesmeden once de onizleme yapabilmek icin tuketim burada da
  // hesaplanir; kesinlesme aninda ayni hesap satirlara yazilir.
  const consumption = finalized
    ? new Map(data.lines.map((l) => [l.product_id, l.recipe_qty || 0]))
    : recipeConsumption(data.campus_id, data.production);
  const usedQty = (line) => (finalized ? (line.recipe_qty || 0) : (consumption.get(line.product_id) || 0));
  const directSold = (line) => round4((line.expected_qty ?? 0) - usedQty(line) - line.counted_qty);

  const countedRevenue = finalized
    ? round2(data.expected_revenue - data.production_revenue)
    : round2(data.lines.reduce((s, l) => s + directSold(l) * l.sale_price, 0));
  const productionRevenue = finalized
    ? data.production_revenue
    : round2(data.production.reduce((s, r) => s + r.quantity * r.sale_price, 0));
  const expectedRevenue = round2(countedRevenue + productionRevenue);

  const productionCost = round2(data.production.reduce((s, r) => {
    const cost = finalized ? r.purchase_price : recipeUnitCost(data.campus_id, r.product_id).unitCost;
    return s + r.quantity * cost;
  }, 0));

  const cogs = finalized
    ? data.cogs_total
    : round2(data.lines.reduce((s, l) => s + directSold(l) * l.purchase_price, 0) + productionCost);

  // Recete kontrolu: beyan edilen uretimin gerektirdigi hammadde ile
  // fiilen tukenen hammadde karsilastirilir
  const recipeCheck = data.lines
    .filter((l) => usedQty(l) > 0)
    .map((l) => {
      const expectedUse = round4(usedQty(l));
      const totalOut = round4((l.expected_qty ?? 0) - l.counted_qty);
      const unexplained = round4(totalOut - expectedUse);
      const product = get('SELECT product_type FROM products WHERE id = ?', [l.product_id]);
      return {
        product_id: l.product_id,
        product_name: l.product_name,
        unit: l.unit,
        product_type: product?.product_type ?? 'SATIN_ALINAN',
        recipe_qty: expectedUse,
        total_out: totalOut,
        unexplained,
        unexplained_value: round2(unexplained * l.purchase_price),
        unexplained_pct: expectedUse > 0 ? pctOf(unexplained, expectedUse) : null,
      };
    })
    .sort((a, b) => Math.abs(b.unexplained_value) - Math.abs(a.unexplained_value));

  const actualRevenue = round2(revenue.total);
  // Nokta sayimi urunlerin yalnizca bir bolumunu kapsar; ciro ile karsilastirilamaz
  const difference = isSpot ? null : round2(actualRevenue - expectedRevenue);
  const actualNet = round2(netFromGross(actualRevenue, weightedVat(data.lines)));
  const grossProfit = isSpot ? null : round2(actualNet - cogs);

  return {
    blind: false,
    isSpot,
    count: {
      id: data.id, campusId: data.campus_id, campusName: data.campus_name,
      countDate: data.count_date, periodStart: data.period_start,
      status: data.status, countType: data.count_type,
      submittedByName: data.submitted_by_name, witnessName: data.witness_name,
      finalizedByName: data.finalized_by_name, reopenedCount: data.reopened_count,
    },
    period: { from, to, dayCount: revenue.day_count, schoolDays: revenue.school_days },
    revenue: {
      expected: expectedRevenue,
      counted: countedRevenue,
      production: productionRevenue,
      actual: actualRevenue,
      difference,
      differencePct: isSpot ? null : pctOf(difference, expectedRevenue),
      cash: round2(revenue.cash), card: round2(revenue.card), credit: round2(revenue.credit),
    },
    production: {
      revenue: productionRevenue,
      cost: productionCost,
      sharePct: expectedRevenue > 0 ? pctOf(productionRevenue, expectedRevenue) : null,
      items: data.production.filter((r) => r.quantity > 0),
      // Recete tanimli olan uretim kalemleri: maliyeti tahmin degil, hammadde toplami
      withRecipe: data.production.filter((r) => r.quantity > 0
        && recipeUnitCost(data.campus_id, r.product_id).hasRecipe).length,
    },
    recipeCheck: {
      items: recipeCheck,
      // Hammaddede aciklanamayan tuketim, dogrudan satilmadigi icin kayip isaretidir
      totalUnexplainedValue: round2(recipeCheck
        .filter((r) => r.product_type === 'HAMMADDE')
        .reduce((s, r) => s + r.unexplained_value, 0)),
    },
    profitability: {
      cogs, actualNet, grossProfit,
      grossMarginPct: isSpot ? null : pctOf(grossProfit, actualNet),
      theoreticalProfit: round2(data.lines.reduce(
        (s, l) => s + (l.expected_qty - l.counted_qty) * (netFromGross(l.sale_price, l.vat_rate) - l.purchase_price), 0
      )),
    },
    purchases: { netTotal: round2(purchases.net), grossTotal: round2(purchases.gross), documentCount: purchases.doc_count },
    waste: { costValue: round2(waste.cost), recordCount: waste.record_count },
    returns: {
      netTotal: round2(returns.net), grossTotal: round2(returns.gross),
      documentCount: returns.document_count,
    },
    perStudent: campus.student_count > 0 && !isSpot ? {
      studentCount: campus.student_count,
      revenuePerStudent: round2(actualRevenue / campus.student_count),
      dailyRevenuePerStudent: revenue.school_days > 0
        ? round2(actualRevenue / campus.student_count / revenue.school_days) : null,
    } : null,
    schoolShare: campus.rent_share_pct > 0 && !isSpot
      ? { pct: campus.rent_share_pct, amount: round2(actualRevenue * campus.rent_share_pct / 100) }
      : null,
    topVariances: [...data.lines]
      .filter((l) => l.diff_qty !== 0)
      .map((l) => ({ ...l, variance_value: round2(l.diff_qty * l.sale_price) }))
      .sort((a, b) => Math.abs(b.variance_value) - Math.abs(a.variance_value))
      .slice(0, 20),
    soldItems: [...data.lines]
      .filter((l) => l.expected_qty - l.counted_qty > 0)
      .map((l) => ({ ...l, sold: round2(l.expected_qty - l.counted_qty) }))
      .sort((a, b) => b.sold * b.sale_price - a.sold * a.sale_price)
      .slice(0, 30),
  };
});

/* ----------------------------- yardimcilar ------------------------- */
/** Sayim taslagi mi, kullanicinin yetkisi var mi? */
function requireDraft(ctx, what) {
  const header = get('SELECT * FROM counts WHERE id = ?', [Number(ctx.params.id)]);
  if (!header) throw notFound('Sayim bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  if (header.status === 'KESINLESMIS') throw conflict('Kesinlesmis sayim degistirilemez.');
  if (header.status === 'SAYILDI') {
    throw conflict(`${what} kilitlenmis sayimda degistirilemez. Genel mudurluk sayimi yeniden acabilir.`);
  }
  return header;
}

function producedProducts(campusId) {
  return all(
    `SELECT p.id,
            COALESCE(cp.purchase_price, p.purchase_price) AS purchase_price,
            COALESCE(cp.sale_price,     p.sale_price)     AS sale_price,
            p.vat_rate
       FROM products p
       LEFT JOIN campus_products cp ON cp.product_id = p.id AND cp.campus_id = ?
      WHERE p.is_active = 1 AND p.product_type = 'URETILEN'
      ORDER BY p.name COLLATE NOCASE`,
    [campusId]
  );
}

/**
 * Sayim kaydini yukler.
 * Kor sayim taslak halindeyken beklenen miktar ve turevleri maskelenir;
 * bu maskeleme sunucu tarafinda yapilir, arayuzden asilamaz.
 */
function loadCount(countId, user) {
  const header = get(
    `SELECT c.*, k.name AS campus_name,
            u.full_name  AS created_by_name,
            su.full_name AS submitted_by_name,
            fu.full_name AS finalized_by_name
       FROM counts c JOIN campuses k ON k.id = c.campus_id
       LEFT JOIN users u  ON u.id = c.created_by
       LEFT JOIN users su ON su.id = c.submitted_by
       LEFT JOIN users fu ON fu.id = c.finalized_by
      WHERE c.id = ?`, [countId]
  );
  if (!header) throw notFound('Sayim bulunamadi.');

  const blindActive = !!header.is_blind && header.status === 'TASLAK';

  let lines = all(
    `SELECT l.*, p.name AS product_name, p.barcode, p.unit, cat.name AS category_name
       FROM count_lines l
       JOIN products p ON p.id = l.product_id
       LEFT JOIN categories cat ON cat.id = p.category_id
      WHERE l.count_id = ? ORDER BY cat.sort_order, p.name COLLATE NOCASE`, [countId]
  );

  const filled = lines.filter((l) => l.counted_qty !== 0).length;
  const progress = { total: lines.length, filled };

  if (blindActive) {
    lines = lines.map((l) => ({
      ...l,
      expected_qty: null, diff_qty: null, sold_qty: null, sales_value: null, cost_value: null,
    }));
  }

  const production = all(
    `SELECT ps.*, p.name AS product_name, p.unit
       FROM production_sales ps JOIN products p ON p.id = ps.product_id
      WHERE ps.count_id = ? ORDER BY p.name COLLATE NOCASE`, [countId]
  );

  return withVariance({
    ...header,
    lines,
    production,
    progress,
    blind_active: blindActive,
    can_finalize: header.status === 'SAYILDI'
      && header.count_type === 'DONEM'
      && header.submitted_by !== user?.id
      && ['ADMIN', 'GENEL_MUDURLUK', 'KAMPUS_YONETICISI'].includes(user?.role),
  });
}

function withVariance(row) {
  const difference = round2((row.actual_revenue || 0) - (row.expected_revenue || 0));
  return { ...row, difference, difference_pct: pctOf(difference, row.expected_revenue || 0) };
}

/** Donem kilitleri yalnizca DONEM sayimlarina bakar; nokta sayimi donemi kapatmaz. */
export function lastFinalizedCount(campusId, beforeDate = null) {
  const params = [campusId];
  let sql = "SELECT * FROM counts WHERE campus_id = ? AND status = 'KESINLESMIS' AND count_type = 'DONEM'";
  if (beforeDate) { sql += ' AND count_date < ?'; params.push(beforeDate); }
  sql += ' ORDER BY count_date DESC, id DESC LIMIT 1';
  return get(sql, params);
}

function periodRevenue(campusId, from, to) {
  const params = [campusId, to];
  let sql = 'SELECT COALESCE(SUM(total_amount), 0) AS total FROM daily_revenues WHERE campus_id = ? AND revenue_date <= ?';
  if (from) { sql += ' AND revenue_date >= ?'; params.push(from); }
  return get(sql, params).total;
}

function firstMovementDate(campusId) {
  return get('SELECT MIN(movement_date) AS d FROM stock_movements WHERE campus_id = ?', [campusId])?.d || null;
}

/** Satirlarin satis tutarina gore agirlikli ortalama KDV orani. */
function weightedVat(lines) {
  let value = 0;
  let weighted = 0;
  for (const l of lines) {
    const v = Math.abs(((l.expected_qty ?? 0) - l.counted_qty) * l.sale_price);
    value += v;
    weighted += v * l.vat_rate;
  }
  return value > 0 ? weighted / value : 10;
}

export function addDays(dateStr, days) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const tr = (n) => (n === null || n === undefined ? '' : String(n).replace('.', ','));
