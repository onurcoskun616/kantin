# Fiyat Yönetimi

İki fiyat vardır ve **ikisi de artık ürün kartında elle tutulmaz**:

| | **Alış fiyatı** | **Satış fiyatı** |
|---|---|---|
| Kim belirler | Tedarikçi (fatura) | Okul |
| Nereden gelir | **Mal girişlerinden** — fatura veya açılış stoğu | Elle girilir, **bir tarihten itibaren** geçerli olur |
| KDV | **Hariç** (faturadaki mal bedeli) | **Dahil** (raf etiketi) |
| Kampüse göre | Her kampüs kendi alımının fiyatını taşır | Kampüse özel fiyat tanımlanabilir |
| Nerede yönetilir | Mal Girişi (Alım) | Ürünler ve Fiyatlar → **🗓️ Fiyat Takvimi** |

---

## 1. Alış fiyatı: faturadan gelir, elle girilmez

Ürün kartında **“Alış fiyatı”** diye bir giriş alanı yoktur. Yerinde fiyatın
nereden geldiğini söyleyen bir satır vardır:

> ₺9,00 — 20.09.2026 tarihli mal girişinden (iskonto düşülmüş gerçek maliyet).
> Değiştirmek için yeni bir alım belgesi girin.

### Neden elle girilmiyor?

Elle tutulan bir alış fiyatı, faturayla güncellenen gerçek maliyetin yanında
sessizce eskir. İki farklı rakam olduğunda hangisinin doğru olduğu
anlaşılmaz; kâr marjı, stok değeri ve zararına satış uyarıları yanlış çıkar.

### Hangi hareketler fiyat belirler?

| Hareket | Fiyat belirler mi? |
|---|---|
| **Mal girişi (fatura/irsaliye)** | ✅ Evet |
| **Açılış stoğu girişi** | ✅ Evet — ilk kurulumda maliyet buradan gelir |
| Fire / zayiat | ❌ Hayır |
| Satış | ❌ Hayır |
| Sayım farkı | ❌ Hayır |
| Kampüsler arası transfer | ❌ Hayır |

Fire ve sayım farkı bir fiyat **beyanı** değildir; mevcut maliyeti taşır,
belirlemez.

### İskonto düşülmüş gerçek maliyet

Kaydedilen fiyat faturadaki liste fiyatı değil, **ödenen** fiyattır:

```
20,00 TL birim fiyat, %25 iskonto  →  maliyet 15,00 TL
```

Belge geneli iskonto (ciro primi) da satırlara dağıtılır — ayrıntısı
**[FATURA-GIRISI.md](FATURA-GIRISI.md)** içindedir.

### Her kampüs kendi fiyatını taşır

Aynı ürün Esenyurt'a 9,40 TL'ye, Çorlu'ya 15,00 TL'ye gelebilir. Stok değeri,
kâr marjı ve sayım farkı **o kampüsün kendi alım fiyatıyla** hesaplanır.
Hiç alım yapılmamış bir kampüste ürün kartındaki başlangıç değeri kullanılır.

### Belge iptal edilirse

O girişin fiyatı da geçerliliğini yitirir: sistem bir önceki mal girişinin
fiyatına döner. Aynı şey kalıcı silmede de olur.

---

## 2. Satış fiyatı: bir tarihten itibaren geçerli

**Ürünler ve Fiyatlar → 🗓️ Fiyat Takvimi**

Her fiyatın bir **geçerlilik tarihi** vardır. Bu üç şeyi çözer:

1. **İleri tarihli zam.** “1 Ekim'den itibaren simit 15 TL” diye
   tanımlarsınız; bugünkü satışlar eski fiyattan devam eder, belirtilen gün
   fiyat kendiliğinden geçer. Kimsenin o sabah sisteme girmesi gerekmez.
2. **Geçmişe dönük doğru rapor.** Eylül ayının kârlılığı Eylül'de geçerli
   olan fiyatla hesaplanır; bugün yapılan bir zam geçmişi değiştirmez.
3. **“Bu ürünü geçen dönem kaça satıyorduk?”** sorusunun cevabı kayıtlıdır.

### Fiyat tanımlama

| Alan | Açıklama |
|---|---|
| **Satış fiyatı** | KDV dahil raf fiyatı |
| **Geçerlilik tarihi** | Bugün, ileri veya geçmiş bir tarih |
| **Kapsam** | *Tüm kampüsler* (katalog) ya da *yalnızca bir kampüs* |
| **Açıklama** | Neden değişti — denetimde okunur |

Kampüse özel fiyat, katalog fiyatını **o kampüs için** ezer; diğer kampüsler
etkilenmez.

Aynı gün için ikinci bir fiyat girilirse sonuncusu geçerli olur.

### Listedeki uyarı

Ürün listesinde **“Yaklaşan Fiyat”** sütunu, henüz yürürlüğe girmemiş bir
fiyat varsa tarihini gösterir.

### Neyi silebilirsiniz?

| | Silinebilir mi? |
|---|---|
| **Yürürlüğe girmemiş** (ileri tarihli) fiyat | ✅ İptal edilebilir |
| **Yürürlüğe girmiş** fiyat | ❌ Hayır |

Uygulanmış bir fiyat, o dönemin kârlılığını açıklayan kayıttır; silinmesi
geçmişi değiştirir. Yanlışsa **yeni bir fiyat tanımlayın**.

### Mevcut fiyatlar ne oldu?

Sistem güncellendiğinde her ürünün o anki satış fiyatı, ürünün tanımlandığı
tarihten geçerli olacak şekilde fiyat listesine taşındı. Takvimde
*“Mevcut fiyat (listeye aktarıldı)”* açıklamasıyla görürsünüz.

---

## 3. Sık sorulanlar

**Yeni ürün açarken alış fiyatı sormuyor, kâr nasıl hesaplanacak?**
İlk mal girişine kadar hesaplanmaz. Fatura girildiği an gerçek maliyet
oluşur ve kâr marjı anlam kazanır. Excel'den toplu ürün yüklerken başlangıç
alış fiyatı verebilirsiniz; ilk fatura onu değiştirir.

**Fiyatı bugünden değil de dünden geçerli yapabilir miyim?**
Evet. Geçmiş tarihli fiyat, o günden sonraki raporları etkiler. Kesinleşmiş
sayımlar etkilenmez: sayım kendi fiyatlarını dondurur.

**Kampüs fiyatını kaldırmak istersem?**
Katalog fiyatıyla aynı değeri o kampüs için tanımlayın. Kampüs satırı
geçmiş kaydı olarak kalır.

**Tavan fiyatı aşarsam ne olur?**
Ürün kartındaki “Tavan fiyat” doluysa ve satış fiyatı onu aşıyorsa fiyat
denetimi raporunda işaretlenir; kayıt engellenmez.
