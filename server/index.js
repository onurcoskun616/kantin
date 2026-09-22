import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from './config.js';
import { migrate, get as dbGet, setSetting } from './db.js';
import { Router } from './lib/router.js';
import { HttpError, readJsonBody, sendJson, serveStatic, clientIp, parseCookies, forbidden } from './lib/http.js';
import { resolveSession, purgeExpiredSessions, requireAuth } from './lib/auth.js';
import { ensureSeedData } from './seed.js';
import { guncellemeVarMi, calisanSurum } from './lib/surum.js';

import { authRoutes } from './routes/auth.js';
import { campusRoutes } from './routes/campuses.js';
import { productRoutes } from './routes/products.js';
import { supplierRoutes } from './routes/suppliers.js';
import { purchaseRoutes } from './routes/purchases.js';
import { stockRoutes, wasteRoutes, transferRoutes } from './routes/stock.js';
import { returnRoutes } from './routes/returns.js';
import { recipeRoutes } from './routes/recipes.js';
import { countRoutes } from './routes/counts.js';
import { revenueRoutes } from './routes/revenues.js';
import { handoverRoutes } from './routes/handovers.js';
import { reportRoutes } from './routes/reports.js';
import { userRoutes, auditRoutes } from './routes/users.js';

migrate();
// Sunucu yalnizca ZORUNLU kayitlari olusturur: yonetici, kampusler, kategoriler.
// Ornek urun/tedarikci katalogu buraya DAHIL DEGILDIR — aksi halde `--bos` ile
// kurulan bir uretim veritabanina ilk aciliste ornek veri dolardi.
// Ornekler yalnizca acik istekle gelir: `npm run seed` / `npm run seed -- --demo`.
ensureSeedData({ withExamples: false });
purgeExpiredSessions();

const router = new Router();
/**
 * Saglik ve TESHIS ucu.
 *
 * Oturumsuz cagrida yalnizca "ayakta miyim" der. Oturum acmis bir
 * kullaniciya ise yavasligin NEREDE oldugunu gosteren olcumleri verir:
 * veritabani okuma/yazma suresi, disk fsync suresi, ayakta kalma suresi
 * ve bellek. "Sunucu yavas mi, ag mi yavas" sorusu tek istekle cevaplanir.
 *
 * `uptimeSeconds` kucukse konteyner surekli yeniden basliyordur: o zaman
 * her istek acilis maliyetini oder ve sistem "yavas" hissedilir.
 */
const TESHIS_ROLLERI = ['ADMIN', 'GENEL_MUDURLUK'];

router.get('/api/health', async (ctx) => {
  const temel = { ok: true, time: new Date().toISOString() };
  // Olcumler sunucu ic bilgisidir (veritabani yolu, bellek, surum):
  // yalnizca Sistem Durumu ekranini gorebilen roller alir.
  if (!ctx.user || !TESHIS_ROLLERI.includes(ctx.user.role)) return temel;
  return { ...temel, version: calisanSurum(), ...olcumAl(ctx.user.role === 'ADMIN') };
});

/**
 * GUNCELLEME KONTROLU — ayri bir uctur, bilerek.
 *
 * GitHub'a disari istek yapar; /api/health'e koysaydik "sunucu ne kadar
 * hizli" olcumu internet gecikmesiyle kirlenirdi. `?tazele=1` onbellegi
 * atlar (varsayilan 15 dk).
 */
router.get('/api/health/guncelleme', async (ctx) => {
  if (!ctx.user || !TESHIS_ROLLERI.includes(ctx.user.role)) throw forbidden();
  return guncellemeVarMi({ tazele: ctx.query.tazele === '1' });
});
router.use('/api/auth', authRoutes);
router.use('/api/campuses', campusRoutes);
router.use('/api/products', productRoutes);
router.use('/api/suppliers', supplierRoutes);
router.use('/api/purchases', purchaseRoutes);
router.use('/api/stock', stockRoutes);
router.use('/api/waste', wasteRoutes);
router.use('/api/transfers', transferRoutes);
router.use('/api/returns', returnRoutes);
router.use('/api/recipes', recipeRoutes);
router.use('/api/counts', countRoutes);
router.use('/api/revenues', revenueRoutes);
router.use('/api/handovers', handoverRoutes);
router.use('/api/reports', reportRoutes);
router.use('/api/users', userRoutes);
router.use('/api/audit', auditRoutes);

// Oturum gerektirmeyen uclar
const PUBLIC_ROUTES = new Set(['POST /api/auth/login', 'GET /api/health']);

/*
 * ISTEK SURESI OLCUMU
 *
 * "Sistem yavas" sikayeti olculemedigi surece cozulemez: gecen sure
 * sunucuda mi, agda mi, tarayicida mi bilinmez. Iki sey yapariz:
 *
 *   1) `Server-Timing` basligi -- tarayicinin Ag sekmesinde istegin
 *      YANINDA sunucunun kac ms harcadigi yazar. Toplam sure 2 sn,
 *      sunucu 4 ms ise sorun ag ya da vekil sunucudadir.
 *   2) YAVAS istek gunlugu -- esigi asan her istek journalctl/docker logs
 *      icine tek satir dusr. Sonradan bakilabilir.
 *
 * Esik ortam degiskeniyle degistirilebilir (SLOW_REQUEST_MS, 0 = kapali).
 */
const SLOW_MS = Number(process.env.SLOW_REQUEST_MS ?? 400);
const BASLANGIC = Date.now();

const server = http.createServer(async (req, res) => {
  const t0 = process.hrtime.bigint();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    if (SLOW_MS > 0 && ms >= SLOW_MS) {
      console.warn(`[YAVAS] ${ms.toFixed(0)} ms  ${req.method} ${pathname} -> ${res.statusCode}`);
    }
  });

  if (!pathname.startsWith('/api/')) {
    if (serveStatic(req, res, url.pathname)) return;
    // Tek sayfa uygulama: bilinmeyen yollar index.html'e duser
    if (serveStatic(req, res, '/index.html')) return;
    return sendJson(res, 404, { error: 'Sayfa bulunamadi.' });
  }

  try {
    const { handler, params, rawBody } = router.match(req.method, pathname);
    const routeKey = `${req.method} ${pathname}`;

    const token = extractToken(req);
    const user = resolveSession(token);
    if (!PUBLIC_ROUTES.has(routeKey) && !user) {
      return sendJson(res, 401, { error: 'Oturum suresi doldu. Lutfen tekrar giris yapin.' });
    }

    // Dosya yukleme uclari govdeyi kendileri okur (readRawBody)
    const body = (!rawBody && ['POST', 'PUT', 'PATCH'].includes(req.method))
      ? await readJsonBody(req)
      : {};
    const ctx = {
      req, res, user, params, body,
      query: Object.fromEntries(url.searchParams.entries()),
      ip: clientIp(req),
    };
    if (!PUBLIC_ROUTES.has(routeKey)) requireAuth(user);

    const result = await handler(ctx);
    if (res.writableEnded) return;           // handler yanit gonderdi (CSV vb.)
    // Tarayicinin Ag sekmesinde "sunucu kac ms harcadi" olarak gorunur
    res.setHeader('Server-Timing', `app;dur=${(Number(process.hrtime.bigint() - t0) / 1e6).toFixed(1)}`);
    return sendJson(res, 200, result ?? { ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.message, details: err.details ?? undefined });
    }
    console.error('[HATA]', req.method, pathname, err);
    return sendJson(res, 500, { error: 'Sunucu hatasi olustu. Lutfen sistem yoneticisine bildirin.' });
  }
});

/**
 * Sunucunun kendi olcumleri: yavasligin kaynagini gosterir.
 * @param yolVer Veritabani dosya yolu yalnizca ADMIN'e gosterilir.
 */
function olcumAl(yolVer = false) {
  const sur = (fn) => {
    const t = process.hrtime.bigint();
    fn();
    return Math.round((Number(process.hrtime.bigint() - t) / 1e6) * 100) / 100;
  };

  const okumaMs = sur(() => dbGet('SELECT COUNT(*) AS n FROM products'));
  // Gercek bir yazma islemi: WAL'a yazar ve commit eder (fsync dahil)
  const yazmaMs = sur(() => setSetting('saglik_olcum', new Date().toISOString()));
  // Diskin kendisi: gecici dosya yaz + fsync
  let diskMs = null;
  try {
    const dosya = path.join(os.tmpdir(), `kantin-disk-${process.pid}.tmp`);
    diskMs = sur(() => {
      const fd = fs.openSync(dosya, 'w');
      fs.writeSync(fd, 'olcum');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
    });
    fs.unlinkSync(dosya);
  } catch { /* olcum alinamadi, onemli degil */ }

  const bellek = process.memoryUsage();
  return {
    uptimeSeconds: Math.round((Date.now() - BASLANGIC) / 1000),
    db: { readMs: okumaMs, writeMs: yazmaMs, path: yolVer ? config.dbPath : undefined },
    diskFsyncMs: diskMs,
    memoryMb: {
      rss: Math.round(bellek.rss / 1048576),
      heapUsed: Math.round(bellek.heapUsed / 1048576),
    },
    node: process.version,
  };
}

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookies(req).kantin_token || null;
}

// Suresi dolmus oturumlari saatte bir temizle
const cleanup = setInterval(purgeExpiredSessions, 3600_000);
cleanup.unref();

/*
 * Vekil sunucu (Caddy/nginx) arkasinda baglanti omru.
 *
 * Node'un varsayilan keepAliveTimeout'u 5 sn. Vekil sunucu daha uzun
 * tutmak isterse, tam kapanma aninda gonderilen istek "socket hang up"
 * ile duser ve tarayici yeniden dener -- kullanici bunu bekleme olarak
 * gorur. Vekilden UZUN tutmak bu yarisi ortadan kaldirir.
 */
server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;

server.listen(config.port, config.host, () => {
  console.log(`Topkapi Kantin Yonetim Sistemi calisiyor: http://${config.host}:${config.port}`);
  console.log(`Veritabani: ${config.dbPath}`);
});

export { server, router };
