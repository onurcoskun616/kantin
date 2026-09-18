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
  // Alim belgelerine iliştirilen fatura dosyalari (PDF/foto/XML)
  attachmentsDir: path.resolve(ROOT, process.env.ATTACHMENTS_DIR || './data/ekler'),
  isProduction: process.env.NODE_ENV === 'production',
};

/**
 * Ayarlarin bariz bozuk olmadigini kurulusta kontrol eder.
 *
 * En sik kurulum hatasi satir ici yorum: `.env` icinde
 *   HOST=127.0.0.1   # nginx arkasinda
 * yazildiginda hem systemd hem de bizim okuyucumuz '#' sonrasini degerin
 * parcasi sayar; sunucu "getaddrinfo ENOTFOUND" ile baslamaz ve sebebi
 * gunlukte anlasilmaz. Burada acikca soyluyoruz.
 */
function validateConfig() {
  const problems = [];
  const commented = (name, value) => (/\s#/.test(String(value))
    ? `${name} degerinde satir ici yorum var: "${value}". `
      + '.env dosyasinda aciklamayi kendi satirina alin (# ile baslayan ayri bir satir).'
    : null);

  for (const [name, value] of [
    ['HOST', process.env.HOST], ['PORT', process.env.PORT],
    ['DB_PATH', process.env.DB_PATH], ['ATTACHMENTS_DIR', process.env.ATTACHMENTS_DIR],
    ['SESSION_TTL_HOURS', process.env.SESSION_TTL_HOURS],
  ]) {
    if (value === undefined) continue;
    const msg = commented(name, value);
    if (msg) problems.push(msg);
  }

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    problems.push(`PORT gecerli bir port numarasi degil: "${process.env.PORT}"`);
  }
  if (/\s/.test(config.host)) {
    problems.push(`HOST bosluk iceriyor: "${config.host}". Sunucuda 127.0.0.1 olmalidir.`);
  }
  if (!Number.isFinite(config.sessionTtlHours) || config.sessionTtlHours <= 0) {
    problems.push(`SESSION_TTL_HOURS pozitif bir sayi olmali: "${process.env.SESSION_TTL_HOURS}"`);
  }

  if (problems.length) {
    console.error('\n[AYAR HATASI] .env dosyasi duzeltilmeden sunucu baslatilamaz:\n');
    for (const p of problems) console.error(`  - ${p}`);
    console.error('\nOrnek icin .env.example dosyasina bakin.\n');
    process.exit(1);
  }

  if (config.isProduction && config.sessionSecret.startsWith('gelistirme')) {
    console.warn('[UYARI] SESSION_SECRET ayarlanmamis. Production icin .env dosyasinda mutlaka tanimlayin.');
  }
}
validateConfig();
