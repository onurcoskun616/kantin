# Topkapı Okulları — Kantin Yönetim ve Denetim Sistemi

5 kampüsün kantin stoklarını, günlük cirolarını, tedarikçi alımlarını ve ürün
kârlılığını tek yerden yöneten, tarayıcı üzerinden çalışan web uygulaması.

Sistemin çekirdeği **sayım bazlı ciro mutabakatıdır**: periyodik sayımlarda
kayıtlara göre olması gereken stok ile fiilen sayılan stok karşılaştırılır,
aradaki fark dönemin satışını verir. Bu satışın parasal karşılığı ile girilen
günlük cirolar karşılaştırılarak kantin denetlenir.

```
Dönem satışı  = Dönem başı stok + Alımlar + Transfer girişleri
                − Transfer çıkışları − Fire − Dönem sonu sayım
Beklenen ciro = Σ (dönem satışı × satış fiyatı)
Fark          = Girilen ciro − Beklenen ciro     (eksi ise ciro açığı)
```

---

## Özellikler

### Stok ve envanter
- Kampüs bazlı stok defteri — her rakamın arkasında belge var (açılış, alım, fire, transfer, sayım)
- Periyodik sayım fişi: barkod okuyucu destekli, tablet uyumlu hızlı giriş
- Sayım kesinleştirme ve geriye dönük kayıt kilidi
- Kritik stok seviyesi ve önerilen sipariş miktarı
- Kampüsler arası transfer takibi
- Fire/zayiat kaydı (SKT, kırılma, bozulma, ikram, personel)

### Ciro ve denetim
- Günlük ciro girişi: nakit / kredi kartı / veresiye-öğrenci kartı / diğer kırılımı
- Z rapor no eşleştirme alanı
- Ciro takvimi — girilmemiş iş günlerini kırmızı gösterir
- Toplu ciro girişi (haftalık/aylık tek ekranda)
- Sayım bazlı mutabakat raporu ve kalem bazlı sapma listesi

### Fiyat ve kârlılık
- Alış (KDV hariç) ve satış (KDV dahil) fiyatı ayrı tutulur
- Birim kâr, kâr marjı ve maliyet üzeri kâr oranı otomatik hesaplanır
- Kampüs bazlı fiyat istisnası
- Fiyat değişiklik geçmişi; alımda %10 üzeri fiyat artışı uyarısı
- Fiyat denetimi raporu: zararına satış, düşük marj, tavan fiyat aşımı

### Tedarikçi
- İrsaliye/fatura girişi (iskonto, KDV, SKT alanlarıyla)
- Mükerrer belge no kontrolü
- Cari hesap: toplam alım, ödemeler, bakiye
- Tedarikçi bazlı alım raporu

### Raporlar
- Ürün bazlı satış adedi ve kârlılık
- Aylık kampüs özeti ve ciro farkı denetimi
- Kampüs karşılaştırma (öğrenci başına ciro/günlük harcama, marj, fire)
- Kritik stok, fire analizi, tedarikçi alımları
- Tüm raporlar Excel (CSV) olarak indirilebilir

### Güvenlik ve yönetim
- 5 rol: Sistem Yöneticisi, Genel Müdürlük, Kampüs Yöneticisi, Kantin Görevlisi, Denetçi (salt okunur)
- Kampüs bazlı veri izolasyonu — görevli yalnızca kendi kampüsünü görür
- Parolalar `scrypt` ile saklanır, oturumlar HMAC imzalı
- Silinemez denetim izi: kim, ne zaman, neyi değiştirdi
- Kesinleşmiş sayım dönemine geriye dönük müdahale engeli

---

## Kurulum

### Gereksinim
Yalnızca **Node.js 22.5 veya üstü**. Harici npm bağımlılığı, derleme adımı veya
ayrı bir veritabanı sunucusu gerekmez (veritabanı: yerleşik SQLite).

```bash
node -v      # v22.5.0+ olmalı
```

### Adımlar

```bash
git clone <repo-adresi> kantin
cd kantin

cp .env.example .env
# .env dosyasını açıp SESSION_SECRET ve ADMIN_PASSWORD değerlerini değiştirin

node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"   # SESSION_SECRET üretir

npm run seed     # veritabanını oluşturur, 5 kampüs + örnek ürünleri ekler
npm start        # http://localhost:3000
```

İlk giriş bilgileri `.env` dosyasındaki `ADMIN_EMAIL` / `ADMIN_PASSWORD`
değerleridir. **Giriş yaptıktan sonra parolayı mutlaka değiştirin.**

### Örnek veriyle denemek

```bash
npm run seed -- --demo      # 60 günlük örnek alım ve ciro verisi üretir
npm run reset -- --demo     # her şeyi siler ve baştan örnek veri kurar
```

### Docker ile

```bash
docker compose up -d
```

### Testler

```bash
npm test     # 24 uçtan uca API testi
```

---

## Sisteme geçiş sırası

1. **Kampüsler** ekranından 5 kampüsün adını, öğrenci sayısını ve (varsa) okul pay oranını girin.
2. **Kullanıcılar** ekranından her kampüse bir kantin görevlisi ve bir kampüs yöneticisi tanımlayın.
3. **Ürünler** ekranından ürün listesini, barkodları, alış/satış fiyatlarını ve KDV oranlarını girin.
4. **Tedarikçiler** ekranından çalıştığınız firmaları tanımlayın.
5. **Stok Durumu → Açılış Stoğu Gir** ile her kampüsün mevcut rafını sayarak sisteme girin.
6. Bu tarihten itibaren **her mal girişini** ve **her günün cirosunu** günü gününe işleyin.
7. Ay sonunda (veya 15 günde bir) **Sayım** yapıp kesinleştirin — mutabakat raporu otomatik çıkar.

---

## Hesaplama kabulleri

| Alan | Kabul |
|---|---|
| `purchase_price` | Tedarikçiden alış, **KDV hariç** (fatura satır fiyatı) |
| `sale_price` | Öğrenciye satış, **KDV dahil** (raf etiketi) |
| Birim kâr | `satış(KDV hariç) − alış(KDV hariç)` |
| Kâr marjı % | `birim kâr / satış(KDV hariç) × 100` |
| Maliyet üzeri kâr % | `birim kâr / alış × 100` |

KDV devlete ait olduğu için kârlılık her zaman KDV hariç netler üzerinden
hesaplanır; aksi halde kâr yapay olarak yüksek görünür.

Yerleşik KDV oranları örnek değerlerdir — kendi mali müşavirinizle doğrulayıp
ürün kartlarından güncelleyin.

---

## Proje yapısı

```
server/
  index.js          HTTP sunucusu ve yönlendirme
  schema.sql        Veritabanı şeması
  seed.js           İlk kurulum ve demo verisi
  config.js         Ayarlar (.env okuyucu)
  db.js             SQLite erişim katmanı
  lib/              auth, stok defteri, para/KDV hesapları, denetim izi
  routes/           API uçları
public/
  index.html        Tek sayfa uygulama kabuğu
  css/app.css       Arayüz stilleri (açık/koyu tema)
  js/pages/         Ekranlar
test/
  api.test.js       Uçtan uca API testleri
docs/
  YOL-HARITASI.md   Sonraki aşama önerileri
```

---

## Yedekleme

Tüm veri tek dosyadadır: `data/kantin.db`.

```bash
./scripts/yedekle.sh          # backups/ klasörüne tarihli kopya alır
```

Sunucu çalışırken bile güvenlidir (SQLite online backup kullanılır).
Yedek dosyasını mutlaka **başka bir makinede/bulutta** da saklayın.
