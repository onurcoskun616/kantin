/**
 * Tarayıcı içinde .xlsx okuma — harici kütüphane kullanmadan.
 *
 * Bir .xlsx dosyası aslında içinde XML barındıran bir ZIP arşividir. Burada
 * ZIP merkezî dizini elle okunur, sıkıştırılmış girdiler tarayıcının yerleşik
 * DecompressionStream'i ile açılır ve sayfa XML'i DOMParser ile çözülür.
 *
 * Desteklenen: xlsx (deflate/stored), csv. Formül hücrelerinde önbellekli değer
 * varsa okunur, yoksa boş kabul edilir.
 */

/* =============================== ZIP =============================== */
const EOCD_SIG = 0x06054b50;
const CD_SIG = 0x02014b50;

async function unzip(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const bytes = new Uint8Array(arrayBuffer);

  // Sondaki "end of central directory" kaydını geriye doğru ara
  let eocd = -1;
  const minPos = Math.max(0, bytes.length - 65557);
  for (let i = bytes.length - 22; i >= minPos; i -= 1) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Dosya geçerli bir Excel (.xlsx) dosyası değil.');

  const entryCount = view.getUint16(eocd + 10, true);
  let pointer = view.getUint32(eocd + 16, true);

  const files = new Map();
  for (let n = 0; n < entryCount; n += 1) {
    if (view.getUint32(pointer, true) !== CD_SIG) break;
    const method = view.getUint16(pointer + 10, true);
    const compressedSize = view.getUint32(pointer + 20, true);
    const nameLength = view.getUint16(pointer + 28, true);
    const extraLength = view.getUint16(pointer + 30, true);
    const commentLength = view.getUint16(pointer + 32, true);
    const localOffset = view.getUint32(pointer + 42, true);
    const name = new TextDecoder('utf-8').decode(bytes.subarray(pointer + 46, pointer + 46 + nameLength));

    // Yerel başlıktan gerçek veri başlangıcını bul (alan uzunlukları farklı olabilir)
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;

    files.set(name, { method, data: bytes.subarray(dataStart, dataStart + compressedSize) });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function readEntry(files, name) {
  const entry = files.get(name);
  if (!entry) return null;
  if (entry.method === 0) return new TextDecoder('utf-8').decode(entry.data);
  if (entry.method !== 8) throw new Error(`Desteklenmeyen sıkıştırma yöntemi (${entry.method}).`);
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Tarayıcınız .xlsx açmayı desteklemiyor. Dosyayı Excel\'de "CSV (virgülle ayrılmış)" olarak kaydedip yükleyin.');
  }
  const stream = new Blob([entry.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Response(stream).text();
}

/* ============================== XLSX =============================== */
/** "B12" -> 1 (sıfır tabanlı sütun indeksi) */
function columnIndex(ref) {
  let n = 0;
  for (const ch of ref) {
    const code = ch.charCodeAt(0);
    if (code < 65 || code > 90) break;
    n = n * 26 + (code - 64);
  }
  return n - 1;
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return [...doc.getElementsByTagName('si')].map((si) =>
    [...si.getElementsByTagName('t')].map((t) => t.textContent).join(''));
}

function parseSheet(xml, sharedStrings) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const rows = [];
  for (const row of doc.getElementsByTagName('row')) {
    const index = Number(row.getAttribute('r') || rows.length + 1) - 1;
    const cells = [];
    for (const c of row.getElementsByTagName('c')) {
      const col = columnIndex(c.getAttribute('r') || '');
      const type = c.getAttribute('t');
      let value = null;
      if (type === 'inlineStr') {
        value = [...c.getElementsByTagName('t')].map((t) => t.textContent).join('');
      } else {
        const v = c.getElementsByTagName('v')[0];
        if (v) {
          const raw = v.textContent;
          if (type === 's') value = sharedStrings[Number(raw)] ?? '';
          else if (type === 'b') value = raw === '1';
          else if (type === 'e') value = null;
          else if (type === 'str') value = raw;
          else value = raw === '' ? null : Number(raw);
        }
      }
      if (col >= 0) cells[col] = value ?? '';
    }
    rows[index] = cells;
  }
  // Boş satırları dizide delik bırakmadan normalize et
  return Array.from(rows, (r) => r ?? []);
}

/**
 * Dosyayı okur, sayfa adı -> satır dizisi eşlemesi döndürür.
 * @returns {Promise<{sheetNames: string[], sheets: Record<string, any[][]>}>}
 */
export async function readWorkbook(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith('.csv') || name.endsWith('.txt')) {
    const text = await file.text();
    return { sheetNames: ['CSV'], sheets: { CSV: parseCsv(text) } };
  }
  if (!name.endsWith('.xlsx')) {
    throw new Error('Yalnızca .xlsx ve .csv dosyaları yüklenebilir. (.xls eski bir biçimdir; Excel\'de "Farklı Kaydet → .xlsx" yapın.)');
  }

  const files = await unzip(await file.arrayBuffer());
  const sharedStrings = parseSharedStrings(await readEntry(files, 'xl/sharedStrings.xml'));

  // Sayfa adlarını workbook.xml + ilişkiler dosyasından çöz
  const workbookXml = await readEntry(files, 'xl/workbook.xml');
  if (!workbookXml) throw new Error('Excel dosyası okunamadı (workbook.xml bulunamadı).');
  const relsXml = await readEntry(files, 'xl/_rels/workbook.xml.rels');

  const relMap = new Map();
  if (relsXml) {
    const relDoc = new DOMParser().parseFromString(relsXml, 'application/xml');
    for (const rel of relDoc.getElementsByTagName('Relationship')) {
      let target = rel.getAttribute('Target') || '';
      if (target.startsWith('/xl/')) target = target.slice(1);
      else if (!target.startsWith('xl/')) target = `xl/${target.replace(/^\.\//, '')}`;
      relMap.set(rel.getAttribute('Id'), target);
    }
  }

  const wbDoc = new DOMParser().parseFromString(workbookXml, 'application/xml');
  const sheetNames = [];
  const sheets = {};
  let fallbackIndex = 1;

  for (const sheet of wbDoc.getElementsByTagName('sheet')) {
    const sheetName = sheet.getAttribute('name') || `Sayfa${fallbackIndex}`;
    const rid = sheet.getAttribute('r:id') || sheet.getAttributeNS?.('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const path = relMap.get(rid) || `xl/worksheets/sheet${fallbackIndex}.xml`;
    fallbackIndex += 1;

    const sheetXml = await readEntry(files, path);
    if (!sheetXml) continue;
    sheetNames.push(sheetName);
    sheets[sheetName] = parseSheet(sheetXml, sharedStrings);
  }

  if (!sheetNames.length) throw new Error('Excel dosyasında okunabilir sayfa bulunamadı.');
  return { sheetNames, sheets };
}

/* =============================== CSV =============================== */
/** Ayırıcıyı (; veya ,) otomatik algılayan CSV çözümleyici. */
export function parseCsv(text) {
  const clean = text.replace(/^﻿/, '');
  const firstLine = clean.split(/\r?\n/)[0] || '';
  const delimiter = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';

  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (ch === '\r') continue;
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ========================= Başlık eşleştirme ======================= */
/** Türkçe karakterleri ve boşlukları normalize eder. */
export function normalizeHeader(text) {
  return String(text ?? '')
    .toLocaleLowerCase('tr')
    .replace(/[ıİ]/g, 'i').replace(/[şŞ]/g, 's').replace(/[ğĞ]/g, 'g')
    .replace(/[üÜ]/g, 'u').replace(/[öÖ]/g, 'o').replace(/[çÇ]/g, 'c')
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Başlık satırını arayıp sütun adlarını alan adlarına eşler.
 * @param {any[][]} rows
 * @param {Record<string, string[]>} fieldAliases alan -> olası başlık listesi
 * @returns {{headerRow: number, map: Record<string, number>}}
 */
export function mapColumns(rows, fieldAliases) {
  const normalizedAliases = Object.fromEntries(
    Object.entries(fieldAliases).map(([field, aliases]) => [field, aliases.map(normalizeHeader)])
  );

  for (let r = 0; r < Math.min(rows.length, 15); r += 1) {
    const cells = (rows[r] || []).map(normalizeHeader);
    if (!cells.some(Boolean)) continue;

    const map = {};
    const used = new Set();
    // 1. tur: birebir eşleşme ("birim" başlığı "birim kâr" sütununa kaymasın diye)
    for (const [field, aliases] of Object.entries(normalizedAliases)) {
      const index = cells.findIndex((cell, i) => cell && !used.has(i) && aliases.includes(cell));
      if (index !== -1) { map[field] = index; used.add(index); }
    }
    // 2. tur: eşleşmeyen alanlar için baştan eşleşme
    for (const [field, aliases] of Object.entries(normalizedAliases)) {
      if (map[field] !== undefined) continue;
      const index = cells.findIndex((cell, i) => cell && !used.has(i) && aliases.some((a) => cell.startsWith(a)));
      if (index !== -1) { map[field] = index; used.add(index); }
    }
    // İki veya daha fazla alan eşleştiyse bu satır başlık satırıdır
    if (Object.keys(map).length >= 2) return { headerRow: r, map };
  }
  return { headerRow: -1, map: {} };
}

/** Hücre değerini sayıya çevirir; "12,50" ve "1.234,56" biçimlerini anlar. */
export function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  let s = String(value).trim().replace(/\s|₺|TL/gi, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '').replace(',', '.');
  else if (s.includes(',')) s = s.replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Barkodun bilimsel gösterime düşmüş hâlini de düzeltir. */
export function toText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value.toFixed(0) : String(value);
  }
  return String(value).trim();
}
