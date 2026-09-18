# VPS Kurulum Rehberi

Ubuntu 22.04 / 24.04 üzerinde adım adım kurulum. Komutları sırayla uygulayın.
Her adımın ne yaptığı kısaca açıklanmıştır; sistem yöneticiniz yoksa da
takip edebilirsiniz.

**Önerilen sunucu:** 2 vCPU / 2 GB RAM / 40 GB SSD yeterlidir. Veritabanı tek
dosyadır ve 5 kampüs × 5 yıllık veri birkaç yüz MB'ı geçmez.

---

## 1. Sunucuyu hazırlayın

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git ufw nginx

# Güvenlik duvarı: yalnızca SSH ve web trafiği
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

Uygulama 3000 portunda çalışır ama bu port **dışarı açılmaz**; nginx önünde
durur. `ufw` bunu zaten engeller.

## 2. Node.js 22 kurun

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v      # v22.5.0 veya üstü görmelisiniz
```

## 3. Uygulama kullanıcısı ve dosyaları

Uygulamayı `root` ile çalıştırmayın; kendi kullanıcısı olsun.

```bash
sudo useradd --system --home /opt/kantin --shell /usr/sbin/nologin kantin
sudo git clone https://github.com/onurcoskun616/kantin.git /opt/kantin
sudo chown -R kantin:kantin /opt/kantin
```

## 4. Ayar dosyasını oluşturun

```bash
cd /opt/kantin
sudo -u kantin cp .env.example .env

# Oturum anahtarı üretin (çıktıyı kopyalayın)
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

sudo -u kantin nano .env
```

`.env` içinde şunları mutlaka değiştirin:

```ini
PORT=3000
HOST=127.0.0.1                 # dışarıdan doğrudan erişilmesin, nginx üzerinden gelsin
DB_PATH=./data/kantin.db
ATTACHMENTS_DIR=./data/ekler      # faturaların PDF/XML dosyaları buraya yazılır
SESSION_SECRET=<yukarıda ürettiğiniz uzun rastgele değer>
SESSION_TTL_HOURS=12
ADMIN_EMAIL=mudur@topkapiokullari.com
ADMIN_PASSWORD=<güçlü bir başlangıç parolası>
ADMIN_NAME=Sistem Yöneticisi
```

Dosyayı yalnızca uygulama kullanıcısı okuyabilsin:

```bash
sudo chmod 600 /opt/kantin/.env
sudo chown kantin:kantin /opt/kantin/.env
```

## 5. Veritabanını oluşturun

```bash
# Gerçek kullanıma geçiş: örnek ürün listesi OLMADAN kurulum
sudo -u kantin node /opt/kantin/server/seed.js --bos
```

Bu komut 5 kampüsü (İkitelli OSB, İstanbul OSB, Esenyurt, Kıraç, Çorlu),
kategorileri ve yönetici hesabını oluşturur. Ürünleri Excel şablonuyla
yükleyeceksiniz.

> Önce sistemi örnek veriyle denemek isterseniz `--bos` yerine `--demo`
> kullanın, sonra `node server/seed.js --reset --bos` ile temizleyin.

## 6. Servis olarak çalıştırın

```bash
sudo cp /opt/kantin/deploy/kantin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kantin

sudo systemctl status kantin        # "active (running)" görmelisiniz
curl -s http://127.0.0.1:3000/api/health
```

Günlükler: `sudo journalctl -u kantin -f`

## 7. nginx ve alan adı

DNS'te `kantin.topkapiokullari.com` gibi bir A kaydını sunucunun IP adresine
yönlendirin, sonra:

```bash
sudo cp /opt/kantin/deploy/nginx-ratelimit.conf /etc/nginx/conf.d/
sudo cp /opt/kantin/deploy/nginx-kantin.conf /etc/nginx/sites-available/kantin

# Dosyadaki server_name satırlarını kendi alan adınızla değiştirin
sudo nano /etc/nginx/sites-available/kantin

sudo ln -s /etc/nginx/sites-available/kantin /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 8. HTTPS sertifikası

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d kantin.topkapiokullari.com
```

certbot sertifikayı kurar, nginx yapılandırmasını günceller ve yenilemeyi
otomatik zamanlar. Kurulum bitince adresi tarayıcıda açın ve `.env` dosyasındaki
yönetici bilgileriyle giriş yapın.

**İlk girişten hemen sonra parolanızı değiştirin** (sol altta "Parola" düğmesi).

## 9. Otomatik yedekleme

```bash
sudo cp /opt/kantin/deploy/kantin-yedek.cron /etc/cron.d/kantin-yedek
sudo chmod 644 /etc/cron.d/kantin-yedek
sudo touch /var/log/kantin-yedek.log && sudo chown kantin:kantin /var/log/kantin-yedek.log

# Hemen bir kez deneyin
sudo -u kantin /opt/kantin/scripts/yedekle.sh
```

Her gece 02:00'de `/opt/kantin/backups` altına sıkıştırılmış yedek alınır ve
son 30 yedek saklanır.

> **Önemli:** Yedeği mutlaka **sunucu dışına** da kopyalayın. Sunucu çökerse
> üzerindeki yedek de gider. `deploy/kantin-yedek.cron` içinde `rclone` ile
> buluta kopyalama satırı hazır; yorum işaretini kaldırıp kullanabilirsiniz.

---

## Güncelleme

```bash
cd /opt/kantin
sudo -u kantin /opt/kantin/scripts/yedekle.sh     # önce yedek
sudo -u kantin git pull
sudo systemctl restart kantin
sudo systemctl status kantin
```

Veritabanı şeması geriye dönük uyumludur; `migrate()` her açılışta eksik
tabloları ekler, mevcut veriye dokunmaz.

## Geri yükleme

```bash
sudo systemctl stop kantin
cd /opt/kantin/data
sudo -u kantin gunzip -c /opt/kantin/backups/kantin-20260101-020000.db.gz > kantin.db
sudo chown kantin:kantin kantin.db
sudo systemctl start kantin
```

---

## Kurulum sonrası kontrol listesi

- [ ] `.env` içindeki `SESSION_SECRET` değiştirildi (varsayılan bırakılmadı)
- [ ] Yönetici parolası ilk girişte değiştirildi
- [ ] `HOST=127.0.0.1` ayarlandı (uygulama doğrudan internete açık değil)
- [ ] HTTPS çalışıyor, `http://` adresi `https://`'e yönleniyor
- [ ] `ufw status` yalnızca SSH ve Nginx'i gösteriyor
- [ ] Yedekleme cron'u kuruldu ve bir kez elle denendi
- [ ] Yedek çıktısında **hem** `kantin-*.db.gz` **hem** `ekler-*.tar.gz` var
      (fatura dosyaları veritabanının içinde değildir)
- [ ] Yedekler ikinci bir konuma kopyalanıyor
- [ ] Her kampüs için kullanıcı açıldı, kimse ortak hesap kullanmıyor
- [ ] Sunucu saati doğru: `timedatectl` çıktısında `Europe/Istanbul`
      (`sudo timedatectl set-timezone Europe/Istanbul`)

## Sorun giderme

| Belirti | Kontrol |
|---|---|
| Sayfa açılmıyor, 502 hatası | `sudo systemctl status kantin` — uygulama çalışıyor mu? |
| "Oturum süresi doldu" döngüsü | `.env` içindeki `SESSION_SECRET` değişti mi? Değişirse tüm oturumlar düşer, yeniden giriş yapın |
| Giriş yapılamıyor | `sudo journalctl -u kantin -n 50` ile günlüğe bakın |
| Excel yüklenmiyor | nginx'te `client_max_body_size` yeterli mi (12M ayarlı) |
| Fatura dosyası yüklenmiyor | Aynı ayar; ayrıca dosya 10 MB'ı aşmamalı ve PDF/JPG/PNG/WEBP/XML olmalı |
| "Dosya sunucuda bulunamadı" | `data/ekler` klasörü yerinde mi, uygulama kullanıcısının yazma hakkı var mı (`ls -la /opt/kantin/data`) |
| Tarih/saat kaymış | Sunucu saat dilimi `Europe/Istanbul` olmalı |
| Disk doldu | `du -sh /opt/kantin/backups` — eski yedekler birikmiş olabilir |
