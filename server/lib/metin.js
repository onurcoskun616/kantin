/**
 * Metin sadelestirme.
 *
 * Arama ve eslestirmede kullanilir. `public/js/ui.js` icindeki `normalizeTr`
 * ile AYNI kurali uygular; ikisi ayrisirsa tarayicida eslesen bir ad sunucuda
 * eslesmez ve "neden ogrenmedi" sorusu cikar.
 *
 * Turkce harfler ASCII karsiliklarina indirgenir, harf/rakam disindaki her
 * sey tek bosluga cevrilir:
 *   "KUTU  AYRAN 200ML."  ->  "kutu ayran 200ml"
 *   "Çikolatalı Gofret"   ->  "cikolatali gofret"
 */
const TR_HARFLER = {
  ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o',
  ş: 's', Ş: 's', ü: 'u', Ü: 'u', â: 'a', î: 'i', û: 'u',
};

export function normalizeTr(s) {
  return String(s || '')
    .replace(/[çÇğĞıİöÖşŞüÜâîû]/g, (c) => TR_HARFLER[c] || c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * ARAMA ICIN TURKCE KATLAMA.
 *
 * SQLite'in LIKE'i yalnizca ASCII harflerde buyuk/kucuk harf ayrimini
 * yok sayar. Turkce harflerde AYNEN esleme arar: "çikolatalı" yazan
 * kullanici "Çikolatalı Süt" urununu BULAMIYORDU; yalnizca faturadaki
 * yazimin harfi harfine aynisi calisiyordu. Kullanici icin bu, "arama
 * kutusu calismiyor" demektir.
 *
 * `normalizeTr`den farki: noktalama ve bosluklara DOKUNMAZ. Arama
 * "0.5 CC PET" gibi terimlerde noktayi da eslestirebilmeli.
 *
 *   trFold('Çikolatalı SÜT')  ->  'cikolatali sut'
 */
export function trFold(s) {
  return String(s || '')
    .replace(/[çÇğĞıİöÖşŞüÜâÂîÎûÛ]/g, (c) => TR_HARFLER[c] || TR_HARFLER[c.toLowerCase()] || c)
    .toLowerCase();
}

/**
 * Ayni katlamayi SQL tarafinda yapan ifadeyi uretir.
 *
 * SQLite'ta unicode farkindali LOWER yok; Turkce harfler tek tek
 * degistirilir. Katalog birkac yuz satir oldugu icin maliyeti onemsiz.
 */
export function trFoldSql(sutun) {
  const ciftler = [
    ['Ç', 'c'], ['ç', 'c'], ['Ğ', 'g'], ['ğ', 'g'], ['İ', 'i'], ['ı', 'i'],
    ['Ö', 'o'], ['ö', 'o'], ['Ş', 's'], ['ş', 's'], ['Ü', 'u'], ['ü', 'u'],
    ['Â', 'a'], ['â', 'a'], ['Î', 'i'], ['î', 'i'], ['Û', 'u'], ['û', 'u'],
  ];
  // LOWER en sonda: ASCII harfleri o kucultur, Turkceleri yukaridaki
  // degistirmeler zaten kucuk ASCII karsiligina cevirdi.
  return ciftler.reduce((ifade, [buyuk, kucuk]) => `REPLACE(${ifade}, '${buyuk}', '${kucuk}')`,
    `LOWER(${sutun})`);
}

/**
 * URUN ADINDAN AMBALAJ ADEDI IPUCU CIKARIR.
 *
 * Sahadan:
 *   "DUCAT SICAK ÇİKOLATA*10"        -> 10
 *   "Ducat Sıcak Çikolata 10 Lu"     -> 10
 *   "CRAX ACI BAHARATLI 50GX20KL"    -> 20   (50 g degil, 20 koli adedi)
 *   "BİSKREM KAKAOLU 100GRx18"       -> 18
 *   "SÜT 180 ML"                     -> (yok)
 *
 * IPUCUDUR, karar degil: iki yerde kullanilir -- mukerrer kart
 * birlestirmede "1 PAKET = kac ADET" on dolgusu, ve fiyat denetiminde
 * "koli fiyati adet fiyati sanilmis" tanisi.
 */
export function adAdetIpucu(ad) {
  const t = normalizeTr(String(ad || '').replace(/\*/g, ' x '));
  const bulunan = new Set();
  for (const m of t.matchAll(/x\s*(\d{1,3})/g)) bulunan.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*l[uiy]\b/g)) bulunan.add(Number(m[1]));
  for (const m of t.matchAll(/(\d{1,3})\s*adet/g)) bulunan.add(Number(m[1]));
  return [...bulunan].filter((n) => n >= 2 && n <= 500).sort((a, b) => a - b);
}
