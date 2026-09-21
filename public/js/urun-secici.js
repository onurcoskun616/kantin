/**
 * ARANABİLİR ÜRÜN SEÇİCİ
 *
 * Fatura satırında doğru ürünü bulmak için. Açılır liste (`<select>`) yüzlerce
 * ürünle kullanılamaz hale geliyor: aradığınızı görmek için listeyi elle
 * taramak gerekiyor.
 *
 * Bu seçici yazdıkça süzer ve her satırda ürünün **stoğunu** gösterir —
 * fatura girerken "bu ürün zaten var mıydı" sorusunun cevabı ekranda durur.
 *
 * Harici kütüphane yok; klavyeyle de kullanılır (↑ ↓ Enter Esc).
 */
import { el } from './ui.js';

/** Karşılaştırma için sadeleştirir: Türkçe harfler ve noktalama. */
function normalize(s) {
  return String(s || '')
    .toLocaleLowerCase('tr')
    .replace(/ı/g, 'i').replace(/İ/g, 'i')
    .replace(/[^a-z0-9ğüşöç]+/g, ' ')
    .trim();
}

const MAX_SONUC = 60;

/**
 * @param products        [{ id, name, barcode, unit, vat_rate }]
 * @param stockByProduct  Map(productId -> stok miktarı) — isteğe bağlı
 * @param value           seçili ürün id'si (null olabilir)
 * @param placeholder     boşken gösterilecek metin
 * @param onChange        (productId|null) => void
 * @param onCreateNew     (yazılanMetin) => void — verilirse "yeni ürün" satırı çıkar
 * @returns { node, setValue, getValue, focus }
 */
export function createProductPicker({
  products,
  stockByProduct = new Map(),
  value = null,
  placeholder = '— ürün seçin —',
  onChange = () => {},
  onCreateNew = null,
} = {}) {
  let selectedId = value ?? null;
  let acik = false;
  let vurgu = -1;
  let sonuclar = [];

  const input = el('input.picker-input', { placeholder, autocomplete: 'off' });
  const liste = el('div.picker-list', { hidden: true });
  const node = el('div.picker', {}, [input, liste]);

  const urunAdi = (id) => products.find((p) => p.id === id)?.name ?? '';

  const stokMetni = (p) => {
    if (!stockByProduct.has(p.id)) return '';
    const q = stockByProduct.get(p.id);
    return `stok ${Number(q).toLocaleString('tr-TR', { maximumFractionDigits: 2 })} ${p.unit || ''}`.trim();
  };

  /** Yazılan metne göre süzer. Boşsa tüm liste (ilk MAX_SONUC). */
  function ara(q) {
    const needle = normalize(q);
    if (!needle) return products.slice(0, MAX_SONUC);
    const kelimeler = needle.split(' ').filter(Boolean);
    const skor = (p) => {
      const ad = normalize(p.name);
      const barkod = String(p.barcode || '').toLocaleLowerCase('tr');
      // Barkodun tamamı yazıldıysa en üste
      if (barkod && barkod === needle) return 0;
      if (!kelimeler.every((k) => ad.includes(k) || barkod.includes(k))) return null;
      if (ad.startsWith(needle)) return 1;       // baştan eşleşme daha alakalı
      return 2;
    };
    return products
      .map((p) => ({ p, s: skor(p) }))
      .filter((x) => x.s !== null)
      .sort((a, b) => a.s - b.s)
      .slice(0, MAX_SONUC)
      .map((x) => x.p);
  }

  function ciz() {
    const satirlar = sonuclar.map((p, i) => el(`div.picker-item${i === vurgu ? '.on' : ''}`, {
      // mousedown kullanılır: blur'dan ÖNCE çalışsın, yoksa liste kapanır
      onmousedown: (e) => { e.preventDefault(); sec(p.id); },
    }, [
      el('span.picker-name', { text: p.name }),
      el('span.picker-meta', {
        text: [p.barcode || null, stokMetni(p) || null].filter(Boolean).join(' · '),
      }),
    ]));

    if (!sonuclar.length) {
      satirlar.push(el('div.picker-empty', {
        text: input.value.trim() ? `"${input.value.trim()}" için ürün bulunamadı.` : 'Ürün yok.',
      }));
    }
    if (onCreateNew) {
      const yazilan = input.value.trim();
      satirlar.push(el(`div.picker-item.picker-new${vurgu === sonuclar.length ? '.on' : ''}`, {
        onmousedown: (e) => { e.preventDefault(); kapat(); onCreateNew(yazilan); },
      }, [
        el('span.picker-name', { text: yazilan ? `+ "${yazilan}" adıyla yeni ürün tanımla` : '+ Yeni ürün tanımla' }),
      ]));
    }
    liste.replaceChildren(...satirlar);
  }

  /** Vurgulanabilecek son satırın indeksi (yeni ürün satırı dahil). */
  const sonIndeks = () => sonuclar.length - (onCreateNew ? 0 : 1);

  /**
   * Listeyi girdinin altına sabitler.
   *
   * Satır tablosu yatayda kaydırıldığı icin (`overflow:auto`) normal bir
   * `position:absolute` liste kırpılır. Bu yüzden liste `position:fixed`
   * yapılır ve koordinatları buradan verilir. Aşağıda yer yoksa yukarı açılır.
   */
  function konumla() {
    const r = input.getBoundingClientRect();
    const altBosluk = window.innerHeight - r.bottom;
    const yukari = altBosluk < 220 && r.top > altBosluk;
    liste.classList.add('floating');
    liste.style.width = `${Math.max(r.width, 260)}px`;
    liste.style.left = `${Math.min(r.left, window.innerWidth - Math.max(r.width, 260) - 8)}px`;
    liste.style.maxHeight = `${Math.max(140, (yukari ? r.top : altBosluk) - 12)}px`;
    if (yukari) { liste.style.top = 'auto'; liste.style.bottom = `${window.innerHeight - r.top + 2}px`; }
    else { liste.style.bottom = 'auto'; liste.style.top = `${r.bottom + 2}px`; }
  }

  function ac() {
    sonuclar = ara(input.value);
    vurgu = -1;
    acik = true;
    liste.hidden = false;
    node.classList.add('open');
    ciz();
    konumla();
  }

  function kapat() {
    acik = false;
    liste.hidden = true;
    node.classList.remove('open');
    // Yazılan metin bir seçim değil: seçili ürünün adına geri dön
    input.value = selectedId ? urunAdi(selectedId) : '';
  }

  function sec(id) {
    selectedId = id;
    kapat();
    input.value = urunAdi(id);
    node.classList.remove('needs-pick');
    onChange(id);
  }

  // Liste ekrana sabitlendigi icin sayfa kayinca birlikte gitmez: kapatiriz.
  const kaydirmaIzle = () => { if (acik) konumla(); };
  window.addEventListener('resize', kaydirmaIzle);
  window.addEventListener('scroll', kaydirmaIzle, true);

  input.addEventListener('focus', () => { input.select(); ac(); });
  input.addEventListener('input', () => {
    if (!acik) ac(); else { sonuclar = ara(input.value); vurgu = -1; ciz(); }
  });
  input.addEventListener('blur', () => { if (acik) kapat(); });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (acik) { e.stopPropagation(); kapat(); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!acik) { ac(); return; }
      const son = sonIndeks();
      if (son < 0) return;
      vurgu = e.key === 'ArrowDown'
        ? (vurgu >= son ? 0 : vurgu + 1)
        : (vurgu <= 0 ? son : vurgu - 1);
      ciz();
      liste.querySelector('.picker-item.on')?.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (e.key === 'Enter') {
      if (!acik) return;
      e.preventDefault();
      if (vurgu >= 0 && vurgu < sonuclar.length) { sec(sonuclar[vurgu].id); return; }
      if (onCreateNew && vurgu === sonuclar.length) { const y = input.value.trim(); kapat(); onCreateNew(y); return; }
      // Vurgu yoksa tek sonuç varsa onu seç: yazıp Enter'lamak yeterli olsun
      if (sonuclar.length === 1) sec(sonuclar[0].id);
    }
  });

  if (selectedId) input.value = urunAdi(selectedId);

  return {
    node,
    focus: () => input.focus(),
    getValue: () => selectedId,
    setValue: (id) => {
      selectedId = id ?? null;
      input.value = selectedId ? urunAdi(selectedId) : '';
      node.classList.toggle('needs-pick', !selectedId);
    },
    /** Yeni ürün eklendiğinde listeyi tazeler ve onu seçer. */
    addProduct: (p, select = true) => {
      products.push(p);
      if (select) sec(p.id);
    },
    markMissing: (missing) => node.classList.toggle('needs-pick', !!missing),
  };
}
