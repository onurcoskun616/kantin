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

### Gerçek kullanıma geçerken

```bash
npm run seed -- --bos       # örnek ürün/tedarikçi listesi OLMADAN kurar
```

`--bos` yalnızca 5 kampüsü (İkitelli OSB, İstanbul OSB, Esenyurt, Kıraç, Çorlu),
kategorileri ve yönetici hesabını oluşturur. Ürünleri Excel şablonuyla yüklersiniz.

### Docker ile

```bash
docker compose up -d
```

### Testler

```bash
npm test     # 24 uçtan uca API testi
```

---

## Excel ile ürün listesi yükleme

`docs/sablonlar/urun-listesi-sablonu.xlsx` dosyasını doldurup uygulamadaki
**Ürünler → Excel'den Aktar** düğmesiyle yükleyin. Şablonu uygulamanın içinden
de indirebilirsiniz.

Şablonda üç sekme var:

| Sekme | İçerik |
|---|---|
| Nasıl Doldurulur | Alan açıklamaları, fiyat/KDV kuralları, kampüs kodları |
| Ürün Listesi | Doldurulacak ana liste — birim kâr ve marj anında hesaplanır |
| Açılış Stoğu | İsteğe bağlı: kampüs kodu + miktar ile ilk stokları aynı dosyadan aktarın |

- Sarı hücreler doldurulur, gri hücreler otomatik hesaplanır.
- Zararına satış kırmızı, %20 altı marj sarı görünür — yüklemeden önce hatayı yakalarsınız.
- Yükleme öncesi önizleme gösterilir; onaylamadan hiçbir kayıt oluşmaz.
- Barkodu daha önce yüklenmiş ürün tekrar eklenmez, **güncellenir** — toplu fiyat
  güncellemesi için de aynı şablonu kullanabilirsiniz.
- `.xlsx` ve `.csv` desteklenir. Şablonu kullanmasanız da olur; başlıkları tanıyan
  bir eşleştirme var (Ürün Adı / Alış Fiyatı / Satış Fiyatı yeterli).

Şablonu yeniden üretmek için: `python3 scripts/sablon-olustur.py`

---

## Sunucuya kurulum (VPS)

Ubuntu üzerinde systemd + nginx + HTTPS + otomatik yedekleme içeren adım adım
rehber: **[docs/VPS-KURULUM.md](docs/VPS-KURULUM.md)**

Hazır dosyalar `deploy/` klasöründedir (systemd servisi, nginx yapılandırması,
cron yedekleme görevi).

---

## Sisteme geçiş sırası

1. **Kampüsler** ekranından 5 kampüsün öğrenci sayısını ve (varsa) okul pay oranını girin.
   Kampüsler kurulumda hazır gelir: İkitelli OSB, İstanbul OSB, Esenyurt, Kıraç, Çorlu.
2. **Kullanıcılar** ekranından her kampüse bir kantin görevlisi ve bir kampüs yöneticisi tanımlayın.
   Sayımı giren ile kesinleştiren farklı kişi olmalıdır — sistem bunu zorunlu kılar.
3. **Ürünler → Excel'den Aktar** ile ürün listesini yükleyin (yukarıdaki bölüme bakın).
4. **Tedarikçiler** ekranından çalıştığınız firmaları tanımlayın.
5. **Açılış stoğunu** girin — Excel şablonunun "Açılış Stoğu" sekmesinden ya da
   **Stok Durumu → Açılış Stoğu Gir** ekranından.
6. Bu tarihten itibaren **her mal girişini** ve **her günün cirosunu** günü gününe işleyin.
7. **Sayım** yapıp kesinleştirin — mutabakat raporu otomatik çıkar.
   Kasa yazılımı kullanılmadığı için ilk 3 ay **haftalık** sayım önerilir;
   rakamlar oturunca 15 günde bire, sonra ayda bire düşürebilirsiniz.

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

KDV oranını **tedarikçi faturanızdan** okuyup ürün kartına (veya Excel şablonuna)
yazmanız yeterlidir. Süt, ekmek ve taze meyve gibi temel gıdalarda oran düşük;
gazlı içecek ve kırtasiyede yüksektir. Emin olmadığınız üründe faturaya bakın.

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
  js/xlsx.js        Tarayıcı içi Excel okuyucu (harici kütüphane yok)
test/
  api.test.js       Uçtan uca API testleri
deploy/             systemd, nginx ve cron dosyaları
scripts/
  yedekle.sh        Veritabanı yedekleme
  sablon-olustur.py Excel şablonu üretici
docs/
  VPS-KURULUM.md    Sunucu kurulum rehberi
  YOL-HARITASI.md   Atlanan noktalar ve sonraki aşama önerileri
  sablonlar/        Excel şablonu
```

---

## Yedekleme

Tüm veri tek dosyadadır: `data/kantin.db`.

```bash
./scripts/yedekle.sh          # backups/ klasörüne tarihli kopya alır
```

Sunucu çalışırken bile güvenlidir (SQLite online backup kullanılır).
Yedek dosyasını mutlaka **başka bir makinede/bulutta** da saklayın.
