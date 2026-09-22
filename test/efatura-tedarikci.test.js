/**
 * e-Fatura tedarikci eslestirmesinin birim testleri.
 *
 * `public/js/efatura.js` tarayici icin yazildi ama eslestirme kismi saf
 * JavaScript'tir; Node icinde dogrudan sinanabilir.
 *
 * Sinanan kural: XML yuklenince tedarikci ONCE VKN ile, VKN tutmazsa unvan
 * ile bulunur. Her seferinde elle secmek gerekmez.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { matchSupplier } from '../public/js/efatura.js';

const KAYITLI = [
  { id: 1, name: 'Anadolu Gıda Sanayi A.Ş.', tax_no: '1234567890' },
  { id: 2, name: 'Çorlu İçecek Ltd. Şti.', tax_no: '9876543210' },
  { id: 3, name: 'Vergisiz Firma', tax_no: '' },
];

test('VKN tutuyorsa tedarikci kendiliginden secilir', () => {
  const r = matchSupplier({ taxNo: '9876543210', name: 'BAMBASKA BIR UNVAN' }, KAYITLI);
  assert.equal(r.supplier.id, 2);
  assert.equal(r.matchedBy, 'VKN');
});

test('VKN unvandan ONCE gelir: unvan degisse bile dogru karta baglanir', () => {
  // Firma unvan degistirdi, VKN ayni. Unvana bakilsa eslesmezdi.
  const r = matchSupplier({ taxNo: '1234567890', name: 'Anadolu Gıda Holding A.Ş.' }, KAYITLI);
  assert.equal(r.supplier.id, 1);
  assert.equal(r.matchedBy, 'VKN');
});

test('VKN bicim farklari eslesmeyi bozmaz', () => {
  // Kartta bosluklu/tireli yazilmis eski bir kayit olabilir; fatura duz yazar.
  const kartlar = [{ id: 9, name: 'Eski Kayıt', tax_no: '123 456-78.90' }];
  const r = matchSupplier({ taxNo: '1234567890', name: 'Farklı' }, kartlar);
  assert.equal(r.supplier.id, 9, 'bosluk/tire yuzunden eslesmezse kullanici cikissiz kalir');
  assert.equal(r.matchedBy, 'VKN');
});

test('VKN yoksa unvandan eslesir (Turkce harf ve noktalama onemsiz)', () => {
  const r = matchSupplier({ taxNo: '', name: 'CORLU ICECEK LTD STI' }, KAYITLI);
  assert.equal(r.supplier.id, 2);
  assert.equal(r.matchedBy, 'unvan');
});

test('VKN tutmuyorsa unvana DUSULUR', () => {
  // Faturadaki VKN sistemde yok ama unvan birebir ayni.
  const r = matchSupplier({ taxNo: '5555555555', name: 'Anadolu Gıda Sanayi A.Ş.' }, KAYITLI);
  assert.equal(r.supplier.id, 1);
  assert.equal(r.matchedBy, 'unvan');
});

test('hicbiri tutmazsa eslesme YOK: kullanici secer ya da yeni kart acar', () => {
  const r = matchSupplier({ taxNo: '5555555555', name: 'Hiç Tanımlanmamış Firma' }, KAYITLI);
  assert.equal(r.supplier, null);
  assert.equal(r.matchedBy, null);
});

test('VKN"si bos kartlar bos VKN ile eslesmez', () => {
  // "Vergisiz Firma"nin tax_no alani bos; faturada da VKN yoksa bu ikisi
  // "ikisi de bos" diye eslesmemeli, yoksa rastgele bir karta baglanir.
  const r = matchSupplier({ taxNo: '', name: 'Bambaşka Firma' }, KAYITLI);
  assert.equal(r.supplier, null);
});
