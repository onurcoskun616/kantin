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
