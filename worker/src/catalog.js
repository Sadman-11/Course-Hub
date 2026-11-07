// The catalog: one compact snapshot of the library, written by the sync job
// after every run. Stored gzipped in D1 (one row read per cold isolate),
// memoised per isolate, and served to the site with an ETag.
import { gzip, gunzip, nowIso } from './util.js';
import instructors from '../../data/instructors.json';
// Titles taken from each course's official outline PDF; editable in the dashboard.
import courseTitles from '../../data/courses.json';

let memo = null; // { etag, doc, byPath }

export async function saveCatalog(env, doc) {
  const text = JSON.stringify(doc);
  await env.DB.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, updated_at = ?3')
    .bind('catalog', await gzip(text), nowIso()).run();
  memo = null;
}

export async function loadCatalog(env) {
  const row = await env.DB.prepare('SELECT v, updated_at FROM kv WHERE k = ?').bind('catalog').first();
  if (!row) return null;
  const etag = `"${row.updated_at}"`;
  if (memo && memo.etag === etag) return memo;
  const doc = JSON.parse(await gunzip(new Uint8Array(row.v)));
  memo = { etag, doc, byPath: new Map(doc.files.map((r) => [r[0], r])) };
  return memo;
}

export async function getMeta(env) {
  const row = await env.DB.prepare('SELECT v FROM kv WHERE k = ?').bind('meta').first();
  const stored = row ? JSON.parse(new TextDecoder().decode(new Uint8Array(row.v))) : {};
  return {
    courses: { ...courseTitles, ...(stored.courses || {}) },
    instructors: { ...titleCaseAll(instructors), ...(stored.instructors || {}) },
  };
}

export async function saveMeta(env, meta) {
  await env.DB.prepare('INSERT INTO kv (k, v, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, updated_at = ?3')
    .bind('meta', new TextEncoder().encode(JSON.stringify(meta)), nowIso()).run();
}

// "MR. MD. ASHRAFUL ALAM" -> "Mr. Md. Ashraful Alam"
function titleCaseAll(map) {
  const fix = (s) => (s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s.-])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()) : s);
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, fix(v)]));
}
