# Tedarikçi Faturasını Sisteme İşleme

Menüde **Mal Girişi (Alım)** → sağ üstte **“+ Yeni Mal Girişi”**.

Faturayı üç yoldan girebilirsiniz; üçü de aynı belgeyi üretir:

| Yol | Elinizde ne var | Ne kadarını doldurur |
|---|---|---|
| **1. e-Fatura XML** | Entegratörden inen `.xml` dosyası | Başlık **ve** tüm ürün satırları |
| **2. Karekod (QR)** | Kâğıt/PDF fatura çıktısı | Başlık + toplamlar; satırları siz girersiniz, sistem denetler |
| **3. Elle** | Sadece fatura | Hepsini siz girersiniz |

> Elinizde XML varsa onu kullanın: satırları da dolduran tek yol odur.
> XML yoksa karekod, elle girişi **denetlenir** hale getirir.

---

## 0. İlk kurulum: açılış stoğu MU, geçmiş faturalar MI?

> **Bu bölümü atlamayın.** İkisini birden yaparsanız stok iki katına çıkar ve
> ilk sayımda açıklayamayacağınız bir fark çıkar.

Sistemi kurarken stoğu oluşturmanın iki yolu var. **Birini seçin:**

### Yol A — Açılış stoğu (önerilen)

Bir gün belirleyin (örneğin 1 Ekim). O gün rafları sayın ve **Stok Durumu →
Açılış Stoğu** ekranından miktarları girin. Maliyet olarak elinizdeki son
alış fiyatını yazarsınız.

- **Hızlıdır** — bir günlük iş
- Sayım o günden itibaren tutarlı çalışır
- O günden **sonraki** faturaları normal şekilde girersiniz

Geçmiş faturaları *kayıt için* saklamak isterseniz girebilirsiniz ama
**belge tarihini açılış gününden önce** vermeyin — yoksa o alımlar da
stoğa eklenir.

### Yol B — Geçmiş faturalardan oluşturma

Açılış stoğu **girmezsiniz**. Bunun yerine belirli bir tarihten bugüne kadarki
tüm alış faturalarını girersiniz; stok bunlardan oluşur.

- Geçmiş maliyetler ve tedarikçi cariniz de doğru oluşur
- Ama **satışlar sistemde olmadığı için** stok olduğundan yüksek çıkar:
  sistem malın girdiğini bilir, satıldığını bilmez
- Bu yüzden ilk sayımı yaptığınızda büyük bir "eksik" farkı görürsünüz —
  bu fark gerçekte o dönemin satışıdır

#### Yol B'yi seçtiyseniz: üç adım

**1. Faturaları girin.** Belge tarihleri gerçek tarihleri olsun. Stok
girdikçe şişecek — bu normaldir, henüz satış bilgisi yok.

**2. Bir "kapanış günü" belirleyip o gün rafları sayın.** Sayımı normal
dönem sayımı olarak açın, gerçek miktarları girin ve **kesinleştirin**.
Stok bu anda gerçeğe oturur; aradaki fark `SATIS` hareketi olarak yazılır.

**3. Asıl denetim bundan SONRAKİ sayımdır.** İlk sayımın farkı geçmişin
tamamını kapsar, denetim anlamı taşımaz. İkinci sayımdan itibaren fark
gerçek dönem satışıdır ve ciro ile karşılaştırılabilir.

#### İlk sayımda çıkacak farkı açık sanmayın

İlk sayımda "beklenen ciro" ile "kaydedilen ciro" **aynı dönemi
anlatmaz**: beklenen ciro ilk faturadan bugüne kadarki tüm malı kapsar,
kaydedilen ciro ise ancak sistemi kullanmaya başladığınız günden sonrasını.

Sistem bunu kendisi söyler: ilk dönem sayımının mutabakat ekranında mavi
bir uyarı çıkar ve mal girişinin hangi tarihte başladığını, ciro kaydının
hangi tarihte başladığını, aradaki kayıtsız dönemde kaç belgeyle ne kadar
mal girdiğini yazar. Fark da "ciro açığı" değil, **"ilk sayımda beklenen
fark"** olarak gösterilir.

> Geçmiş ciroları da elinizde varsa **Günlük Ciro** ekranından geçmiş
> tarihlerle girebilirsiniz. O zaman ilk sayımın mutabakatı da anlamlı
> olur — ama bu ekstra iştir ve zorunlu değildir.

### Hangisi?

| | Yol A (açılış stoğu) | Yol B (geçmiş faturalar) |
|---|---|---|
| Emek | Bir günlük sayım | Tüm faturaların girişi |
| Stok doğruluğu | İlk günden doğru | İlk sayıma kadar yüksek |
| Geçmiş maliyet/cari | Yok | Var |
| Tavsiye | ✅ | Geçmiş cari hesap gerekiyorsa |

**Karma yapmayın.** Hem açılış stoğu girip hem de o tarihten önceki
faturaları girerseniz aynı mal iki kez stoğa girer.

---

## 1. e-Fatura / e-Arşiv XML'den otomatik doldurma

Formun üstündeki **“🧾 e-Fatura XML'den Doldur”** düğmesine basıp entegratörden
(veya GİB portalından) indirdiğiniz **UBL-TR XML** dosyasını seçin.

Sistem dosyadan şunları okur ve formu doldurur:

| Faturadan okunan | Nereye yazılır |
|---|---|
| Satıcı VKN'si | Tedarikçi (kartındaki VKN ile eşlenir) |
| Fatura numarası | Belge No |
| Düzenleme tarihi | Belge Tarihi |
| Vade tarihi | Vade Tarihi |
| Her kalem: ad, barkod, miktar, birim fiyat, iskonto, KDV oranı | Ürün satırları |
| ETTN (belge kimliği) | Belgeye gizli olarak yazılır |

### Ürün eşleştirme sırası

1. **Barkod** (faturadaki GTIN / satıcı ürün kodu) — en güvenilir yol
2. **Ürün adı** birebir aynıysa
3. Ada benzeyen **tek bir** ürün varsa

Hiçbiri tutmazsa satır **kırmızı** görünür ve “— ürün seçin —” der. Bu satırlar
sessizce atlanmaz: ürünü seçmeden ya da satırı silmeden belge kaydedilmez.
Faturadaki kalem adı satırın altında küçük yazıyla görünür, hangi ürün olduğunu
bulabilmeniz için.

### Kaydetmeden önce ekranda göreceğiniz uyarılar

- **Tedarikçi eşleşmedi** — tedarikçi kartına VKN yazarsanız bir dahaki sefere
  kendiliğinden eşleşir
- **N kalem eşleşmedi** — hangi ürünler olduğu adıyla yazar
- **Satır tutarı uyuşmuyor** — faturanın yazdığı satır bedeli ile hesaplanan
  tutmuyorsa (iskonto farklı hesaplanmış olabilir)
- **Fatura toplamı** — satırlardan hesaplanan toplam, faturanın kendi yazdığı
  toplamla karşılaştırılır; fark varsa söylenir

> Bu kontroller bilerek var: XML'den gelen rakamı körlemesine kabul etmek,
> elle girmekten daha tehlikeli olurdu — hatayı kimse görmez.

### Aynı ürün, farklı adlar — sistem bir kez öğrenir

Aynı ürün her faturada aynı adla gelmez:

| Tedarikçi | Faturada yazan |
|---|---|
| Anadolu Gıda | `AYRAN 200 ML` |
| Marmara Dağıtım | `KUTU AYRAN` |
| Öz Kuruyemiş | `AYRAN PK 200ML` |

Üçü de sizin **Ayran 200 ml** ürününüzdür. Her faturada elle eşleştirmek hem
zaman kaybı hem hata kaynağıdır: aynı ürün iki ayrı kart olarak açılırsa stok
ikiye bölünür ve sayım farkı açıklanamaz hale gelir.

**Çözüm: bir kez seçersiniz, sistem öğrenir.** Faturayı kaydettiğinizde
"bu tedarikçinin bu adla gönderdiği kalem = bizim şu ürünümüz" bilgisi
saklanır. O tedarikçinin sonraki faturalarında aynı kalem kendiliğinden
bulunur ve ekranda *“önceki eşleştirmelerden bulundu”* yazar.

- Eşleştirme **tedarikçi bazlıdır**: A'nın "KUTU AYRAN"ı B'yi etkilemez.
- **Satıcı ürün kodu** varsa o kullanılır — addan daha güvenilirdir.
- Büyük/küçük harf, fazladan boşluk, noktalama ve Türkçe karakter fark etmez:
  `KUTU AYRAN 200ML` ile `kutu ayran 200ml.` aynı sayılır.
- Yanlış eşleşmiş bir satırı formda düzeltirseniz, **düzeltme de öğrenilir**.

### Koli / paket alıyorsanız: çevrim çarpanı

Tedarikçi koli satıyor ama siz adet sayıyorsanız miktarlar tutmaz. Her
eşleştirmenin bir **çevrim çarpanı** vardır:

> 1 fatura birimi = **24** stok birimi

Fatura `10 koli × 192,00 TL` diyorsa stoğa `240 adet × 8,00 TL` girer.
**Belge tutarı değişmez**, yalnızca birim çevrilir. Çevrim yapıldığında
fatura okunurken ekranda söylenir.

Çarpan varsayılan olarak **1**'dir. Koli alıyorsanız ilk faturadan sonra
**Tedarikçiler → 🔗 Ürün Eşleştirmeleri** ekranından düzeltin.

> Yanlış çarpan stoğu sessizce bozar: 24'lük koliyi 1 adet sayarsanız
> stok 24 kat eksik görünür ve sayım farkı patlar. İlk faturadan sonra
> çarpanları bir kez gözden geçirin.

### Eşleştirmeleri görme ve düzeltme

**Tedarikçiler → 🔗 Ürün Eşleştirmeleri** (ya da bir tedarikçinin satırındaki
**Eşleştirmeler**) ekranı öğrenilen her şeyi listeler: faturadaki ad, satıcı
kodu, hangi ürüne bağlandığı, çevrim çarpanı, kaç faturada kullanıldığı.

- **Düzelt** — yanlış ürüne bağlanmışsa değiştirin, çarpanı ayarlayın
- **Sil** — artık kullanılmayan kaydı kaldırın

Silmek **geçmiş belgeleri etkilemez**: kaydedilmiş satırlar zaten ürüne
bağlıdır. Yalnızca bundan sonraki faturalarda o kalem yeniden elle
eşleştirilir.

### Eşleşmeyen kalemi elle bağlama veya yeni ürün açma

Satırdaki ürün kutusuna tıklayın: **yazdıkça süzen** bir liste açılır. Her
satırda ürünün **barkodu ve mevcut stoğu** görünür, böylece "bu ürün zaten
var mıydı" sorusunun cevabı ekranda durur.

- Türkçe karakter yazmanıza gerek yok: **"cay"** yazınca **"Çay"** gelir.
- Barkodu okutup doğrudan seçebilirsiniz.
- Listenin sonundaki **“+ … adıyla yeni ürün tanımla”** ile kalemi oracıkta
  ürün olarak açarsınız. Ad, barkod, birim, KDV oranı ve **iskonto düşülmüş
  birim maliyet faturadan gelir**; siz yalnızca satış fiyatını ve kategoriyi
  girersiniz. Ürün eklenir eklenmez satıra bağlanır.

### Tedarikçi sistemde yoksa

Fatura eşleşmediğinde uyarının altında **“+ … tedarikçi olarak ekle”** düğmesi
çıkar. Unvan ve VKN faturadan gelir; kaydettiğiniz an seçili hale gelir ve o
firmanın sonraki faturaları VKN ile kendiliğinden eşleşir.

### Aynı fatura iki kez girilemez

Her e-Faturanın ETTN'si tekildir ve belgeye yazılır. Aynı XML ikinci kez
aktarılmak istenirse sistem hangi belgeye girildiğini söyleyerek reddeder.
(Ayrıca aynı tedarikçiye aynı belge no da ikinci kez girilemez.)

### İskontolar

İki tür iskonto vardır ve ikisi de işlenir:

| Tür | Faturada nerede | Ne yapılır |
|---|---|---|
| **Satır iskontosu** | `InvoiceLine` içindeki `AllowanceCharge` | Satırın İsk % sütununa yazılır. Birim fiyat **iskonto öncesi** kalır (faturadaki gibi), tutar iskontolu hesaplanır |
| **Belge geneli iskonto** | `LegalMonetaryTotal/AllowanceTotalAmount` (ciro primi vb.) | Satırlara **mal bedeline orantılı dağıtılır** ve İsk % sütununa eklenir |

Belge geneli iskonto satır fiyatlarına yansımaz; yalnızca ödenecek tutarı
düşürür. Dağıtılmazsa **stok maliyeti gerçekten ödenenden yüksek kaydedilir**
ve kâr olduğundan düşük görünür. Dağıtım yapıldığında ekranda söylenir;
tedarikçi farklı dağıtmış olabileceği için satır tutarlarını kontrol edin.

> **Belge geneli masraf** (nakliye, ambalaj) dağıtılmaz. Ürün maliyetine
> eklenip eklenmeyeceği sizin kararınızdır; uyarı çıkar, eklemek isterseniz
> satır fiyatlarını elle artırırsınız.

Stok maliyeti her zaman **iskonto düşülmüş gerçek birim maliyettir**
(satır neti ÷ miktar), faturadaki liste fiyatı değil.

### Denemek için

| Dosya | İçeriği |
|---|---|
| `docs/sablonlar/ornek-efatura.xml` | Farklı KDV oranları, iskontolu bir satır ve bilerek eşleşmeyen bir kalem |
| `docs/sablonlar/ornek-efatura-iskontolu.xml` | Yukarıdakinin **%10 belge geneli iskontolu** hâli — dağıtımın nasıl çalıştığını görmek için |

İkisi de gerçek yapıda, uydurma bilgilerle hazırlanmıştır.

---

## 2. Karekod (QR) ile giriş

Kâğıt ya da PDF olarak gelen e-Fatura/e-Arşiv faturalarının üzerinde GİB'in
zorunlu kıldığı bir **karekod** vardır. Formdaki **“📷 Karekod Okut”**
düğmesiyle okutabilirsiniz.

### Karekodda ne var, ne yok

| Karekodda **VAR** | Karekodda **YOK** |
|---|---|
| Satıcı VKN/TCKN | ❌ Ürün adları |
| Belge numarası ve tarihi | ❌ Miktarlar |
| ETTN (belge kimliği) | ❌ Birim fiyatlar |
| Mal/hizmet toplamı | ❌ İskontolar |
| KDV oranı başına matrah ve KDV | ❌ SKT |
| Ödenecek tutar | |

Bu GİB'in belirlediği içeriktir; hiçbir yazılım karekoddan ürün satırı okuyamaz.
**Satırları elle girersiniz.**

### Asıl faydası: çapraz kontrol

Karekodu okuttuktan sonra formda **“Karekodla karşılaştırma”** tablosu açılır ve
her tuş vuruşunda güncellenir:

| Kalem | Faturada | Girilen | Fark | Durum |
|---|---|---|---|---|
| %20 matrah | 1.000,00 ₺ | 960,00 ₺ | -40,00 ₺ | ▼ eksik |
| %20 KDV | 200,00 ₺ | 192,00 ₺ | -8,00 ₺ | ▼ eksik |
| Genel toplam | 1.200,00 ₺ | 1.152,00 ₺ | -48,00 ₺ | ▼ eksik |

Fark kalırsa kaydederken **onay istenir**. Böylece yanlış yazılmış bir miktar
veya KDV oranı, aylar sonra sayım farkı olarak değil, faturayı girerken ortaya
çıkar. Fark bilerek olabilir (faturada kantinle ilgisiz bir kalem varsa);
o zaman onaylayıp geçersiniz.

Karekoddan gelen **ETTN** de kaydedilir: aynı fatura ikinci kez girilmek
istenirse sistem reddeder — XML olmadan da mükerrer fatura koruması çalışır.

### Nasıl okutulur

1. **Kamera** — bilgisayarın webcam'i veya telefonun arka kamerası. Karekodu
   çerçeveye alın, okunduğu anda pencere kapanır.
2. **Fotoğraf / ekran görüntüsü** — çekilmiş bir resim dosyası seçilir.
   PDF doğrudan okunamaz; PDF'i açıp karekodun **ekran görüntüsünü** alın.
3. **Metni yapıştır** — pencerenin altındaki bölüm.

> **Tarayıcı uyarısı:** karekod okuma **Chrome ve Edge**'de çalışır;
> **Firefox ve Safari**'de yoktur. iPhone'da Safari zorunlu olduğu için
> karekodu **Kamera uygulamasıyla** okutup çıkan metni kopyalayın, sonra
> penceredeki *“Karekod metnini elle yapıştır”* kutusuna yapıştırın —
> sonuç aynıdır. Kamera ayrıca yalnızca **https** adreste açılır.

### Karekod okunmuyorsa

- Karekodu daha yakından, düz ve net çekin; gölge veya parlama olmasın.
- Faturanın karekodu yerine kargo/kampanya karekodunu okutmuş olabilirsiniz;
  sistem bunu söyler ve okuduğu metni gösterir.
- Hiç okunmuyorsa elle girişe devam edin: karekod bir kolaylıktır, zorunlu
  değildir.

---

## 3. Elle giriş

### Fatura başlığı

| Alan | Ne yazılır |
|---|---|
| **Tedarikçi** * | Listeden seçilir |
| **Belge No** | İrsaliye veya fatura numarası |
| **Belge Tarihi** * | Faturanın tarihi (malın geldiği gün) |
| **Vade Tarihi** | Ödeme vadesi — boş bırakılabilir |
| **Not** | İsteğe bağlı |

### Kalemler

“+ Satır Ekle” ile her fatura kalemi için bir satır:

**Ürün · Miktar · Birim Fiyat (KDV hariç) · İskonto % · KDV % · SKT**

Tutar ve alttaki Net / KDV / Genel Toplam kendiliğinden hesaplanır. Ürünü
seçtiğinizde birim fiyat ve KDV oranı ürün kartından gelir; faturada farklıysa
düzeltirsiniz.

> **Birim fiyat KDV HARİÇ girilir.** Faturadaki mal bedeli sütunudur, KDV'li
> satır toplamı değil. Öğrenciye satış fiyatı ise KDV **dahil** girilir. Kâr
> bu ikisinden net üzerinden hesaplanır; karıştırılırsa kâr olduğundan yüksek
> görünür.

---

## 4. Eşleşmeyen fatura satırları (kayda alınmayan kalemler)

Faturadaki her kalem kantin stoğuna girmez: nakliye bedeli, ambalaj, kantinle
ilgisiz bir malzeme ya da henüz tanımlanmamış bir ürün olabilir. Böyle bir
satırı formdan sildiğinizde **iz bırakır**.

> Neden önemli: silinen kalem hiçbir yere yazılmazsa, faturanın toplamı ile
> sistemdeki belgenin toplamı birbirini tutmaz ve bu fark aylar sonra
> açıklanamaz hale gelir.

Belgeyi kaydettiğinizde bir uyarı çıkar ve kalem **Mal Girişi** ekranının
üstündeki **“⚠️ Eşleşmeyen Fatura Satırları”** panelinde açık olarak bekler.
Kontrol panelindeki uyarı listesinde de görünür.

Panelde her kalem için **“Sonuçlandır”** düğmesi vardır; iki yoldan biri:

| Seçenek | Ne olur |
|---|---|
| **Ürüne bağla** | Kalem belgeye satır olarak eklenir, **stoğa girer** ve belge toplamı büyür. Miktar/fiyat/KDV faturadan gelir, gerekirse düzeltirsiniz. |
| **Yok say** | Stok değişmez. **Sebep yazmak zorunludur** ("nakliye bedeli, stok kalemi değil" gibi) ve bu açıklama denetimde okunur. |

Kesinleşmiş bir sayımın kapsadığı belgeye satır eklenemez — mutabakat bozulur;
böyle bir durumda düzeltme kaydı girilir.

---

## 5. Faturanın kendisini belgeye iliştirme

Belge kaydedildikten sonra **Mal Girişi → Detay** ekranının altında **Fatura
Dosyaları** bölümü vardır. **“📎 Fatura Dosyası Ekle”** ile faturanın PDF'ini,
fotoğrafını veya XML'ini yükleyebilirsiniz.

- Kabul edilen türler: **PDF, JPG, PNG, WEBP, XML** — en fazla 10 MB
- Tür, dosyanın **içeriğine** bakılarak doğrulanır; uzantısını değiştirerek
  başka bir dosya yüklenemez
- XML'den doldurduysanız o XML belgeye **kendiliğinden eklenir**
- Listede dosya adının yanında **SHA-256 özetinin** ilk 12 hanesi görünür: bu,
  belgenin parmak izidir. Dosya sonradan değişirse bu değer de değişir
- Alım listesinde 📎 işareti, hangi belgelerin fatura dosyası olduğunu gösterir

### Kim silebilir?

Fatura dosyası kanıt niteliğindedir; **yalnızca genel müdürlük / sistem
yöneticisi** silebilir. Kampüsteki görevli ekleyebilir ama kaldıramaz. Hem
ekleme hem silme denetim izine, dosyanın özetiyle birlikte yazılır.

### Dosyalar nerede duruyor?

`data/ekler/` klasöründe, sunucu tarafından üretilmiş adlarla. Web'den doğrudan
erişilemez: her açılışta oturum ve kampüs yetkisi kontrol edilir.

> **Yedeklemede unutmayın:** fatura dosyaları veritabanının içinde değildir.
> `./scripts/yedekle.sh` ikisini birlikte alır; elle yedek alıyorsanız
> `data/kantin.db` yanında `data/ekler/` klasörünü de alın.

---

## 6. Yanlış girilen belgeyi geri alma

| | **İptal Et** | **Kalıcı Olarak Sil** |
|---|---|---|
| Kim yapabilir | Yazma yetkisi olan herkes (ön muhasebe dahil) | Yalnızca **yönetim** (sistem yöneticisi / genel müdürlük) |
| Belge | Listede **“İPTAL”** olarak kalır | Hiç olmamış gibi kaybolur |
| Stok | Hareketler geri alınır | Hareketler geri alınır |
| Fatura dosyaları | Durur | **Diskten de silinir** |
| e-Fatura (ETTN) | **Serbest kalır** — aynı fatura yeniden girilebilir | Serbest kalır |
| Denetim izi | Kayıt durur | Yalnızca denetim günlüğünde: belge, satırları ve silinen dosya adları |

Silme penceresi ne kaybedileceğini tek tek sayar ve onay için **belge
numarasını yazmanızı** ister. Kayıt izini korumak istiyorsanız silmek yerine
iptal edin.

İkisi de şu iki durumda engellenir:
- Belge tarihinden sonra **kesinleşmiş bir dönem sayımı** varsa (o sayım bu
  alımı hesaba kattı; geri almak sayımı geçmişe dönük yanlış yapar)
- Belgeye dayanan bir **iade kaydı** varsa (önce iade çözülmeli)

---

## 7. Faturanın devamı: ödeme ve iade

- **Ödeme** — Tedarikçiler → tedarikçiye tıklayın → **“+ Ödeme Kaydet”**.
  Bakiye = Alım − İade − Ödeme.
- **İade** — Tedarikçiye İade ekranı. İade belgesi alım belgesinden
  doldurulabilir; iade tedarikçinin borcundan düşer, fire gibi maliyet olarak
  kantine yazılmaz.

---

## Kaydettiğinizde sistemde ne oluyor?

- Ürünler **stoğa girer** (sayım mutabakatının “Alımlar” kalemi budur)
- Tedarikçinin **cari hesabına borç** yazılır
- Alış fiyatı **fiyat geçmişine** işlenir
- Bir üründe alış fiyatı **%10'dan fazla arttıysa** uyarı çıkar — satış fiyatını
  gözden geçirmeniz için
- Kesinleşmiş sayım dönemine geriye dönük giriş yapılamaz
