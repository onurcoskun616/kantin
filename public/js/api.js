/** Sunucu ile iletisim katmani. */
const TOKEN_KEY = 'kantin_token';

export const auth = {
  get token() { return localStorage.getItem(TOKEN_KEY); },
  set token(v) {
    if (v) {
      localStorage.setItem(TOKEN_KEY, v);
      // Sunucu tarafi CSV indirmelerinde cerez uzerinden dogrulama yapar
      document.cookie = `kantin_token=${encodeURIComponent(v)}; path=/; max-age=86400; SameSite=Strict`;
    } else {
      localStorage.removeItem(TOKEN_KEY);
      document.cookie = 'kantin_token=; path=/; max-age=0';
    }
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

async function request(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;

  const res = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });

  if (res.status === 401) {
    auth.token = null;
    auth.user = null;
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(401, 'Oturum süresi doldu. Lütfen tekrar giriş yapın.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Beklenmeyen hata (${res.status})`, data.details);
  return data;
}

export const api = {
  get: (path, params) => request('GET', withQuery(path, params)),
  post: (path, body) => request('POST', path, body ?? {}),
  put: (path, body) => request('PUT', path, body ?? {}),
  del: (path) => request('DELETE', path),
  /** CSV indirmesini yeni sekmede acar. */
  download(path, params) {
    window.open(withQuery(path, { ...params, format: 'csv' }), '_blank');
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
