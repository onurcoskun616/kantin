/**
 * ALIM BELGESI EKLERI — dosya saklama
 *
 * Faturanin kendisi (PDF / fotograf / e-Fatura XML) diske yazilir, kunyesi
 * veritabaninda tutulur. Denetimde "bu rakam nereden geldi" sorusunun
 * karsiligi budur.
 *
 * Guvenlik kararlari:
 *   - Dosya turu GONDERILEN BASLIGA DEGIL, icerigin ilk baytlarina bakilarak
 *     belirlenir. Istemci "image/png" deyip baska bir sey yollayamaz.
 *   - Diskteki ad sunucu tarafinda uretilir; kullanicinin verdigi ad yalnizca
 *     gosterim icin saklanir. Boylece dizin disina cikis (path traversal) ya da
 *     ".." benzeri adlar imkansizdir.
 *   - Dosyalar public/ altinda DEGIL, data/ altinda durur: yalnizca oturum
 *     acmis ve o kampusu gorebilen kullanici indirebilir.
 *   - sha256 ozeti saklanir; belgenin sonradan degisip degismedigi anlasilir.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { badRequest } from './http.js';

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB

/** Izin verilen turler ve imzalari (magic bytes). */
const SIGNATURES = [
  { type: 'application/pdf', ext: '.pdf', test: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  { type: 'image/jpeg', ext: '.jpg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    type: 'image/png',
    ext: '.png',
    test: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  },
  {
    type: 'image/webp',
    ext: '.webp',
    test: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  },
  {
    type: 'application/xml',
    ext: '.xml',
    // e-Fatura/e-Arsiv XML: BOM ve bosluklardan sonra '<' ile baslamali
    test: (b) => {
      const head = b.subarray(0, 512).toString('utf8').replace(/^﻿/, '').trimStart();
      return head.startsWith('<');
    },
  },
];

export const ALLOWED_TYPES = SIGNATURES.map((s) => s.type);

/** Icerige bakarak turu belirler; taninmayan dosyayi reddeder. */
export function detectType(buffer) {
  for (const sig of SIGNATURES) {
    try {
      if (sig.test(buffer)) return sig;
    } catch { /* kisa dosya: sonraki imzayi dene */ }
  }
  throw badRequest(
    'Yalnizca PDF, JPG, PNG, WEBP ve XML dosyalari yuklenebilir. '
    + 'Gonderilen dosya bu turlerden birine benzemiyor.'
  );
}

/** Istegin govdesini bellege okur; boyut sinirini asarsa keser. */
export async function readRawBody(req, limit = MAX_ATTACHMENT_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      throw badRequest(`Dosya cok buyuk. En fazla ${Math.round(limit / 1024 / 1024)} MB yuklenebilir.`);
    }
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (!buffer.length) throw badRequest('Bos dosya yuklenemez.');
  return buffer;
}

function ensureDir() {
  fs.mkdirSync(config.attachmentsDir, { recursive: true });
  return config.attachmentsDir;
}

/**
 * Dosyayi diske yazar ve kunyesini dondurur.
 * Diskteki ad: <32 hex><uzanti> — kullanicinin verdigi addan tamamen bagimsiz.
 */
export function storeFile(buffer, originalName) {
  const sig = detectType(buffer);
  const dir = ensureDir();
  const storedName = crypto.randomBytes(16).toString('hex') + sig.ext;
  fs.writeFileSync(path.join(dir, storedName), buffer, { mode: 0o600 });

  return {
    storedName,
    contentType: sig.type,
    byteSize: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
    fileName: safeDisplayName(originalName, sig.ext),
  };
}

/** Gosterim adini zararsiz hale getirir (dizin ayraci, kontrol karakteri yok). */
function safeDisplayName(name, fallbackExt) {
  const base = String(name || '')
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0);
      return code > 31 && code !== 127 && ch !== '/' && ch !== '\\';
    })
    .join('')
    .trim()
    .slice(0, 120);
  return base || `belge${fallbackExt}`;
}

/** Kunyedeki stored_name'i dosya yoluna cevirir; dizin disini reddeder. */
export function filePathOf(storedName) {
  if (!/^[0-9a-f]{32}\.[a-z0-9]{2,5}$/.test(String(storedName))) {
    throw badRequest('Gecersiz dosya kunyesi.');
  }
  return path.join(config.attachmentsDir, storedName);
}

export function readFile(storedName) {
  const file = filePathOf(storedName);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file);
}

export function deleteFile(storedName) {
  try {
    fs.unlinkSync(filePathOf(storedName));
  } catch { /* dosya zaten yoksa sorun degil */ }
}
