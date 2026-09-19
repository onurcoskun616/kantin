/**
 * Fatura karekodu (GİB QR) çözümleyicisinin birim testleri.
 *
 * `public/js/karekod.js` tarayıcı için yazıldı ama çözümleme ve
 * karşılaştırma kısmı saf JavaScript'tir; bu yüzden Node içinde doğrudan
 * sınanabilir. Tarayıcıya bağımlı kısımlar (kamera, BarcodeDetector)
 * ayrı dosyadadır ve burada çağrılmaz.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKarekod, compareWithLines, parseMoney, parseDate } from '../public/js/karekod.js';

/** GİB'in yayımladığı alan adlarıyla örnek bir karekod içeriği. */
function ornekQr(extra = {}) {
  return JSON.stringify({
    vkntckn: '1234567890',
    avkntckn: '9876543210',
    senaryo: 'TEMELFATURA',
    tip: 'SATIS',
    tarih: '2026-09-15',
    no: 'GIB2026000000123',
    ettn: '8f14e45f-ceea-4d29-9a1b-7c3d2e5a9b01',
    malhizmettoplam: 1000.0,
    'kdvmatrah(1)': 0,
    'hesaplanankdv(1)': 0,
    'kdvmatrah(10)': 400.0,
    'hesaplanankdv(10)': 40.0,
    'kdvmatrah(20)': 600.0,
    'hesaplanankdv(20)': 120.0,
    vergidahil: 1160.0,
    odenecek: 1160.0,
    ...extra,
  });
}

test('tutar biçimleri: nokta, virgül ve binlik ayracı', () => {
  assert.equal(parseMoney(1180.5), 1180.5);
  assert.equal(parseMoney('1180.50'), 1180.5);
  assert.equal(parseMoney('1180,50'), 1180.5);
  assert.equal(parseMoney('1.180,50'), 1180.5);
  assert.equal(parseMoney('1,180.50'), 1180.5);
  assert.equal(parseMoney('1.180.500'), 1180500);
  assert.equal(parseMoney('1180,50 TL'), 1180.5);
  assert.equal(parseMoney(''), null);
  assert.equal(parseMoney('abc'), null);
});

test('tarih biçimleri ISO"ya çevrilir', () => {
  assert.equal(parseDate('2026-09-15'), '2026-09-15');
  assert.equal(parseDate('15.09.2026'), '2026-09-15');
  assert.equal(parseDate('15/9/2026'), '2026-09-15');
  assert.equal(parseDate(''), '');
  assert.equal(parseDate('anlamsiz'), '');
});

test('standart GİB karekodu okunur', () => {
  const qr = parseKarekod(ornekQr());
  assert.equal(qr.taxNo, '1234567890');
  assert.equal(qr.buyerTaxNo, '9876543210');
  assert.equal(qr.documentNo, 'GIB2026000000123');
  assert.equal(qr.issueDate, '2026-09-15');
  assert.equal(qr.uuid, '8f14e45f-ceea-4d29-9a1b-7c3d2e5a9b01');
  assert.equal(qr.scenario, 'TEMELFATURA');
  assert.equal(qr.payable, 1160);
  // Sifir olan %1 satiri gosterilmez
  assert.deepEqual(qr.vatByRate, [
    { rate: 10, base: 400, tax: 40 },
    { rate: 20, base: 600, tax: 120 },
  ]);
  assert.deepEqual(qr.computed, { base: 1000, tax: 160, gross: 1160 });
  assert.deepEqual(qr.warnings, []);
});

test('Türkçe sayı yazan ve parantezsiz oran kullanan entegratör de okunur', () => {
  const qr = parseKarekod(JSON.stringify({
    VKNTCKN: '1234567890',
    BelgeNo: 'ABC2026000000001',
    BelgeTarihi: '15.09.2026',
    ETTN: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    MalHizmetToplam: '1.000,00',
    KDVMatrah20: '1.000,00',
    HesaplananKDV20: '200,00',
    Odenecek: '1.200,00',
  }));
  assert.equal(qr.documentNo, 'ABC2026000000001');
  assert.equal(qr.issueDate, '2026-09-15');
  assert.deepEqual(qr.vatByRate, [{ rate: 20, base: 1000, tax: 200 }]);
  assert.equal(qr.payable, 1200);
});

test('ödenecek yoksa vergi dahil tutara düşülür', () => {
  const raw = JSON.parse(ornekQr());
  delete raw.odenecek;
  const qr = parseKarekod(JSON.stringify(raw));
  assert.equal(qr.payable, 1160);
});

test('mal/hizmet toplamı matrahlarla tutmuyorsa uyarır', () => {
  const qr = parseKarekod(ornekQr({ malhizmettoplam: 1250.0 }));
  assert.equal(qr.warnings.length, 1);
  assert.match(qr.warnings[0], /1250\.00/);
});

test('URL biçimli karekod: sorgu parametreleri okunur', () => {
  const qr = parseKarekod(
    'https://ornek.entegrator.com/sorgula?vkntckn=1234567890&no=XYZ2026000000009'
    + '&tarih=15.09.2026&ettn=11111111-2222-3333-4444-555555555555'
  );
  assert.equal(qr.taxNo, '1234567890');
  assert.equal(qr.documentNo, 'XYZ2026000000009');
  assert.equal(qr.issueDate, '2026-09-15');
});

test('fatura karekodu olmayan içerik açık bir hatayla reddedilir', () => {
  assert.throws(() => parseKarekod('https://www.ornek.com.tr/kampanya'), /tanınamadı/);
  assert.throws(() => parseKarekod(''), /boş/);
  // Alan sozlugu cikiyor ama fatura kimligi yok
  assert.throws(
    () => parseKarekod(JSON.stringify({ urun: 'Su', adet: '5' })),
    /fatura bilgisi içermiyor/
  );
});

test('tanınamayan içerikte ham metin hataya eklenir', () => {
  try {
    parseKarekod('sadece duz bir yazi');
    assert.fail('hata bekleniyordu');
  } catch (err) {
    assert.equal(err.raw, 'sadece duz bir yazi');
  }
});

test('doğru girilen satırlar farksız çıkar', () => {
  const qr = parseKarekod(ornekQr());
  const rep = compareWithLines(qr, [
    { vatRate: 10, net: 400, vat: 40 },
    { vatRate: 20, net: 600, vat: 120 },
  ]);
  assert.equal(rep.ok, true);
  assert.deepEqual(rep.issues, []);
  assert.equal(rep.enteredGross, 1160);
  assert.equal(rep.invoiceGross, 1160);
});

test('eksik yazılan miktar oran bazında yakalanır', () => {
  const qr = parseKarekod(ornekQr());
  const rep = compareWithLines(qr, [
    { vatRate: 10, net: 400, vat: 40 },
    { vatRate: 20, net: 560, vat: 112 },
  ]);
  assert.equal(rep.ok, false);
  assert.equal(rep.issues.length, 3);           // matrah, KDV ve genel toplam
  assert.match(rep.issues[0], /%20 matrah.*600\.00.*560\.00.*-40\.00/);
  assert.match(rep.issues[2], /Genel toplam/);
});

test('faturada olmayan KDV oranı ayrıca bildirilir', () => {
  const qr = parseKarekod(ornekQr());
  const rep = compareWithLines(qr, [
    { vatRate: 10, net: 400, vat: 40 },
    { vatRate: 20, net: 600, vat: 120 },
    { vatRate: 1, net: 50, vat: 0.5 },
  ]);
  assert.equal(rep.ok, false);
  assert.ok(rep.issues.some((i) => /Faturada %1 KDV'li kalem yok/.test(i)));
});

test('yanlış KDV oranı seçilmesi iki oranda birden fark üretir', () => {
  const qr = parseKarekod(ornekQr());
  // %10"luk kalemler yanlislikla %20 ile girilmis
  const rep = compareWithLines(qr, [{ vatRate: 20, net: 1000, vat: 200 }]);
  assert.equal(rep.ok, false);
  assert.ok(rep.issues.some((i) => i.startsWith('%10 matrah')));
  assert.ok(rep.issues.some((i) => i.startsWith('%20 matrah')));
});

test('bir kuruşluk yuvarlama farkı uyarı üretmez', () => {
  const qr = parseKarekod(ornekQr());
  const rep = compareWithLines(qr, [
    { vatRate: 10, net: 400.02, vat: 40 },
    { vatRate: 20, net: 600, vat: 119.98 },
  ]);
  assert.equal(rep.ok, true);
});

test('hiç satır girilmemişken karşılaştırma faturanın tamamını fark gösterir', () => {
  const qr = parseKarekod(ornekQr());
  const rep = compareWithLines(qr, []);
  assert.equal(rep.ok, false);
  assert.equal(rep.enteredGross, 0);
  assert.ok(rep.issues.some((i) => /Genel toplam: faturada 1160\.00, girilen 0\.00/.test(i)));
});
