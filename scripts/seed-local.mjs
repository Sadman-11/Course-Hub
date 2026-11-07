// Load a Drive manifest into a locally running `wrangler dev` as the catalog,
// so the site can be developed against real data before any credentials exist.
//
//   node scripts/seed-local.mjs <manifest.json> [http://localhost:8787]
//
// manifest.json: output of `node sync/index.js --list-drive=...` or the mirror crawler.
import fs from 'node:fs';

const [manifest, base = 'http://localhost:8787'] = process.argv.slice(2);
const token = /SYNC_TOKEN\s*=\s*"?([^"\n]+)/.exec(fs.readFileSync('.dev.vars', 'utf8'))?.[1];
const rows = JSON.parse(fs.readFileSync(manifest, 'utf8')).filter((f) => f.type === 'file');
const LIMIT = 100 * 1024 * 1024;
const files = rows.map((f) => [f.path, f.size, f.modified, f.created || f.modified, f.id || null, f.size <= LIMIT ? 'local' : null]);
const res = await fetch(`${base}/api/internal/catalog`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ commit: process.env.SEED_COMMIT || 'main', generated: new Date().toISOString(), files }),
});
console.log(res.status, await res.text());
