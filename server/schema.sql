-- =====================================================================
-- Topkapi Okullari - Kantin Yonetim ve Denetim Sistemi
-- Sema surumu: 1
-- =====================================================================

-- ---------------------------------------------------------------------
-- Kampusler
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS campuses (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT    NOT NULL UNIQUE,
  name           TEXT    NOT NULL,
  address        TEXT,
  phone          TEXT,
  student_count  INTEGER NOT NULL DEFAULT 0,
  -- Kantin isletmecisi okula ciro uzerinden pay veriyorsa (%)
  rent_share_pct REAL    NOT NULL DEFAULT 0,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Kullanicilar ve oturumlar
--   ADMIN             : her sey (kullanici yonetimi dahil)
--   GENEL_MUDURLUK    : tum kampusleri gorur ve yonetir
--   KAMPUS_YONETICISI : sadece kendi kampusu, tam yetki
--   KANTIN_GOREVLISI  : sadece kendi kampusu, veri girisi (sayim/ciro/alim)
--   DENETCI           : tum kampusler, salt okunur
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  full_name     TEXT    NOT NULL,
  password_hash TEXT    NOT NULL,
  role          TEXT    NOT NULL CHECK (role IN
                  ('ADMIN','GENEL_MUDURLUK','KAMPUS_YONETICISI','KANTIN_GOREVLISI','DENETCI')),
  campus_id     INTEGER REFERENCES campuses(id) ON DELETE SET NULL,
  is_active     INTEGER NOT NULL DEFAULT 1,
  last_login_at TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_users_campus ON users(campus_id);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_agent TEXT,
  ip         TEXT,
  expires_at TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------
-- Urun katalogu
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS suppliers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  tax_office TEXT,
  tax_no     TEXT,
  phone      TEXT,
  email      TEXT,
  address    TEXT,
  note       TEXT,
  is_active  INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_suppliers_name ON suppliers(name);

-- Fiyatlar:
--   purchase_price : tedarikciden ALIS fiyati, KDV HARIC (fatura satiri)
--   sale_price     : ogrenciye SATIS fiyati, KDV DAHIL (raf etiketi)
-- Kar hesabi KDV haric netler uzerinden yapilir (bkz. server/lib/money.js)
CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode         TEXT    UNIQUE,
  name            TEXT    NOT NULL,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  unit            TEXT    NOT NULL DEFAULT 'ADET',
  -- SATIN_ALINAN : tedarikciden alinir, raftan sayilir, dogrudan satilir
  -- HAMMADDE     : tedarikciden alinir, raftan sayilir, dogrudan SATILMAZ;
  --                uretilen urunlerin recetesinde tuketilir (ekmek, kasar, cay)
  -- URETILEN     : kantinde hazirlanir (tost, cay, pogaca). Stogu sayilamaz;
  --                donem satisi sayim ekranindaki "uretim satisi" bolumunden girilir.
  product_type    TEXT    NOT NULL DEFAULT 'SATIN_ALINAN'
                    CHECK (product_type IN ('SATIN_ALINAN','HAMMADDE','URETILEN')),
  purchase_price  REAL    NOT NULL DEFAULT 0,
  sale_price      REAL    NOT NULL DEFAULT 0,
  vat_rate        REAL    NOT NULL DEFAULT 10,
  critical_stock  REAL    NOT NULL DEFAULT 0,
  -- MEB kantin yonetmeligi / gida guvenligi uygunlugu
  meb_approved    INTEGER NOT NULL DEFAULT 1,
  -- Resmi tarifedeki tavan fiyat (0 = tanimsiz)
  max_price       REAL    NOT NULL DEFAULT 0,
  track_expiry    INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
CREATE INDEX IF NOT EXISTS idx_products_category ON products(category_id);

-- ---------------------------------------------------------------------
-- Receteler (URETILEN urunler icin)
--
-- Bir recete `yield_quantity` adet urun uretir ve icindeki hammaddeleri
-- tuketir. Ornek: 1 demlik cay recetesi 40 bardak uretir, 60 g cay tuketir.
--
-- Recete iki ise yarar:
--   1. Uretilen urunun GERCEK maliyeti (tahmin degil, hammadde toplami)
--   2. Sayimda capraz kontrol: beyan edilen uretim adedinin gerektirdigi
--      hammadde ile fiilen tukenen hammadde karsilastirilir
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS recipes (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id     INTEGER NOT NULL UNIQUE REFERENCES products(id) ON DELETE CASCADE,
  -- Bu recete kac adet urun uretir (1 demlik cay = 40 bardak gibi)
  yield_quantity REAL    NOT NULL DEFAULT 1 CHECK (yield_quantity > 0),
  note           TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS recipe_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  recipe_id     INTEGER NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  -- yield_quantity adet urun icin gereken toplam miktar
  quantity      REAL    NOT NULL CHECK (quantity > 0),
  note          TEXT,
  UNIQUE (recipe_id, ingredient_id)
);
CREATE INDEX IF NOT EXISTS idx_recipe_items_recipe ON recipe_items(recipe_id);
CREATE INDEX IF NOT EXISTS idx_recipe_items_ingredient ON recipe_items(ingredient_id);

-- Kampus bazli fiyat/kritik stok istisnasi (NULL = katalog degeri gecerli)
CREATE TABLE IF NOT EXISTS campus_products (
  campus_id      INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  purchase_price REAL,
  sale_price     REAL,
  critical_stock REAL,
  is_active      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (campus_id, product_id)
);

-- Fiyat degisiklik gecmisi (denetim ve gecmise donuk kar hesabi icin)
CREATE TABLE IF NOT EXISTS price_history (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id      INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  campus_id       INTEGER REFERENCES campuses(id) ON DELETE CASCADE,
  old_purchase    REAL,
  new_purchase    REAL,
  old_sale        REAL,
  new_sale        REAL,
  effective_date  TEXT    NOT NULL,
  changed_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, effective_date);

-- ---------------------------------------------------------------------
-- Stok hareketleri (tek kaynak dogruluk - ledger)
--   quantity isaretli: giris (+), cikis (-)
--   ALIS            : tedarikciden mal girisi
--   IADE            : tedarikciye iade (-)
--   FIRE            : zayiat / SKT / kirilma / ikram (-)
--   TRANSFER_GIRIS  : baska kampusten gelen (+)
--   TRANSFER_CIKIS  : baska kampuse giden (-)
--   SATIS           : sayim ile hesaplanan ornek satis (-)
--   SAYIM_FAZLA     : sayimda fazla cikan (+)
--   ACILIS          : acilis stogu (+)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_movements (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id     INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  movement_type TEXT    NOT NULL CHECK (movement_type IN
                  ('ALIS','IADE','FIRE','TRANSFER_GIRIS','TRANSFER_CIKIS','SATIS','SAYIM_FAZLA','ACILIS')),
  quantity      REAL    NOT NULL,
  unit_cost     REAL    NOT NULL DEFAULT 0,
  movement_date TEXT    NOT NULL,
  ref_type      TEXT,
  ref_id        INTEGER,
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_mov_campus_product ON stock_movements(campus_id, product_id);
CREATE INDEX IF NOT EXISTS idx_mov_date ON stock_movements(movement_date);
CREATE INDEX IF NOT EXISTS idx_mov_ref ON stock_movements(ref_type, ref_id);

-- ---------------------------------------------------------------------
-- Alim (tedarikci irsaliye/fatura)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id     INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  document_no   TEXT,
  document_date TEXT    NOT NULL,
  net_total     REAL    NOT NULL DEFAULT 0,
  vat_total     REAL    NOT NULL DEFAULT 0,
  gross_total   REAL    NOT NULL DEFAULT 0,
  paid_amount   REAL    NOT NULL DEFAULT 0,
  due_date      TEXT,
  status        TEXT    NOT NULL DEFAULT 'ONAYLI' CHECK (status IN ('TASLAK','ONAYLI','IPTAL')),
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_purchases_campus_date ON purchases(campus_id, document_date);
CREATE INDEX IF NOT EXISTS idx_purchases_supplier ON purchases(supplier_id);

CREATE TABLE IF NOT EXISTS purchase_lines (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  product_id   INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity     REAL    NOT NULL,
  unit_price   REAL    NOT NULL,           -- KDV haric birim alis
  vat_rate     REAL    NOT NULL DEFAULT 10,
  discount_pct REAL    NOT NULL DEFAULT 0,
  net_total    REAL    NOT NULL DEFAULT 0,
  vat_total    REAL    NOT NULL DEFAULT 0,
  gross_total  REAL    NOT NULL DEFAULT 0,
  expiry_date  TEXT
);
CREATE INDEX IF NOT EXISTS idx_purchase_lines_purchase ON purchase_lines(purchase_id);

-- ---------------------------------------------------------------------
-- Tedarikciye iade
--
-- Fire'den farklidir: fire'de maliyet kantinde kalir, iadede tedarikci
-- alacaklandirir. Bu yuzden iade fire raporuna girmez, tedarikcinin cari
-- hesabindan dusulur. Stok etkisi ayni yondedir (IADE hareketi, eksi miktar).
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supplier_returns (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id     INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  supplier_id   INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  -- Hangi alim belgesine dayandigi (biliniyorsa)
  purchase_id   INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  document_no   TEXT,
  return_date   TEXT    NOT NULL,
  reason        TEXT    NOT NULL CHECK (reason IN
                  ('BOZUK','SKT','YANLIS_URUN','FAZLA_GONDERIM','HASARLI','DIGER')),
  net_total     REAL    NOT NULL DEFAULT 0,
  vat_total     REAL    NOT NULL DEFAULT 0,
  gross_total   REAL    NOT NULL DEFAULT 0,
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_returns_campus_date ON supplier_returns(campus_id, return_date);
CREATE INDEX IF NOT EXISTS idx_returns_supplier ON supplier_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_returns_purchase ON supplier_returns(purchase_id);

CREATE TABLE IF NOT EXISTS supplier_return_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id   INTEGER NOT NULL REFERENCES supplier_returns(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity    REAL    NOT NULL CHECK (quantity > 0),
  unit_price  REAL    NOT NULL,            -- KDV haric birim iade fiyati
  vat_rate    REAL    NOT NULL DEFAULT 10,
  net_total   REAL    NOT NULL DEFAULT 0,
  vat_total   REAL    NOT NULL DEFAULT 0,
  gross_total REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_return_lines_return ON supplier_return_lines(return_id);

-- Tedarikciye yapilan odemeler (cari hesap)
CREATE TABLE IF NOT EXISTS supplier_payments (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id  INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  campus_id    INTEGER REFERENCES campuses(id) ON DELETE SET NULL,
  purchase_id  INTEGER REFERENCES purchases(id) ON DELETE SET NULL,
  amount       REAL    NOT NULL,
  payment_date TEXT    NOT NULL,
  method       TEXT    NOT NULL DEFAULT 'NAKIT',
  note         TEXT,
  created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Fire / zayiat
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS waste_records (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id  INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity   REAL    NOT NULL CHECK (quantity > 0),
  reason     TEXT    NOT NULL CHECK (reason IN ('SKT','KIRILMA','BOZULMA','IKRAM','PERSONEL','DIGER')),
  waste_date TEXT    NOT NULL,
  unit_cost  REAL    NOT NULL DEFAULT 0,
  note       TEXT,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_waste_campus_date ON waste_records(campus_id, waste_date);

-- ---------------------------------------------------------------------
-- Kampusler arasi transfer
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS transfers (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  from_campus_id INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  to_campus_id   INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  transfer_date  TEXT    NOT NULL,
  note           TEXT,
  created_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now')),
  CHECK (from_campus_id <> to_campus_id)
);

CREATE TABLE IF NOT EXISTS transfer_lines (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity    REAL    NOT NULL CHECK (quantity > 0),
  unit_cost   REAL    NOT NULL DEFAULT 0
);

-- ---------------------------------------------------------------------
-- Sayim (envanter)
--   period_start : bir onceki kesinlesmis sayimin tarihi (yoksa acilis)
--   status       : TASLAK -> KESINLESMIS
--   Kesinlesince ornek satis hesaplanir ve stok hareketi yazilir.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS counts (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id          INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  count_date         TEXT    NOT NULL,
  period_start       TEXT,
  -- DONEM : donem sonu sayimi, stogu kapatir ve mutabakat uretir
  -- NOKTA : habersiz ara sayim; secili urunlerde anlik tespit, stoga dokunmaz
  count_type         TEXT    NOT NULL DEFAULT 'DONEM' CHECK (count_type IN ('DONEM','NOKTA')),
  -- TASLAK   : miktarlar giriliyor (kor sayimda beklenen miktar gizlidir)
  -- SAYILDI  : sayim kilitlendi, sapmalar aciga cikti, onay bekliyor
  -- KESINLESMIS : yonetici onayladi, stok hareketleri yazildi
  status             TEXT    NOT NULL DEFAULT 'TASLAK'
                       CHECK (status IN ('TASLAK','SAYILDI','KESINLESMIS')),
  -- Kor sayim: girerken "olmasi gereken" miktar gizlenir (bkz. docs/DENETIM-KONTROLLERI.md)
  is_blind           INTEGER NOT NULL DEFAULT 1,
  note               TEXT,
  -- Sayima fiilen katilan ikinci kisi (sistem kullanicisi olmayabilir)
  witness_name       TEXT,
  -- Kesinlesme aninda donmus ozet degerler
  expected_revenue   REAL    NOT NULL DEFAULT 0,
  actual_revenue     REAL    NOT NULL DEFAULT 0,
  cogs_total         REAL    NOT NULL DEFAULT 0,
  -- Uretilen urunlerden gelen beklenen ciro (ayri gosterilir, denetim icin)
  production_revenue REAL    NOT NULL DEFAULT 0,
  reopened_count     INTEGER NOT NULL DEFAULT 0,
  created_by         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  submitted_at       TEXT,
  finalized_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  finalized_at       TEXT,
  created_at         TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_counts_campus_date ON counts(campus_id, count_date);

CREATE TABLE IF NOT EXISTS count_lines (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id          INTEGER NOT NULL REFERENCES counts(id) ON DELETE CASCADE,
  product_id        INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  expected_qty      REAL    NOT NULL DEFAULT 0,  -- kayitlara gore olmasi gereken
  counted_qty       REAL    NOT NULL DEFAULT 0,  -- fiilen sayilan
  diff_qty          REAL    NOT NULL DEFAULT 0,  -- counted - expected
  -- Recetelere gore uretimde tuketilmis olmasi gereken miktar
  recipe_qty        REAL    NOT NULL DEFAULT 0,
  -- Donem dogrudan satisi = expected - recipe_qty - counted
  sold_qty          REAL    NOT NULL DEFAULT 0,
  purchase_price    REAL    NOT NULL DEFAULT 0,
  sale_price        REAL    NOT NULL DEFAULT 0,
  vat_rate          REAL    NOT NULL DEFAULT 10,
  sales_value       REAL    NOT NULL DEFAULT 0,  -- sold_qty * sale_price (KDV dahil)
  cost_value        REAL    NOT NULL DEFAULT 0,  -- sold_qty * purchase_price (KDV haric)
  UNIQUE (count_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_count_lines_count ON count_lines(count_id);

-- Uretilen urunlerin (tost, cay, pogaca) donem satis adedi.
-- Bu urunler raftan sayilamadigi icin adet beyana dayanir; mutabakatta
-- ayri bir kalem olarak gosterilir ki sayimla dogrulanan kismi golgelemesin.
CREATE TABLE IF NOT EXISTS production_sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  count_id       INTEGER NOT NULL REFERENCES counts(id) ON DELETE CASCADE,
  product_id     INTEGER NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity       REAL    NOT NULL DEFAULT 0,
  purchase_price REAL    NOT NULL DEFAULT 0,
  sale_price     REAL    NOT NULL DEFAULT 0,
  vat_rate       REAL    NOT NULL DEFAULT 10,
  sales_value    REAL    NOT NULL DEFAULT 0,
  cost_value     REAL    NOT NULL DEFAULT 0,
  UNIQUE (count_id, product_id)
);

-- ---------------------------------------------------------------------
-- Gunluk ciro
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS daily_revenues (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  campus_id     INTEGER NOT NULL REFERENCES campuses(id) ON DELETE CASCADE,
  revenue_date  TEXT    NOT NULL,
  cash_amount   REAL    NOT NULL DEFAULT 0,
  card_amount   REAL    NOT NULL DEFAULT 0,
  credit_amount REAL    NOT NULL DEFAULT 0,  -- veresiye / ogrenci karti
  other_amount  REAL    NOT NULL DEFAULT 0,
  total_amount  REAL    NOT NULL DEFAULT 0,
  z_report_no   TEXT,
  is_school_day INTEGER NOT NULL DEFAULT 1,
  note          TEXT,
  created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE (campus_id, revenue_date)
);
CREATE INDEX IF NOT EXISTS idx_revenue_date ON daily_revenues(revenue_date);

-- ---------------------------------------------------------------------
-- Denetim izi
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_email TEXT,
  action     TEXT    NOT NULL,
  entity     TEXT    NOT NULL,
  entity_id  INTEGER,
  campus_id  INTEGER,
  detail     TEXT,
  ip         TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_logs(entity, entity_id);

-- ---------------------------------------------------------------------
-- Ayarlar
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
