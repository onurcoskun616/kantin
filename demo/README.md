# Tarayıcı Demosu

VPS kurmadan sistemi denemek için hazırlanan tanıtım sürümü. `public/` altındaki
**gerçek arayüzün aynısını** kullanır; yalnızca sunucu iletişim katmanı
(`public/js/api.js`) tarayıcı içinde çalışan bir demo sunucusuyla değiştirilir.

```bash
npm run demo:build     # demo/dist/ üretir
```

## Nasıl çalışır?

| Dosya | Görevi |
|---|---|
| `src/data.js` | Örnek veriyi üretir — tohumlu rastgelelik, herkeste aynı sonuç |
| `src/store.js` | Gerçek API uçlarının tarayıcı içi karşılığı (aynı yanıt biçimleri) |
| `src/api.js` | `public/js/api.js` yerine geçer; istekleri `store.js`'e yönlendirir |
| `src/boot.js` | Demo çubuğu, hesap seçici ve uygulama başlatma |
| `build.mjs` | `public/` + `demo/src` → `demo/dist` (Artifact biçiminde tek sayfa) |

Finansal hesaplar `server/lib/money.js` dosyasından **birebir kopyalanır**;
demodaki kâr, marj ve KDV sonuçları kurulu sistemle aynıdır.

## Örnek verinin anlattığı hikâye

Veri rastgele değil, tutarlı üretilir: önce satış miktarları belirlenir, stok ve
ciro bunlardan türetilir. Kampüslerin ciro beyan oranları bilinçli olarak farklıdır:

| Kampüs | Durum | Panelde görünen |
|---|---|---|
| İkitelli OSB, İstanbul OSB, Çorlu | Normal | Fark ≈ %0 |
| Esenyurt | Ciro açığı (%2,8 → %4,2 artan) | Kırmızı, dikkat uyarısı |
| Kıraç | Ciro fazlası (%2) | Eksik mal girişi işareti |

## Demonun kurulu sürümden farkları

- Veriler tarayıcıda (`localStorage`) tutulur; başka cihaza veya kişiye geçmez.
- Dosya indirme (Excel/CSV dışa aktarma) claude.ai korumalı alanında engellidir.
- Parola doğrulaması yoktur; giriş ekranındaki hesaplardan biri seçilir.
- Ciro teslim fişinde yazdırma: korumalı alan `window.print()` çağrısını sessizce
  yok sayar. Bu yüzden fiş her durumda önce **ekranda** açılır; ardından ayrı bir
  pencereden yazdırma denenir. O da engellenirse ekranda gerekçesi yazar.
  Kurulu sürümde düğme doğrudan yazdırma penceresini açar.

Bunlar dışında tüm iş akışı — sayım, mutabakat, ciro, alım, fire, transfer,
raporlar, yetkiler — kurulu sürümle aynı mantıkla çalışır.
