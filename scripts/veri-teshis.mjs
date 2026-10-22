/**
 * VERI TESHIS RAPORU — salt okunur, komut satiri.
 *
 * Kontrollerin kendisi server/lib/veri-teshis.js icindedir; panel
 * (Sistem Durumu) ayni modulu kullanir, yani iki yerde ayri sonuc
 * cikmaz.
 *
 * Bu betik IMAJIN ICINDEDIR (Dockerfile scripts/ dizinini kopyalar),
 * veritabani da konteynerde /app/data/kantin.db yolundadir. Sunucuda:
 *
 *   docker exec topkapi-kantin node scripts/veri-teshis.mjs > veri-teshis.txt
 *
 * Konteyner disinda, dosya yolunu vererek de calisir:
 *   node scripts/veri-teshis.mjs /yol/kantin.db > veri-teshis.txt
 *
 * NOT: deploy/teshis.sh BASKA bir aractir -- o, "site acilmiyor"
 * durumunda ERISIMI teshis eder. Bu betik VERIYI inceler.
 */
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { veriTeshisi, raporMetni } from '../server/lib/veri-teshis.js';

const DB = process.argv[2] || process.env.DB_PATH
  || path.resolve(process.cwd(), 'data/kantin.db');

let db;
try {
  db = new DatabaseSync(DB, { readOnly: true });
} catch (err) {
  console.error(`Veritabani acilamadi (${DB}): ${err.message}`);
  process.exit(1);
}

try {
  const all = (sql, p = []) => db.prepare(sql).all(...p);
  console.log(raporMetni(veriTeshisi(all), DB));
} finally {
  db.close();
}
