/** Ortak arayuz yardimcilari: bicimlendirme, DOM olusturma, modal, bildirim. */

/* --------------------------- Bicimlendirme ------------------------- */
const tl = new Intl.NumberFormat('tr-TR', { style: 'currency', currency: 'TRY', maximumFractionDigits: 2 });
const nf = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 0 });

export const fmt = {
  money: (n) => (n === null || n === undefined || n === '' ? '—' : tl.format(Number(n))),
  num: (n) => (n === null || n === undefined || n === '' ? '—' : nf.format(Number(n))),
  int: (n) => (n === null || n === undefined || n === '' ? '—' : nf0.format(Number(n))),
  pct: (n) => (n === null || n === undefined || n === '' ? '—' : `%${nf.format(Number(n))}`),
  date: (s) => {
    if (!s) return '—';
    const d = new Date(`${String(s).slice(0, 10)}T00:00:00`);
    return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('tr-TR');
  },
  dateTime: (s) => {
    if (!s) return '—';
    const d = new Date(s.includes('T') ? s : s.replace(' ', 'T') + 'Z');
    return Number.isNaN(d.getTime()) ? s : d.toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
  },
  monthName: (ym) => {
    if (!ym) return '—';
    const [y, m] = ym.split('-');
    return new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('tr-TR', { month: 'long', year: 'numeric' });
  },
};

export const dateUtil = {
  today: () => new Date().toISOString().slice(0, 10),
  thisMonth: () => new Date().toISOString().slice(0, 7),
  monthsAgo(n) {
    const d = new Date();
    d.setMonth(d.getMonth() - n);
    return d.toISOString().slice(0, 7);
  },
  addDays(dateStr, days) {
    const d = new Date(`${dateStr}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  },
};

/** Kampüs adından kurum ön ekini atar: "Topkapı Okulları - Merkez Kampüs" -> "Merkez Kampüs" */
/**
 * Arama ve eşleştirme için metni sadeleştirir.
 *
 * Türkçe harfler ASCII karşılıklarına indirgenir (ç→c, ş→s, ğ→g, ı/İ→i,
 * ö→o, ü→u). Sebebi pratik: kullanıcı "cay" yazıp "Çay"ı bulamazsa arama
 * kutusu işe yaramaz — özellikle telefonda kimse Türkçe klavyeye geçmez.
 * Aynı indirgeme faturadaki "CIKOLATA" ile katalogdaki "Çikolata"yı da
 * eşleştirir.
 */
const TR_HARFLER = { ç: 'c', Ç: 'c', ğ: 'g', Ğ: 'g', ı: 'i', İ: 'i', ö: 'o', Ö: 'o', ş: 's', Ş: 's', ü: 'u', Ü: 'u', â: 'a', î: 'i', û: 'u' };

export function normalizeTr(s) {
  return String(s || '')
    .replace(/[çÇğĞıİöÖşŞüÜâîû]/g, (c) => TR_HARFLER[c] || c)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function shortName(name) {
  return String(name ?? '').replace(/^\s*Topkap[ıi]\s+Okullar[ıi]\s*[-–—]\s*/i, '').trim();
}

export const ROLE_LABELS = {
  ADMIN: 'Sistem Yöneticisi',
  GENEL_MUDURLUK: 'Genel Müdürlük',
  KAMPUS_YONETICISI: 'Kampüs Yöneticisi',
  KANTIN_GOREVLISI: 'Kantin Görevlisi',
  MUHASEBE: 'Ön Muhasebe (veri girişi)',
  DENETCI: 'Denetçi (salt okunur)',
};

export const WASTE_REASONS = {
  SKT: 'Son kullanma tarihi geçti',
  KIRILMA: 'Kırılma / hasar',
  BOZULMA: 'Bozulma',
  IKRAM: 'İkram / etkinlik',
  PERSONEL: 'Personel tüketimi',
  DIGER: 'Diğer',
};

/* ------------------------------- DOM ------------------------------- */
/** el('div.card', { onclick }, [cocuklar]) */
export function el(spec, props = {}, children = []) {
  const [tag, ...classes] = String(spec).split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');

  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = [node.className, value].filter(Boolean).join(' ');
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'value') node.value = value;
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }

/* ------------------------------ Kartlar ---------------------------- */
export function card(title, bodyChildren, { actions = [], note = null, tight = false } = {}) {
  const head = title || actions.length
    ? el('div.card-head', {}, [title ? el('h3', { text: title }) : null, el('div.spacer'), ...actions])
    : null;
  return el('div.card', {}, [
    head,
    note ? el('div', { class: 'card-body', style: 'padding-bottom:0' }, [el('p.card-note', { text: note })]) : null,
    el('div', { class: tight ? 'card-body tight' : 'card-body' }, bodyChildren),
  ]);
}

export function stat(label, value, { sub = null, tone = '' } = {}) {
  return el(`div.stat${tone ? '.' + tone : ''}`, {}, [
    el('div.stat-label', { text: label }),
    el('div.stat-value', { text: value }),
    sub ? el('div.stat-sub', { text: sub }) : null,
  ]);
}

export function badge(text, tone = '') { return el(`span.badge${tone ? '.' + tone : ''}`, { text }); }

export function empty(message, icon = '📭') {
  return el('div.empty', {}, [el('span.empty-icon', { text: icon }), el('div', { text: message })]);
}

export function alertBox(kind, title, message) {
  return el(`div.alert.alert-${kind}`, {}, [title ? el('strong', { text: title }) : null, message]);
}

/**
 * Veri tablosu.
 * columns: [{ label, key?, value?(row), num?, cls?(row), render?(row) }]
 */
export function table(columns, rows, { footer = null, rowClass = null, emptyText = 'Kayıt bulunamadı.' } = {}) {
  if (!rows.length) return empty(emptyText);

  const thead = el('thead', {}, [
    el('tr', {}, columns.map((c) => el(`th${c.num ? '.num' : ''}`, { text: c.label }))),
  ]);
  const tbody = el('tbody', {}, rows.map((row) => {
    const tr = el('tr', {}, columns.map((c) => {
      const cls = ['td', c.num ? 'num' : '', c.wrap ? 'wrap' : '', c.cls ? c.cls(row) : ''].filter(Boolean).join(' ');
      const td = el('td', { class: cls.replace('td', '').trim() });
      const content = c.render ? c.render(row) : (c.value ? c.value(row) : row[c.key]);
      if (content instanceof Node) td.append(content);
      else td.textContent = content === null || content === undefined ? '—' : String(content);
      return td;
    }));
    const extra = rowClass ? rowClass(row) : null;
    if (extra) tr.className = extra;
    return tr;
  }));

  const parts = [thead, tbody];
  if (footer) {
    parts.push(el('tfoot', {}, [el('tr', {}, columns.map((c) => {
      const v = footer[c.key ?? c.label];
      return el(`td${c.num ? '.num' : ''}`, { text: v === undefined || v === null ? '' : String(v) });
    }))]));
  }
  return el('div.table-wrap', {}, [el('table.data', {}, parts)]);
}

/** Sayisal farki renklendiren hucre. */
export function deltaCell(value, formatter = fmt.money) {
  if (value === null || value === undefined) return el('span.muted', { text: '—' });
  const cls = value < 0 ? 'neg' : value > 0 ? 'pos' : 'muted';
  const sign = value > 0 ? '+' : '';
  return el(`span.${cls}`, { text: sign + formatter(value).replace('+', '') });
}

/* ---------------------------- Bildirimler -------------------------- */
export function toast(message, kind = 'success', ms = 4000) {
  const node = el(`div.toast.${kind}`, { text: message });
  document.getElementById('toasts').append(node);
  setTimeout(() => {
    node.style.opacity = '0';
    setTimeout(() => node.remove(), 200);
  }, ms);
}

/* ------------------------------- Modal ----------------------------- */
export function modal({ title, body, actions = [], wide = false, onClose = null }) {
  const root = document.getElementById('modalRoot');
  const backdrop = el('div.modal-backdrop');
  const close = () => { backdrop.remove(); document.removeEventListener('keydown', onKey); onClose?.(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };

  const box = el(`div.modal${wide ? '.wide' : ''}`, {}, [
    el('div.modal-head', {}, [el('h3', { text: title }), el('button.icon-btn', { text: '✕', onclick: close })]),
    el('div.modal-body', {}, [].concat(body)),
    actions.length ? el('div.modal-foot', {}, actions) : null,
  ]);
  backdrop.append(box);
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  document.addEventListener('keydown', onKey);
  root.append(backdrop);
  setTimeout(() => box.querySelector('input, select, textarea, button')?.focus(), 30);
  return { close, box };
}

export function confirmDialog(message, { title = 'Onay', confirmText = 'Evet, devam et', danger = false } = {}) {
  return new Promise((resolve) => {
    // Karar once isaretlenir: close() icindeki onClose, kullanici zaten secim
    // yaptiysa Promise'i "iptal" ile kapatmamalidir.
    let decided = false;
    const decide = (value) => {
      decided = true;
      m.close();
      resolve(value);
    };
    const m = modal({
      title,
      body: [el('p', { text: message })],
      actions: [
        el('button.btn', { text: 'Vazgeç', onclick: () => decide(false) }),
        el(`button.btn.${danger ? 'btn-danger' : 'btn-primary'}`, { text: confirmText, onclick: () => decide(true) }),
      ],
      onClose: () => { if (!decided) resolve(false); },
    });
  });
}

/**
 * Basit form modal'i.
 * fields: [{name,label,type,value,options,required,hint,step,min}]
 *
 * Ozel tipler:
 *   section - baslik satiri
 *   info    - GIRDI DEGIL, salt okunur bilgi satiri. Degeri formdan
 *             donmez; "bu alan artik elle girilmiyor, su kaynaktan geliyor"
 *             demek icin kullanilir.
 */
export function formModal({ title, fields, submitText = 'Kaydet', wide = false, onSubmit }) {
  const inputs = {};
  const errorBox = el('div.alert.alert-danger', { hidden: true });

  const body = fields.map((f) => {
    if (f.type === 'section') return el('h4', { text: f.label, style: 'margin-top:6px;font-size:13px;color:var(--text-muted)' });
    if (f.type === 'info') {
      return el('div.field', {}, [
        el('span', { text: f.label }),
        el('div.info-value', { text: f.value ?? '' }),
      ]);
    }
    let input;
    if (f.type === 'select') {
      input = el('select', { name: f.name }, (f.options || []).map((o) =>
        el('option', { value: o.value, selected: String(o.value) === String(f.value ?? '') }, [o.label])));
    } else if (f.type === 'textarea') {
      input = el('textarea', { name: f.name, value: f.value ?? '' });
    } else if (f.type === 'checkbox') {
      input = el('input', { type: 'checkbox', name: f.name });
      input.checked = !!f.value;
    } else {
      input = el('input', {
        type: f.type || 'text', name: f.name, value: f.value ?? '',
        step: f.step, min: f.min, max: f.max, placeholder: f.placeholder, required: f.required,
        class: f.type === 'number' ? 'num' : null,
      });
    }
    inputs[f.name] = input;
    if (f.type === 'checkbox') {
      return el('label', { class: 'inline-field', style: 'gap:8px' }, [input, el('span', { text: f.label, style: 'color:var(--text)' })]);
    }
    return el('label.field', {}, [
      el('span', { text: f.label + (f.required ? ' *' : '') }),
      input,
      f.hint ? el('small', { text: f.hint }) : null,
    ]);
  });

  const submitBtn = el('button.btn.btn-primary', { text: submitText });
  const m = modal({
    title, wide,
    body: [errorBox, ...body],
    actions: [el('button.btn', { text: 'Vazgeç', onclick: () => m.close() }), submitBtn],
  });

  submitBtn.addEventListener('click', async () => {
    const values = {};
    for (const [name, input] of Object.entries(inputs)) {
      values[name] = input.type === 'checkbox' ? input.checked : input.value;
    }
    errorBox.hidden = true;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Kaydediliyor...';
    try {
      await onSubmit(values);
      m.close();
    } catch (err) {
      errorBox.textContent = err.message;
      errorBox.hidden = false;
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = submitText;
    }
  });
  return m;
}

/* ------------------------------ Grafik ----------------------------- */
/** Basit yatay cubuk grafik (harici kutuphane kullanmadan). */
export function barChart(items, { labelKey = 'label', valueKey = 'value', formatter = fmt.money } = {}) {
  if (!items.length) return empty('Gösterilecek veri yok.', '📊');
  const max = Math.max(...items.map((i) => Math.abs(Number(i[valueKey]) || 0)), 1);
  return el('div.bar-chart', {}, items.map((i) => {
    const v = Number(i[valueKey]) || 0;
    return el('div.bar-row', {}, [
      el('div', { text: i[labelKey], title: i[labelKey], style: 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' }),
      el('div.bar-track', {}, [el('div.bar-fill', { style: `width:${(Math.abs(v) / max) * 100}%` })]),
      el('div.bar-value', { text: formatter(v) }),
    ]);
  }));
}

/** Yukleniyor gostergesi. */
export function loading(text = 'Yükleniyor...') {
  return el('div.empty', {}, [el('span.empty-icon', { text: '⏳' }), text]);
}
