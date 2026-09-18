import { HttpError, notFound } from './http.js';

function compile(pattern) {
  const keys = [];
  const source = pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${source}$`), keys };
}

/** Sondaki '/' karakterini temizler ('/' kokunu korur). */
function normalize(pattern) {
  const p = pattern.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

/**
 * Minimal desen tabanli yonlendirici.
 * Ornek: router.get('/api/products/:id', handler)
 */
export class Router {
  constructor() {
    this.routes = [];
  }

  /**
   * opts.rawBody: true ise sunucu govdeyi JSON olarak okumaz; handler ham
   * akisi kendisi okur (dosya yukleme uclari icin).
   */
  add(method, pattern, handler, opts = {}) {
    const p = normalize(pattern);
    this.routes.push({ method, pattern: p, handler, rawBody: !!opts.rawBody, ...compile(p) });
    return this;
  }

  get(p, h, o) { return this.add('GET', p, h, o); }
  post(p, h, o) { return this.add('POST', p, h, o); }
  put(p, h, o) { return this.add('PUT', p, h, o); }
  patch(p, h, o) { return this.add('PATCH', p, h, o); }
  delete(p, h, o) { return this.add('DELETE', p, h, o); }

  /** Alt yonlendiriciyi bir on ek altina baglar. */
  use(prefix, subRouter) {
    for (const r of subRouter.routes) {
      const combined = normalize(prefix + (r.pattern === '/' ? '' : r.pattern));
      this.routes.push({
        method: r.method, pattern: combined, handler: r.handler, rawBody: r.rawBody, ...compile(combined),
      });
    }
    return this;
  }

  match(method, pathname) {
    const target = normalize(pathname);
    let pathExists = false;
    for (const route of this.routes) {
      const m = route.regex.exec(target);
      if (!m) continue;
      pathExists = true;
      if (route.method !== method) continue;
      const params = {};
      route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: route.handler, params, pattern: route.pattern, rawBody: route.rawBody };
    }
    if (pathExists) throw new HttpError(405, 'Bu adres icin gecersiz HTTP metodu.');
    throw notFound('Boyle bir API ucu yok.');
  }
}
