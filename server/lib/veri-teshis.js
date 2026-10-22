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
    // ACILIS (devir) sayimlari HARIC. Acilista fark satis degildir: stok
    // sifirdan kurulurken beklenen ile sayilan arasindaki fark devir
    // duzeltmesidir, raftan cikis degil. Ciro raporlari da acilis
    // sayimlarini saymaz (is_opening = 0); burada da saymamak gerekir,
    // yoksa rapor olmayan bir ciro kaybi uydurur.
    const satilan = all(`
      SELECT k.name AS kampus, c.count_date, p.name AS urun, p.unit,
             l.sold_qty, l.purchase_price
        FROM count_lines l
        JOIN counts c ON c.id = l.count_id
         AND c.status = 'KESINLESMIS' AND c.is_opening = 0
        JOIN campuses k ON k.id = c.campus_id
        JOIN products p ON p.id = l.product_id
       WHERE l.sold_qty > 0 AND COALESCE(l.sale_price, 0) <= 0
       ORDER BY k.name, l.sold_qty * l.purchase_price DESC`);
    let toplam = 0;
    const bulgular = satilan.map((r) => {
      const maliyet = r.sold_qty * r.purchase_price;
      toplam += maliyet;
      return {
        tur: 'gerceklesen',
        baslik: `GERÇEKLEŞEN · ${r.kampus} · ${r.count_date} · ${r.urun}`,
        detay: `${sayi(r.sold_qty)} ${r.unit} satılmış · maliyeti ${tl(maliyet)} · ciroya ₺0,00`,
        maliyet: Math.round(maliyet * 100) / 100,
      };
    });

    // Henuz kesinlesmemis ama ayni kaybi uretecek kartlar: stok hareketi
    // var, sayim gununde gecerli satis fiyati yok.
    //
    // FIYAT KARTTAN DEGIL, TARIHTEN OKUNUR. Satis fiyati tarihlidir ve
    // kesinlestirmede SAYIMIN GUNUNDE gecerli olan fiyat kullanilir
    // (bkz. salePriceSql, server/lib/stock.js). Karta bugun fiyat girmek
    // 19 Ekim'de sayilmis bir donemi KURTARMAZ; hatta kampuse ozel ya da
    // daha geç tarihli hatali bir satir, dogru fiyati tamamen golgeler.
    // Bu yuzden kontrol de ayni sirayi izler, yoksa rapor "fiyat var" der
    // ama sayim yine sifir ciro uretir.
    //
    // SQL buraya kopyalanmadi: lib/stock.js, acilista veritabanini acan
    // db.js'e baglidir; komut satiri araci kendi dosyasini actigi icin onu
    // ice aktaramaz. Sira degisirse iki yer birlikte guncellenmelidir.
    const fiyatSatirlari = all(
      'SELECT product_id, campus_id, sale_price, effective_from, id FROM product_prices'
    );
    const fiyatDizini = new Map();
    for (const r of fiyatSatirlari) {
      const k = `${r.product_id}:${r.campus_id ?? ''}`;
      if (!fiyatDizini.has(k)) fiyatDizini.set(k, []);
      fiyatDizini.get(k).push(r);
    }
    const sonFiyat = (productId, campusId, tarih) => {
      const liste = fiyatDizini.get(`${productId}:${campusId ?? ''}`) || [];
      let secili = null;
      for (const r of liste) {
        if (r.effective_from > tarih) continue;
        if (!secili || r.effective_from > secili.effective_from
          || (r.effective_from === secili.effective_from && r.id > secili.id)) secili = r;
      }
      return secili;
    };
    const kampusKart = new Map(all(
      'SELECT campus_id, product_id, sale_price FROM campus_products'
    ).map((r) => [`${r.campus_id}:${r.product_id}`, r.sale_price]));
    const katalogKart = new Map(all(
      "SELECT id, name, unit, sale_price FROM products WHERE is_active = 1 AND product_type <> 'HAMMADDE'"
    ).map((r) => [r.id, r]));

    /** salePriceSql() ile AYNI sira: kampus tarihli -> katalog tarihli -> kampus sutunu -> katalog sutunu. */
    const fiyatCoz = (productId, campusId, tarih) => {
      const k = sonFiyat(productId, campusId, tarih);
      if (k) return k.sale_price;
      const g = sonFiyat(productId, null, tarih);
      if (g) return g.sale_price;
      const cp = kampusKart.get(`${campusId}:${productId}`);
      if (cp !== undefined && cp !== null) return cp;
      return katalogKart.get(productId)?.sale_price ?? 0;
    };

    // Hangi gun icin bakacagiz? Kesinlesmeyi bekleyen DONEM sayimi varsa
    // ONUN gunu; yoksa bugun. Kritik olan bu: kesinlestirme o gunun
    // fiyatini kullanacak.
    const bugun = new Date().toISOString().slice(0, 10);
    const hedefler = all(`
      SELECT k.id, k.name,
             (SELECT c.count_date FROM counts c
               WHERE c.campus_id = k.id AND c.count_type = 'DONEM'
                 AND c.status <> 'KESINLESMIS'
               ORDER BY c.count_date DESC, c.id DESC LIMIT 1) AS acik_tarih
        FROM campuses k WHERE k.is_active = 1 ORDER BY k.name`);
    const hareketli = all(`
      SELECT campus_id, product_id, ROUND(SUM(quantity), 3) AS stok, COUNT(id) AS hareket
        FROM stock_movements GROUP BY campus_id, product_id`);

    const urunBasi = new Map();
    for (const h of hareketli) {
      const urun = katalogKart.get(h.product_id);
      if (!urun) continue;                                  // pasif ya da HAMMADDE
      const hedef = hedefler.find((x) => x.id === h.campus_id);
      if (!hedef) continue;
      const tarih = hedef.acik_tarih || bugun;
      if (fiyatCoz(h.product_id, h.campus_id, tarih) > 0) continue;
      if (!urunBasi.has(h.product_id)) urunBasi.set(h.product_id, { urun, yerler: [] });
      urunBasi.get(h.product_id).yerler.push(
        `${hedef.name}${hedef.acik_tarih ? ` (${hedef.acik_tarih} sayımı)` : ''}`
      );
    }
    const fiyatsiz = [...urunBasi.values()]
      .sort((a, b) => a.urun.name.localeCompare(b.urun.name, 'tr'));
    for (const { urun, yerler } of fiyatsiz) {
      bulgular.push({
        tur: 'riskli',
        productId: urun.id,
        baslik: `RİSKLİ · #${urun.id} ${urun.name}`,
        detay: `o günün satış fiyatı ₺0,00 · ${yerler.join(' · ')}`
          + ' · sayım kesinleşirse ciroya ₺0,00 yazılır',
      });
    }

    const ozetSatir = [];
    if (satilan.length) ozetSatir.push(`Gerçekleşen kayıp: ${satilan.length} kalem, maliyeti ${tl(toplam)}`);
    if (fiyatsiz.length) ozetSatir.push(`Fiyatı girilmeyi bekleyen: ${fiyatsiz.length} kart`);
    ozetSatir.push('Fiyat SAYIM GÜNÜNE göre okunur: geçmiş bir dönemi düzeltirken '
      + 'geçerlilik tarihini sayım gününden önceye alın.');
    ekle(2, 'Satış fiyatı tanımsız kalemler',
      'İki tür bulgu: GERÇEKLEŞEN — kesinleşmiş DÖNEM sayımında raftan çıkmış ama satış '
      + 'fiyatı 0 olan kalemler; beklenen ciroya SIFIR TL yazılmıştır. RİSKLİ — stok '
      + 'hareketi olan ama satış fiyatı tanımsız kartlar; sayım kesinleşince aynı kayıp '
      + 'bunlarda da oluşur, şimdi düzeltilebilir. AÇILIŞ (devir) sayımları hariçtir: '
      + 'orada fark satış değil, devir düzeltmesidir.', bulgular,
      ozetSatir.join(' · ') || null);
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
    // Olcut ONDALIKTIR, fiyatin kucuk olmasi degil. Onceki surum "5 TL'den
    // dusuk" olanlari listeliyordu; ₺2,00 yara bandi ve ₺2,50 sakiz gibi
    // DOGRU fiyatlar da listeye duserek yanlis alarm veriyordu. Kurusa
    // yuvarlandiginda degisen fiyat elle girilmis olamaz: bir bolme
    // isleminin artigi demektir (or. 50 / 18 = 2,777778).
    const satirlar = all(`
      SELECT id, name, unit, sale_price FROM products
       WHERE is_active = 1 AND sale_price > 0 AND ROUND(sale_price, 2) <> sale_price
       ORDER BY sale_price`);
    const bulgular = satirlar.map((r) => ({
      productId: r.id,
      baslik: `#${r.id} ${r.name}`,
      detay: `${r.sale_price}  ← ondalık bozuk (kuruşa yuvarlanmışı ${tl(r.sale_price)})`,
      ondalikBozuk: true,
    }));
    ekle(5, 'Satış fiyatı bozuk görünen kartlar',
      'Kuruşa yuvarlandığında değişen satış fiyatları: elle böyle bir fiyat girilmez, '
      + 'koli fiyatının paket adedine bölünmüş hali olabilir. Doğru perakende fiyatını '
      + 'elle yazın.', bulgular);
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
      // Kiyas KARTIN satis fiyatidir. O fiyat bozuksa (5. bolum) satir
      // haksiz yere suclu gorunur: sebep faturada degil, kartta olabilir.
      const kiyasBozuk = Math.round(r.sale_price * 100) / 100 !== r.sale_price;
      return {
        baslik: `${r.document_date} · ${r.document_no || '(no yok)'} · ${r.kampus} · ${r.tedarikci}`,
        detay: `${r.urun}: ${sayi(r.quantity)} ${r.unit} × ${tl(r.unit_price)}`
          + ` (satış ${tl(r.sale_price)})`
          + (ipucu ? `  → ÷${ipucu} = ${tl(r.unit_price / ipucu)}` : '')
          + (kiyasBozuk ? '  ⚠ kartın satış fiyatı da bozuk — ÖNCE onu düzeltin' : ''),
        carpan: ipucu ?? null,
        kiyasBozuk,
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
