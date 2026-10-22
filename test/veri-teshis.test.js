/**
 * Veri teshis araci (scripts/veri-teshis.mjs) regresyon testi.
 *
 * Arac sahada elle tespit ettigimiz hata turlerini ariyor. Burada o
 * hatalarin AYNISI gecici bir veritabanina kurulur ve aracin hepsini
 * bulup bulmadigi sinanir. Arac yanlis alarm da vermemeli: saglikli
 * kayitlar raporda yer almamalidir.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let dir; let dbPath; let rapor;

describe('Teshis araci', () => {
  before(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'teshis-'));
    dbPath = path.join(dir, 'kantin.db');
    const db = new DatabaseSync(dbPath);
    db.exec(readFileSync(path.resolve('server/schema.sql'), 'utf8'));

    const calistir = (sql, p = []) => db.prepare(sql).run(...p);
    calistir("INSERT INTO campuses (id, name, code, is_active) VALUES (1, 'Teşhis Kampüsü', 'TSH', 1)");
    calistir("INSERT INTO suppliers (id, name, tax_no) VALUES (1, 'Teşhis Tedarikçi', '1234567890')");

    const urun = (id, name, unit, purchase, sale, type = 'SATIN_ALINAN') => calistir(
      `INSERT INTO products (id, name, unit, purchase_price, sale_price, vat_rate, product_type, is_active)
       VALUES (?, ?, ?, ?, ?, 1, ?, 1)`, [id, name, unit, purchase, sale, type]
    );
    // 1) Koli fiyati adet sanilmis: 359,96 / 18 = 20,00 -> satis 50 ile %60
    urun(1, 'BİSKREM KAKAOLU 100GRx18', 'ADET', 359.96, 50);
    // 4) Birimi KUTU kalmis
    urun(2, 'ÇİZİ 70 GR.24 AD.', 'KUTU', 326.51, 25);
    // 5) Fiyati bozuk (50/18)
    urun(3, 'HANIMELLER FINDIKLI RULO 82GRx18', 'ADET', 30, 2.777778);
    // 2) Satilmis ama fiyatsiz
    urun(4, 'ETİ ÇİK BOL SÜTLÜ MİNİ 32GX12X12', 'ADET', 5.05, 0);
    // 3) Mukerrer kart
    urun(5, 'AYRAN', 'ADET', 12, 30);
    urun(6, 'ayran', 'ADET', 12, 30);
    // SAGLIKLI kart: hicbir listede olmamali
    urun(7, 'Sağlıklı Ürün', 'ADET', 20, 50);

    for (const [pid, qty] of [[1, 2], [2, 4], [4, 144], [7, 10]]) {
      calistir(
        `INSERT INTO stock_movements (campus_id, product_id, movement_type, quantity, unit_cost, movement_date)
         VALUES (1, ?, 'ALIS', ?, 1, '2026-10-01')`, [pid, qty]
      );
    }
    // 7) Fatura satiri koli girilmis: birim fiyat satisin 3 katindan yuksek
    calistir(
      `INSERT INTO purchases (id, campus_id, supplier_id, document_no, document_date,
                              net_total, vat_total, gross_total, status)
       VALUES (1, 1, 1, 'TSH-1', '2026-10-01', 1000, 10, 1010, 'ONAYLI')`
    );
    calistir(
      `INSERT INTO purchase_lines (purchase_id, product_id, quantity, unit_price, vat_rate,
                                   discount_pct, net_total, vat_total, gross_total)
       VALUES (1, 1, 2, 356.40, 1, 0, 712.80, 7.13, 719.93)`
    );
    // 2) icin kesinlesmis sayim: 136 adet satilmis, satis fiyati 0
    calistir(
      `INSERT INTO counts (id, campus_id, count_date, count_type, status, is_opening)
       VALUES (1, 1, '2026-10-20', 'DONEM', 'KESINLESMIS', 0)`
    );
    calistir(
      `INSERT INTO count_lines (count_id, product_id, expected_qty, counted_qty, diff_qty,
                                sold_qty, purchase_price, sale_price, vat_rate)
       VALUES (1, 4, 144, 8, -136, 136, 5.05, 0, 1)`
    );
    calistir(
      `INSERT INTO count_lines (count_id, product_id, expected_qty, counted_qty, diff_qty,
                                sold_qty, purchase_price, sale_price, vat_rate)
       VALUES (1, 7, 10, 4, -6, 6, 20, 50, 1)`
    );
    db.close();

    rapor = execFileSync('node', ['scripts/veri-teshis.mjs', dbPath], { encoding: 'utf8' });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  test('1 — koli fiyati adet sanilmis kalemi bulur ve dogru rakami verir', () => {
    assert.match(rapor, /BİSKREM KAKAOLU 100GRx18/);
    assert.match(rapor, /÷ 18 = ₺20,00/, rapor.slice(0, 900));
  });

  test('2 — satilmis ama fiyatsiz kalemi adet ve maliyetiyle bulur', () => {
    assert.match(rapor, /ETİ ÇİK BOL SÜTLÜ MİNİ 32GX12X12/);
    assert.match(rapor, /136 ADET satilmis/);
    assert.match(rapor, /ciroya ₺0,00/);
  });

  test('3 — mukerrer kartlari gruplar', () => {
    const bolum = rapor.split('3. MUKERRER')[1].split('4. BIRIMI')[0];
    assert.match(bolum, /#5/);
    assert.match(bolum, /#6/);
  });

  test('4 — ambalaj birimli kullanimdaki karti bulur', () => {
    const bolum = rapor.split('4. BIRIMI')[1].split('5. SATIS')[0];
    assert.match(bolum, /ÇİZİ 70 GR\.24 AD\./);
    assert.match(bolum, /birim KUTU/);
  });

  test('5 — bozuk ondalikli satis fiyatini isaretler', () => {
    assert.match(rapor, /HANIMELLER FINDIKLI RULO[^\n]*2\.777778/);
    assert.match(rapor, /ondalik bozuk/);
  });

  test('6 — kampus sayim durumunu yazar', () => {
    assert.match(rapor, /Teşhis Kampüsü\s+son donem sayimi 2026-10-20/);
  });

  test('7 — koli girilmis fatura satirini bulur', () => {
    const bolum = rapor.split('7. FATURA')[1];
    assert.match(bolum, /2 ADET × ₺356,40/);
    assert.match(bolum, /÷18 = ₺19,80/);
  });

  test('SAGLIKLI kayit hicbir listede YOK (yanlis alarm vermez)', () => {
    assert.ok(!rapor.includes('Sağlıklı Ürün'), rapor);
  });

  test('KISISEL VERI yazmaz', () => {
    assert.ok(!/@/.test(rapor), 'raporda e-posta olmamali');
    assert.ok(!/password|parola|hash/i.test(rapor), 'raporda parola izi olmamali');
  });

  test('veritabanini DEGISTIRMEZ', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 7);
    db.close();
    assert.match(rapor, /Veritabani degistirilmedi/);
  });
});
