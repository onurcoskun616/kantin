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
    // Hic sayimi olmayan ikinci kampus: "DEVIR SAYIMI YOK" bunun icin
    calistir("INSERT INTO campuses (id, name, code, is_active) VALUES (2, 'Devirsiz Kampüs', 'DVZ', 1)");
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
    // ACILIS sayiminda "satilmis" gorunen kalem: SATIS DEGILDIR, devirdir
    urun(8, 'Devir Kalemi', 'ADET', 10, 0);
    // Kurusu TAM olan ucuz fiyat: bozuk DEGILDIR, listeye dusmemeli
    urun(9, 'Tekli Sakız', 'ADET', 1, 2.5);
    // HAMMADDE'nin satis fiyati olmaz; eksiklik sayilmamali
    urun(10, 'Un', 'KG', 30, 0, 'HAMMADDE');
    // Fiyati SAYIMDAN SONRA gecerli: o sayim icin fiyat YOK demektir
    urun(11, 'Tarihi Geç Fiyat', 'ADET', 10, 0);
    // Fiyati SAYIMDAN ONCE gecerli: sorun yok
    urun(12, 'Tarihi Erken Fiyat', 'ADET', 10, 0);
    // Adinda ambalaj adedi GECEN, birimi KUTU kalmis kart: 4. bolum ipucu vermeli
    urun(13, 'TEST GOFRET 40GRx12', 'KUTU', 10, 50);

    for (const [pid, qty] of [[1, 2], [2, 4], [4, 144], [7, 10], [8, 50], [10, 25],
      [11, 20], [12, 20], [13, 8]]) {
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
    // Satis fiyati TARIHLIDIR: kesinlestirme sayimin GUNUNDE gecerli olani
    // kullanir. 22 Ekim'de girilen fiyat 19 Ekim sayimini kurtarmaz.
    calistir(
      `INSERT INTO product_prices (product_id, campus_id, sale_price, effective_from)
       VALUES (11, NULL, 40, '2026-10-22'), (12, NULL, 40, '2026-09-01')`
    );
    // Kesinlesmeyi bekleyen DONEM sayimi: kontrol BU gune bakmali
    calistir(
      `INSERT INTO counts (id, campus_id, count_date, count_type, status, is_opening)
       VALUES (3, 1, '2026-10-19', 'DONEM', 'SAYILDI', 0)`
    );

    // ACILIS (devir) sayimi: farki satis sayilmamali
    calistir(
      `INSERT INTO counts (id, campus_id, count_date, count_type, status, is_opening)
       VALUES (2, 1, '2026-09-30', 'DONEM', 'KESINLESMIS', 1)`
    );
    calistir(
      `INSERT INTO count_lines (count_id, product_id, expected_qty, counted_qty, diff_qty,
                                sold_qty, purchase_price, sale_price, vat_rate)
       VALUES (2, 8, 50, 2, -48, 48, 10, 0, 1)`
    );
    db.close();

    rapor = execFileSync('node', ['scripts/veri-teshis.mjs', dbPath], { encoding: 'utf8' });
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  /** Rapordan N numarali bolumu keser (baslik metnine bagli kalmaz). */
  const bolum = (n) => {
    const bas = rapor.indexOf(`\n${n}. `);
    const son = rapor.indexOf(`\n${n + 1}. `);
    assert.ok(bas > -1, `${n}. bolum bulunamadi`);
    return rapor.slice(bas, son > -1 ? son : undefined);
  };

  test('1 — koli fiyati adet sanilmis kalemi bulur ve dogru rakami verir', () => {
    assert.match(rapor, /BİSKREM KAKAOLU 100GRx18/);
    assert.match(bolum(1), /÷ 18 = ₺20,00/, rapor.slice(0, 900));
  });

  test('2 — satilmis ama fiyatsiz kalemi adet ve maliyetiyle bulur', () => {
    const b = bolum(2);
    assert.match(b, /ETİ ÇİK BOL SÜTLÜ MİNİ 32GX12X12/);
    assert.match(b, /136 ADET satılmış/);
    assert.match(b, /ciroya ₺0,00/);
  });

  // Esenyurt raporunda 5.120 PAKET "satilmis" gorundu: oysa o kampuste
  // yalnizca ACILIS sayimi vardi. Acilista fark satis degil devirdir;
  // rapor olmayan bir ciro kaybi uydurmamali.
  test('2 — ACILIS sayimindaki farki SATIS saymaz', () => {
    const b = bolum(2);
    assert.doesNotMatch(b, /GERÇEKLEŞEN.*Devir Kalemi/);
    assert.doesNotMatch(b, /48 ADET satılmış/);
    assert.match(b, /AÇILIŞ \(devir\) sayımları hariçtir/);
  });

  test('2 — fiyati girilmeyi bekleyen karti ONCEDEN uyarir', () => {
    const b = bolum(2);
    assert.match(b, /RİSKLİ · #4 ETİ ÇİK/);
    assert.match(b, /sayım kesinleşirse ciroya ₺0,00 yazılır/);
    // Hangi kampusun hangi sayimi oldugu YAZMALI
    assert.match(b, /Teşhis Kampüsü \(2026-10-19 sayımı\)/);
    // HAMMADDE'nin satis fiyati olmaz: eksiklik sayilmamali
    assert.doesNotMatch(b, /RİSKLİ · #10 Un/);
  });

  // Fiyat KARTTAN degil TARIHTEN okunur: kesinlestirme sayimin gunundeki
  // fiyati kullanir. Bugun girilen fiyat gecmis bir donemi kurtarmaz.
  test('2 — SAYIM GUNUNDEN SONRA gecerli fiyati "var" saymaz', () => {
    const b = bolum(2);
    assert.match(b, /RİSKLİ · #11 Tarihi Geç Fiyat/);
    assert.match(b, /o günün satış fiyatı ₺0,00/);
  });

  test('2 — sayim gununden ONCE gecerli fiyati sorun saymaz', () => {
    assert.doesNotMatch(bolum(2), /#12 Tarihi Erken Fiyat/);
  });

  test('3 — mukerrer kartlari gruplar', () => {
    const b = bolum(3);
    assert.match(b, /#5/);
    assert.match(b, /#6/);
  });

  test('4 — ambalaj birimli kullanimdaki karti bulur', () => {
    const b = bolum(4);
    assert.match(b, /ÇİZİ 70 GR\.24 AD\./);
    assert.match(b, /birim KUTU/);
    // Cevrim carpanini ararken ilk bakilacak yer adindaki ambalaj adedidir
    assert.match(b, /TEST GOFRET 40GRx12/);
    assert.match(b, /ad ipucu: 1 KUTU = 12 adet\?/);
  });

  // Gercek raporda ₺2,00 yara bandi ve ₺2,50 sakiz "bozuk" listesine
  // dusuyordu: olcut fiyatin KUCUK olmasi degil, kurusa sigmamasidir.
  test('5 — kurusu TAM olan ucuz fiyati bozuk SAYMAZ', () => {
    const b = bolum(5);
    assert.doesNotMatch(b, /Tekli Sakız/);
    assert.doesNotMatch(b, /Sağlıklı Ürün/);
  });

  test('5 — bozuk ondalikli satis fiyatini isaretler', () => {
    const b = bolum(5);
    assert.match(b, /HANIMELLER FINDIKLI RULO/);
    assert.match(b, /2\.777778/);
    assert.match(b, /ondalık bozuk/);
  });

  test('6 — kampus sayim durumunu yazar', () => {
    const b = bolum(6);
    assert.match(b, /Teşhis Kampüsü/);
    assert.match(b, /son dönem sayımı 2026-10-20/);
  });

  // Devir sayimi EN ESKI sayimdir; onceki surum son 5 sayima baktigi icin
  // tam da onu kacirabiliyordu. Devir kesinlesmeden donem sayimi
  // kesinlesirse gecmis yildan kalan stok "fazla" cikar.
  test('6 — DEVIR sayimini ayrica yazar', () => {
    const b = bolum(6);
    assert.match(b, /devir ✓ 2026-09-30/);
    assert.match(b, /DEVİR SAYIMI YOK/, 'hic sayimi olmayan kampus ayrica isaretlenmeli');
  });

  test('6 — acik sayimlari da yazar', () => {
    assert.match(bolum(6), /açık sayım: 2026-10-19 \(SAYILDI\)/);
  });

  test('7 — koli girilmis fatura satirini bulur', () => {
    const b = bolum(7);
    assert.match(b, /2 ADET × ₺356,40/);
    assert.match(b, /÷18 = ₺19,80/);
  });

  test('SAGLIKLI kayit hicbir listede YOK (yanlis alarm vermez)', () => {
    assert.ok(!rapor.includes('Sağlıklı Ürün'), rapor);
  });

  test('KISISEL VERI yazmaz', () => {
    assert.ok(!/@/.test(rapor), 'raporda e-posta olmamali');
    assert.ok(!/password|parola|hash/i.test(rapor), 'raporda parola izi olmamali');
  });

  test('OZET ve BOLUMLER yapisal olarak da donuyor (panel bunu kullanir)', async () => {
    // Komut satiri ve panel AYNI modulu kullanir; yapisal cikti
    // bozulursa panel sessizce bos kalir.
    const { veriTeshisi } = await import('../server/lib/veri-teshis.js');
    const db2 = new DatabaseSync(dbPath, { readOnly: true });
    const r = veriTeshisi((sql, p = []) => db2.prepare(sql).all(...p));
    db2.close();
    assert.equal(r.bolumler.length, 7);
    assert.ok(r.ozet.toplamBulgu > 0);
    // 6. bolum (sayim durumu) bulgu sayilmaz
    assert.equal(r.ozet.toplamBulgu,
      r.bolumler.filter((b) => b.no !== 6).reduce((t, b) => t + b.sayi, 0));
    for (const b of r.bolumler) {
      assert.ok(b.baslik && b.aciklama, JSON.stringify(b));
      for (const f of b.bulgular) assert.ok(f.baslik && f.detay, JSON.stringify(f));
    }
  });

  test('veritabanini DEGISTIRMEZ', () => {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    // Kurulumda 10 kart yazildi; rapor hicbirine dokunmamali
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM products').get().n, 13);
    db.close();
    assert.match(rapor, /Veritabani degistirilmedi/);
  });
});
