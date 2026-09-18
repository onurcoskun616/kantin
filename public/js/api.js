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

  const data = await res.json().catch(() => ({}));

  // Giris denemesindeki 401 "oturum doldu" DEGILDIR: sunucunun gercek
  // mesajini ("E-posta veya parola hatali.") oldugu gibi gostermeliyiz.
  // Aksi halde yanlis parola giren kullanici sebebi anlamaz.
  const girisDenemesi = path.startsWith('/api/auth/login');
  if (res.status === 401 && !girisDenemesi) {
    auth.token = null;
    auth.user = null;
    window.dispatchEvent(new CustomEvent('auth:expired'));
    throw new ApiError(401, data.error || 'Oturum süresi doldu. Lütfen tekrar giriş yapın.');
  }
  if (!res.ok) throw new ApiError(res.status, data.error || `Beklenmeyen hata (${res.status})`, data.details);
  return data;
}

/** Ham dosya gonderir (JSON'a gomulmeden). Fatura ekleri icin. */
async function upload(path, file, params) {
  const headers = { 'Content-Type': 'application/octet-stream' };
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(withQuery(path, { filename: file.name, ...params }), {
    method: 'POST', headers, body: file,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data.error || `Yükleme başarısız (${res.status})`, data.details);
  return data;
}

/** Korumali bir dosyayi indirir; yetki basligi gerektigi icin fetch ile alinir. */
async function fetchBlob(path) {
  const headers = {};
  if (auth.token) headers.Authorization = `Bearer ${auth.token}`;
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new ApiError(res.status, data.error || `Dosya açılamadı (${res.status})`);
  }
  return res.blob();
}

export const api = {
  get: (path, params) => request('GET', withQuery(path, params)),
  upload,
  fetchBlob,
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
