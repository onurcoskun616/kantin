# Mevcut Docker + Caddy Sunucusuna Kurulum

Bu rehber, sunucuda **zaten çalışan uygulamalar** ve önlerinde bir **Caddy**
ters vekili varken kantin sistemini onların yanına, hiçbirine dokunmadan
kurmak içindir.

Sunucuda host üzerinde nginx veya Node.js kurulu değilse (her şey Docker'da
çalışıyorsa) doğru rehber budur — `VPS-KURULUM.md` boş bir sunucu içindir.

## Neden bu yol?

| | Boş sunucu (VPS-KURULUM.md) | Bu sunucu |
|---|---|---|
| 80/443 | host'taki nginx | **Caddy konteyneri** |
| HTTPS | certbot ile elle | **Caddy otomatik alır** |
| Node.js | host'a kurulur | **gerekmez** (imajın içinde) |
| Kantin | systemd servisi | **Docker konteyneri** |

Host'a hiçbir şey kurulmaz: Node yok, nginx yok, yeni ufw kuralı yok.
Diğer uygulamalara dokunulmaz.

---

## Hızlı yol: tek komutla kurulum

Aşağıdaki adımları tek tek uygulamak yerine hazır betiği çalıştırabilirsiniz.
SSH terminalleri çok satırlı yapıştırmayı bozabildiği için **önerilen yol
budur**:

```bash
curl -fsSL https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/kur.sh -o /tmp/kur.sh
```

Çalıştırmadan önce içeriğine bakmak isterseniz: `less /tmp/kur.sh`

```bash
sudo bash /tmp/kur.sh
```

Kendi yönetici bilgilerinizi vermek isterseniz:

```bash
sudo ADMIN_EMAIL=mudur@topkapikoleji.org ADMIN_PASSWORD='SizinParolaniz' bash /tmp/kur.sh
```

Betik: kodu indirir, `.env`'i güvenli biçimde üretir (oturum anahtarını
kendisi rastgele oluşturur), konteyneri kurar, sağlık kontrolü yapar ve
sonunda **Caddy'ye eklenecek bloğu ekrana yazar**.

**Caddyfile'ı kendisi değiştirmez.** Son adım için ayrı bir betik var:

```bash
curl -fsSL https://raw.githubusercontent.com/onurcoskun616/kantin/main/deploy/caddy-ekle.sh -o /tmp/caddy-ekle.sh
sudo bash /tmp/caddy-ekle.sh
```

Bu betik geri alınabilir bir işlem yapar: tarihli yedek alır → bloğu ekler →
`caddy validate` çalıştırır → **başarısızsa yedekten geri döner** → `reload`
eder → **o da başarısızsa eski yapılandırmayı geri yükler** → sertifika
alınana kadar adresi yoklar.

Sonradan kaldırmak isterseniz:

```bash
sudo bash /tmp/caddy-ekle.sh --kaldir
```

Betik tekrar tekrar çalıştırılabilir; var olan `.env` dosyasının **üzerine
asla yazmaz**.

---

## Adım adım (elle)

## 1. Caddy'nin ağını öğrenin

Kantin konteyneri, Caddy'nin onu adıyla bulabilmesi için **aynı Docker
ağında** olmalı.

```bash
docker inspect topkapi-qr-caddy-1 --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

Çıkan ad (örn. `topkapi-qr_default`) bir sonraki adımda gerekecek.

Caddy yapılandırmasının nerede olduğunu da öğrenin:

```bash
docker inspect topkapi-qr-caddy-1 --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'
```

Çıktıda `Caddyfile`'ın host'taki yolu görünür.

## 2. Kodu indirin

Mevcut yığınların dizinine karışmasın diye ayrı bir klasör:

```bash
sudo mkdir -p /opt/kantin-uygulama
cd /opt/kantin-uygulama
sudo git clone -b main https://github.com/onurcoskun616/kantin.git kaynak
sudo cp kaynak/deploy/compose-kantin.yml docker-compose.yml
sudo mkdir -p backups
```

## 3. Ayarları yazın

```bash
# Oturum anahtarı üretin (çıktıyı kopyalayın)
docker run --rm node:22-alpine node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

sudo nano /opt/kantin-uygulama/.env
```

`.env` içeriği:

```ini
SESSION_SECRET=<yukarıda ürettiğiniz uzun rastgele değer>
ADMIN_EMAIL=mudur@topkapikoleji.org
ADMIN_PASSWORD=<güçlü bir başlangıç parolası>
ADMIN_NAME=Sistem Yöneticisi
```

> ⚠️ **Satır içi yorum kullanmayın.** `ADMIN_EMAIL=x@y.com  # açıklama`
> yazarsanız `#` sonrası değerin parçası sayılır. Açıklamayı kendi satırına
> yazın.

Dosyayı koruyun:

```bash
sudo chmod 600 /opt/kantin-uygulama/.env
```

## 4. Ağ adını doğrulayın

`docker-compose.yml` dosyasının en altındaki ağ adı `topkapi-qr_default`
olarak hazır gelir. 1. adımda başka bir ad çıktıysa burayı düzeltin:

```bash
sudo nano /opt/kantin-uygulama/docker-compose.yml
```

## 5. Başlatın

```bash
cd /opt/kantin-uygulama
sudo docker compose up -d --build
sudo docker compose ps
sudo docker compose logs --tail 20
```

Günlükte şunu görmelisiniz:

```
Topkapi Kantin Yonetim Sistemi calisiyor: http://0.0.0.0:3000
```

Konteyner içinden sağlık kontrolü:

```bash
sudo docker exec topkapi-kantin node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log)"
```

## 6. Caddy'ye kuralı ekleyin

Caddyfile bu sunucuda **`/root/topkapi-qr/deploy/Caddyfile`** dosyasıdır
(konteyner içine `/etc/caddy/Caddyfile` olarak bağlanmış).

Önce yedeğini alın, sonra **dosyanın sonuna şu bloğu ekleyin** — mevcut
satırlara dokunmayın:

```bash
sudo cp /root/topkapi-qr/deploy/Caddyfile /root/topkapi-qr/deploy/Caddyfile.yedek
sudo nano /root/topkapi-qr/deploy/Caddyfile
```

```caddyfile
# Kantin Yonetim Sistemi (Node app, topkapi-qr_default aginda; container: topkapi-kantin:3000)
kantin.topkapikoleji.org {
    import security_headers
    encode gzip
    request_body {
        max_size 12MB
    }
    reverse_proxy topkapi-kantin:3000
}
```

Bu blok mevcut dosyanın üslubunu birebir izler:

- **`import security_headers`** — dosyanın başındaki ortak parçacık (HSTS,
  nosniff, X-Frame-Options, Referrer-Policy, `-Server`). Diğer tüm siteler
  bunu kullanıyor, kantin de kullansın.
- **`encode gzip`** — diğer bloklarla aynı.
- **`request_body max_size 12MB`** — fatura eki 10 MB'a kadar olabiliyor.
  Caddy'de gövde boyutu varsayılan olarak sınırsızdır; bu satır yüklemeyi
  mümkün kılmaz, aşırı büyük isteği **sınırlar**. İstemezseniz çıkarabilirsiniz.
- Alan adı **düz yazılır** — `okul.topkapiokullari.com` bloğundaki gibi.
  Diğerleri `{$API_DOMAIN}` gibi ortam değişkeni kullanıyor çünkü onlar
  `.env.prod` üzerinden geliyor; kantin o yığının parçası değil.

> Bilerek `log` yönergesi koymuyoruz: konteynerde olmayan bir dizine yazmak
> istenirse **reload hata verir ve mevcut siteler de yüklenmez.** Caddy
> varsayılan olarak stdout'a yazar, günlükleri
> `docker logs topkapi-qr-caddy-1` ile görürsünüz.

**Önce doğrulayın** (bu adım hiçbir şeyi değiştirmez):

```bash
sudo docker exec topkapi-qr-caddy-1 caddy validate --config /etc/caddy/Caddyfile
```

`Valid configuration` yazmıyorsa **reload etmeyin** — yedekten geri dönün:
`sudo cp /root/topkapi-qr/deploy/Caddyfile.yedek /root/topkapi-qr/deploy/Caddyfile`

Doğrulama geçtiyse yeniden yükleyin (kesinti olmadan):

```bash
sudo docker exec topkapi-qr-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

Mevcut sitelerinizin hâlâ açıldığını kontrol edin.

> Caddy sertifikayı **kendiliğinden** alır; certbot'a gerek yoktur. DNS
> kaydının sunucuya yönlendiğinden ve Cloudflare'de **gri bulut (DNS only)**
> olduğundan emin olun.

## 7. Açın

`https://kantin.topkapikoleji.org`

`.env` dosyasındaki `ADMIN_EMAIL` / `ADMIN_PASSWORD` ile girin ve
**ilk girişten hemen sonra parolayı değiştirin** (sol altta "Parola").

---

## Veritabanını hazırlama

İlk açılışta yönetici, 5 kampüs ve kategoriler kendiliğinden oluşur. Örnek
ürün listesi **gelmez** (üretim veritabanı temiz kalsın diye). Ürünleri Excel
şablonuyla yüklersiniz.

Önce örnek veriyle denemek isterseniz:

```bash
sudo docker exec topkapi-kantin node server/seed.js --demo
```

Temizlemek için:

```bash
sudo docker exec topkapi-kantin node server/seed.js --reset --bos
sudo docker restart topkapi-kantin
```

---

## Yedekleme

Yedek betiği konteyner içinde çalışır; çıktı host'taki `backups/` klasörüne
düşer (bind mount).

```bash
sudo docker exec topkapi-kantin /app/scripts/yedekle.sh
ls -la /opt/kantin-uygulama/backups
```

İki dosya üretir: `kantin-<tarih>.db.gz` (veritabanı) ve
`ekler-<tarih>.tar.gz` (fatura dosyaları). **İkisi de gerekli** — fatura
dosyaları veritabanının içinde değildir.

Her gece otomatik almak için:

```bash
sudo tee /etc/cron.d/kantin-yedek >/dev/null <<'EOF'
SHELL=/bin/bash
PATH=/usr/local/bin:/usr/bin:/bin
MAILTO=""
0 2 * * * root docker exec topkapi-kantin /app/scripts/yedekle.sh >> /var/log/kantin-yedek.log 2>&1
EOF
sudo chmod 644 /etc/cron.d/kantin-yedek
```

> Yedekleri mutlaka **sunucu dışına** da kopyalayın. Sunucu çökerse
> üzerindeki yedek de gider.

### Geri yükleme

```bash
sudo docker stop topkapi-kantin
sudo docker run --rm -v kantin-uygulama_kantin-data:/data \
  -v /opt/kantin-uygulama/backups:/yedek alpine sh -c \
  "gunzip -c /yedek/kantin-20260101-020000.db.gz > /data/kantin.db && \
   tar -xzf /yedek/ekler-20260101-020000.tar.gz -C /data --strip-components=1"
sudo docker start topkapi-kantin
```

> Volume adını `docker volume ls | grep kantin` ile doğrulayın; compose
> dizin adına göre ön ek alır.

---

## Güncelleme

```bash
cd /opt/kantin-uygulama
sudo docker exec topkapi-kantin /app/scripts/yedekle.sh   # önce yedek
sudo git -C kaynak pull origin main
sudo docker compose up -d --build
sudo docker compose logs --tail 20
```

Veritabanı şeması geriye dönük uyumludur; eksik tablolar her açılışta eklenir,
mevcut veriye dokunulmaz.

---

## Diğer uygulamalara etkisi

Bu kurulum:

- Host'a **hiçbir paket kurmaz** (Node, nginx yok)
- **Yeni port açmaz** — 80/443 zaten Caddy'de, kantin host'a port yayınlamaz
- **ufw kurallarına dokunmaz**
- Kendi Docker volume'unda kendi SQLite dosyasını kullanır — PostgreSQL'e
  ve diğer konteynerlerin verisine erişmez
- Caddy'de yalnızca **yeni bir site bloğu** ekler

Geri almak isterseniz:

```bash
cd /opt/kantin-uygulama && sudo docker compose down
# Caddyfile'daki kantin bloğunu silip: docker exec topkapi-qr-caddy-1 caddy reload --config /etc/caddy/Caddyfile
```

Veri silinmez; `docker volume rm` demediğiniz sürece durur.

---

## Sorun giderme

| Belirti | Kontrol |
|---|---|
| Caddy "dial tcp: lookup topkapi-kantin" hatası | İki konteyner aynı ağda mı: `docker inspect topkapi-kantin --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'` |
| Konteyner başlamıyor | `docker compose logs --tail 50` — `.env` içinde satır içi yorum olabilir |
| `SESSION_SECRET tanimlanmali` hatası | `.env` dosyası compose ile aynı dizinde mi, `chmod 600` sonrası okunabiliyor mu |
| Sertifika alınamıyor | DNS sunucuya yönlensin, Cloudflare'de **gri bulut** olsun |
| Fatura dosyası yüklenmiyor | Caddy'de `max_size 12MB` satırı var mı |
| Yedek çıkmıyor | `docker exec topkapi-kantin /app/scripts/yedekle.sh` — bash imajda var mı |
