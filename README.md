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

### Denetim kontrolleri
- **Kör sayım** — miktar girilirken "olması gereken" gizlidir; sayan kişi hedef rakamı göremez
- **İki imza** — sayıma katılan ikinci kişi kayda geçer; sayımı kilitleyen kendi sayımını kesinleştiremez
- **Üretilen ürün ayrımı** — tost/çay gibi sayılamayan kalemler ayrı beyan edilir, beyanın payı uyarı olarak gösterilir
- **Reçete (BOM)** — "1 tost = 2 dilim ekmek + 30 g kaşar": maliyet tahmin değil hammadde toplamı olur,
  beyan edilen üretim adedi hammadde tüketimiyle çapraz kontrol edilir
- **Habersiz nokta sayımı** — seçili ürünlerde ara kontrol; stoğa dokunmaz, silinemez
- **Ciro teslim fişi** — günlük ciro beyanı imzayla sabitlenir: fiş kesildiği an tutar
  dondurulur, o günler görevliye kapanır, yönetim düzeltirse fiş "FARKLI" olarak işaretlenir
- Ayrıntılar: **[docs/DENETIM-KONTROLLERI.md](docs/DENETIM-KONTROLLERI.md)**

### Stok ve envanter
- Kampüs bazlı stok defteri — her rakamın arkasında belge var (açılış, alım, fire, transfer, sayım)
- Periyodik sayım fişi: barkod okuyucu destekli, tablet uyumlu hızlı giriş
- Sayım akışı: taslak → kilitli → kesinleşmiş; geriye dönük kayıt kilidi
- Kilitli sayım yalnızca gerekçeyle yeniden açılır, her açılış denetim izinde
- Kritik stok seviyesi ve önerilen sipariş miktarı
- Kampüsler arası transfer takibi
- Fire/zayiat kaydı (SKT, kırılma, bozulma, ikram, personel)
- **Tedarikçiye iade** — fireden ayrı tutulur: maliyeti kantine yazılmaz,
  tedarikçinin cari hesabından düşer. İade belgesi alım belgesinden doldurulabilir.

### Ciro ve denetim
- Günlük ciro girişi: nakit / kredi kartı / veresiye-öğrenci kartı / diğer kırılımı
- Z rapor no eşleştirme alanı
- Ciro takvimi — girilmemiş iş günlerini kırmızı gösterir
- Toplu ciro girişi (haftalık/aylık tek ekranda)
- **Ciro teslim fişi** — ön muhasebeye imza karşılığı teslim için A4'e iki nüsha çıktı
  (kantin / ön muhasebe), günlük döküm, tutarın yazıyla karşılığı, iki imza satırı,
  belge numarası ve 6 haneli doğrulama kodu
- Teslim edilmemiş ciro takibi — 3 günden uzun bekleyen ciro panelde uyarı olur
- Belge doğrulama ekranı — eldeki kâğıdın sistemdeki kayıtla aynı olup olmadığını gösterir
- Sayım bazlı mutabakat raporu ve kalem bazlı sapma listesi

### Reçete ve üretim
- Üç ürün tipi: satın alınan · hammadde (sayılır ama satılmaz) · üretilen
- Partili reçete desteği (1 demlik çay = 40 bardak)
- Üretilen ürünün gerçek birim maliyeti ve kâr marjı; tahminle arasındaki sapma gösterilir
- Sayımda hammadde tüketimi reçeteden hesaplanıp sayım farkından düşülür
- Reçete kontrolü raporu: beyan edilen üretim hammadde tüketimiyle tutarlı mı?

### Fiyat ve kârlılık
- **Alış fiyatı ürün kartında elle tutulmaz** — mal girişlerinden (fatura veya
  açılış stoğu) oluşur ve **iskonto düşülmüş gerçek maliyettir**. Her kampüs
  kendi alımının fiyatını taşır: aynı ürün Esenyurt'a başka, Çorlu'ya başka
  fiyata gelebilir ve stok değeri buna göre hesaplanır. Fire, satış ve sayım
  farkı fiyat belirlemez; belge iptal edilirse bir önceki girişe dönülür
- **Satış fiyatı tarih bazlıdır** — “1 Ekim'den itibaren 15 TL” diye
  tanımlanır, günü gelince kendiliğinden geçer. Geçmişe dönük raporlar o
  dönemde geçerli olan fiyatı kullanır. Yürürlüğe girmiş fiyat silinemez
  (o dönemin kârlılığını açıklayan kayıttır); ileri tarihli fiyat iptal edilir
- Alış (KDV hariç) ve satış (KDV dahil) fiyatı ayrı tutulur
- Birim kâr, kâr marjı ve maliyet üzeri kâr oranı otomatik hesaplanır
- Kampüs bazlı fiyat istisnası (tarihli)
- Fiyat değişiklik geçmişi; alımda %10 üzeri fiyat artışı uyarısı
- Fiyat denetimi raporu: zararına satış, düşük marj, tavan fiyat aşımı
- Ayrıntılar: **[docs/FIYAT-YONETIMI.md](docs/FIYAT-YONETIMI.md)**

### Fatura ve belge
- **e-Fatura / e-Arşiv XML aktarımı** — UBL-TR XML dosyasını yükleyin: tedarikçi (VKN ile),
  belge no, tarih, vade ve tüm kalemler (miktar, KDV hariç birim fiyat, iskonto, KDV oranı)
  kendiliğinden dolar. Ürünler barkod veya adla eşlenir
- Eşleşmeyen kalem sessizce atlanmaz: satır kırmızı işaretlenir, ürün seçilmeden belge kaydedilmez
- Fatura toplamı satırlarla çapraz kontrol edilir; tutmuyorsa uyarı çıkar
- **İskontolar** — satır iskontosu satıra işlenir; **belge geneli iskonto**
  (ciro primi vb.) satırlara mal bedeline orantılı dağıtılır. Dağıtılmazsa stok
  maliyeti gerçekten ödenenden yüksek kaydedilir ve kâr olduğundan düşük görünür
- Aynı e-Fatura (ETTN) ikinci kez aktarılamaz
- **Karekod (QR) okuma** — kâğıt/PDF faturadaki GİB karekodu kamerayla ya da
  fotoğraftan okunur: tedarikçi, belge no, tarih ve ETTN dolar. Karekodda ürün
  satırı yoktur (GİB içeriği başlık + toplamlardır), onun yerine **elle girdiğiniz
  satırlar faturanın KDV oranı başına matrah/KDV toplamlarıyla anlık karşılaştırılır**;
  fark kalırsa kaydederken onay istenir. XML olmadan da mükerrer fatura koruması çalışır
- Adım adım: **[docs/FATURA-GIRISI.md](docs/FATURA-GIRISI.md)**
- **Tedarikçi ürün eşleştirmesi (öğrenen)** — aynı ürün her faturada aynı adla
  gelmez ("AYRAN 200 ML" / "KUTU AYRAN" / "AYRAN PK"). Bir kez eşleştirdiğinizde
  sistem öğrenir; o tedarikçinin sonraki faturalarında kalem kendiliğinden
  bulunur. Eşleştirme tedarikçi bazlıdır, satıcı ürün kodu varsa o kullanılır,
  yazım farkları (harf/boşluk/noktalama/Türkçe) önemsenmez. **Çevrim çarpanı**
  ile koli/paket alımı adede çevrilir (1 fatura birimi = N stok birimi);
  belge tutarı değişmez. Tedarikçiler → 🔗 Ürün Eşleştirmeleri ekranından
  görülüp düzeltilir
- **Aranabilir ürün seçici** — fatura satırında ürün adını yazdıkça süzülür;
  her satırda barkod ve **mevcut stok** görünür. Türkçe karakter gerekmez
  ("cay" → "Çay"). Listenin sonundan, faturadaki bilgilerle **yerinde yeni
  ürün** tanımlanabilir; eşleşmeyen tedarikçi de aynı şekilde eklenir
- **Eşleşmeyen fatura satırları paneli** — faturada olup belgeye alınmayan
  kalemler iz bırakır. Her biri ya bir ürüne bağlanır (belgeye satır olarak
  eklenir, stoğa girer) ya da sebebi yazılarak yok sayılır. Aksi halde fatura
  toplamı ile belge toplamı arasındaki fark aylar sonra açıklanamaz kalır
- **Belge iptali ve kalıcı silme** — iptal belgeyi kayıtta bırakır ve ETTN'yi
  serbest bırakır; kalıcı silme (yalnızca yönetim) satırları, stok hareketlerini
  ve fatura dosyalarını diskten de siler, içeriği denetim günlüğüne yazar
- **Fatura dosyası ekleme** — PDF, fotoğraf veya XML belgeye iliştirilir; denetimde
  "bu rakam nereden geldi" sorusu tek tıkla açılır
- Her dosyanın SHA-256 özeti saklanır (sonradan değişirse anlaşılır); silme yetkisi
  genel müdürlüktedir ve denetim izine yazılır

### Tedarikçi
- İrsaliye/fatura girişi (iskonto, KDV, SKT alanlarıyla)
- **Vergi numarası zorunlu ve tekil** — 10 hane VKN veya 11 hane TCKN. Aynı
  numara ikinci firmaya verilemez; hata mesajı çakışan firmanın adını söyler.
  Mükerrer tedarikçi kartı sessiz bir hatadır: fatura bazen birine bazen
  ötekine yazılır, cari borç ikiye bölünür
- Mükerrer belge no kontrolü
- Cari hesap: toplam alım, iade, ödemeler, bakiye (Bakiye = Alım − İade − Ödeme)
- Tedarikçi bazlı alım ve iade raporu (iade oranı %5'i geçen tedarikçi işaretlenir)

### Raporlar
- Ürün bazlı satış adedi ve kârlılık
- Aylık kampüs özeti ve ciro farkı denetimi
- Kampüs karşılaştırma (öğrenci başına ciro/günlük harcama, marj, fire)
- Kritik stok, fire analizi, tedarikçi alımları
- Tüm raporlar Excel (CSV) olarak indirilebilir

### Güvenlik ve yönetim
- 6 rol: Sistem Yöneticisi, Genel Müdürlük, Kampüs Yöneticisi, Kantin Görevlisi,
  **Ön Muhasebe (veri girişi)**, Denetçi (salt okunur). Kullanıcılar ekranındaki
  **Rol Açıklamaları** kartı her rolün ne yapıp ne yapamadığını tek tek sayar
- **Ön muhasebe** bir veri girişi rolüdür: fatura/mal girişi, tedarikçi ve
  ödemeler, iadeler, ürün kartı ve fiyatlar, günlük ciro girer; teslim fişini
  onaylar. Sayım kesinleştiremez, stok düzeltemez, kuruluş tanımlarına
  dokunamaz, belgeyi kalıcı silemez. Yetki **alan alan** verilir ve varsayılan
  kapalıdır — sonradan eklenen bir uç yanlışlıkla açılmaz
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

> Örnek ürün/tedarikçi listesi **yalnızca `npm run seed` açıkça çalıştırıldığında**
> eklenir. Sunucu açılışta kendiliğinden yalnızca zorunlu kayıtları (yönetici,
> kampüsler, kategoriler) oluşturur — böylece `--bos` ile kurulan bir üretim
> veritabanına ilk açılışta örnek veri dolmaz.

### Docker ile

```bash
docker compose up -d
```

### Testler

```bash
npm test        # 130 test: uçtan uca API + karekod çözümleyici
npm run test:ui # tarayıcı regresyon testleri:
                #   sayim-akisi  — kör sayım → iki imza → kesinleştirme
                #   ciro-teslim  — teslim fişi → tutar dondurma → kod ile onay
                #   fatura-eki   — e-Fatura XML aktarımı → fatura dosyası ekleme
                #   karekod      — karekod ile başlık + satır/fatura çapraz kontrolü
                #   yetki-ve-silme — VKN tekilliği, belge silme, ön muhasebe yetkisi
                #   eslesmeyen-satirlar — kayda alınmayan kalemin izi ve çözümü
                #   belge-iskontosu — belge geneli iskontonun satırlara dağıtımı
                #   fiyat-mimarisi — alış faturadan, satış tarih bazlı
                #   urun-eslestirme — tedarikçi ürün adlarının öğrenilmesi
```

`test:ui` Playwright gerektirir (`npm i -g playwright && playwright install chromium`)
ve çalışan bir sunucu ile `--demo` verisi bekler.

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

Sunucunuzda **zaten başka uygulamalar ve bir Caddy/Traefik ters vekili varsa**
→ **[docs/KURULUM-DOCKER-CADDY.md](docs/KURULUM-DOCKER-CADDY.md)**
(host'a hiçbir şey kurmaz, diğer uygulamalara dokunmaz).

Boş bir sunucuya kuruyorsanız aşağıdaki rehber:

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
7. **Sayım** yapın: miktarları girin → **Sayımı Kilitle** (sayıma katılan kişiyi yazın)
   → sapmalar açılır → **başka bir yetkili** kesinleştirir. Mutabakat raporu otomatik çıkar.
   Kasa yazılımı kullanılmadığı için ilk 3 ay **haftalık** sayım önerilir;
   rakamlar oturunca 15 günde bire, sonra ayda bire düşürebilirsiniz.
8. Ayda bir **habersiz nokta sayımı** yapın — yüksek cirolu 5-10 üründe, tarih vermeden.

---

## Hesaplama kabulleri

| Alan | Kabul |
|---|---|
| `purchase_price` | Tedarikçiden alış, **KDV hariç**. Ürün kartında yalnızca *başlangıç* değeridir; geçerli fiyat mal girişlerinden gelir |
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
  lib/              auth, stok defteri, para/KDV hesapları, denetim izi, dosya saklama
  routes/           API uçları
public/
  index.html        Tek sayfa uygulama kabuğu
  css/app.css       Arayüz stilleri (açık/koyu tema)
  js/pages/         Ekranlar
  js/xlsx.js        Tarayıcı içi Excel okuyucu (harici kütüphane yok)
  js/efatura.js     Tarayıcı içi e-Fatura (UBL-TR) okuyucu
  js/karekod.js     Fatura karekodu (GİB QR) çözümleyici + çapraz kontrol
  js/urun-secici.js Aranabilir ürün seçici (stok gösterir, yerinde ürün açar)
test/
  api.test.js       Uçtan uca API testleri
  karekod.test.js   Karekod çözümleyici birim testleri
  ui/               Tarayıcı regresyon testi
deploy/             systemd, nginx ve cron dosyaları
scripts/
  yedekle.sh        Veritabanı + fatura ekleri yedekleme
  kontrol.sh        Kurulum sonrası sağlık kontrolü
  sablon-olustur.py Excel şablonu üretici
docs/
  DENETIM-KONTROLLERI.md  Kör sayım, iki imza, üretilen ürün, nokta sayımı, ciro teslim fişi
  KURULUM-DOCKER-CADDY.md Mevcut Docker + Caddy sunucusuna yan yana kurulum
  FATURA-GIRISI.md  Tedarikçi faturasını işleme: XML, karekod, elle giriş, dosya ekleme
  FIYAT-YONETIMI.md Alış fiyatı nereden gelir, tarih bazlı satış fiyatı
  VPS-KURULUM.md    Sunucu kurulum rehberi
  YOL-HARITASI.md   Atlanan noktalar ve sonraki aşama önerileri
  sablonlar/        Excel şablonu ve örnek e-Fatura XML'leri (biri iskontolu)
```

---

## Yedekleme

Yedeklenmesi gereken **iki** şey var:

| Ne | Nerede |
|---|---|
| Veritabanı (tüm kayıtlar) | `data/kantin.db` |
| Fatura dosyaları (PDF / foto / XML) | `data/ekler/` |

```bash
./scripts/yedekle.sh          # ikisini de backups/ klasörüne tarihli alır
```

Betik veritabanı için `kantin-<tarih>.db.gz`, fatura ekleri için
`ekler-<tarih>.tar.gz` üretir. Sunucu çalışırken bile güvenlidir (SQLite online
backup kullanılır).

> Yalnızca `.db` dosyasını yedeklemek yetmez: fatura dosyaları veritabanının
> içinde değil, diskte durur. Geri yüklerken **ikisini birlikte** alın, yoksa
> kayıtlar durur ama faturaların kendisi kaybolur.

Yedekleri mutlaka **başka bir makinede/bulutta** da saklayın.
