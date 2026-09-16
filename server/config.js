import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Basit .env okuyucu (harici bagimlilik istemiyoruz)
function loadEnvFile() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnvFile();

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dbPath: path.resolve(ROOT, process.env.DB_PATH || './data/kantin.db'),
  sessionSecret: process.env.SESSION_SECRET || 'gelistirme-ortami-anahtari-degistirin',
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  admin: {
    email: process.env.ADMIN_EMAIL || 'admin@topkapiokullari.com',
    password: process.env.ADMIN_PASSWORD || 'Kantin2026!',
    name: process.env.ADMIN_NAME || 'Sistem Yoneticisi',
  },
  publicDir: path.join(ROOT, 'public'),
  isProduction: process.env.NODE_ENV === 'production',
};

if (config.isProduction && config.sessionSecret.startsWith('gelistirme')) {
  console.warn('[UYARI] SESSION_SECRET ayarlanmamis. Production icin .env dosyasinda mutlaka tanimlayin.');
}
