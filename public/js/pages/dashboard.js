import { api } from '../api.js';
import { state, navigate, canWrite } from '../app.js';
import { el, card, stat, table, fmt, badge, empty, alertBox, barChart, deltaCell, dateUtil, shortName} from '../ui.js';

export async function render(root) {
  const monthInput = el('input', { type: 'month', value: state.month, style: 'width:170px' });
  monthInput.addEventListener('change', () => { state.month = monthInput.value; render(root); });

  const data = await api.get('/api/reports/dashboard', { month: state.month });
  root.replaceChildren();

  root.append(el('div.row', { style: 'justify-content:space-between' }, [
    el('label.inline-field', {}, [el('span', { text: 'Dönem' }), monthInput]),
    el('div.small.muted', { text: `${fmt.monthName(data.month)} · ${data.campuses.length} kampüs` }),
  ]));

  /* --- Genel özet --- */
  const t = data.totals;
  root.append(el('div.grid.grid-4', {}, [
    stat('Aylık Toplam Ciro', fmt.money(t.revenue), { sub: `${fmt.int(t.studentCount)} öğrenci` }),
    stat('Alım (Tedarikçi)', fmt.money(t.purchaseTotal), { sub: 'KDV dahil belge tutarı' }),
    stat('Stok Değeri (maliyet)', fmt.money(t.stockCostValue), { sub: 'Tüm kampüsler, güncel' }),
    stat('Fire Maliyeti', fmt.money(t.wasteCost), { tone: t.wasteCost > 0 ? 'warn' : '', sub: 'Kayıtlı zayiat' }),
  ]));

  /* --- Dikkat gerektirenler --- */
  const warnings = [];
  for (const c of data.campuses) {
    if (c.missingRevenueDays.length) {
      warnings.push(`${shortName(c.campusName)}: ${c.missingRevenueDays.length} iş gününde ciro girilmemiş (${c.missingRevenueDays.slice(0, 3).map(fmt.date).join(', ')}${c.missingRevenueDays.length > 3 ? '…' : ''})`);
    }
    if (c.stock.criticalCount > 0) warnings.push(`${shortName(c.campusName)}: ${c.stock.criticalCount} üründe stok kritik seviyede.`);
    if (c.stock.negativeCount > 0) warnings.push(`${shortName(c.campusName)}: ${c.stock.negativeCount} üründe stok eksiye düşmüş — mal girişi eksik olabilir.`);
    if (c.lastCount && c.lastCount.status === 'KESINLESMIS' && c.lastCount.difference !== null && c.lastCount.difference < -1) {
      warnings.push(`${shortName(c.campusName)}: son sayımda ${fmt.money(Math.abs(c.lastCount.difference))} ciro açığı tespit edildi.`);
    }
    if (!c.lastCount) warnings.push(`${shortName(c.campusName)}: henüz hiç sayım yapılmamış. Denetim için ilk sayımı girin.`);
  }
  if (warnings.length) {
    root.append(card('Dikkat Edilmesi Gerekenler', [
      el('ul', { style: 'margin:0;padding-left:18px;display:grid;gap:6px;font-size:13px' },
        warnings.slice(0, 12).map((w) => el('li', { text: w }))),
    ]));
  } else {
    root.append(alertBox('success', 'Her şey yolunda', 'Eksik ciro girişi, kritik stok veya sayım açığı görünmüyor.'));
  }

  /* --- Kampüs karşılaştırma tablosu --- */
  root.append(card(`Kampüs Bazlı Özet — ${fmt.monthName(data.month)}`, [
    table([
      { label: 'Kampüs', render: (r) => el('a', { href: '#', onclick: (e) => { e.preventDefault(); state.campusId = r.campusId; document.getElementById('campusSelect').value = r.campusId; navigate('stock'); } }, [shortName(r.campusName)]) },
      { label: 'Öğrenci', num: true, value: (r) => fmt.int(r.studentCount) },
      { label: 'Ciro', num: true, value: (r) => fmt.money(r.revenue) },
      { label: 'Günlük Ort.', num: true, value: (r) => fmt.money(r.dailyAverage) },
      { label: 'Öğrenci Başına', num: true, value: (r) => fmt.money(r.revenuePerStudent) },
      { label: 'Alım', num: true, value: (r) => fmt.money(r.purchaseTotal) },
      { label: 'Stok Maliyeti', num: true, value: (r) => fmt.money(r.stock.costValue) },
      { label: 'Kritik Ürün', num: true, render: (r) => r.stock.criticalCount ? badge(String(r.stock.criticalCount), 'warn') : el('span.muted', { text: '0' }) },
      {
        label: 'Son Sayım',
        render: (r) => {
          if (!r.lastCount) return badge('Yapılmadı', 'bad');
          if (r.lastCount.status === 'TASLAK') return badge('Taslak', 'warn');
          return el('span', {}, [fmt.date(r.lastCount.count_date)]);
        },
      },
      { label: 'Sayım Farkı', num: true, render: (r) => (r.lastCount && r.lastCount.difference !== null ? deltaCell(r.lastCount.difference) : el('span.muted', { text: '—' })) },
    ], data.campuses, {
      rowClass: (r) => (r.lastCount?.difference !== null && r.lastCount?.difference < -1 ? 'is-warn' : ''),
    }),
  ], { tight: true }));

  /* --- Ciro dağılımı grafiği --- */
  if (data.campuses.length > 1) {
    root.append(el('div.grid.grid-2', {}, [
      card('Kampüs Cirosu', [barChart(
        [...data.campuses].sort((a, b) => b.revenue - a.revenue).map((c) => ({ label: shortName(c.campusName), value: c.revenue })),
      )]),
      card('Öğrenci Başına Günlük Harcama', [barChart(
        [...data.campuses]
          .map((c) => ({ label: shortName(c.campusName), value: c.schoolDays > 0 && c.studentCount > 0 ? Math.round((c.revenue / c.studentCount / c.schoolDays) * 100) / 100 : 0 }))
          .sort((a, b) => b.value - a.value),
      )], { note: 'Kampüsler arası fiyat/verimlilik farklarını en hızlı bu gösterge ortaya çıkarır.' }),
    ]));
  }

  /* --- Hızlı işlemler --- */
  if (canWrite()) {
    root.append(card('Hızlı İşlemler', [
      el('div.btn-row', {}, [
        el('button.btn.btn-primary', { text: '💰 Günlük Ciro Gir', onclick: () => navigate('revenues') }),
        el('button.btn', { text: '🚚 Mal Girişi Yap', onclick: () => navigate('purchases') }),
        el('button.btn', { text: '🧾 Sayım Başlat', onclick: () => navigate('counts') }),
        el('button.btn', { text: '🗑️ Fire Kaydı', onclick: () => navigate('waste') }),
        el('button.btn', { text: '📈 Raporlar', onclick: () => navigate('reports') }),
      ]),
    ]));
  }
}

