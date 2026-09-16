# Atlanan Noktalar ve Yol Haritası

Bu belge iki bölümden oluşur:

1. **Talebinizde yer almayan ama bu sürüme dahil ettiğim kritik parçalar** —
   bunlar olmadan sayım/ciro denetimi güvenilir sonuç vermez.
2. **Sonraki aşamalar için öneriler** — sistem kullanıma girdikten sonra
   önceliklendirebileceğiniz geliştirmeler.

---

## 1. Talebinizde olmayan, sisteme eklediğim parçalar

### 1.1 Fire / zayiat kaydı  ✅ eklendi
Bozulan, kırılan, son kullanma tarihi geçen, ikram edilen veya personelin
tükettiği ürünler kaydedilmezse sayımda eksik çıkar ve **kayıp/kaçak gibi
görünür**. Denetimi anlamlı kılan en kritik eksik parça buydu. Neden kodlarıyla
(SKT, kırılma, bozulma, ikram, personel, diğer) ayrı ayrı raporlanıyor.

### 1.2 Kampüsler arası transfer  ✅ eklendi
5 kampüsünüz olduğu için ürünler kampüsler arasında gidip gelecektir.
Kaydedilmezse gönderen kampüste açık, alan kampüste fazla oluşur.

### 1.3 KDV ayrımı  ✅ eklendi
Alış fiyatı KDV hariç (fatura), satış fiyatı KDV dahil (raf) tutuluyor; kâr
**KDV hariç netler** üzerinden hesaplanıyor. Aksi halde kâr marjı %10–20
yanıltıcı biçimde yüksek çıkar. Kantin ürünlerinde KDV oranları farklıdır
(süt/ekmek vs. içecek/kırtasiye), bu yüzden oran ürün bazlı tanımlanıyor.

### 1.4 Ciro ödeme türü kırılımı  ✅ eklendi
Nakit / kredi kartı / veresiye-öğrenci kartı ayrımı olmadan kasa mutabakatı
yapılamaz. POS ekstresi ile kart tutarını, kasa sayımıyla nakdi
karşılaştırabilirsiniz. Z rapor no alanı da eklendi.

### 1.5 Rol ve yetki ayrımı  ✅ eklendi
Denetim sisteminde veriyi giren ile denetleyen aynı kişi olmamalıdır:
- **Kantin Görevlisi** veri girer, sayımı **kesinleştiremez**
- **Kampüs Yöneticisi** sayımı kesinleştirir
- **Denetçi** hiçbir şeyi değiştiremez, her şeyi görür
- Görevli yalnızca kendi kampüsünün verisine erişir

### 1.6 Geriye dönük değişiklik kilidi  ✅ eklendi
Sayım kesinleştikten sonra o tarihten önceye alım/fire/transfer girilemez,
ciro yalnızca genel müdürlük tarafından düzeltilebilir. Bu olmadan geçmiş
dönem mutabakatı sessizce bozulabilirdi.

### 1.7 Silinemez denetim izi  ✅ eklendi
Kim, ne zaman, hangi kaydı nasıl değiştirdi — hepsi IP adresiyle birlikte
kayıt altında. Başarısız giriş denemeleri de loglanıyor.

### 1.8 Eksik ciro günü uyarısı  ✅ eklendi
Ciro takvimi hafta içi girilmemiş günleri kırmızı gösterir. Bir gün eksik
kalırsa mutabakat o kadar açık verir; en sık yapılan hata budur.

### 1.9 Mükerrer irsaliye kontrolü  ✅ eklendi
Aynı tedarikçiye ait aynı belge numarası ikinci kez girilemiyor. Aynı
irsaliyenin iki kez işlenmesi stoğu şişirip sahte "ciro fazlası" üretir.

### 1.10 Fiyat geçmişi ve artış uyarısı  ✅ eklendi
Alış fiyatı bir önceki değerin %10 üzerine çıktığında mal girişi sonrası
uyarı verilir; satış fiyatını güncellemeyi unutma riski ortadan kalkar.

### 1.11 Tavan fiyat ve yönetmelik uygunluğu  ✅ eklendi
Ürün kartında "tavan fiyat" ve "kantin yönetmeliğine uygun ürün" alanları var.
Fiyat denetimi raporu tavan aşımı, zararına satış ve düşük marjı listeler.

### 1.12 Öğrenci başına ciro göstergesi  ✅ eklendi
5 kampüsü doğru karşılaştırmanın tek yolu budur. 850 öğrencili kampüsün
cirosu 480 öğrencili kampüsten yüksek olacaktır; anlamlı olan
**öğrenci başına günlük harcamadır**. Kampüsler arası fark %20'yi geçiyorsa
fiyat politikası, ürün çeşidi veya kayıt disiplini farkı vardır.

### 1.13 Okul pay oranı  ✅ eklendi
Kantin dışarıya kiralıysa ciro üzerinden alınan okul payı otomatik hesaplanır.

### 1.14 Yedekleme  ✅ eklendi
`scripts/yedekle.sh` sunucu çalışırken bile tutarlı yedek alır.

---

## 2. Sonraki aşama önerileri

Öncelik sırasına göre dizilmiştir.

### Öncelik 1 — Kullanıma geçtikten hemen sonra

**Yazar kasa / POS entegrasyonu**
Şu anda satış adedi sayımdan geriye doğru hesaplanıyor. Kasadan ürün bazlı
satış verisi alınabilirse (günlük dosya aktarımı veya API), fark **gün bazında**
görülür; aylık sayımı beklemeye gerek kalmaz. Hangi kasa/POS yazılımını
kullandığınızı öğrenmem yeterli. Bu, sistemin denetim gücünü en çok artıracak
tek geliştirmedir.

**Otomatik yedekleme görevi**
`scripts/yedekle.sh` her gece 02:00'de cron ile çalışacak şekilde kurulmalı ve
yedekler ikinci bir konuma (bulut deposu) kopyalanmalı.

**Excel'den ürün listesi içe aktarma ekranı**
API hazır (`POST /api/products/bulk-import`), arayüzde dosya yükleme ekranı
eklenmeli. Mevcut ürün listeniz Excel'deyse ilk kurulum saatler yerine
dakikalar sürer.

### Öncelik 2 — İlk dönem içinde

**Son kullanma tarihi (SKT) takibi ve uyarı**
Alım satırında SKT alanı zaten var; parti bazlı stok takibi ve "3 gün içinde
SKT'si dolacak ürünler" uyarısı eklenmeli. Okul kantininde gıda güvenliği
açısından denetime de konu olur.

**E-posta / SMS özet bildirimi**
Genel müdürlüğe haftalık özet, sayım açığı oluştuğunda anlık uyarı.

**Sipariş önerisi ve satın alma talebi**
Kritik stok raporu var; buradan doğrudan tedarikçiye gönderilebilir sipariş
formu üretilmesi.

**Dönem/tatil takvimi**
Resmî tatil, yarıyıl tatili ve sınav günleri tanımlanıp "okul günü" sayısı
otomatik hesaplanabilir. Şu anda manuel işaretleniyor.

### Öncelik 3 — Olgunlaşma

**Menü/reçete yönetimi (üretilen ürünler)**
Tost, sandviç, çay gibi kantinde **üretilen** ürünlerin reçetesi tanımlanırsa
(1 tost = 2 dilim ekmek + 30 g kaşar), hammadde stoğu satıştan otomatik düşer.
Şu anda tost tek bir ürün olarak takip ediliyor; hammadde israfı görünmez.

**Öğrenci kartı / bakiye sistemi**
Veresiye alanı var ancak öğrenci bazlı bakiye takibi yok. Nakitsiz kantin
hedefleniyorsa ayrı bir modül gerekir (veli paneli, bakiye yükleme, harcama
limiti, alerjen/yasaklı ürün kısıtı).

**Mobil uygulama / PWA**
Arayüz tablet ve telefonda çalışıyor; çevrimdışı sayım yapabilmek için PWA'ya
dönüştürülmesi sahada işi hızlandırır.

**Muhasebe entegrasyonu**
Alım faturalarının ve cironun muhasebe programına (Logo, Mikro, Netsis vb.)
aktarımı.

**Çoklu sayım ekibi / çift sayım**
Yüksek riskli dönemlerde iki kişinin bağımsız sayıp sonuçların karşılaştırılması.

---

## 3. Süreç önerileri (yazılım değil, işletme)

Yazılım tek başına denetim sağlamaz. Aşağıdaki kuralları yazılı hale getirmenizi
öneririm:

| Konu | Öneri |
|---|---|
| Sayım sıklığı | Ayda 1 zorunlu + yılda 2 habersiz sayım |
| Sayımı kim yapar | Kantin görevlisi **tek başına** saymamalı; kampüs yöneticisi veya idari personel eşlik etmeli |
| Kesinleştirme | Sayımı giren kişi ile kesinleştiren kişi farklı olmalı (sistem bunu zorunlu kılıyor) |
| Ciro girişi | Her gün kapanışta, Z raporu ile birlikte |
| Kabul edilebilir fark | Ciro açığı **%2'yi** geçerse yazılı açıklama istenmeli |
| Mal kabul | İrsaliye olmadan mal kabul edilmemeli; miktar teslim alınırken sayılmalı |
| Fire | Aynı gün, fotoğraflı olarak kaydedilmeli |
| Fiyat değişikliği | Yalnızca genel müdürlük onayıyla; sistem geçmişi tutuyor |

**Fark yorumlama rehberi**

| Durum | Olası neden |
|---|---|
| Ciro açığı (fark eksi) | Kayıt dışı satış, eksik ciro beyanı, kaydedilmemiş fire/ikram, hatalı sayım, çalınma |
| Ciro fazlası (fark artı) | İşlenmemiş irsaliye, eksik mal girişi, yanlış satış fiyatı tanımı, sayımda fazla yazım |
| Tek üründe büyük sapma | Barkod/ürün karışıklığı, o ürüne özel kayıp |
| Tüm ürünlerde orantılı sapma | Sistematik sorun: fiyat tanımı, dönem tarihi veya sayım yöntemi hatası |
