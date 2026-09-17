/**
 * CIRO TESLIM FISI
 *
 * Gunluk ciro sistemden ciktisi alinip kantin gorevlisi tarafindan on
 * muhasebeye imza karsiligi teslim edilir. Bu ekran o belgeyi uretir,
 * yazdirir ve sonradan dogrulanmasini saglar.
 *
 * Belgenin denetim degeri tutari DONDURMASINDAN gelir: kagittaki rakam ile
 * sistemdeki rakam sonradan ayrisirsa ekran bunu "FARKLI" olarak gosterir.
 */
import { api } from '../api.js';
import { state, canWrite, canConfirmHandover, navigate } from '../app.js';
import {
  el, card, stat, table, fmt, badge, modal, toast, formModal,
  dateUtil, alertBox, shortName, deltaCell,
} from '../ui.js';

const STATUS = {
  TESLIM_EDILDI: { label: 'Teslim edildi · onay bekliyor', tone: 'warn' },
  ONAYLANDI: { label: 'Ön muhasebe onayladı', tone: 'ok' },
  FARKLI: { label: 'Tutar sonradan değişti', tone: 'danger' },
};

/* ============================== LISTE ============================== */
export async function render(root) {
  const container = el('div.grid');
  root.replaceChildren(container);
  await draw();

  async function draw() {
    const [data, pending] = await Promise.all([
      api.get('/api/handovers', { campusId: state.campusId }),
      api.get('/api/handovers/pending', { campusId: state.campusId }),
    ]);
    container.replaceChildren();

    container.append(el('div.row', { style: 'justify-content:space-between' }, [
      el('div', {}, [
        el('h2', { text: 'Ciro Teslim Fişleri', style: 'margin:0;font-size:18px' }),
        el('small.muted', { text: 'Kantin görevlisi → ön muhasebe · imza karşılığı' }),
      ]),
      el('div.row', { style: 'gap:8px' }, [
        el('button.btn', { text: '🔎 Belge Doğrula', onclick: () => openVerify() }),
        canWrite() ? el('button.btn.btn-primary', { text: '+ Teslim Fişi Oluştur', onclick: () => openForm(draw) }) : null,
      ]),
    ]));

    container.append(alertBox('info', 'Bu belge ne işe yarar?',
      'Fiş oluşturulduğu anda o günlerin cirosu belgenin üzerine yazılır ve dondurulur. '
      + 'Teslim edilen günlerin cirosunu kantin görevlisi artık değiştiremez; genel müdürlük değiştirirse '
      + 'fiş "FARKLI" olarak işaretlenir ve kâğıttaki tutar ile sistemdeki tutar yan yana görünür. '
      + 'İmzanın anlamı budur: kâğıt ile sistem her zaman karşılaştırılabilir kalır.'));

    /* ---- Teslim edilmeyi bekleyen ciro ---- */
    if (pending.items.length) {
      const late = pending.items.filter((p) => p.waitingDays >= 3);
      container.append(card('Teslim Edilmemiş Ciro', [
        late.length
          ? alertBox('warn', 'Bekleyen nakit var',
            `${late.map((p) => shortName(p.campusName)).join(', ')} kampüsünde 3 günden uzun süredir `
            + 'teslim edilmemiş ciro görünüyor. Kasada bekleyen nakit, sayımla denetlenemeyen tek kalemdir.')
          : null,
        table([
          { label: 'Kampüs', value: (r) => shortName(r.campusName) },
          { label: 'En Eski Gün', value: (r) => fmt.date(r.oldestDate) },
          { label: 'Gün', num: true, value: (r) => fmt.int(r.dayCount) },
          { label: 'Bekleme', num: true, render: (r) => badge(`${r.waitingDays} gün`, r.waitingDays >= 3 ? 'warn' : '') },
          { label: 'Tutar', num: true, value: (r) => fmt.money(r.total) },
          {
            label: '', render: (r) => (canWrite()
              ? el('button.btn.btn-sm', {
                text: 'Fiş oluştur',
                onclick: () => openForm(draw, { campusId: r.campusId, from: r.oldestDate, to: r.days[r.days.length - 1].date }),
              })
              : el('span.muted', { text: '—' })),
          },
        ], pending.items),
      ], { note: `Toplam bekleyen: ${fmt.money(pending.totalPending)}` }));
    }

    /* ---- Ozet ---- */
    const s = data.summary;
    container.append(el('div.grid.grid-3', {}, [
      stat('Belge Sayısı', fmt.int(s.documentCount)),
      stat('Teslim Edilen Tutar', fmt.money(s.totalAmount)),
      stat('Onay Bekleyen', fmt.int(s.pendingConfirm), {
        sub: s.mismatched ? `${s.mismatched} fişte tutar farkı var` : 'Tutar farkı yok',
        tone: s.mismatched ? 'danger' : (s.pendingConfirm ? 'warn' : 'ok'),
      }),
    ]));

    /* ---- Fis listesi ---- */
    container.append(card('Fişler', [
      table([
        { label: 'Belge No', render: (r) => el('a.link', { text: r.document_no, href: `#/handoverDetail/${r.id}` }) },
        { label: 'Kampüs', value: (r) => shortName(r.campus_name) },
        { label: 'Dönem', value: (r) => (r.period_from === r.period_to
          ? fmt.date(r.period_from)
          : `${fmt.date(r.period_from)} – ${fmt.date(r.period_to)}`) },
        { label: 'Gün', num: true, value: (r) => fmt.int(r.day_count) },
        { label: 'Fiş Tutarı', num: true, value: (r) => fmt.money(r.total_amount) },
        { label: 'Sistemdeki', num: true, render: (r) => (r.has_mismatch
          ? deltaCell(r.difference)
          : el('span.muted', { text: fmt.money(r.current_total) })) },
        { label: 'Teslim Eden', value: (r) => r.delivered_by_name },
        { label: 'Teslim Alan', value: (r) => r.received_by_name },
        { label: 'Durum', render: (r) => badge(STATUS[r.status]?.label ?? r.status, STATUS[r.status]?.tone) },
      ], data.items, { emptyText: 'Henüz teslim fişi oluşturulmamış.' }),
    ]));
  }
}

/* ============================== DETAY ============================== */
export async function renderDetail(root, { params }) {
  const id = Number(params[0]);
  const data = await api.get(`/api/handovers/${id}`);
  const reload = () => renderDetail(root, { params: [id] });
  root.replaceChildren();

  const container = el('div.grid');
  root.append(container);

  container.append(el('div.row', { style: 'justify-content:space-between' }, [
    el('div', {}, [
      el('h2', { text: data.document_no, style: 'margin:0;font-size:18px' }),
      el('small.muted', { text: `${shortName(data.campus_name)} · ${fmt.date(data.period_from)} – ${fmt.date(data.period_to)}` }),
    ]),
    el('div.row', { style: 'gap:8px' }, [
      el('button.btn', { text: '← Listeye dön', onclick: () => navigate('handovers') }),
      el('button.btn.btn-primary', { text: '🖨️ Yazdır (2 nüsha)', onclick: () => printSlip(data) }),
      (canConfirmHandover() && data.status !== 'ONAYLANDI')
        ? el('button.btn.btn-success', { text: '✔ Teslim Aldım', onclick: () => openConfirm(data, reload) })
        : null,
    ]),
  ]));

  if (data.has_mismatch) {
    container.append(alertBox('danger', 'Kâğıttaki tutar ile sistemdeki tutar farklı',
      `İmzalanan belgede ${fmt.money(data.total_amount)} yazıyor, sistemde şu an ${fmt.money(data.current_total)} görünüyor `
      + `(fark ${fmt.money(data.difference)}). Değişiklik denetim izine yazıldı. `
      + 'İmzalı nüsha ile sistemin uyuşması için düzeltme gerekçesi ön muhasebeye yazılı bildirilmelidir.'));
  } else if (data.status === 'ONAYLANDI') {
    container.append(alertBox('ok', 'Teslim tamamlandı',
      `${data.confirmed_by_name || data.received_by_name} tarafından ${fmt.dateTime(data.received_at)} `
      + 'tarihinde sistemde onaylandı. Kâğıttaki tutar ile sistemdeki tutar aynı.'));
  } else {
    container.append(alertBox('warn', 'Ön muhasebe onayı bekleniyor',
      'Belge oluşturuldu ve tutar donduruldu. Ön muhasebe kâğıdı teslim alıp doğrulama kodunu '
      + 'sisteme girdiğinde teslim tamamlanır.'));
  }

  container.append(el('div.grid.grid-3', {}, [
    stat('Fiş Tutarı (donduruldu)', fmt.money(data.total_amount), { sub: `${data.day_count} gün` }),
    stat('Sistemdeki Güncel Tutar', fmt.money(data.current_total), {
      sub: data.has_mismatch ? `Fark: ${fmt.money(data.difference)}` : 'Fark yok',
      tone: data.has_mismatch ? 'danger' : 'ok',
    }),
    stat('Doğrulama Kodu', data.verification_code, { sub: 'Kâğıdın üzerinde basılıdır' }),
  ]));

  container.append(card('Ödeme Dağılımı', [
    table([
      { label: 'Kalem', key: 'label' },
      { label: 'Tutar', num: true, value: (r) => fmt.money(r.amount) },
    ], [
      { label: 'Nakit', amount: data.cash_amount },
      { label: 'Kredi Kartı', amount: data.card_amount },
      { label: 'Veresiye / Öğrenci Kartı', amount: data.credit_amount },
      { label: 'Diğer', amount: data.other_amount },
    ]),
  ], { note: 'Nakit kalemi, fiziken elden teslim edilen tutardır.' }));

  container.append(card('Fişe Dahil Günler', [
    table([
      { label: 'Tarih', value: (r) => fmt.date(r.revenue_date) },
      { label: 'Nakit', num: true, value: (r) => fmt.money(r.cash_amount) },
      { label: 'Kart', num: true, value: (r) => fmt.money(r.card_amount) },
      { label: 'Veresiye', num: true, value: (r) => fmt.money(r.credit_amount) },
      { label: 'Diğer', num: true, value: (r) => fmt.money(r.other_amount) },
      { label: 'Toplam', num: true, value: (r) => fmt.money(r.total_amount) },
      { label: 'Z No', key: 'z_report_no' },
    ], data.days, { emptyText: 'Bu fişe bağlı ciro kaydı kalmamış.' }),
  ]));

  container.append(card('Belge Bilgileri', [
    table([
      { label: 'Alan', key: 'k' },
      { label: 'Değer', key: 'v' },
    ], [
      { k: 'Belge No', v: data.document_no },
      { k: 'Teslim Eden (kantin)', v: data.delivered_by_name },
      { k: 'Teslim Alan (ön muhasebe)', v: data.received_by_name },
      { k: 'Sistemde Onaylayan', v: data.confirmed_by_name || '—' },
      { k: 'Onay Zamanı', v: data.received_at ? fmt.dateTime(data.received_at) : '—' },
      { k: 'Oluşturulma', v: fmt.dateTime(data.created_at) },
      { k: 'Yazıyla', v: data.amountInWords },
      { k: 'Açıklama', v: data.note || '—' },
    ]),
  ]));
}

/* =========================== FIS OLUSTURMA ========================= */
function openForm(onDone, preset = {}) {
  const today = dateUtil.today();
  formModal({
    title: 'Ciro Teslim Fişi Oluştur',
    submitText: 'Fişi Oluştur',
    fields: [
      {
        name: 'campusId', label: 'Kampüs', type: 'select', required: true,
        value: preset.campusId ?? state.campusId,
        options: state.campuses.map((c) => ({ value: c.id, label: shortName(c.name) })),
      },
      { name: 'from', label: 'Başlangıç Tarihi', type: 'date', required: true, value: preset.from ?? today },
      { name: 'to', label: 'Bitiş Tarihi', type: 'date', required: true, value: preset.to ?? today,
        hint: 'Tek gün teslim ediliyorsa iki tarihi de aynı bırakın.' },
      { name: 'receivedByName', label: 'Teslim Alan (ön muhasebe)', required: true,
        hint: 'Kâğıdı imzalayacak ön muhasebe görevlisinin adı soyadı.' },
      { name: 'note', label: 'Açıklama', type: 'textarea' },
    ],
    async onSubmit(v) {
      const created = await api.post('/api/handovers', {
        campusId: Number(v.campusId), from: v.from, to: v.to,
        receivedByName: v.receivedByName, note: v.note,
      });
      toast(`${created.document_no} oluşturuldu. Çıktısını alıp imzalatın.`);
      await onDone?.();
      // Yazdirma penceresi modal kapandiktan sonra acilmali, yoksa
      // window.print() modali ekranda kilitli birakir.
      setTimeout(() => printSlip(created), 0);
    },
  });
}

/* ========================= ON MUHASEBE ONAYI ======================= */
function openConfirm(data, onDone) {
  formModal({
    title: `${data.document_no} — Teslim Aldım`,
    submitText: 'Onayla',
    fields: [
      { name: 'verificationCode', label: 'Doğrulama Kodu', required: true, placeholder: 'Örn. K7M2QX',
        hint: 'Elinizdeki kâğıdın sağ üst köşesinde basılı 6 haneli koddur. '
          + 'Kod tutmuyorsa kâğıt bu belgenin kendisi değildir — onaylamayın.' },
    ],
    async onSubmit(v) {
      await api.post(`/api/handovers/${data.id}/confirm`, { verificationCode: v.verificationCode });
      toast('Teslim onaylandı.');
      await onDone?.();
    },
  });
}

/* ========================== BELGE DOGRULAMA ======================== */
function openVerify() {
  const docInput = el('input', { placeholder: 'IKT-2026-0001' });
  const codeInput = el('input', { placeholder: 'K7M2QX' });
  const result = el('div');
  const btn = el('button.btn.btn-primary', { text: 'Doğrula' });

  btn.addEventListener('click', async () => {
    result.replaceChildren();
    try {
      const r = await api.get(`/api/handovers/verify/${encodeURIComponent(docInput.value.trim())}`,
        { code: codeInput.value.trim() });
      result.append(el('div.grid', {}, [
        r.codeMatches
          ? alertBox('ok', 'Kod doğru', 'Elinizdeki kâğıt bu belgenin kendisidir.')
          : alertBox('danger', 'Kod eşleşmiyor',
            'Girilen doğrulama kodu bu belgeye ait değil. Kâğıt üzerinde değişiklik yapılmış olabilir.'),
        r.changedAfterHandover
          ? alertBox('danger', 'Tutar teslimden sonra değişmiş',
            `Kâğıtta ${fmt.money(r.paperTotal)}, sistemde ${fmt.money(r.systemTotal)} görünüyor.`)
          : alertBox('ok', 'Tutar değişmemiş', `Kâğıt ve sistem aynı: ${fmt.money(r.paperTotal)}.`),
        table([
          { label: 'Alan', key: 'k' }, { label: 'Değer', key: 'v' },
        ], [
          { k: 'Kampüs', v: r.campusName },
          { k: 'Dönem', v: `${fmt.date(r.period.from)} – ${fmt.date(r.period.to)}` },
          { k: 'Fiş Tutarı', v: fmt.money(r.paperTotal) },
          { k: 'Yazıyla', v: r.amountInWords },
          { k: 'Durum', v: STATUS[r.status]?.label ?? r.status },
        ]),
      ]));
    } catch (err) {
      result.append(alertBox('danger', 'Bulunamadı', err.message));
    }
  });

  modal({
    title: 'Belge Doğrula',
    wide: true,
    body: [
      el('p.muted', { text: 'Elinizdeki imzalı kâğıdın sistemdeki kayıtla aynı olup olmadığını kontrol edin.' }),
      el('label.field', {}, [el('span', { text: 'Belge No' }), docInput]),
      el('label.field', {}, [el('span', { text: 'Doğrulama Kodu' }), codeInput]),
      result,
    ],
    actions: [btn],
  });
}

/* ============================== YAZDIRMA =========================== */
/**
 * A4 uzerine iki nusha basar: ust yari kantin nushasi, alt yari on muhasebe
 * nushasi. Ikisi de ayni tutari ve ayni dogrulama kodunu tasir; imza satirlari
 * ayridir ki her taraf kendi nushasini imzali olarak saklasin.
 */
function printSlip(data) {
  const host = document.getElementById('printRoot') || (() => {
    const n = el('div', { id: 'printRoot' });
    document.body.append(n);
    return n;
  })();
  host.replaceChildren(
    slipCopy(data, 'KANTİN NÜSHASI'),
    el('div.slip-cut', { text: '✂ — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — — —' }),
    slipCopy(data, 'ÖN MUHASEBE NÜSHASI'),
  );
  window.print();
}

function slipCopy(data, copyLabel) {
  const period = data.period_from === data.period_to
    ? fmt.date(data.period_from)
    : `${fmt.date(data.period_from)} – ${fmt.date(data.period_to)}`;

  return el('div.slip', {}, [
    el('div.slip-head', {}, [
      el('div', {}, [
        el('div.slip-org', { text: 'TOPKAPI OKULLARI' }),
        el('div.slip-title', { text: 'GÜNLÜK CİRO TESLİM FİŞİ' }),
        el('div.slip-copy', { text: copyLabel }),
      ]),
      el('div.slip-doc', {}, [
        el('div', {}, [el('strong', { text: data.document_no })]),
        el('div.slip-code', { text: `Doğrulama: ${data.verification_code}` }),
        el('div.slip-small', { text: `Düzenleme: ${fmt.dateTime(data.created_at)}` }),
      ]),
    ]),

    el('table.slip-meta', {}, [el('tbody', {}, [
      el('tr', {}, [el('th', { text: 'Kampüs' }), el('td', { text: data.campus_name }),
        el('th', { text: 'Dönem' }), el('td', { text: period })]),
      el('tr', {}, [el('th', { text: 'Gün Sayısı' }), el('td', { text: String(data.day_count) }),
        el('th', { text: 'Belge No' }), el('td', { text: data.document_no })]),
    ])]),

    el('table.slip-days', {}, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: 'Tarih' }), el('th.num', { text: 'Nakit' }), el('th.num', { text: 'Kart' }),
        el('th.num', { text: 'Veresiye' }), el('th.num', { text: 'Diğer' }), el('th.num', { text: 'Toplam' }),
        el('th', { text: 'Z No' }),
      ])]),
      el('tbody', {}, (data.days || []).map((d) => el('tr', {}, [
        el('td', { text: fmt.date(d.revenue_date) }),
        el('td.num', { text: fmt.money(d.cash_amount) }),
        el('td.num', { text: fmt.money(d.card_amount) }),
        el('td.num', { text: fmt.money(d.credit_amount) }),
        el('td.num', { text: fmt.money(d.other_amount) }),
        el('td.num', { text: fmt.money(d.total_amount) }),
        el('td', { text: d.z_report_no || '' }),
      ]))),
      el('tfoot', {}, [el('tr', {}, [
        el('th', { text: 'TOPLAM' }),
        el('th.num', { text: fmt.money(data.cash_amount) }),
        el('th.num', { text: fmt.money(data.card_amount) }),
        el('th.num', { text: fmt.money(data.credit_amount) }),
        el('th.num', { text: fmt.money(data.other_amount) }),
        el('th.num', { text: fmt.money(data.total_amount) }),
        el('th', { text: '' }),
      ])]),
    ]),

    el('div.slip-words', {}, [
      el('span', { text: 'Yazıyla: ' }),
      el('strong', { text: data.amountInWords || '' }),
    ]),

    el('div.slip-sign', {}, [
      el('div.slip-sign-box', {}, [
        el('div.slip-sign-role', { text: 'TESLİM EDEN — Kantin Görevlisi' }),
        el('div.slip-sign-name', { text: data.delivered_by_name }),
        el('div.slip-sign-line', { text: 'İmza' }),
      ]),
      el('div.slip-sign-box', {}, [
        el('div.slip-sign-role', { text: 'TESLİM ALAN — Ön Muhasebe' }),
        el('div.slip-sign-name', { text: data.received_by_name }),
        el('div.slip-sign-line', { text: 'İmza' }),
      ]),
    ]),

    el('div.slip-foot', {
      text: 'Yukarıda dökümü verilen ciro, belirtilen tutar üzerinden teslim edilmiştir. '
        + 'Bu belgedeki tutar sistemde dondurulmuştur; sonradan yapılan her değişiklik denetim izine kaydedilir '
        + 've fiş "tutar farklı" olarak işaretlenir.',
    }),
  ]);
}
