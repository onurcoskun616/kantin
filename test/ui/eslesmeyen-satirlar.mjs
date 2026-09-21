/**
 * Arayuz regresyon testi: faturada olup kayda alinmayan satirlar.
 *
 * Kontrol edilen zincir:
 *   e-Fatura XML aktarilir -> eslesmeyen kalem SILINIR -> belge kaydedilir ->
 *   silinen kalem iz birakir ("kayda alinmadi" bildirimi) -> alim sayfasinda
 *   uyari paneli acilir -> kalem urun secilmeden belgeye baglanamaz ->
 *   sebep yazilmadan yok sayilamaz -> sebep yazilinca panelden duser.
 *
 * Gereksinim: Playwright (global kurulum yeterli)
 * Kullanim:
 *   node server/seed.js --reset --demo
 *   node server/index.js &
 *   node test/ui/eslesmeyen-satirlar.mjs [http://127.0.0.1:3000]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const BASE = process.argv[2] || 'http://127.0.0.1:3000';
const RUN=Date.now().toString(36).slice(-5).toUpperCase();
const b=await chromium.launch(); const p=await (await b.newContext({viewport:{width:1500,height:1050}})).newPage();
p.on('pageerror',e=>console.log('PAGEERROR',e.message));
p.on('console',m=>{if(m.type()==='error'&&!/40\d|409/.test(m.text()))console.log('CONSOLE',m.text().slice(0,150));});
const problems=[]; const ok=(l,c,d='')=>{if(c)console.log('  ✓ '+l);else{console.log('  ✗ '+l+(d?' — '+String(d).slice(0,200):''));problems.push(l);}};

console.log('\n1) Kayda alinmayan kalem iz birakir');
await p.goto(BASE,{waitUntil:'networkidle'});
await p.fill('input[name=email]','admin@topkapiokullari.com');await p.fill('input[name=password]','Kantin2026!');
await p.click('button[type=submit]');await p.waitForSelector('#app:not([hidden])');await p.waitForTimeout(1500);

// XML aktarimi: eslesmeyen kalemi SIL, kaydet
const fs=await import('node:fs'); const os=await import('node:os'); const path=await import('node:path');
const SAMPLE = new URL('../../docs/sablonlar/ornek-efatura.xml', import.meta.url).pathname;
const xml = fs.readFileSync(SAMPLE, 'utf8')
  .replace('<cbc:ID>GIB2026000000123</cbc:ID>', `<cbc:ID>ESL${RUN}</cbc:ID>`)
  .replace('8f14e45f-ceea-4d29-9a1b-7c3d2e5a9b01', `8f14e45f-ceea-4d29-9a1b-${RUN.toLowerCase().padEnd(12,'0')}`);
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kantin-esl-')); const XML=path.join(dir,'f.xml');
fs.writeFileSync(XML,xml);

await p.evaluate(async (vkn)=>{const t=localStorage.getItem('kantin_token');
  const h={'Content-Type':'application/json',Authorization:`Bearer ${t}`};
  const list=(await (await fetch('/api/suppliers',{headers:h})).json()).items;
  if(list.some(x=>String(x.tax_no).trim()===vkn)) return;
  const s=list[0];
  await fetch(`/api/suppliers/${s.id}`,{method:'PUT',headers:h,body:JSON.stringify({name:s.name,taxNo:vkn,taxOffice:'X',phone:s.phone})});
},'1234567890');

await p.evaluate(()=>{location.hash='#/purchases';}); await p.waitForTimeout(2000);
await p.click('button:has-text("+ Yeni Mal Girişi")'); await p.waitForSelector('.modal-backdrop');
await p.setInputFiles('.modal input[type=file][accept*="xml"]', XML); await p.waitForTimeout(1500);
ok('3 satir aktarildi', (await p.$$('.modal .line-table tbody tr')).length===3);
// 3. satir eslesmeyen (Kagit Havlu) -> sil
await p.click('.modal .line-table tbody tr:nth-child(3) .icon-btn'); await p.waitForTimeout(400);
await p.click('.modal-foot .btn-primary'); await p.waitForTimeout(2500);
// Kaydetme sonrasi "alis fiyati artti" penceresi acilmis olabilir
for (let i=0;i<4 && (await p.$$('.modal-backdrop')).length;i++){
  await p.click('.modal-backdrop:last-of-type .modal-head .icon-btn').catch(()=>{});
  await p.waitForTimeout(300);
}
const toastText = await p.textContent('.toasts').catch(()=>'');
ok('Kayda alinmayan kalem bildirildi', /kayda alınmadı/.test(toastText), toastText.slice(0,200));

await p.evaluate(()=>{location.hash='#/purchases';}); await p.waitForTimeout(2200);
// Diger testler de kalem birakmis olabilir: KENDI belgemizin satirina bakariz.
// Panel, basligindan bulunur; alim listesi tablosuyla karistirilmamali.
const kendiSatirim = async () => p.evaluate((no) => {
  const kart = [...document.querySelectorAll('.card')]
    .find((c) => c.querySelector('.card-head h3')?.textContent.includes('Eşleşmeyen'));
  if (!kart) return [];
  return [...kart.querySelectorAll('tbody tr')]
    .map((n) => n.textContent).filter((t) => t.includes(no));
}, `ESL${RUN}`);
const sayfa = await p.textContent('#pageContent');
ok('Uyari paneli acildi', /Eşleşmeyen Fatura Satırları/.test(sayfa), sayfa.slice(0,150));
const bizim = await kendiSatirim();
ok('Kendi kalemimiz listede', bizim.length===1, JSON.stringify(bizim));
ok('Faturadaki ad gosteriliyor', /Kağıt Havlu/.test(bizim[0]||''), bizim[0]||'');

console.log('\n2) Kalemi sonuclandirma');
// Kendi satirimizin "Sonuclandir" dugmesi (baska testlerin kalemleri de olabilir)
await p.click(`.card table.data tbody tr:has-text("ESL${RUN}") button:has-text("Sonuçlandır")`);
await p.waitForSelector('.modal-backdrop'); await p.waitForTimeout(1200);
const pen = await p.textContent('.modal-body');
ok('Faturadaki bilgiler gosteriliyor', /Kağıt Havlu/.test(pen), pen.slice(0,200));
ok('Iki yol anlatiliyor', /İki yoldan biri/.test(pen));
await p.click('.modal-foot .btn-primary'); await p.waitForTimeout(700);
let h=await p.textContent('.modal .alert-danger').catch(()=>'');
ok('Urun secilmeden baglanamaz', /Önce bir ürün seçin/.test(h), h.slice(0,120));
await p.click('.modal-foot button:has-text("Yok Say")'); await p.waitForTimeout(600);
h=await p.textContent('.modal .alert-danger').catch(()=>'');
ok('Sebep yazilmadan yok sayilamaz', /sebep yazmalısınız/.test(h), h.slice(0,120));
await p.fill('.modal input[placeholder*="nakliye"]','Kantinde satılmıyor, temizlik malzemesi.');
await p.click('.modal-foot button:has-text("Yok Say")'); await p.waitForTimeout(2200);
const kalan = await kendiSatirim();
ok('Yok sayilan kalem panelden dustu', kalan.length===0, JSON.stringify(kalan));
await b.close();
fs.rmSync(dir,{recursive:true,force:true});
console.log(problems.length?`\n${problems.length} kontrol basarisiz.\n`:'\nTum kontroller gecti.\n');
process.exit(problems.length?1:0);
