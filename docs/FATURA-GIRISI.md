# Tedarikçi Faturasını Sisteme İşleme

Menüde **Mal Girişi (Alım)** → sağ üstte **“+ Yeni Mal Girişi”**.

Faturayı iki yoldan girebilirsiniz: **elle** ya da **e-Fatura XML dosyasından
otomatik**. İkisi de aynı belgeyi üretir; XML'den doldurmak yalnızca yazım
hatasını ve süreyi ortadan kaldırır.

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

### Aynı fatura iki kez girilemez

Her e-Faturanın ETTN'si tekildir ve belgeye yazılır. Aynı XML ikinci kez
aktarılmak istenirse sistem hangi belgeye girildiğini söyleyerek reddeder.
(Ayrıca aynı tedarikçiye aynı belge no da ikinci kez girilemez.)

### Denemek için

`docs/sablonlar/ornek-efatura.xml` — gerçek yapıda, uydurma bilgilerle
hazırlanmış örnek bir e-Fatura. İçinde farklı KDV oranları, iskontolu bir satır
ve bilerek eşleşmeyen bir kalem var.

---

## 2. Elle giriş

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

## 3. Faturanın kendisini belgeye iliştirme

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

## 4. Faturanın devamı: ödeme ve iade

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
