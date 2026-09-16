/**
 * Demo sürümü için sunucu iletişim katmanı.
 *
 * Gerçek uygulamada bu dosya `fetch` ile sunucuya gider. Demoda aynı arayüzü
 * sunar ama istekleri tarayıcı içindeki demo sunucusuna yönlendirir; böylece
 * ekran kodlarının hiçbiri değişmez.
 */
import { dispatch, DemoError } from './demo/store.js';

export const auth = {
  get token() { return sessionStorage.getItem('kantin_demo_token'); },
  set token(v) {
    try {
      if (v) sessionStorage.setItem('kantin_demo_token', v);
      else sessionStorage.removeItem('kantin_demo_token');
    } catch { /* depolama kapalı olabilir */ }
  },
  user: null,
};

export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function splitPath(path) {
  const [pathname, search] = String(path).split('?');
  const query = Object.fromEntries(new URLSearchParams(search || '').entries());
  return { pathname: pathname.replace(/\/+$/, '') || '/', query };
}

/** Ağ gecikmesi yokken arayüz "anlık" göründüğü için minik bir gecikme bırakıyoruz. */
function request(method, path, body) {
  const { pathname, query } = splitPath(path);
  return new Promise((resolve, reject) => {
    setTimeout(() => {
      try {
        resolve(dispatch(method, pathname, query, body));
      } catch (err) {
        if (err instanceof DemoError) {
          if (err.status === 401) {
            auth.token = null;
            auth.user = null;
            window.dispatchEvent(new CustomEvent('auth:expired'));
          }
          reject(new ApiError(err.status, err.message));
          return;
        }
        console.error(err);
        reject(new ApiError(500, err.message || 'Demo içinde beklenmeyen bir hata oluştu.'));
      }
    }, 40);
  });
}

export const api = {
  get: (path, params) => request('GET', withQuery(path, params)),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  del: (path) => request('DELETE', path),
  /**
   * Demo, claude.ai'nin korumalı alanında çalıştığı için dosya indirme
   * engellidir. Kurulu sürümde bu düğmeler Excel dosyasını indirir.
   */
  download() {
    window.dispatchEvent(new CustomEvent('demo:download-blocked'));
  },
};

function withQuery(path, params) {
  if (!params) return path;
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, v);
  }
  const qs = usp.toString();
  return qs ? `${path}?${qs}` : path;
}
