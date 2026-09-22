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
sudo git clone -b main https://github.com/onurcoskun616/kantin.git /opt/kantin
sudo chown -R kantin:kantin /opt/kantin
```

> Depo şu an **herkese açık**, bu yüzden sunucuda parola sorulmadan
> klonlanır. Kaynak kodda parola/gizli bilgi yoktur — hepsi `.env` içinde ve
> `.env` depoya girmez.
>
> **Depoyu ileride özel yaparsanız** `git clone` sunucuda parola sorup
> başarısız olur. O durumda deploy key kullanın:
>
> ```bash
> sudo -u kantin ssh-keygen -t ed25519 -f /opt/kantin/.ssh/id_ed25519 -N ""
> sudo cat /opt/kantin/.ssh/id_ed25519.pub
> ```
>
> Çıktıyı GitHub'da **Settings → Deploy keys → Add deploy key** ile ekleyin
> (yazma izni gerekmez), sonra SSH adresiyle klonlayın:
> `git clone git@github.com:onurcoskun616/kantin.git /opt/kantin`
>
> Sunucu **`main`** dalını takip eder. Geliştirme ayrı dallarda yapılır ve
> hazır olduğunda `main`'e alınır; böylece yarım kalmış bir iş üretime
> yansımaz.

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
# Uygulama doğrudan internete açılmasın, nginx önünde dursun
HOST=127.0.0.1
DB_PATH=./data/kantin.db
# Faturaların PDF / foto / XML dosyaları (veritabanının içinde değildir)
ATTACHMENTS_DIR=./data/ekler
SESSION_SECRET=<yukarıda ürettiğiniz uzun rastgele değer>
SESSION_TTL_HOURS=12
ADMIN_EMAIL=mudur@topkapiokullari.com
ADMIN_PASSWORD=<güçlü bir başlangıç parolası>
ADMIN_NAME=Sistem Yöneticisi
```

> ⚠️ **Satır içi yorum kullanmayın.** `.env` dosyasında
> `HOST=127.0.0.1   # nginx arkasında` yazarsanız hem systemd hem uygulama
> `#` sonrasını **değerin parçası** sayar ve sunucu
> `getaddrinfo ENOTFOUND` hatasıyla başlamaz. Açıklamayı her zaman kendi
> satırına yazın (yukarıdaki gibi). Uygulama bu hatayı yakalarsa ne olduğunu
> açıkça söyleyerek durur.

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

Yedek dizinini önceden oluşturun (servis yalnızca `data/` ve `backups/`
altına yazabilecek şekilde kısıtlanmıştır):

```bash
sudo -u kantin mkdir -p /opt/kantin/backups
```

```bash
sudo cp /opt/kantin/deploy/kantin.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kantin

sudo systemctl status kantin        # "active (running)" görmelisiniz
curl -s http://127.0.0.1:3000/api/health
```

Günlükler: `sudo journalctl -u kantin -f`

## 7. nginx ve alan adı

DNS'te `kantin.topkapikoleji.org` gibi bir A kaydını sunucunun IP adresine
yönlendirin, sonra:

```bash
sudo cp /opt/kantin/deploy/nginx-ratelimit.conf /etc/nginx/conf.d/
sudo cp /opt/kantin/deploy/nginx-kantin.conf /etc/nginx/sites-available/kantin

# Dosyada alan adı kantin.topkapikoleji.org olarak hazır gelir.
# Başka bir adres kullanacaksanız server_name satırlarını değiştirin:
# sudo nano /etc/nginx/sites-available/kantin

sudo ln -s /etc/nginx/sites-available/kantin /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 8. HTTPS sertifikası

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d kantin.topkapikoleji.org
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

## 10. Kurulumu doğrulayın

Her şeyin yerli yerinde olduğunu tek komutla görün:

```bash
sudo /opt/kantin/scripts/kontrol.sh
```

Betik sırayla şunları denetler ve sorun bulursa **çözüm komutunu da yazar**:

| Ne kontrol edilir |
|---|
| `.env` var mı, izni 600 mü, **satır içi yorum var mı** |
| `SESSION_SECRET` değiştirilmiş mi, yeterince uzun mu |
| `HOST=127.0.0.1` mi (uygulama doğrudan internete açık değil) |
| Veritabanı, fatura eki ve yedek dizinleri var mı, sahibi doğru mu |
| Servis çalışıyor ve açılışta başlıyor mu |
| `/api/health` yanıt veriyor mu |
| Yedekleme cron'u kurulu mu, son yedek ne kadar eski, **ekler yedeği var mı** |
| `ufw` etkin mi, uygulama portu dışarı kapalı mı |
| nginx yapılandırması geçerli mi |
| HTTPS sertifikası kaç gün geçerli |
| Saat dilimi `Europe/Istanbul` mu |

Çıkış kodu 0 ise sorun yoktur. Bu betiği güncellemelerden ve geri
yüklemelerden sonra da çalıştırın.

---

## Güncelleme

```bash
cd /opt/kantin
sudo -u kantin /opt/kantin/scripts/yedekle.sh     # önce yedek
sudo -u kantin git pull origin main
sudo systemctl restart kantin
sudo /opt/kantin/scripts/kontrol.sh               # her şey yolunda mı?
```

Veritabanı şeması geriye dönük uyumludur; `migrate()` her açılışta eksik
tabloları ekler, mevcut veriye dokunmaz.

## Geri yükleme

**İki parça birlikte geri yüklenir:** veritabanı ve fatura dosyaları. Yalnızca
veritabanını geri yüklerseniz kayıtlar döner ama faturaların kendisi açılmaz
("Dosya sunucuda bulunamadı" hatası verir).

```bash
sudo systemctl stop kantin

# 1) Veritabanı
cd /opt/kantin/data
sudo -u kantin gunzip -c /opt/kantin/backups/kantin-20260101-020000.db.gz > kantin.db

# 2) Fatura dosyaları (aynı tarihli yedeği seçin)
sudo -u kantin tar -xzf /opt/kantin/backups/ekler-20260101-020000.tar.gz -C /opt/kantin/data

sudo chown -R kantin:kantin /opt/kantin/data
sudo systemctl start kantin
sudo /opt/kantin/scripts/kontrol.sh
```

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
- [ ] `sudo /opt/kantin/scripts/kontrol.sh` sorunsuz geçiyor

## Sorun giderme

| Belirti | Kontrol |
|---|---|
| Sayfa açılmıyor, 502 hatası | `sudo systemctl status kantin` — uygulama çalışıyor mu? |
| Servis başlamıyor, `getaddrinfo ENOTFOUND` | `.env` içinde satır içi yorum vardır (`HOST=127.0.0.1  # ...`). Açıklamayı kendi satırına alın |
| Servis başlamıyor, `status=226/NAMESPACE` | `/opt/kantin/backups` dizini yok: `sudo -u kantin mkdir -p /opt/kantin/backups` |
| Neyin bozuk olduğunu bulamıyorum | `sudo /opt/kantin/scripts/kontrol.sh` — sorunu ve çözüm komutunu yazar |
| "Oturum süresi doldu" döngüsü | `.env` içindeki `SESSION_SECRET` değişti mi? Değişirse tüm oturumlar düşer, yeniden giriş yapın |
| Giriş yapılamıyor | `sudo journalctl -u kantin -n 50` ile günlüğe bakın |
| Excel yüklenmiyor | nginx'te `client_max_body_size` yeterli mi (12M ayarlı) |
| Fatura dosyası yüklenmiyor | Aynı ayar; ayrıca dosya 10 MB'ı aşmamalı ve PDF/JPG/PNG/WEBP/XML olmalı |
| "Dosya sunucuda bulunamadı" | `data/ekler` klasörü yerinde mi, uygulama kullanıcısının yazma hakkı var mı (`ls -la /opt/kantin/data`) |
| Tarih/saat kaymış | Sunucu saat dilimi `Europe/Istanbul` olmalı |
| Disk doldu | `du -sh /opt/kantin/backups` — eski yedekler birikmiş olabilir |

---

## Yavaşlık teşhisi

"Sistem yavaş" şikâyeti ölçülmeden çözülemez: geçen süre sunucuda mı, ağda
mı, tarayıcıda mı belli olmaz. Sistem bunu kendisi ayırır.

### 1. Sistem Durumu ekranı

**Yönetim → Sistem Durumu** (yalnızca admin ve genel müdürlük görür)

| Ölçüm | Ne anlama gelir | İyi değer |
|---|---|---|
| **Gidiş-Dönüş** | Tarayıcıdan sunucuya ve geri | < 300 ms |
| **Ağ / Vekil** | Bu sürenin sunucuda geçmeyen kısmı | < 300 ms |
| **Veritabanı Yazma** | Bir kaydın diske yazılması | < 20 ms |
| **Disk (fsync)** | Sunucu diskinin yazma gecikmesi | < 20 ms |

Ekran rakamları ayrıca **tek cümleyle yorumlar** — sizin yorumlamanız
gerekmez.

Altta **bu oturumdaki en yavaş istekler** listelenir. "Sunucu" sütunu
sunucunun kendi işleme süresidir:

- Toplam büyük, **sunucu küçük** → gecikme ağda ya da vekil sunucuda
  (Caddy/CDN/internet). Uygulamada değil.
- **Sunucu da büyük** → sunucu tarafında bir sorun var; aşağıya bakın.

### 2. Sunucu günlüğünde yavaş istekler

Eşiği (varsayılan 400 ms) aşan her istek günlüğe tek satır düşer:

```
[YAVAS] 1840 ms  PUT /api/products/12 -> 200
```

Bakmak için:

```bash
sudo docker compose -f /opt/kantin-uygulama/docker-compose.yml logs --tail=200 | grep YAVAS
```

Eşiği değiştirmek için `.env` dosyasına: `SLOW_REQUEST_MS=200` (0 = kapalı).

### 3. Tarayıcının kendi ölçümü

Her yanıtta `Server-Timing: app;dur=...` başlığı gider. Tarayıcının **Ağ**
sekmesinde isteğin yanında sunucunun kaç ms harcadığı görünür. Toplam 2 sn,
sunucu 4 ms ise sorun uygulamada değildir.

### Sık çıkan sebepler

| Belirti | Sebep | Çözüm |
|---|---|---|
| **Disk (fsync) > 100 ms** | Sağlayıcının diski yavaş ya da dolu | Disk doluluğunu kontrol edin (`df -h`); sağlayıcıya başvurun |
| **Çalışma süresi sürekli küçük** | Konteyner yeniden başlıyor | `docker compose logs` ile çökme sebebine bakın |
| **Bellek (RSS) sürekli artıyor** | Bellek sınırı dar | Konteyner bellek limitini yükseltin |
| **Ağ > 1 sn, sunucu hızlı** | İnternet bağlantısı ya da vekil | Vekil sunucu ayarları; başka bir bağlantıdan deneyin |

### Zaman aşımı

İstekler **25 saniye** yanıtsız kalırsa artık sonsuza kadar beklemez;
açık bir uyarı çıkar ve kaydın oluşup oluşmadığını kontrol etmeniz söylenir.
Eskiden "Kaydediliyor..." yazısı hiç değişmezdi ve kullanıcı çoğu zaman
ikinci kez kaydederdi.


---

## Sürüm ve güncelleme bildirimi

**Yönetim → Sistem Durumu → Sürüm**

Ekran çalışan sürümü gösterir ve GitHub'daki `main` dalıyla karşılaştırır.
Geride kalınmışsa **bekleyen değişiklikleri tek tek listeler** ve
çalıştırılacak komutu kopyalanabilir biçimde verir.

### Uygulama neden kendi kendini güncellemiyor?

Bir konteynerin kendi imajını yeniden kurabilmesi için **Docker soketine**
erişmesi gerekir. Docker soketi host üzerinde root yetkisine denktir:
uygulamada bulunacak herhangi bir açık, o anda sunucunun tamamını ele
geçirmeye dönüşür. Kantin uygulaması internete açık ve birden çok rolün
giriş yaptığı bir uygulamadır; bu riski almaya değmez.

Ayrıca konteyner kendini yeniden başlatırken kendi isteğini keser —
"güncelleniyor" ekranı hiçbir zaman sonuçlanmaz.

Bu yüzden sistem **haber verir, uygulamaz**. Güncellemeyi sunucuda siz
çalıştırırsınız:

```bash
curl -fsSL https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/kur.sh -o /tmp/kur.sh
sudo bash /tmp/kur.sh
```

> Tek tıkla güncelleme isterseniz güvenli yolu vardır: host tarafında bir
> systemd servisi paylaşılan klasördeki istek dosyasını izler, uygulama o
> dosyayı yazar. Konteynere hiçbir yetki verilmez. Bunu kurmak isterseniz
> söyleyin.

### Sürüm damgası nasıl oluşuyor?

Konteynerin içinde `.git` yoktur (`.dockerignore`). `kur.sh`, imajı
derlemeden hemen önce çalışan commit'i `surum.json` dosyasına yazar:

```
==> 5/8  Imaj ve konteyner
  ✓ Surum damgasi yazildi (9718d16)
```

`kur.sh` ile derlenmemiş bir imajda sürüm **"geliştirme"** görünür ve
güncelleme kontrolü yapılmaz — bu normaldir.

### Kontrol edilemiyorsa

| Mesaj | Sebep |
|---|---|
| *"Sunucunun dışarı internet erişimi engelleniyor olabilir"* | Sunucu GitHub'a çıkamıyor; güvenlik duvarı |
| *"GitHub istek sınırına takıldı"* | Saatlik API limiti (IP başına 60); bir süre sonra düzelir |
| *"Çalışan sürüm bilinmiyor"* | İmaj `kur.sh` ile derlenmemiş |

Sonuç **15 dakika önbelleklenir**; "Güncellemeleri kontrol et" düğmesi
önbelleği atlar.
