/**
 * VERI TESHIS RAPORU — salt okunur.
 *
 * Bu oturumda elle tespit ettigimiz hata turlerini veritabaninda tek
 * tek arar ve okunabilir bir rapor yazar. Hicbir sey DEGISTIRMEZ:
 * veritabani salt okunur acilir.
 *
 * Kisisel veri YAZMAZ: kullanici adi, e-posta, parola ozeti raporda
 * yer almaz. Rapor tedarikci/urun/kampus adlari ve sayilardan ibarettir,
 * boylece guvenle paylasilabilir.
 *
 * Kullanim (sunucuda, uygulama dizininde):
 *   node tools/teshis.mjs > teshis.txt
 *   node tools/teshis.mjs /opt/kantin-uygulama/data/kantin.db > teshis.txt
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

const DB = process.argv[2] || path.resolve(process.cwd(), 'data/kantin.db');
let db;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (err) {
  console.error(`Veritabani acilamadi (${DB}): ${err.message}`);
  process.exit(1);
}
const all = (sql, p = []) => db.prepare(sql).all(...p);
const tl = (n) => `₺${Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sayi = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 3 });

const baslik = (n, s) => console.log(`\n${'='.repeat(72)}\n${n}. ${s}\n${'='.repeat(72)}`);
const bos = (s) => console.log(`  ✓ ${s}`);

/** Urun adindaki ambalaj adedi ipuclari ("50GX20KL" -> 20). */
const TR = { ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u' };
const sadelestir = (s) => String(s || '').replace(/\*/g, ' x ')
  .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR[c] || c).toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ').trim();
function adAdetIpucu(ad) {
  const t = sadelestir(ad);
  const b = new Set();
  for (const m of t.matchAll(/x\s*(\d{1,3})/g)) b.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*l[uiy]\b/g)) b.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*adet/g)) b.add(Number(m[1]));
  return [...b].filter((n) => n >= 2 && n <= 500).sort((a, c) => a - c);
}

const kampusler = all('SELECT id, name FROM campuses WHERE is_active = 1 ORDER BY name');
console.log(`TESHIS RAPORU — ${new Date().toLocaleString('tr-TR')}`);
console.log(`Veritabani: ${DB}`);
console.log(`Kampus: ${kampusler.length} · Urun: ${all('SELECT 1 FROM products').length}`
  + ` · Alim belgesi: ${all("SELECT 1 FROM purchases WHERE status <> 'IPTAL'").length}`);

/* ------------------------------------------------------------------ */
baslik(1, 'KOLI FIYATI ADET FIYATI SANILMIS OLABILIR');
console.log('Zararina satilan urunlerde alis fiyati, adindaki ambalaj adedine');
console.log('bolununce makul bir marj veriyorsa fatura koli uzerinden girilmis');
console.log('ve cevrim uygulanmamis demektir. Miktar da koli kadar girmistir.\n');
{
  const satirlar = all(`
    SELECT p.id, p.name, p.unit, p.purchase_price, p.sale_price
      FROM products p
     WHERE p.is_active = 1 AND p.product_type = 'SATIN_ALINAN'
       AND p.sale_price > 0 AND p.purchase_price > p.sale_price
     ORDER BY p.purchase_price DESC`);
  const bulgu = [];
  for (const r of satirlar) {
    for (const n of adAdetIpucu(r.name)) {
      const birim = r.purchase_price / n;
      const marj = ((r.sale_price - birim) / r.sale_price) * 100;
      if (marj >= 20 && marj <= 90) { bulgu.push({ ...r, n, birim, marj }); break; }
    }
  }
  if (!bulgu.length) bos('Boyle bir kalem bulunamadi.');
  for (const b of bulgu) {
    console.log(`  #${b.id} ${b.name}`);
    console.log(`      alis ${tl(b.purchase_price)} ÷ ${b.n} = ${tl(b.birim)}`
      + ` → satis ${tl(b.sale_price)} ile %${b.marj.toFixed(1)} marj   [birim: ${b.unit}]`);
  }
  console.log(`\n  TOPLAM: ${bulgu.length} kalem`);
}

/* ------------------------------------------------------------------ */
baslik(2, 'SATILMIS AMA SATIS FIYATI TANIMSIZ');
console.log('Kesinlesmis sayimlarda raftan cikmis ama satis fiyati 0 olan');
console.log('kalemler. Beklenen ciroya SIFIR TL yazilmistir.\n');
{
  const satirlar = all(`
    SELECT k.name AS kampus, c.count_date, p.name AS urun, p.unit,
           l.sold_qty, l.purchase_price
      FROM count_lines l
      JOIN counts c ON c.id = l.count_id AND c.status = 'KESINLESMIS'
      JOIN campuses k ON k.id = c.campus_id
      JOIN products p ON p.id = l.product_id
     WHERE l.sold_qty > 0 AND COALESCE(l.sale_price, 0) <= 0
     ORDER BY k.name, l.sold_qty * l.purchase_price DESC`);
  if (!satirlar.length) bos('Kesinlesmis sayimlarda boyle bir kalem yok.');
  let toplam = 0;
  for (const r of satirlar) {
    const maliyet = r.sold_qty * r.purchase_price;
    toplam += maliyet;
    console.log(`  ${r.kampus} · ${r.count_date} · ${r.urun}`);
    console.log(`      ${sayi(r.sold_qty)} ${r.unit} satilmis · maliyeti ${tl(maliyet)} · ciroya ₺0,00`);
  }
  if (satirlar.length) console.log(`\n  TOPLAM: ${satirlar.length} kalem · maliyet ${tl(toplam)}`);
}

/* ------------------------------------------------------------------ */
baslik(3, 'MUKERRER URUN KARTLARI');
console.log('Ayni urun icin ikinci kart acilmis; stok ikiye bolunur,');
console.log('sayim mutabakati tutmaz.\n');
{
  const urunler = all('SELECT id, name, unit FROM products WHERE is_active = 1');
  const stok = new Map(all(`
    SELECT product_id, ROUND(SUM(quantity), 3) AS q
      FROM stock_movements GROUP BY product_id`).map((r) => [r.product_id, r.q]));
  const grup = new Map();
  for (const u of urunler) {
    const k = sadelestir(u.name);
    if (!grup.has(k)) grup.set(k, []);
    grup.get(k).push(u);
  }
  const mukerrer = [...grup.values()].filter((g) => g.length > 1);
  if (!mukerrer.length) bos('Birebir ayni adli mukerrer kart yok.');
  for (const g of mukerrer) {
    console.log(`  "${g[0].name}"`);
    for (const u of g) console.log(`      #${u.id} · ${u.unit} · stok ${sayi(stok.get(u.id) || 0)}`);
  }
  if (mukerrer.length) console.log(`\n  TOPLAM: ${mukerrer.length} grup`);
}

/* ------------------------------------------------------------------ */
baslik(4, 'BIRIMI KUTU/PAKET OLAN, KULLANIMDAKI KARTLAR');
console.log('Stok adet uzerinden sayiliyorsa bu kartlarin birimi ADET');
console.log('olmalidir; aksi halde miktar ve fiyat koli bazinda kalir.');
console.log('Stok su an 0 olsa da gecmis hareketleri koli bazindadir.\n');
{
  const satirlar = all(`
    SELECT p.id, p.name, p.unit, p.sale_price,
           ROUND(SUM(m.quantity), 3) AS stok, COUNT(m.id) AS hareket
      FROM products p JOIN stock_movements m ON m.product_id = p.id
     WHERE p.is_active = 1 AND UPPER(p.unit) IN ('KUTU','PAKET','KOLI')
     GROUP BY p.id
     ORDER BY p.name`);
  if (!satirlar.length) bos('Ambalaj birimli, hareket gormus kart yok.');
  for (const r of satirlar) {
    console.log(`  #${r.id} ${r.name} · birim ${r.unit} · stok ${sayi(r.stok)}`
      + ` · ${r.hareket} hareket · satis ${tl(r.sale_price)}`);
  }
  if (satirlar.length) console.log(`\n  TOPLAM: ${satirlar.length} kart`);
}

/* ------------------------------------------------------------------ */
baslik(5, 'SATIS FIYATI BOZUK GORUNEN KARTLAR');
console.log('Koli fiyatinin paket adedine bolunmus hali gibi duran,');
console.log('kurus seviyesinde ondalikli satis fiyatlari.\n');
{
  const satirlar = all(`
    SELECT id, name, unit, sale_price FROM products
     WHERE is_active = 1 AND sale_price > 0 AND sale_price < 5
     ORDER BY sale_price`);
  if (!satirlar.length) bos('Boyle bir fiyat yok.');
  for (const r of satirlar) {
    const ondalikli = Math.abs(r.sale_price - Math.round(r.sale_price * 100) / 100) > 1e-9
      || String(r.sale_price).split('.')[1]?.length > 2;
    console.log(`  #${r.id} ${r.name} · ${r.sale_price}${ondalikli ? '  ← ondalik bozuk' : ''}`);
  }
}

/* ------------------------------------------------------------------ */
baslik(6, 'KAMPUS SAYIM DURUMU');
console.log('Satis/maliyet/kar sutunlari kesinlesmis DONEM sayimindan gelir.\n');
for (const k of kampusler) {
  const s = all(`
    SELECT status, is_opening, count_date FROM counts
     WHERE campus_id = ? AND count_type = 'DONEM'
     ORDER BY count_date DESC, id DESC LIMIT 5`, [k.id]);
  const kesin = s.filter((x) => x.status === 'KESINLESMIS');
  const sayilan = kesin.filter((x) => !x.is_opening);
  const durum = sayilan.length ? `son donem sayimi ${sayilan[0].count_date}`
    : (kesin.length ? `yalnizca ACILIS sayimi (${kesin[0].count_date})` : 'kesinlesmis sayim YOK');
  const acik = s.find((x) => x.status !== 'KESINLESMIS');
  console.log(`  ${k.name.padEnd(30)} ${durum}`
    + (acik ? `  · acik sayim: ${acik.count_date} (${acik.status})` : ''));
}

/* ------------------------------------------------------------------ */
baslik(7, 'FATURA SATIRI KOLI GIRILMIS OLABILIR');
console.log('Birim fiyati, urunun satis fiyatinin 3 katindan yuksek olan');
console.log('fatura satirlari. Koli fiyati adet fiyati gibi girilmis olabilir.\n');
{
  const satirlar = all(`
    SELECT pu.document_no, pu.document_date, k.name AS kampus, s.name AS tedarikci,
           p.name AS urun, p.unit, l.quantity, l.unit_price, p.sale_price
      FROM purchase_lines l
      JOIN purchases pu ON pu.id = l.purchase_id AND pu.status <> 'IPTAL'
      JOIN campuses k ON k.id = pu.campus_id
      JOIN suppliers s ON s.id = pu.supplier_id
      JOIN products p ON p.id = l.product_id
     WHERE p.sale_price > 0 AND l.unit_price > p.sale_price * 3
     ORDER BY pu.document_date DESC, l.unit_price DESC`);
  if (!satirlar.length) bos('Boyle bir fatura satiri yok.');
  for (const r of satirlar.slice(0, 60)) {
    const ipucu = adAdetIpucu(r.urun)[0];
    console.log(`  ${r.document_date} · ${r.document_no || '(no yok)'} · ${r.kampus} · ${r.tedarikci}`);
    console.log(`      ${r.urun}: ${sayi(r.quantity)} ${r.unit} × ${tl(r.unit_price)}`
      + ` (satis ${tl(r.sale_price)})`
      + (ipucu ? `  → ÷${ipucu} = ${tl(r.unit_price / ipucu)}` : ''));
  }
  console.log(`\n  TOPLAM: ${satirlar.length} satir`
    + (satirlar.length > 60 ? ' (ilk 60 gosterildi)' : ''));
}

console.log(`\n${'='.repeat(72)}\nRapor sonu. Veritabani degistirilmedi.\n`);
db.close();
