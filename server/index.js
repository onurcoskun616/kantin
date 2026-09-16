import http from 'node:http';
import { config } from './config.js';
import { migrate } from './db.js';
import { Router } from './lib/router.js';
import { HttpError, readJsonBody, sendJson, serveStatic, clientIp, parseCookies } from './lib/http.js';
import { resolveSession, purgeExpiredSessions, requireAuth } from './lib/auth.js';
import { ensureSeedData } from './seed.js';

import { authRoutes } from './routes/auth.js';
import { campusRoutes } from './routes/campuses.js';
import { productRoutes } from './routes/products.js';
import { supplierRoutes } from './routes/suppliers.js';
import { purchaseRoutes } from './routes/purchases.js';
import { stockRoutes, wasteRoutes, transferRoutes } from './routes/stock.js';
import { countRoutes } from './routes/counts.js';
import { revenueRoutes } from './routes/revenues.js';
import { reportRoutes } from './routes/reports.js';
import { userRoutes, auditRoutes } from './routes/users.js';

migrate();
ensureSeedData();
purgeExpiredSessions();

const router = new Router();
router.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
router.use('/api/auth', authRoutes);
router.use('/api/campuses', campusRoutes);
router.use('/api/products', productRoutes);
router.use('/api/suppliers', supplierRoutes);
router.use('/api/purchases', purchaseRoutes);
router.use('/api/stock', stockRoutes);
router.use('/api/waste', wasteRoutes);
router.use('/api/transfers', transferRoutes);
router.use('/api/counts', countRoutes);
router.use('/api/revenues', revenueRoutes);
router.use('/api/reports', reportRoutes);
router.use('/api/users', userRoutes);
router.use('/api/audit', auditRoutes);

// Oturum gerektirmeyen uclar
const PUBLIC_ROUTES = new Set(['POST /api/auth/login', 'GET /api/health']);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');

  if (!pathname.startsWith('/api/')) {
    if (serveStatic(req, res, url.pathname)) return;
    // Tek sayfa uygulama: bilinmeyen yollar index.html'e duser
    if (serveStatic(req, res, '/index.html')) return;
    return sendJson(res, 404, { error: 'Sayfa bulunamadi.' });
  }

  try {
    const { handler, params } = router.match(req.method, pathname);
    const routeKey = `${req.method} ${pathname}`;

    const token = extractToken(req);
    const user = resolveSession(token);
    if (!PUBLIC_ROUTES.has(routeKey) && !user) {
      return sendJson(res, 401, { error: 'Oturum suresi doldu. Lutfen tekrar giris yapin.' });
    }

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readJsonBody(req) : {};
    const ctx = {
      req, res, user, params, body,
      query: Object.fromEntries(url.searchParams.entries()),
      ip: clientIp(req),
    };
    if (!PUBLIC_ROUTES.has(routeKey)) requireAuth(user);

    const result = await handler(ctx);
    if (res.writableEnded) return;           // handler yanit gonderdi (CSV vb.)
    return sendJson(res, 200, result ?? { ok: true });
  } catch (err) {
    if (err instanceof HttpError) {
      return sendJson(res, err.status, { error: err.message, details: err.details ?? undefined });
    }
    console.error('[HATA]', req.method, pathname, err);
    return sendJson(res, 500, { error: 'Sunucu hatasi olustu. Lutfen sistem yoneticisine bildirin.' });
  }
});

function extractToken(req) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return parseCookies(req).kantin_token || null;
}

// Suresi dolmus oturumlari saatte bir temizle
const cleanup = setInterval(purgeExpiredSessions, 3600_000);
cleanup.unref();

server.listen(config.port, config.host, () => {
  console.log(`Topkapi Kantin Yonetim Sistemi calisiyor: http://${config.host}:${config.port}`);
  console.log(`Veritabani: ${config.dbPath}`);
});

export { server, router };
