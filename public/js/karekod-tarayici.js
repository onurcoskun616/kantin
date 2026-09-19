/**
 * KAREKOD OKUMA PENCERESİ
 *
 * `karekod.js` çözümlemeyi yapar; burası yalnızca kullanıcı arayüzüdür.
 * Ayrı dosyada durmasının sebebi `karekod.js`'in tarayıcıya bağımlı
 * olmadan (Node içinde) sınanabilmesidir.
 *
 * Üç yol sunulur, çünkü tek yol her yerde çalışmaz:
 *   1. Kamera       — masaüstü webcam veya telefon arka kamerası
 *   2. Fotoğraf     — çekilmiş resim ya da ekran görüntüsü dosyası
 *   3. Elle yapıştırma — karekod okumayı desteklemeyen tarayıcılar için
 *      (Safari/Firefox). iPhone'da Kamera uygulaması karekodu okuyup metni
 *      kopyalayabildiği için bu yol gerçekten işe yarar.
 */
import { el, modal, alertBox } from './ui.js';
import { qrSupported, readQrFromImageFile, scanWithCamera } from './karekod.js';

const DESTEK_YOK =
  'Bu tarayıcı karekod okumayı desteklemiyor (Firefox ve Safari desteklemez). '
  + 'Chrome veya Edge ile açabilir ya da aşağıdaki kutuya karekod metnini '
  + 'yapıştırabilirsiniz. iPhone\'da Kamera uygulamasıyla karekodu okutup '
  + 'çıkan metni kopyalayabilirsiniz.';

/**
 * Karekod okuma penceresini açar.
 * @returns {Promise<string|null>} okunan ham metin, vazgeçilirse null
 */
export function openKarekodScanner() {
  return new Promise((resolve) => {
    let settled = false;
    let camera = null;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      camera?.stop();
      camera = null;
      m.close();
      resolve(value ?? null);
    };

    const durum = el('div');
    const video = el('video', {
      style: 'display:none;width:100%;max-height:320px;background:#000;border-radius:8px',
      playsinline: '', muted: true,
    });

    const fileInput = el('input', {
      type: 'file',
      accept: 'image/*',
      // capture yok: kullanıcı hem galeriden hem kameradan seçebilsin
      style: 'display:none',
    });

    const kameraBtn = el('button.btn', { text: '📷 Kamerayı Aç' });
    const dosyaBtn = el('button.btn', { text: '🖼️ Fotoğraf / Ekran Görüntüsü Seç', onclick: () => fileInput.click() });

    const metinKutusu = el('textarea', {
      rows: '4',
      placeholder: '{"vkntckn":"...","no":"...","ettn":"..."}',
      style: 'width:100%;font-family:monospace;font-size:12px',
    });
    const metinBtn = el('button.btn.btn-sm', {
      text: 'Bu metni kullan',
      onclick: () => {
        const t = metinKutusu.value.trim();
        if (!t) { bilgi('warning', 'Kutu boş', 'Karekod metnini yapıştırın.'); return; }
        finish(t);
      },
    });

    const bilgi = (kind, title, message) => durum.replaceChildren(alertBox(kind, title, message));

    /* ----------------------------- kamera ---------------------------- */
    let kameraAcik = false;
    kameraBtn.addEventListener('click', async () => {
      if (kameraAcik) { camera?.stop(); return; }   // "Kamerayı Kapat"
      kameraAcik = true;
      kameraBtn.textContent = '⏹ Kamerayı Kapat';
      video.style.display = 'block';
      bilgi('info', 'Kamera açık', 'Karekodu çerçeveye alın; okunduğu anda pencere kapanır.');

      camera = scanWithCamera(video);
      const { text, error } = await camera.promise;
      camera = null;
      kameraAcik = false;
      video.style.display = 'none';
      kameraBtn.textContent = '📷 Kamerayı Aç';

      if (settled) return;
      if (text) { finish(text); return; }
      if (error) {
        bilgi('danger', 'Kamera açılamadı',
          `${error.message} Fotoğraf seçerek ya da metni yapıştırarak devam edebilirsiniz.`);
      } else {
        bilgi('info', 'Kamera kapatıldı', 'İsterseniz tekrar açabilir veya fotoğraf seçebilirsiniz.');
      }
    });

    /* ---------------------------- fotoğraf --------------------------- */
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      dosyaBtn.disabled = true;
      bilgi('info', 'Okunuyor', `${file.name} taranıyor...`);
      try {
        const text = await readQrFromImageFile(file);
        if (text) { finish(text); return; }
        bilgi('warning', 'Karekod bulunamadı',
          'Görüntüde karekod okunamadı. Karekodu daha yakından, düz ve net çekin; '
          + 'gölge ya da parlama olmasın. PDF ise karekodun ekran görüntüsünü alın.');
      } catch (err) {
        bilgi('danger', 'Okunamadı', err.message);
      } finally {
        fileInput.value = '';
        dosyaBtn.disabled = false;
      }
    });

    /* ----------------------------- pencere --------------------------- */
    const destek = qrSupported();
    if (!destek) {
      kameraBtn.disabled = true;
      dosyaBtn.disabled = true;
      durum.replaceChildren(alertBox('warning', 'Karekod okuma bu tarayıcıda yok', DESTEK_YOK));
    }

    const m = modal({
      title: 'Fatura Karekodunu Okut',
      body: [
        el('p.card-note', {
          text: 'Karekod faturanın başlık bilgilerini (tedarikçi, belge no, tarih, ETTN) ve '
            + 'toplamlarını taşır. Ürün satırları karekodda YOKTUR; satırları siz girersiniz, '
            + 'sistem de girdiklerinizi faturanın toplamlarıyla karşılaştırır.',
        }),
        destek ? el('div.btn-row', {}, [kameraBtn, dosyaBtn, fileInput]) : el('div', {}, [fileInput]),
        video,
        durum,
        el('details', {}, [
          el('summary', { text: 'Karekod metnini elle yapıştır', style: 'cursor:pointer;margin:8px 0' }),
          el('p.card-note', {
            text: 'Telefonunuzun kamera uygulamasıyla karekodu okutup çıkan metni buraya yapıştırabilirsiniz.',
          }),
          metinKutusu,
          el('div.btn-row', {}, [metinBtn]),
        ]),
      ],
      actions: [el('button.btn', { text: 'Vazgeç', onclick: () => finish(null) })],
      onClose: () => finish(null),
    });

    if (!destek) m.box.querySelector('details')?.setAttribute('open', '');
  });
}
