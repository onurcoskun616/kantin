/**
 * VERI TESHISI — veri kalitesi sorunlarini tek seferde tarar.
 *
 * Sahada hatalari ekran ekran, gozle bulduk: koli fiyatinin adet fiyati
 * sanilmasi, satilmis ama fiyati tanimsiz kalemler, mukerrer kartlar...
 * Hepsi ayni koke dayaniyor ve hepsi veritabaninda SORGUYLA bulunabilir.
 *
 * Bu modul tek kaynaktir: komut satiri araci (scripts/veri-teshis.mjs)
 * ve panel (Sistem Durumu ekrani) ayni sonucu uretir. Ikisi ayri
 * yazilsaydi biri duzelirken digeri eskide kalirdi.
 *
 * SALT OKUNURDUR. Rapora kisisel veri yazilmaz (kullanici adi, e-posta,
 * parola ozeti yok) -- boylece rapor guvenle paylasilabilir.
 */

const TR = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i',
  ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u',
};

/** Ad karsilastirma/arama icin sadelestirme. */
export function sadelestir(s) {
  return String(s || '').replace(/\*/g, ' x ')
    .replace(/[çÇğĞıİöÖşŞüÜ]/g, (c) => TR[c] || c).toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Urun adindaki ambalaj adedi ipuclari: "50GX20KL" -> 20, "10 LU" -> 10.
 * Kesin degil ADAYDIR; raporda "olabilir" diye sunulur.
 */
export function adAdetIpucu(ad) {
  const t = sadelestir(ad);
  const b = new Set();
  for (const m of t.matchAll(/x\s*(\d{1,3})/g)) b.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*l[uiy]\b/g)) b.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*adet/g)) b.add(Number(m[1]));
  return [...b].filter((n) => n >= 2 && n <= 500).sort((a, c) => a - c);
}

const tl = (n) => `₺${Number(n || 0).toLocaleString('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const sayi = (n) => Number(n || 0).toLocaleString('tr-TR', { maximumFractionDigits: 3 });

/**
 * Teshisi calistirir.
 *
 * @param {(sql: string, params?: unknown[]) => object[]} all  satir dondiren sorgu
 * @returns {{ozet: object, bolumler: object[]}}
 */
export function veriTeshisi(all) {
  const bolumler = [];
  const ekle = (no, baslik, aciklama, bulgular, ozet = null) =>
    bolumler.push({ no, baslik, aciklama, bulgular, ozet, sayi: bulgular.length });

  /* 1 ---------------------------------------------------------------- */
  {
    const aday = all(`
      SELECT p.id, p.name, p.unit, p.purchase_price, p.sale_price
        FROM products p
       WHERE p.is_active = 1 AND p.product_type = 'SATIN_ALINAN'
         AND p.sale_price > 0 AND p.purchase_price > p.sale_price
       ORDER BY p.purchase_price DESC`);
    const bulgular = [];
    for (const r of aday) {
      for (const n of adAdetIpucu(r.name)) {
        const birim = r.purchase_price / n;
        const marj = ((r.sale_price - birim) / r.sale_price) * 100;
        if (marj < 20 || marj > 90) continue;
        bulgular.push({
          productId: r.id,
          baslik: `#${r.id} ${r.name}`,
          detay: `alış ${tl(r.purchase_price)} ÷ ${n} = ${tl(birim)}`
            + ` → satış ${tl(r.sale_price)} ile %${marj.toFixed(1)} marj   [birim: ${r.unit}]`,
          carpan: n, birimAlis: Math.round(birim * 100) / 100,
        });
        break;
      }
    }
    ekle(1, 'Koli fiyatı adet fiyatı sanılmış olabilir',
      'Zararına satılan ürünlerde alış fiyatı, adındaki ambalaj adedine bölününce makul '
      + 'bir marj veriyorsa fatura koli üzerinden girilmiş ve çevrim uygulanmamış demektir. '
      + 'Miktar da koli kadar girmiştir.', bulgular);
  }

  /* 2 ---------------------------------------------------------------- */
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
    let toplam = 0;
    const bulgular = satirlar.map((r) => {
      const maliyet = r.sold_qty * r.purchase_price;
      toplam += maliyet;
      return {
        baslik: `${r.kampus} · ${r.count_date} · ${r.urun}`,
        detay: `${sayi(r.sold_qty)} ${r.unit} satılmış · maliyeti ${tl(maliyet)} · ciroya ₺0,00`,
        maliyet: Math.round(maliyet * 100) / 100,
      };
    });
    ekle(2, 'Satılmış ama satış fiyatı tanımsız',
      'Kesinleşmiş sayımlarda raftan çıkmış ama satış fiyatı 0 olan kalemler. '
      + 'Beklenen ciroya SIFIR TL yazılmıştır.', bulgular,
      bulgular.length ? `Toplam maliyet ${tl(toplam)}` : null);
  }

  /* 3 ---------------------------------------------------------------- */
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
    const bulgular = [...grup.values()].filter((g) => g.length > 1).map((g) => ({
      baslik: `"${g[0].name}"`,
      detay: g.map((u) => `#${u.id} · ${u.unit} · stok ${sayi(stok.get(u.id) || 0)}`).join('   |   '),
      productIds: g.map((u) => u.id),
    }));
    ekle(3, 'Mükerrer ürün kartları',
      'Aynı ürün için ikinci kart açılmış; stok ikiye bölünür, sayım mutabakatı tutmaz.',
      bulgular);
  }

  /* 4 ---------------------------------------------------------------- */
  {
    const satirlar = all(`
      SELECT p.id, p.name, p.unit, p.sale_price,
             ROUND(SUM(m.quantity), 3) AS stok, COUNT(m.id) AS hareket
        FROM products p JOIN stock_movements m ON m.product_id = p.id
       WHERE p.is_active = 1 AND UPPER(p.unit) IN ('KUTU','PAKET','KOLI')
       GROUP BY p.id ORDER BY p.name`);
    const bulgular = satirlar.map((r) => ({
      productId: r.id,
      baslik: `#${r.id} ${r.name}`,
      detay: `birim ${r.unit} · stok ${sayi(r.stok)} · ${r.hareket} hareket`
        + ` · satış ${tl(r.sale_price)}`,
    }));
    ekle(4, 'Birimi KUTU/PAKET olan, kullanımdaki kartlar',
      'Stok adet üzerinden sayılıyorsa bu kartların birimi ADET olmalıdır; aksi halde '
      + 'miktar ve fiyat koli bazında kalır. Stok şu an 0 olsa da geçmiş hareketleri '
      + 'koli bazındadır.', bulgular);
  }

  /* 5 ---------------------------------------------------------------- */
  {
    const satirlar = all(`
      SELECT id, name, unit, sale_price FROM products
       WHERE is_active = 1 AND sale_price > 0 AND sale_price < 5
       ORDER BY sale_price`);
    const bulgular = satirlar.map((r) => {
      const bozuk = String(r.sale_price).split('.')[1]?.length > 2;
      return {
        productId: r.id,
        baslik: `#${r.id} ${r.name}`,
        detay: `${r.sale_price}${bozuk ? '  ← ondalık bozuk' : ''}`,
        ondalikBozuk: Boolean(bozuk),
      };
    });
    ekle(5, 'Satış fiyatı bozuk görünen kartlar',
      'Koli fiyatının paket adedine bölünmüş hali gibi duran, kuruş seviyesinde '
      + 'ondalıklı satış fiyatları.', bulgular);
  }

  /* 6 ---------------------------------------------------------------- */
  {
    const kampusler = all('SELECT id, name FROM campuses WHERE is_active = 1 ORDER BY name');
    const bulgular = kampusler.map((k) => {
      const s = all(`
        SELECT status, is_opening, count_date FROM counts
         WHERE campus_id = ? AND count_type = 'DONEM'
         ORDER BY count_date DESC, id DESC LIMIT 5`, [k.id]);
      const kesin = s.filter((x) => x.status === 'KESINLESMIS');
      const sayilan = kesin.filter((x) => !x.is_opening);
      const durum = sayilan.length ? `son dönem sayımı ${sayilan[0].count_date}`
        : (kesin.length ? `yalnızca AÇILIŞ sayımı (${kesin[0].count_date})`
          : 'kesinleşmiş sayım YOK');
      const acik = s.find((x) => x.status !== 'KESINLESMIS');
      return {
        campusId: k.id,
        baslik: k.name,
        detay: durum + (acik ? `  · açık sayım: ${acik.count_date} (${acik.status})` : ''),
        sorunlu: !sayilan.length,
      };
    });
    ekle(6, 'Kampüs sayım durumu',
      'Satış/maliyet/kâr sütunları kesinleşmiş DÖNEM sayımından gelir.', bulgular);
  }

  /* 7 ---------------------------------------------------------------- */
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
    const bulgular = satirlar.map((r) => {
      const ipucu = adAdetIpucu(r.urun)[0];
      return {
        baslik: `${r.document_date} · ${r.document_no || '(no yok)'} · ${r.kampus} · ${r.tedarikci}`,
        detay: `${r.urun}: ${sayi(r.quantity)} ${r.unit} × ${tl(r.unit_price)}`
          + ` (satış ${tl(r.sale_price)})`
          + (ipucu ? `  → ÷${ipucu} = ${tl(r.unit_price / ipucu)}` : ''),
        carpan: ipucu ?? null,
      };
    });
    ekle(7, 'Fatura satırı koli girilmiş olabilir',
      'Birim fiyatı, ürünün satış fiyatının 3 katından yüksek olan fatura satırları. '
      + 'Koli fiyatı adet fiyatı gibi girilmiş olabilir.', bulgular);
  }

  const ozet = {
    kampus: all('SELECT 1 FROM campuses WHERE is_active = 1').length,
    urun: all('SELECT 1 FROM products').length,
    belge: all("SELECT 1 FROM purchases WHERE status <> 'IPTAL'").length,
    toplamBulgu: bolumler.filter((b) => b.no !== 6).reduce((t, b) => t + b.sayi, 0),
    uretildi: new Date().toISOString(),
  };
  return { ozet, bolumler };
}

/** Raporu duz metne cevirir (komut satiri ve indirme icin). */
export function raporMetni(rapor, kaynak = '') {
  const satir = [];
  satir.push(`TESHIS RAPORU — ${new Date(rapor.ozet.uretildi).toLocaleString('tr-TR')}`);
  if (kaynak) satir.push(`Veritabani: ${kaynak}`);
  satir.push(`Kampus: ${rapor.ozet.kampus} · Urun: ${rapor.ozet.urun}`
    + ` · Alim belgesi: ${rapor.ozet.belge} · Bulgu: ${rapor.ozet.toplamBulgu}`);
  for (const b of rapor.bolumler) {
    satir.push('', '='.repeat(72), `${b.no}. ${b.baslik.toUpperCase()}`, '='.repeat(72));
    satir.push(b.aciklama, '');
    if (!b.bulgular.length) {
      satir.push('  ✓ Bulgu yok.');
      continue;
    }
    for (const f of b.bulgular) {
      satir.push(`  ${f.baslik}`);
      satir.push(`      ${f.detay}`);
    }
    satir.push('', `  TOPLAM: ${b.bulgular.length}` + (b.ozet ? ` · ${b.ozet}` : ''));
  }
  satir.push('', '='.repeat(72), 'Rapor sonu. Veritabani degistirilmedi.', '');
  return satir.join('\n');
}
