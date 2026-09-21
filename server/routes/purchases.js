import { Router } from '../lib/router.js';
import { all, get, insert, run, tx } from '../db.js';
import { notFound, badRequest, conflict } from '../lib/http.js';
import { requireWrite, requireRole, assertCampusAccess, campusFilter } from '../lib/auth.js';
import { readRawBody, storeFile, readFile, deleteFile, MAX_ATTACHMENT_BYTES } from '../lib/uploads.js';
import { logAudit } from '../lib/audit.js';
import { str, num, int, date, arr, today } from '../lib/validate.js';
import { purchaseLineTotals, round2 } from '../lib/money.js';
import { addMovement } from '../lib/stock.js';
import { learnAlias } from './products.js';

export const purchaseRoutes = new Router();

purchaseRoutes.get('/', async (ctx) => {
  const f = campusFilter(ctx.user, 'p.campus_id', ctx.query.campusId);
  const params = [...f.params];
  let extra = '';
  if (ctx.query.from) { extra += ' AND p.document_date >= ?'; params.push(ctx.query.from); }
  if (ctx.query.to) { extra += ' AND p.document_date <= ?'; params.push(ctx.query.to); }
  if (ctx.query.supplierId) { extra += ' AND p.supplier_id = ?'; params.push(Number(ctx.query.supplierId)); }

  const items = all(
    `SELECT p.*, s.name AS supplier_name, k.name AS campus_name, u.full_name AS created_by_name,
            (SELECT COUNT(*) FROM purchase_lines l WHERE l.purchase_id = p.id) AS line_count,
            (SELECT COUNT(*) FROM purchase_attachments a WHERE a.purchase_id = p.id) AS attachment_count
       FROM purchases p
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN campuses  k ON k.id = p.campus_id
       LEFT JOIN users u ON u.id = p.created_by
      WHERE 1 = 1 ${f.clause} ${extra}
      ORDER BY p.document_date DESC, p.id DESC
      LIMIT ?`,
    [...params, Number(ctx.query.limit || 200)]
  );
  return { items };
});

/* ============ FATURADA OLUP KAYDA ALINMAYAN SATIRLAR ============== */
/**
 * Acik (henuz cozulmemis) kalemler. `/:id` deseninden ONCE tanimlanmali:
 * yonlendirici ilk eslesen rotayi kullanir, aksi halde "unmatched" bir
 * belge id'si sanilir.
 */
purchaseRoutes.get('/unmatched', async (ctx) => {
  const f = campusFilter(ctx.user, 'p.campus_id');
  const durum = ctx.query.status || 'ACIK';
  const params = [];
  const where = ["u.status = ?"];
  params.push(durum);
  if (ctx.query.campusId) { where.push('p.campus_id = ?'); params.push(Number(ctx.query.campusId)); }

  const items = all(
    `SELECT u.*, p.document_no, p.document_date, p.campus_id, p.status AS purchase_status,
            s.name AS supplier_name, k.name AS campus_name, pr.name AS resolved_product_name
       FROM purchase_unmatched_lines u
       JOIN purchases p ON p.id = u.purchase_id
       JOIN suppliers s ON s.id = p.supplier_id
       JOIN campuses  k ON k.id = p.campus_id
       LEFT JOIN products pr ON pr.id = u.resolved_product_id
      WHERE ${where.join(' AND ')} ${f.clause}
      ORDER BY p.document_date DESC, u.id DESC LIMIT 300`,
    [...params, ...f.params]
  );
  const openCount = get(
    `SELECT COUNT(*) AS c, COALESCE(SUM(u.gross_total), 0) AS total
       FROM purchase_unmatched_lines u JOIN purchases p ON p.id = u.purchase_id
      WHERE u.status = 'ACIK' ${f.clause}`, f.params
  );
  return { items, openCount: openCount.c, openTotal: round2(openCount.total) };
});

/**
 * Bir kalemi cozer. Iki yol var:
 *   productId verilirse  -> kalem belgeye SATIR olarak eklenir, stok girer
 *   ignore: true         -> sebebi yazilarak yok sayilir (stok degismez)
 *
 * Belgeye satir eklemek stogu degistirir; bu yuzden iptal/silme ile ayni
 * engeller gecerlidir (kesinlesmis sayim, bagli iade).
 */
purchaseRoutes.post('/unmatched/:id/resolve', async (ctx) => {
  requireWrite(ctx.user, 'purchases');
  const id = Number(ctx.params.id);
  const row = get('SELECT * FROM purchase_unmatched_lines WHERE id = ?', [id]);
  if (!row) throw notFound('Kalem bulunamadi.');
  if (row.status !== 'ACIK') throw conflict('Bu kalem zaten sonuclandirilmis.');

  const header = get('SELECT * FROM purchases WHERE id = ?', [row.purchase_id]);
  if (!header) throw notFound('Kalemin bagli oldugu belge bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);

  const note = str(ctx.body.note, 'Aciklama', { max: 300 });

  if (ctx.body.ignore) {
    if (!note) throw badRequest('Yok saymak icin sebep yazmalisiniz.');
    run(
      `UPDATE purchase_unmatched_lines
          SET status = 'YOKSAYILDI', resolution_note = ?, resolved_by = ?, resolved_at = datetime('now')
        WHERE id = ?`, [note, ctx.user.id, id]
    );
    logAudit({
      user: ctx.user, action: 'UPDATE', entity: 'purchase_unmatched_lines', entityId: id,
      campusId: header.campus_id, detail: { yoksayildi: row.source_name, sebep: note }, ip: ctx.ip,
    });
    return { ok: true, status: 'YOKSAYILDI' };
  }

  const productId = int(ctx.body.productId, 'Urun', { required: true });
  const product = get('SELECT * FROM products WHERE id = ?', [productId]);
  if (!product) throw badRequest('Urun bulunamadi.');
  if (header.status === 'IPTAL') throw conflict('Iptal edilmis belgeye satir eklenemez.');
  assertPurchaseMutable(header, 'satir eklenemez');

  const quantity = num(ctx.body.quantity, 'Miktar', { def: row.quantity }) ?? row.quantity;
  const unitPrice = num(ctx.body.unitPrice, 'Birim fiyat', { def: row.unit_price }) ?? row.unit_price;
  const vatRate = num(ctx.body.vatRate, 'KDV', { min: 0, max: 100, def: row.vat_rate }) ?? row.vat_rate;
  const discountPct = num(ctx.body.discountPct, 'Iskonto', { min: 0, max: 100, def: row.discount_pct }) ?? row.discount_pct;
  if (!(quantity > 0)) throw badRequest('Miktar sifirdan buyuk olmalidir.');

  const t = purchaseLineTotals({ quantity, unitPrice, vatRate, discountPct });
  const effectiveUnitCost = round2(t.netTotal / quantity);

  tx(() => {
    insert(
      `INSERT INTO purchase_lines (purchase_id, product_id, quantity, unit_price, vat_rate, discount_pct,
                                   net_total, vat_total, gross_total, expiry_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      [header.id, productId, quantity, unitPrice, vatRate, discountPct, t.netTotal, t.vatTotal, t.grossTotal]
    );
    addMovement({
      campusId: header.campus_id, productId, type: 'ALIS', quantity,
      unitCost: effectiveUnitCost, date: header.document_date,
      refType: 'purchase', refId: header.id, userId: ctx.user.id,
    });
    // Belge toplamlari da buyumeli, yoksa fatura ile belge yine tutmaz
    run(
      `UPDATE purchases SET net_total = net_total + ?, vat_total = vat_total + ?, gross_total = gross_total + ?
        WHERE id = ?`, [t.netTotal, t.vatTotal, t.grossTotal, header.id]
    );
    run(
      `UPDATE purchase_unmatched_lines
          SET status = 'COZULDU', resolved_product_id = ?, resolution_note = ?,
              resolved_by = ?, resolved_at = datetime('now')
        WHERE id = ?`, [productId, note || null, ctx.user.id, id]
    );
  });

  logAudit({
    user: ctx.user, action: 'UPDATE', entity: 'purchase_unmatched_lines', entityId: id,
    campusId: header.campus_id,
    detail: { belge: header.id, faturaAdi: row.source_name, urun: product.name, miktar: quantity, tutar: t.grossTotal },
    ip: ctx.ip,
  });
  return { ok: true, status: 'COZULDU', purchaseId: header.id, grossTotal: t.grossTotal };
});

/**
 * Bir alim belgesine dokunulabilir mi?
 *
 * Iki durumda dokunulamaz; ikisi de mutabakati bozar:
 *   1. Belge tarihinden SONRA kesinlesmis bir donem sayimi varsa. O sayim
 *      bu alimi stoga dahil ederek fark hesapladi; belgeyi geri almak
 *      kesinlesmis sayimi gecmise donuk yanlis hale getirir.
 *   2. Belgeye dayanan bir iade kaydi varsa. Once iade cozulmelidir.
 */
function assertPurchaseMutable(header, eylem) {
  const laterCount = get(
    `SELECT id, count_date FROM counts
      WHERE campus_id = ? AND status = 'KESINLESMIS' AND count_type = 'DONEM' AND count_date >= ? LIMIT 1`,
    [header.campus_id, header.document_date]
  );
  if (laterCount) {
    throw conflict(
      `Bu belge ${laterCount.count_date} tarihli kesinlesmis sayima dahil oldugu icin ${eylem}. `
      + 'Duzeltme kaydi giriniz.'
    );
  }
  const linkedReturn = get('SELECT id FROM supplier_returns WHERE purchase_id = ? LIMIT 1', [header.id]);
  if (linkedReturn) {
    throw conflict(`Bu belgeye bagli bir iade kaydi var (#${linkedReturn.id}). Once iadeyi silin.`);
  }
}

purchaseRoutes.post('/:id/cancel', async (ctx) => {
  requireWrite(ctx.user, 'purchases');
  const id = Number(ctx.params.id);
  const header = get('SELECT * FROM purchases WHERE id = ?', [id]);
  if (!header) throw notFound('Alim belgesi bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  if (header.status === 'IPTAL') throw conflict('Belge zaten iptal edilmis.');
  assertPurchaseMutable(header, 'iptal edilemez');

  tx(() => {
    run("UPDATE purchases SET status = 'IPTAL' WHERE id = ?", [id]);
    run("DELETE FROM stock_movements WHERE ref_type = 'purchase' AND ref_id = ?", [id]);
  });
  logAudit({
    user: ctx.user, action: 'CANCEL', entity: 'purchases', entityId: id, campusId: header.campus_id,
    detail: { documentNo: header.document_no, efaturaUuid: header.efatura_uuid || undefined },
    ip: ctx.ip,
  });
  return { ok: true };
});

/**
 * Belgeyi ve BAGLI HER SEYI kalici olarak siler: satirlar, stok hareketleri,
 * fatura dosyalari (diskten de), fiyat gecmisi kaydi.
 *
 * Iptal ile farki: iptal belgeyi kayitta birakir (denetim izi kalir), silme
 * hic olmamis sayar. Bu yuzden yalnizca ADMIN ve GENEL_MUDURLUK yapabilir ve
 * silinen belgenin tam icerigi denetim gunlugune yazilir.
 */
purchaseRoutes.delete('/:id', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const id = Number(ctx.params.id);
  const header = get('SELECT * FROM purchases WHERE id = ?', [id]);
  if (!header) throw notFound('Alim belgesi bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  assertPurchaseMutable(header, 'silinemez');

  const lines = all(
    `SELECT pl.*, pr.name AS product_name FROM purchase_lines pl
       JOIN products pr ON pr.id = pl.product_id WHERE pl.purchase_id = ?`, [id]
  );
  const attachments = all('SELECT * FROM purchase_attachments WHERE purchase_id = ?', [id]);

  // Once veritabani (geri alinabilir), sonra dosyalar (geri alinamaz).
  tx(() => {
    run("DELETE FROM stock_movements WHERE ref_type = 'purchase' AND ref_id = ?", [id]);
    run('DELETE FROM purchase_attachments WHERE purchase_id = ?', [id]);
    run('DELETE FROM purchase_lines WHERE purchase_id = ?', [id]);
    run('DELETE FROM purchases WHERE id = ?', [id]);
  });
  for (const a of attachments) deleteFile(a.stored_name);

  // Silinen belge geri getirilemez; ne oldugu gunlukte tam kalsin.
  logAudit({
    user: ctx.user, action: 'DELETE', entity: 'purchases', entityId: id, campusId: header.campus_id,
    detail: {
      documentNo: header.document_no, documentDate: header.document_date,
      supplierId: header.supplier_id, grossTotal: header.gross_total,
      efaturaUuid: header.efatura_uuid || undefined,
      lines: lines.map((l) => ({
        urun: l.product_name, miktar: l.quantity, birimFiyat: l.unit_price,
        iskonto: l.discount_pct, kdv: l.vat_rate, tutar: l.gross_total,
      })),
      silinenDosyalar: attachments.map((a) => a.file_name),
    },
    ip: ctx.ip,
  });
  return { ok: true, deletedLines: lines.length, deletedFiles: attachments.length };
});

purchaseRoutes.get('/:id', async (ctx) => {
  const id = Number(ctx.params.id);
  const header = get(
    `SELECT p.*, s.name AS supplier_name, k.name AS campus_name FROM purchases p
       JOIN suppliers s ON s.id = p.supplier_id JOIN campuses k ON k.id = p.campus_id WHERE p.id = ?`, [id]
  );
  if (!header) throw notFound('Alim belgesi bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  const lines = all(
    `SELECT l.*, pr.name AS product_name, pr.barcode, pr.unit FROM purchase_lines l
       JOIN products pr ON pr.id = l.product_id WHERE l.purchase_id = ? ORDER BY l.id`, [id]
  );
  return { ...header, lines, attachments: attachmentsOf(id) };
});

purchaseRoutes.post('/', async (ctx) => {
  requireWrite(ctx.user, 'purchases');
  const campusId = assertCampusAccess(ctx.user, ctx.body.campusId);
  const supplierId = int(ctx.body.supplierId, 'Tedarikci', { required: true });
  if (!get('SELECT id FROM suppliers WHERE id = ?', [supplierId])) throw badRequest('Tedarikci bulunamadi.');

  const documentNo = str(ctx.body.documentNo, 'Belge no', { max: 60 });
  const documentDate = date(ctx.body.documentDate, 'Belge tarihi', { def: today() });
  const dueDate = date(ctx.body.dueDate, 'Vade tarihi', { def: null });
  const note = str(ctx.body.note, 'Aciklama', { max: 500 });
  // e-Fatura XML'inden aktarildiysa belgenin ETTN'si
  const efaturaUuid = str(ctx.body.efaturaUuid, 'e-Fatura ETTN', { max: 60 });
  const lines = arr(ctx.body.lines, 'Satirlar', { required: true, min: 1 });
  // Faturada olup belgeye ALINMAYAN kalemler (kullanici satiri sildi).
  // Iz birakmadan kaybolmasinlar: panelde acik olarak bekleyecekler.
  const unmatched = arr(ctx.body.unmatchedLines, 'Eslesmeyen satirlar', { def: [] }) ?? [];

  // Ayni e-Fatura ikinci kez aktarilmasin (kampus fark etmeksizin: ETTN tekildir).
  // IPTAL edilmis belge engel degildir: tedarikci faturayi iptal edip yeniden
  // duzenlemis olabilir, ya da hatali giris iptal edilip tekrar girilecektir.
  if (efaturaUuid) {
    const dupEf = get(
      "SELECT id, document_no FROM purchases WHERE efatura_uuid = ? AND status <> 'IPTAL'", [efaturaUuid]
    );
    if (dupEf) {
      throw conflict(
        `Bu e-Fatura zaten sisteme aktarilmis (Belge #${dupEf.id}${dupEf.document_no ? ' / ' + dupEf.document_no : ''}). `
        + 'Yanlis girildiyse once o belgeyi iptal edin, sonra yeniden aktarin.'
      );
    }
  }

  // Ayni tedarikci + belge no ikilisi iki kez girilmesin (mukerrer irsaliye)
  if (documentNo) {
    const dup = get(
      "SELECT id FROM purchases WHERE supplier_id = ? AND document_no = ? AND campus_id = ? AND status <> 'IPTAL'",
      [supplierId, documentNo, campusId]
    );
    if (dup) throw conflict(`Bu belge no (${documentNo}) bu tedarikci icin zaten kayitli. Belge #${dup.id}`);
  }

  const prepared = lines.map((raw, i) => {
    const productId = int(raw.productId, `Satir ${i + 1} urun`, { required: true });
    const product = get('SELECT * FROM products WHERE id = ?', [productId]);
    if (!product) throw badRequest(`Satir ${i + 1}: urun bulunamadi.`);
    const quantity = num(raw.quantity, `Satir ${i + 1} miktar`, { required: true, min: 0.001 });
    const unitPrice = num(raw.unitPrice, `Satir ${i + 1} birim fiyat`, { required: true, min: 0 });
    const vatRate = num(raw.vatRate, `Satir ${i + 1} KDV`, { min: 0, max: 100, def: product.vat_rate }) ?? product.vat_rate;
    const discountPct = num(raw.discountPct, `Satir ${i + 1} iskonto`, { min: 0, max: 100, def: 0 }) ?? 0;
    const totals = purchaseLineTotals({ quantity, unitPrice, vatRate, discountPct });
    return {
      productId, product, quantity, unitPrice, vatRate, discountPct, ...totals,
      expiryDate: date(raw.expiryDate, `Satir ${i + 1} SKT`, { def: null }),
      // Iskonto sonrasi gercek birim maliyet
      effectiveUnitCost: quantity > 0 ? round2(totals.netTotal / quantity) : 0,
      // Faturada bu kalem hangi ad/kodla geldi? Eslestirme bundan ogrenilir.
      sourceName: str(raw.sourceName, `Satir ${i + 1} fatura adi`, { max: 300 }),
      sourceCode: str(raw.sourceCode, `Satir ${i + 1} satici kodu`, { max: 60 }),
      aliasFactor: num(raw.aliasFactor, `Satir ${i + 1} cevrim carpani`, { min: 0.0001, max: 100000, def: 1 }) ?? 1,
    };
  });

  const netTotal = round2(prepared.reduce((s, l) => s + l.netTotal, 0));
  const vatTotal = round2(prepared.reduce((s, l) => s + l.vatTotal, 0));
  const grossTotal = round2(netTotal + vatTotal);

  const purchaseId = tx(() => {
    const pid = insert(
      `INSERT INTO purchases (campus_id, supplier_id, document_no, document_date, net_total, vat_total, gross_total,
                              due_date, status, note, efatura_uuid, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ONAYLI', ?, ?, ?)`,
      [campusId, supplierId, documentNo, documentDate, netTotal, vatTotal, grossTotal, dueDate, note,
       efaturaUuid || null, ctx.user.id]
    );
    for (const l of prepared) {
      insert(
        `INSERT INTO purchase_lines (purchase_id, product_id, quantity, unit_price, vat_rate, discount_pct,
                                     net_total, vat_total, gross_total, expiry_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pid, l.productId, l.quantity, l.unitPrice, l.vatRate, l.discountPct,
         l.netTotal, l.vatTotal, l.grossTotal, l.expiryDate]
      );
      addMovement({
        campusId, productId: l.productId, type: 'ALIS', quantity: l.quantity,
        unitCost: l.effectiveUnitCost, date: documentDate,
        refType: 'purchase', refId: pid, userId: ctx.user.id,
      });
      // Alis fiyati degistiyse katalogu guncelle ve gecmise yaz
      if (round2(l.product.purchase_price) !== l.effectiveUnitCost) {
        run("UPDATE products SET purchase_price = ?, updated_at = datetime('now') WHERE id = ?",
          [l.effectiveUnitCost, l.productId]);
        insert(
          `INSERT INTO price_history (product_id, campus_id, old_purchase, new_purchase, old_sale, new_sale, effective_date, changed_by)
           VALUES (?, NULL, ?, ?, ?, ?, ?, ?)`,
          [l.productId, l.product.purchase_price, l.effectiveUnitCost,
           l.product.sale_price, l.product.sale_price, documentDate, ctx.user.id]
        );
      }
    }
    // ESLESTIRMEYI OGREN: faturadaki ad/kod ile secilen urunu baglar.
    // Ayni tedarikcinin sonraki faturalarinda bu kalem kendiliginden
    // eslesir; kullanici ayni isi ikinci kez yapmaz.
    for (const l of prepared) {
      if (!l.sourceName && !l.sourceCode) continue;
      learnAlias({
        productId: l.productId, supplierId, sourceCode: l.sourceCode,
        sourceName: l.sourceName, factor: l.aliasFactor, userId: ctx.user.id,
      });
    }

    for (const u of unmatched) {
      const ad = str(u.sourceName, 'Faturadaki ad', { max: 300 });
      if (!ad) continue;
      const miktar = num(u.quantity, 'Miktar', { def: 0 }) ?? 0;
      const fiyat = num(u.unitPrice, 'Birim fiyat', { def: 0 }) ?? 0;
      const iskonto = num(u.discountPct, 'Iskonto', { min: 0, max: 100, def: 0 }) ?? 0;
      const kdv = num(u.vatRate, 'KDV', { min: 0, max: 100, def: 0 }) ?? 0;
      const t = purchaseLineTotals({ quantity: miktar, unitPrice: fiyat, vatRate: kdv, discountPct: iskonto });
      insert(
        `INSERT INTO purchase_unmatched_lines (purchase_id, source_name, source_code, quantity, unit_code,
                                               unit_price, discount_pct, vat_rate, net_total, gross_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [pid, ad, str(u.sourceCode, 'Kod', { max: 60 }) || null, miktar,
         str(u.unitCode, 'Birim', { max: 20 }) || null, fiyat, iskonto, kdv, t.netTotal, t.grossTotal]
      );
    }
    return pid;
  });

  logAudit({
    user: ctx.user, action: 'CREATE', entity: 'purchases', entityId: purchaseId, campusId,
    detail: { supplierId, documentNo, grossTotal, lineCount: prepared.length, efaturaUuid: efaturaUuid || undefined },
    ip: ctx.ip,
  });

  // Fiyat degisimi uyarilari
  const priceAlerts = prepared
    .filter((l) => l.product.purchase_price > 0 && l.effectiveUnitCost > l.product.purchase_price * 1.1)
    .map((l) => ({
      productName: l.product.name,
      oldPrice: l.product.purchase_price,
      newPrice: l.effectiveUnitCost,
      increasePct: round2(((l.effectiveUnitCost - l.product.purchase_price) / l.product.purchase_price) * 100),
    }));

  return {
    id: purchaseId, netTotal, vatTotal, grossTotal, priceAlerts,
    unmatchedCount: unmatched.length,
    learnedAliases: prepared.filter((l) => l.sourceName || l.sourceCode).length,
  };
});

/* ======================= ALIM BELGESI EKLERI ======================= */
/**
 * Faturanin kendisi (PDF / fotograf / e-Fatura XML) belgeye baglanir.
 *
 * Dosya JSON'a gomulmeden HAM olarak gonderilir (rawBody); boylece 10 MB'lik
 * bir PDF base64'e cevrilip %33 sismez. Ad ve tur sorgu dizesinden gelir ama
 * TUR ICERIKTEN DOGRULANIR — bkz. lib/uploads.js.
 */
purchaseRoutes.post('/:id/attachments', async (ctx) => {
  requireWrite(ctx.user, 'purchases');
  const header = purchaseFor(ctx, Number(ctx.params.id));
  if (header.status === 'IPTAL') throw conflict('Iptal edilmis belgeye ek eklenemez.');

  const buffer = await readRawBody(ctx.req, MAX_ATTACHMENT_BYTES);
  const kind = ctx.query.kind === 'EFATURA_XML' ? 'EFATURA_XML' : 'BELGE';
  const stored = storeFile(buffer, ctx.query.filename);

  // Ayni dosya iki kez yuklenmisse tekrar saklamaya gerek yok
  const same = get('SELECT id FROM purchase_attachments WHERE purchase_id = ? AND sha256 = ?',
    [header.id, stored.sha256]);
  if (same) {
    deleteFile(stored.storedName);
    throw conflict('Bu dosya bu belgeye zaten eklenmis.');
  }

  const id = insert(
    `INSERT INTO purchase_attachments
       (purchase_id, file_name, stored_name, content_type, byte_size, sha256, kind, uploaded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [header.id, stored.fileName, stored.storedName, stored.contentType,
     stored.byteSize, stored.sha256, kind, ctx.user.id]
  );
  logAudit({
    user: ctx.user, action: 'ATTACH', entity: 'purchases', entityId: header.id, campusId: header.campus_id,
    detail: { fileName: stored.fileName, byteSize: stored.byteSize, kind, sha256: stored.sha256 }, ip: ctx.ip,
  });
  return { items: attachmentsOf(header.id) };
}, { rawBody: true });

purchaseRoutes.get('/:id/attachments', async (ctx) => {
  const header = purchaseFor(ctx, Number(ctx.params.id));
  return { items: attachmentsOf(header.id) };
});

/** Dosyayi indirir. Kimlik dogrulamasi ve kampus kontrolu her istekte yapilir. */
purchaseRoutes.get('/:id/attachments/:attachmentId', async (ctx) => {
  const header = purchaseFor(ctx, Number(ctx.params.id));
  const row = get('SELECT * FROM purchase_attachments WHERE id = ? AND purchase_id = ?',
    [Number(ctx.params.attachmentId), header.id]);
  if (!row) throw notFound('Ek belge bulunamadi.');

  const data = readFile(row.stored_name);
  if (!data) throw notFound('Dosya sunucuda bulunamadi. Yedekten geri yuklenmesi gerekebilir.');

  ctx.res.writeHead(200, {
    'Content-Type': row.content_type,
    'Content-Length': data.length,
    // Tarayici dosyayi calistirmasin, sadece gostersin/indirsin
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    'Content-Security-Policy': "default-src 'none'; img-src 'self'; object-src 'none'; sandbox",
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=300',
  });
  ctx.res.end(data);
});

/**
 * Ek belge silme yalnizca genel mudurluk/admin yetkisindedir: fatura kaniti
 * niteliginde oldugu icin kampustaki gorevli kaldiramaz. Silme denetim izine
 * dosya ozetiyle birlikte yazilir.
 */
purchaseRoutes.delete('/:id/attachments/:attachmentId', async (ctx) => {
  requireRole(ctx.user, 'ADMIN', 'GENEL_MUDURLUK');
  const header = purchaseFor(ctx, Number(ctx.params.id));
  const row = get('SELECT * FROM purchase_attachments WHERE id = ? AND purchase_id = ?',
    [Number(ctx.params.attachmentId), header.id]);
  if (!row) throw notFound('Ek belge bulunamadi.');

  run('DELETE FROM purchase_attachments WHERE id = ?', [row.id]);
  deleteFile(row.stored_name);
  logAudit({
    user: ctx.user, action: 'ATTACHMENT_DELETE', entity: 'purchases', entityId: header.id,
    campusId: header.campus_id,
    detail: { fileName: row.file_name, sha256: row.sha256, kind: row.kind }, ip: ctx.ip,
  });
  return { items: attachmentsOf(header.id) };
});

/* ----------------------------- yardimcilar ------------------------- */
/** Belgeyi bulur ve kullanicinin o kampusu gorme yetkisini dogrular. */
function purchaseFor(ctx, id) {
  const header = get('SELECT * FROM purchases WHERE id = ?', [id]);
  if (!header) throw notFound('Alim belgesi bulunamadi.');
  assertCampusAccess(ctx.user, header.campus_id);
  return header;
}

function attachmentsOf(purchaseId) {
  return all(
    `SELECT a.id, a.file_name, a.content_type, a.byte_size, a.sha256, a.kind, a.created_at,
            u.full_name AS uploaded_by_name
       FROM purchase_attachments a
       LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.purchase_id = ? ORDER BY a.id`,
    [purchaseId]
  );
}
