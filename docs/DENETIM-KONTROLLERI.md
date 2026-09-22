# Denetim Kontrolleri

Bu sistemin amacı kayıt tutmak değil, **kantini denetlemektir**. Kayıt tutan her
yazılım, kaydı giren kişi kötü niyetliyse kandırılabilir. Aşağıdaki beş kontrol
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

## 5. Ciro teslim fişi — beyanı imzayla sabitlemek

Günlük ciro beyanı sistemden çıktı alınır ve kantin görevlisi tarafından ön
muhasebeye **imza karşılığı** teslim edilir. Yazılımın buradaki işi kâğıt
üretmek değil, **kâğıttaki rakam ile sistemdeki rakamı her zaman
karşılaştırılabilir tutmaktır.**

Çünkü asıl risk şu: imzalanan kâğıtta 12.400 TL yazar, aylar sonra sistemde
o günlerin toplamı 11.900 TL görünür. İmza, karşılığı değişebilen bir rakamın
altındaysa hiçbir şey ifade etmez.

### Fiş nasıl çalışır?

1. **Tutar dondurulur.** Fiş oluşturulduğu anda o günlerin cirosu (nakit / kart
   / veresiye / diğer kırılımıyla) belgenin üzerine yazılır ve saklanır. Ciro
   kayıtları sonradan değişse bile fişin üzerindeki tutar değişmez.
2. **O günler kilitlenir.** Fişe dahil günlerin cirosunu kantin görevlisi artık
   değiştiremez, silemez. Denemesi 409 ile reddedilir ve ekranda gün "🔒 imzalı"
   olarak görünür.
3. **Yönetim değiştirirse iz kalır.** Genel müdürlük düzeltme yapabilir; ancak
   fiş otomatik olarak **"FARKLI"** durumuna geçer, denetim izine
   `HANDOVER_MISMATCH` kaydı düşer ve fiş ekranında kâğıttaki tutar ile
   sistemdeki tutar **yan yana** gösterilir.
4. **Fiş silinemez.** İmzalanmış bir belgenin sistemdeki karşılığı kaldırılamaz.

### Doğrulama kodu

Her fişin üzerine belge içeriğinden (belge no + kampüs + dönem + tutar)
türetilmiş 6 haneli bir kod basılır. Ön muhasebe teslim alırken bu kodu sisteme
girer; kod tutmazsa **elindeki kâğıt o belgenin kendisi değildir** ve onay
reddedilir. Kâğıt üzerinde rakam oynanmışsa kod tutmaz.

Kod, sunucunun `SESSION_SECRET` anahtarıyla HMAC-SHA256 üretilir; belgeye
bakarak yeniden hesaplanamaz.

### Çıktı

"Yazdır" düğmesi fişi önce **ekranda** açar (önizleme), sonra yazdırma
penceresini dener. Çıktı tek A4'e **iki nüsha** basar: üst yarı *kantin nüshası*,
alt yarı *ön muhasebe nüshası*. Her iki nüshada da aynı belge numarası, aynı
doğrulama kodu, günlük döküm, toplam, **tutarın yazıyla karşılığı** ve iki ayrı
imza satırı (teslim eden / teslim alan) bulunur. Böylece her taraf kendi imzalı
nüshasını saklar. Döküm uzunsa (ör. bir aylık teslim) ikinci nüsha kendi
sayfasına taşınır; nüsha asla ortadan bölünmez.

Fiş kesildikten sonra ciro değiştiyse, yeniden alınan çıktının üzerine
**"Bu fiş kesildikten sonra ciro kaydı değişmiştir"** uyarısı basılır ve teslim
anındaki tutar ile güncel tutar birlikte yazılır — imzalı belgenin kopyası
sessizce farklı bir toplam göstermez.

Not: uygulama korumalı bir çerçeve içinde çalışıyorsa (demo sürümü böyle)
tarayıcı yazdırma penceresini engeller. Bu yüzden belge her koşulda ekranda
açılır; yazdırma onun üstüne gelir.

### Ön Muhasebe rolü

`MUHASEBE` rolü **tüm kampüsleri görür** ve bir **veri girişi** rolüdür:
belge girer, **onaylamaz/kesinleştirmez**.

| Yapabilir | Yapamaz |
|---|---|
| Fatura / mal girişi, fatura dosyası ekleme, belge iptali | Sayım açma ve kesinleştirme |
| Tedarikçi tanımı, ödeme ve iade kaydı | Stok düzeltme, fire, kampüsler arası transfer |
| Ürün kartı ve satış fiyatı | Reçete tanımı |
| Günlük ciro girişi | Kampüs ve kullanıcı tanımı |
| **Ciro teslim fişini onaylama** | Belgeyi **kalıcı silme** (iptal edebilir) |

Yetki sunucuda alan alan verilir (`requireWrite(user, alan)`); teslim fişi
onayı ayrıca `requireRole` ile açılır. **Varsayılan kapalıdır**: alan adı
verilmeyen bir uç bu role otomatik açılmaz, böylece sonradan eklenen bir uç
yanlışlıkla açık kalmaz.

> Sayım kesinleştirme bilerek dışarıdadır: mutabakatın kendisidir, veri
> girişi değildir. Aynı kişinin hem veriyi girip hem mutabakatı onaylaması
> denetimin anlamını ortadan kaldırır.

### Teslim edilmemiş ciro

Panel ve Günlük Ciro ekranı, fişi kesilmemiş günleri ayrıca gösterir. 3 günden
uzun süredir teslim edilmemiş ciro uyarı olarak çıkar — çünkü **kasada bekleyen
nakit, sayımla denetlenemeyen tek kalemdir.**

---

## Ek: fire ile iadeyi ayırmak

Stok açısından ikisi de aynı yönde düşer, ama **maliyeti kimin taşıdığı** farklıdır
ve bu fark denetimi doğrudan etkiler:

| | Fire | Tedarikçiye iade |
|---|---|---|
| Ne oldu? | Mal bizde bozuldu / kırıldı / ikram edildi | Mal tedarikçiye geri gönderildi |
| Maliyeti kim taşır? | Kantin | Tedarikçi (alacaklandırır) |
| Fire raporunda | ✓ görünür | ✗ görünmez |
| Cari hesapta | etkisi yok | **iadeyi yapan kampüsün** borcunu azaltır |
| Stok etkisi | düşer | düşer |

İade fire olarak kaydedilirse kantin, taşımadığı bir maliyeti üstlenmiş görünür ve
fire oranı yapay olarak yükselir — gerçek fire sorununu göremezsiniz. Tersine, iade
hiç kaydedilmezse mal satılmış sayılır ve **olmayan bir ciro açığı** doğar.

İade ekranı, iade belgesini ilgili alım belgesinden doldurabilir; böylece fiyatlar
faturayla birebir eşleşir. Aynı irsaliye numarası ikinci kez girilemez, üretilen
ürünler (tost, çay) iade edilemez ve iadesi olan alım belgesi iptal edilemez.

### Açılış sayımı denetim verisi değildir

Sisteme geçiş sayımı (**açılış sayımı**) stoğu düzeltir ve dönemi kilitler
ama farkı bir denetim sinyali değildir: sistem öncesi satışı, fireyi ve
kaydedilmemiş her şeyi tek kalemde taşır. Bu yüzden aylık kârlılık, ürün
satış ve kampüs karşılaştırma raporlarına **girmez**; panoda alarm üretmez;
listede *Açılış* rozetiyle ayrılır.

Yalnızca bir kampüsün **ilk** dönem sayımı açılış olarak işaretlenebilir —
sonraki bir sayımın açılış sayılması, o dönemin satışını raporlardan silmek
olurdu. Kural hem arayüzde hem sunucuda uygulanır.

Denetim açısından okunuşu: **gerçek ölçüm ikinci sayımdan başlar.** Açılış
sayımından sonraki ilk dönemde çıkan fark, karşılaştırılabilir tek rakamdır.

---

### Cari hesap kampüs bazlıdır

Tedarikçi **kartı** beş kampüste ortaktır (tek firma, tek VKN); **hesabı**
değildir. Mal hangi kampüse girdiyse borç o kampüsündür, iade ve ödeme de o
kampüsün hesabına işler.

Denetim açısından önemi: kampüs bakiyeleri tek torbada toplanırsa bir kampüsün
ödenmemiş borcu, başka bir kampüsün fazla ödemesiyle gizlenir ve "kime ne kadar
borçluyuz" sorusunun cevabı hiçbir kampüs için doğru çıkmaz. Ödeme kaydında
kampüs seçimi bu yüzden **zorunludur**; yanlış kampüse girilen ödeme silinmez,
denetim kaydı bırakarak düzeltilir.

Ayrıntılar: **[TEDARIKCI-CARI-HESAP.md](TEDARIKCI-CARI-HESAP.md)**

**Denetim sinyali:** bir tedarikçide iade oranı %5'i geçiyorsa rapor onu işaretler.
Tekrar eden "bozuk mal" iadeleri ya tedarikçi sorunudur ya da kayıp/kaçağı iade
gibi göstermenin bir yoludur — ikisi de bakılmayı hak eder.

---

## Kontrollerin kapsamadığı yer

Dürüst olmak gerekirse bu kontroller denetimi **zorlaştırır, imkânsız kılmaz**.
Açıkta kalan nokta:

1. **Ciro beyanının kaynağı.** Yazar kasa olmadığı için günlük ciro, hâlâ birinin
   kasadan sayıp yazdığı rakamdır. Teslim fişi (§ 5) bu rakamı **imzayla
   sabitler** — yani beyan edildikten sonra sessizce değiştirilemez, kâğıt ile
   sistem her zaman karşılaştırılabilir kalır. Ama ilk anda *eksik beyan
   edilmesini* engellemez; onu sayım mutabakatı (dönem satışı ile beyan edilen
   ciro farkı) yakalar.
2. **Üretilen ürün adedi.** Reçete tanımlıysa hammadde tüketimiyle çapraz kontrol
   edilir (§ 3.1) — bağımsız bir doğrulamadır ama mutlak değildir: reçete miktarları
   da elle girilir. Reçetesi olmayan üretilen ürünlerde beyan hâlâ denetimsizdir;
   Reçeteler ekranı bunları "Reçete tanımsız" olarak işaretler.

İkisi de tam olarak yazılımla değil, süreçle ve (ileride) yazar kasa ile kapanır.
Süreç önerileri için `docs/YOL-HARITASI.md` dosyasının son bölümüne bakın.

---

## Özet: hangi işlemi kim yapabilir?

| İşlem | Kantin Görevlisi | Kampüs Yöneticisi | Genel Müdürlük / Admin | Ön Muhasebe | Denetçi |
|---|:---:|:---:|:---:|:---:|:---:|
| Sayım açma, miktar girme | ✓ | ✓ | ✓ | — | — |
| Sayımı kilitleme | ✓ | ✓ | ✓ | — | — |
| Kesinleştirme | — | ✓ | ✓ | — | — |
| Kendi sayımını kesinleştirme | — | — | — | — | — |
| Kilitli sayımı yeniden açma | — | — | ✓ (gerekçeli) | — | — |
| Kör sayımı kapatma | — | — | ✓ | — | — |
| Kesinleşmiş sayımı silme | — | — | — | — | — |
| Ciro girme / düzeltme | ✓ | ✓ | ✓ | ✓ | — |
| Teslim fişi oluşturma (çıktı) | ✓ | ✓ | ✓ | — | — |
| Fatura / mal girişi | ✓ | ✓ | ✓ | ✓ | — |
| Belgeyi iptal etme | ✓ | ✓ | ✓ | ✓ | — |
| Belgeyi kalıcı silme | — | — | ✓ | — | — |
| Tedarikçi, ödeme, iade | ✓ | ✓ | ✓ | ✓ | — |
| Ürün kartı ve satış fiyatı | ✓ | ✓ | ✓ | ✓ | — |
| Stok düzeltme / fire / transfer | ✓ | ✓ | ✓ | — | — |
| Teslim fişini onaylama (kodla) | — | — | ✓ | ✓ | — |
| Fişe dahil günün cirosunu değiştirme | — | — | ✓ (fiş "FARKLI" olur) | — | — |
| Teslim fişini silme | — | — | — | — | — |
| Denetim izini okuma | — | — | ✓ | — | ✓ |
