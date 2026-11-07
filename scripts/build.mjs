// Copies the shared taxonomy into the static site so the browser and the
// sync engine use the exact same rules. Run automatically by `wrangler dev/deploy`.
// Writes only when the content changed, so file watchers don't loop.
import fs from 'node:fs';

const out = 'web/js/taxonomy.js';
const next = '// GENERATED from shared/taxonomy.js by scripts/build.mjs. Do not edit.\n' + fs.readFileSync('shared/taxonomy.js', 'utf8');
const prev = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
if (prev !== next) {
  fs.writeFileSync(out, next);
  console.log(`build: wrote ${out}`);
}
