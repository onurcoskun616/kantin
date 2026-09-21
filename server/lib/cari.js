/**
 * TEDARIKCI CARI HESABI — KAMPUS BAZLI
 *
 * Tedarikci KARTI ortaktir: "Anadolu Gida A.S." bes kampusun tamami icin tek
 * firmadir, tek VKN'si ve tek adresi vardir. Mukerrer kart acmak (her kampus
 * icin ayri "Anadolu Gida") e-Fatura eslestirmesini ve urun eslestirmelerini
 * bozar.
 *
 * Tedarikci HESABI ortak DEGILDIR: mal hangi kampuse girdiyse borc o
 * kampusundur ve odemeyi de o kampus yapar. Esenyurt'un odemesi Corlu'nun
 * borcunu kapatmaz. Bu dosya, tek bir firma karti uzerinden kampus kampus
 * ayrilmis hesaplari uretir.
 *
 * Bakiye = Alim - Iade - Odeme   (her kampus icin ayri ayri)
 *   Alim  : IPTAL olmayan alim belgelerinin KDV dahil tutari (borc)
 *   Iade  : tedarikciye geri giden mal (alacak, borcu azaltir)
 *   Odeme : tedarikciye yapilan odeme (alacak)
 */
import { all } from '../db.js';

const round = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Bir tedarikcinin kampus kampus ozeti.
 *
 * @param supplierId
 * @param campusIds Gorulebilecek kampus id listesi; null ise tum kampusler
 *                  (bkz. auth.allowedCampusIds).
 * @returns Hareketi olan ya da aktif olan her kampus icin bir satir.
 */
export function campusBalances(supplierId, campusIds = null) {
  const rows = all(
    `SELECT k.id AS campus_id, k.name AS campus_name, k.is_active,
            COALESCE(a.tutar, 0) AS total_purchase,
            COALESCE(a.adet, 0)  AS purchase_count,
            a.son_tarih          AS last_purchase_date,
            COALESCE(i.tutar, 0) AS total_return,
            COALESCE(o.tutar, 0) AS total_paid,
            o.son_tarih          AS last_payment_date
       FROM campuses k
       LEFT JOIN (SELECT campus_id, SUM(gross_total) tutar, COUNT(*) adet,
                         MAX(document_date) son_tarih
                    FROM purchases WHERE supplier_id = ? AND status <> 'IPTAL'
                   GROUP BY campus_id) a ON a.campus_id = k.id
       LEFT JOIN (SELECT campus_id, SUM(gross_total) tutar
                    FROM supplier_returns WHERE supplier_id = ?
                   GROUP BY campus_id) i ON i.campus_id = k.id
       LEFT JOIN (SELECT campus_id, SUM(amount) tutar, MAX(payment_date) son_tarih
                    FROM supplier_payments WHERE supplier_id = ?
                   GROUP BY campus_id) o ON o.campus_id = k.id
      ORDER BY k.name COLLATE NOCASE`,
    [supplierId, supplierId, supplierId]
  );

  return rows
    .filter((r) => !campusIds || campusIds.includes(r.campus_id))
    // Kapatilmis bir kampus yalnizca hesabi varsa listede kalir
    .filter((r) => r.is_active || r.total_purchase || r.total_return || r.total_paid)
    .map((r) => ({
      campusId: r.campus_id,
      campusName: r.campus_name,
      purchaseCount: r.purchase_count,
      lastPurchaseDate: r.last_purchase_date,
      lastPaymentDate: r.last_payment_date,
      ...totals(r.total_purchase, r.total_return, r.total_paid),
    }));
}

/** Satirlarin toplami (tum kampusler / secili kapsam icin tek ozet). */
export function sumBalances(list) {
  return totals(
    list.reduce((s, r) => s + r.totalPurchase, 0),
    list.reduce((s, r) => s + r.totalReturn, 0),
    list.reduce((s, r) => s + r.totalPaid, 0)
  );
}

function totals(alim, iade, odeme) {
  return {
    totalPurchase: round(alim),
    totalReturn: round(iade),
    netPurchase: round(alim - iade),
    totalPaid: round(odeme),
    debt: round(alim - iade - odeme),
  };
}

/**
 * EKSTRE: tek bir kampusun hareket dokumu, yuruyen bakiyesiyle.
 *
 * "Bu tedarikciye ne kadar borcluyuz" sorusunun cevabi tek bir rakamdir;
 * "nasil bu rakama gelindi" sorusunun cevabi bu listedir. Denetimde ikincisi
 * sorulur.
 *
 * @param campusId null ise tum (gorulebilen) kampusler tek listede birlesir.
 */
export function ledger(supplierId, campusId = null, campusIds = null) {
  const kampusKosulu = campusId
    ? { clause: 'AND x.campus_id = ?', params: [campusId] }
    : campusIds
      ? { clause: `AND x.campus_id IN (${campusIds.map(() => '?').join(',') || 'NULL'})`, params: campusIds }
      : { clause: '', params: [] };

  const bolum = (sql) => sql.replace('{KAMPUS}', kampusKosulu.clause);
  const rows = all(
    `${bolum(`SELECT 'ALIM' AS kind, x.document_date AS tarih, x.document_no AS ref,
             x.gross_total AS borc, 0 AS alacak, x.id AS kayit_id, x.campus_id
        FROM purchases x
       WHERE x.supplier_id = ? AND x.status <> 'IPTAL' {KAMPUS}`)}
     UNION ALL
     ${bolum(`SELECT 'IADE', x.return_date, x.document_no, 0, x.gross_total, x.id, x.campus_id
        FROM supplier_returns x WHERE x.supplier_id = ? {KAMPUS}`)}
     UNION ALL
     ${bolum(`SELECT 'ODEME', x.payment_date, x.method, 0, x.amount, x.id, x.campus_id
        FROM supplier_payments x WHERE x.supplier_id = ? {KAMPUS}`)}
     ORDER BY tarih, kayit_id`,
    [
      supplierId, ...kampusKosulu.params,
      supplierId, ...kampusKosulu.params,
      supplierId, ...kampusKosulu.params,
    ]
  );

  let bakiye = 0;
  return rows.map((r) => {
    bakiye = round(bakiye + r.borc - r.alacak);
    return {
      kind: r.kind,
      date: r.tarih,
      ref: r.ref,
      campusId: r.campus_id,
      debit: round(r.borc),
      credit: round(r.alacak),
      balance: bakiye,
      recordId: r.kayit_id,
    };
  });
}
