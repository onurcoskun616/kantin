# Tedarikçi Cari Hesabı

## Tek cümlede

**Tedarikçi kartı tüm kampüslerde ortaktır; cari hesabı değildir.**
Mal hangi kampüse girdiyse borç o kampüsündür, ödemeyi de o kampüs yapar.

---

## 1. Neden kart ortak, hesap ayrı?

“Anadolu Gıda A.Ş.” beş kampüsün tamamı için **tek firmadır**: tek VKN, tek
adres, tek iletişim bilgisi. Her kampüs için ayrı bir kart açmak üç şeyi
bozar:

1. **Mükerrer kayıt engeli çalışmaz.** VKN tekildir; “Anadolu Gıda –
   Esenyurt” ve “Anadolu Gıda – Çorlu” aynı VKN'yi taşıyamaz.
2. **e-Fatura eşleşmesi belirsizleşir.** Gelen XML'deki VKN hangi karta
   gidecek?
3. **Öğrenilmiş ürün eşleştirmeleri bölünür.** Esenyurt'ta “KUTU AYRAN
   200ML”in hangi ürün olduğu öğrenilir, Çorlu aynı şeyi baştan öğrenir.

Ama **hesap** ortak olamaz. Esenyurt'un yaptığı ödeme Çorlu'nun borcunu
kapatmaz; beş kampüsün bakiyesi tek torbada toplanırsa hiçbiri için doğru
rakam çıkmaz. Bu yüzden tek kartın altında **kampüs sayısı kadar hesap**
tutulur.

---

## 2. Bakiye nasıl hesaplanır?

```
Bakiye = Alım − İade − Ödeme        (her kampüs için ayrı ayrı)
```

| Hareket | Etkisi | Hangi kampüse |
|---|---|---|
| **Mal girişi** (fatura/irsaliye) | Borç artar | Belgede seçilen kampüse |
| **Tedarikçiye iade** | Borç azalır | İadenin yapıldığı kampüse |
| **Ödeme** | Borç azalır | Ödemede **seçilen** kampüse |

İptal edilen alım belgeleri hesaba girmez.

---

## 3. Ekranda ne görürsünüz?

### Tedarikçiler listesi

Listedeki **Bakiye** sütunu her zaman **üstteki kampüs seçicide seçili olan
kampüsün** bakiyesidir. Başka bir kampüsün borcunu görmek için kampüsü
değiştirin — aynı firma, başka rakam.

Üstteki özet kartı “bu kampüste kaç firmaya, toplam ne kadar borçluyuz”
sorusunu cevaplar.

### Cari Hesap penceresi

| Bölüm | Ne gösterir |
|---|---|
| **Üst dört kutu** | Seçili kampüsün alım / iade / ödeme / bakiyesi |
| **Kampüs Hesapları** | Aynı firmanın her kampüsteki ayrı bakiyesi |
| **Hesap Ekstresi** | Tarih sırasıyla hareketler ve **yürüyen bakiye** |
| **Alım Belgeleri / İadeler / Ödemeler** | Hareketlerin dökümü |

“Ne kadar borçluyuz” sorusunun cevabı tek rakamdır; “nasıl bu rakama
gelindi” sorusunun cevabı **ekstredir**. Denetimde ikincisi sorulur.

Kampüs bağımlı kullanıcılar (kampüs yöneticisi, kantin görevlisi) yalnızca
kendi kampüslerinin hesabını görür. Genel müdürlük, admin, ön muhasebe ve
denetçi tüm kampüsleri görür; kampüs seçilmeden bakılırsa **grup toplamı**
gösterilir.

---

## 4. Ödeme kaydetme

Ödeme kaydederken **hangi kampüs adına yapıldığı zorunlu olarak sorulur.**
Açılır listede her kampüsün o anki borcu da yazar, böylece yanlış kampüs
seçme ihtimali azalır.

> Ödeme yalnızca seçilen kampüsün borcunu kapatır.

Ödeme bir alım belgesine bağlanıyorsa belge **aynı tedarikçinin ve aynı
kampüsün** olmalıdır; sistem başka kampüsün belgesine bağlamayı reddeder.

### Yanlış kampüse girilen ödeme

Silinmez, **düzeltilir**: Cari Hesap → ilgili ödeme → *Kampüse Ata*. Tutar
değişmez, yalnızca hangi kampüsün borcunu kapattığı değişir ve düzeltme
denetim kaydına yazılır. Belgeye bağlı bir ödeme başka kampüse taşınırsa
belge bağı kopar — belge eski kampüsündedir.

---

## 5. Güncellemeden gelen eski ödemeler

Önceki sürümde ödemenin kampüsü boş bırakılabiliyordu. Güncelleme sırasında
sistem bunları elinden geldiğince kendisi bağlar:

1. Ödeme bir alım belgesine bağlıysa → belgenin kampüsü.
2. Tedarikçiden yalnızca tek kampüs alım yaptıysa → o kampüs.

Bu ikisiyle çözülemeyen ödemeler **olduğu gibi bırakılır**. Bilinmeyen bir
kampüse “en yakın tahmin”le para yazmak, boş bırakmaktan kötüdür: yanlış
kampüsün bakiyesi düzelmiş gibi görünür.

Böyle bir ödeme varsa Cari Hesap penceresinde sarı bir uyarıyla listelenir
ve **hiçbir kampüsün bakiyesine girmez**. *Kampüse Ata* ile bağlayın;
hepsi bağlandıktan sonraki ilk açılışta kampüs alanı kendiliğinden zorunlu
hale gelir.

---

## 6. Sık sorulanlar

**Aynı firmaya bir kampüste borçlu, diğerinde alacaklı olabilir miyiz?**
Evet. Fazla ödeme yapılan kampüsün bakiyesi eksi çıkar, yeşil gösterilir.
Kampüs Hesapları tablosu bunu açıkça gösterir; tek bir toplam rakam gizlerdi.

**Bir kampüsün ödemesiyle diğerinin borcunu kapattık, ne yapmalıyız?**
Bu bir **kampüsler arası alacak-borç** meselesidir. Ödemeyi fiilen parayı
ödeyen kampüse kaydedin; iki kampüs arasındaki mahsuplaşma tedarikçi
hesabının değil, okul içi muhasebenin konusudur.

**Tedarikçi bize tek fatura kesip beş kampüse mal gönderirse?**
Faturayı kampüs kampüs bölerek girin: her kampüs kendi aldığı malın
belgesini girer. Stok zaten kampüs bazlıdır; tek belgeye yazılırsa malın
tamamı tek kampüse girmiş olur.

**Genel müdürlük tüm kampüslerin toplam borcunu görebilir mi?**
Evet — Cari Hesap penceresinde kampüs seçmeden bakıldığında grup toplamı ve
altında kampüs kampüs dökümü görünür.
