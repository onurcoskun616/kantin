# Denetim Kontrolleri

Bu sistemin amacı kayıt tutmak değil, **kantini denetlemektir**. Kayıt tutan her
yazılım, kaydı giren kişi kötü niyetliyse kandırılabilir. Aşağıdaki dört kontrol
bunu zorlaştırmak için vardır.

Kontrollerin hepsi **sunucu tarafında** uygulanır: arayüzü değiştirerek,
tarayıcı konsolundan istek göndererek veya API'yi doğrudan çağırarak aşılamazlar.

---

## 1. Kör sayım

**Sorun.** Sayım fişinde "olması gereken" miktar görünüyorsa, sayan kişi rafı
saymak zorunda bile değildir: beyan ettiği ciroya denk düşen rakamı yazar, fark
sıfır çıkar, sistem "mutabakat sağlandı" der. Sınav kâğıdının yanına cevap
anahtarını koymak gibidir.

**Kontrol.** Sayım taslak halindeyken şu alanlar sunucu tarafında `null` olarak
döner ve arayüzde sütunları hiç oluşturulmaz:

| Gizlenen alan | Neden |
|---|---|
| `expected_qty` | Hedef rakam |
| `diff_qty` | Hedeften sapma |
| `sold_qty` | Dönem satışı |
| `sales_value`, `cost_value` | Sapmanın parasal karşılığı |

Mutabakat ucu (`GET /api/counts/:id/reconciliation`) bu aşamada yalnızca
`{ blind: true, count, progress }` döner — beklenen ciro dışarı verilmez.
CSV dışa aktarımı da kilitlenene kadar kapalıdır.

Sayan kişi miktarları girer, **"Sayımı Kilitle"** der; ancak o anda sapmalar
açılır ve satırlar değiştirilemez hale gelir.

Kör sayımı kapatmak mümkündür ama yalnızca `ADMIN` / `GENEL_MUDURLUK` yapabilir
ve bu tercih sayım kaydında (`is_blind`) saklanır.

## 2. İki imza

**Sorun.** Kantin görevlisi hem günlük ciroyu hem sayılan miktarları giriyorsa,
zincirin tamamı tek kişinin elindedir. Yöneticinin "kesinleştirme"si, elinde
bağımsız bilgi yoksa sadece bir imzadır.

**Kontrol.** İki ayrı gereklilik:

- **Sayıma katılan kişi zorunludur.** Kilitleme ekranı, rafı birlikte sayan
  ikinci kişinin adını ister (`witness_name`). Bu ad kayda geçer, sonradan
  değiştirilemez ve mutabakat raporunda görünür.
- **Sayan onaylayamaz.** `submitted_by` ile `finalized_by` aynı kullanıcı
  olamaz; sunucu 403 döner, arayüzde düğme kapalı gelir ve nedeni yazar.

**Düzeltme gerekirse:** kilitli sayım silinemez. Yalnızca `ADMIN` /
`GENEL_MUDURLUK` **gerekçe yazarak** yeniden açabilir. Yeniden açılan sayım
tekrar körleşir, sayaç (`reopened_count`) artar ve işlem denetim izine düşer.
Sık yeniden açılan sayımlar başlı başına bir uyarı işaretidir.

## 3. Üretilen ürünlerin ayrılması

**Sorun.** Tost, çay, poğaça gibi kantinde hazırlanan ürünler raftan sayılamaz.
Bunlar sayılabilir ürünmüş gibi tutulursa mutabakat matematiksel olarak anlamsız
sonuç üretir — üstelik bu kalemler cironun %20-30'u olabilir.

**Kontrol.** Ürün kartında `product_type` alanı vardır:

| Tip | Davranış |
|---|---|
| `SATIN_ALINAN` | Stok defterinde tutulur, sayım fişine girer, mutabakatı sayım belirler |
| `URETILEN` | Stoktan ve sayımdan çıkarılır; dönem satış adedi ayrıca **beyan edilir** |

Beyan edilen kısım mutabakatta gizlenmez, tam tersine **ayrı gösterilir**:

```
Beklenen ciro = Sayımdan gelen  +  Üretilenden beyan
```

Beyanın payı hesaplanır ve ekranda uyarı olarak yazılır: *"Beklenen cironun
%X'i beyana dayalı."* Böylece denetleyen kişi, rakamın ne kadarının sayımla
doğrulandığını ve ne kadarının güvene dayandığını görür.

### 3.1 Reçete — beyanı bağımsız doğrulamak

Reçete tanımlandığında bu kalem güven esasından çıkar. Üç ürün tipi vardır:

| Tip | Stok | Sayım | Satış |
|---|---|---|---|
| `SATIN_ALINAN` | tutulur | sayılır | doğrudan satılır |
| `HAMMADDE` | tutulur | **sayılır** | satılmaz, reçetede tüketilir |
| `URETILEN` | tutulmaz | sayılmaz | beyan edilir, maliyeti reçeteden |

Bir reçete `yield_quantity` adet ürün üretir: *"1 demlik çay = 40 bardak, 60 g çay"*.

**Birinci fayda — gerçek maliyet.** Üretilen ürünün maliyeti artık tahmin değil,
içindeki hammaddelerin toplamıdır. Örnek kurulumda aradaki fark çarpıcı:

| Ürün | Elle girilen tahmin | Reçeteden gerçek | Sapma |
|---|---|---|---|
| Tost | ₺18,00 | ₺16,95 | −₺1,05 |
| Çay (bardak) | ₺2,50 | ₺0,42 | −₺2,08 |
| Salep (bardak) | ₺9,00 | ₺13,20 | **+₺4,20** |

Salep'te maliyet tahminin %47 üstünde — yani o üründe kâr marjınız sandığınızdan
düşük. Bu tür sapmalar fiyatlamanın yanlış varsayıma dayandığını gösterir.

**İkinci fayda — çapraz kontrol.** Sayım kesinleşirken şu hesap yapılır:

```
Hammaddenin reçeteye göre tüketimi = Σ (beyan edilen üretim × birim reçete miktarı)
Bu miktar, hammaddenin sayım farkından DÜŞÜLÜR.
Geriye kalan = o hammaddenin doğrudan satışı (varsa) veya açıklanamayan tüketim
```

Bu düşme olmazsa üretimde kullanılan ekmek "satılmış" sayılır ve beklenen ciroyu
yapay olarak şişirir. Düşüldükten sonra geriye kalan fark iki yönlü okunur:

| Fark | Anlamı | Olası neden |
|---|---|---|
| **Artı** (gerekenden fazla tükenmiş) | Beyan edilenden fazla üretim yapılmış | Kayıt dışı satış, kaydedilmemiş fire, reçete miktarı düşük girilmiş |
| **Eksi** (gereken kadar tükenmemiş) | Beyan edilen üretim hammaddeyle açıklanamıyor | Üretim adedi fazla beyan edilmiş, reçete miktarı yüksek girilmiş, sayım hatalı |

Mutabakat ekranındaki **"Reçete Kontrolü"** kartı bu karşılaştırmayı kalem kalem
gösterir ve %5'i aşan sapmaları işaretler.

**Kısıtlar:** üretilen bir ürün başka bir reçetenin içeriği olamaz (döngü ve maliyet
zinciri karmaşası), aynı içerik iki satırda olamaz, kesinleşmiş sayımda kullanılmış
reçete silinemez — geçmiş mutabakatlar kendi anındaki maliyetle dondurulmuştur.

## 4. Habersiz nokta sayımı

**Sorun.** Dönem sayımı önceden bellidir; tarihi bilinen bir denetimin
caydırıcılığı düşüktür.

**Kontrol.** Seçilen birkaç üründe, herhangi bir gün yapılabilen ara sayım.

- Yalnızca seçilen ürünleri kapsar (ekranda "en değerli 10 ürünü seç" kısayolu var)
- **Stok defterine dokunmaz**, dönemi kapatmaz, geriye dönük kilit oluşturmaz
- Kör başlar, kilitlendiğinde sapmalar açılır
- Kilitlendikten sonra **silinemez** — kalıcı bir tespit kaydıdır

Nokta sayımında "fark" hesaplanmaz ve hesaplanmamalıdır: kontrol ürünlerin bir
alt kümesini kapsarken girilen ciro tümünü kapsar, ikisi karşılaştırılamaz.
Bakılacak şey şudur: *bir üründe raftan çıkan miktar, o dönemde o üründen
satılabilecek makul miktarın çok üzerinde mi?*

Asıl değeri karşılaştırmadadır: nokta sayımının gösterdiği sapma, sonraki dönem
sayımının raporladığından belirgin biçimde büyükse, arada bir düzeltme yapılmış
demektir.

---

## Ek: fire ile iadeyi ayırmak

Stok açısından ikisi de aynı yönde düşer, ama **maliyeti kimin taşıdığı** farklıdır
ve bu fark denetimi doğrudan etkiler:

| | Fire | Tedarikçiye iade |
|---|---|---|
| Ne oldu? | Mal bizde bozuldu / kırıldı / ikram edildi | Mal tedarikçiye geri gönderildi |
| Maliyeti kim taşır? | Kantin | Tedarikçi (alacaklandırır) |
| Fire raporunda | ✓ görünür | ✗ görünmez |
| Cari hesapta | etkisi yok | borcu azaltır |
| Stok etkisi | düşer | düşer |

İade fire olarak kaydedilirse kantin, taşımadığı bir maliyeti üstlenmiş görünür ve
fire oranı yapay olarak yükselir — gerçek fire sorununu göremezsiniz. Tersine, iade
hiç kaydedilmezse mal satılmış sayılır ve **olmayan bir ciro açığı** doğar.

İade ekranı, iade belgesini ilgili alım belgesinden doldurabilir; böylece fiyatlar
faturayla birebir eşleşir. Aynı irsaliye numarası ikinci kez girilemez, üretilen
ürünler (tost, çay) iade edilemez ve iadesi olan alım belgesi iptal edilemez.

**Denetim sinyali:** bir tedarikçide iade oranı %5'i geçiyorsa rapor onu işaretler.
Tekrar eden "bozuk mal" iadeleri ya tedarikçi sorunudur ya da kayıp/kaçağı iade
gibi göstermenin bir yoludur — ikisi de bakılmayı hak eder.

---

## Kontrollerin kapsamadığı yer

Dürüst olmak gerekirse bu dört kontrol denetimi **zorlaştırır, imkânsız
kılmaz**. Açıkta kalan iki nokta:

1. **Ciro beyanı.** Yazar kasa olmadığı için günlük ciro, birinin kasadan sayıp
   yazdığı rakamdır. Sayım bunu çapraz kontrol eder ama bağımsız bir kaynak yoktur.
2. **Üretilen ürün adedi.** Reçete tanımlıysa hammadde tüketimiyle çapraz kontrol
   edilir (§ 3.1) — bağımsız bir doğrulamadır ama mutlak değildir: reçete miktarları
   da elle girilir. Reçetesi olmayan üretilen ürünlerde beyan hâlâ denetimsizdir;
   Reçeteler ekranı bunları "Reçete tanımsız" olarak işaretler.

İkisi de yazılımla değil, süreçle ve (ileride) yazar kasa ile kapanır. Süreç
önerileri için `docs/YOL-HARITASI.md` dosyasının son bölümüne bakın.

---

## Özet: hangi işlemi kim yapabilir?

| İşlem | Kantin Görevlisi | Kampüs Yöneticisi | Genel Müdürlük / Admin | Denetçi |
|---|:---:|:---:|:---:|:---:|
| Sayım açma, miktar girme | ✓ | ✓ | ✓ | — |
| Sayımı kilitleme | ✓ | ✓ | ✓ | — |
| Kesinleştirme | — | ✓ | ✓ | — |
| Kendi sayımını kesinleştirme | — | — | — | — |
| Kilitli sayımı yeniden açma | — | — | ✓ (gerekçeli) | — |
| Kör sayımı kapatma | — | — | ✓ | — |
| Kesinleşmiş sayımı silme | — | — | — | — |
| Denetim izini okuma | — | — | ✓ | ✓ |
