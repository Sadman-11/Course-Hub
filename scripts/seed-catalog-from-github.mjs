// One-off: publish a catalog of what's on GitHub right now, so the live site is
// useful before the first sync. The first sync overwrites it with the full,
// Drive-backed catalog. Paths matched by .syncignore are left out.
//   node --env-file=.env scripts/seed-catalog-from-github.mjs <drive-manifest.json>
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { compileIgnore } from '../sync/ignore.js';

const repo = process.env.GITHUB_REPO;
const manifest = new Map(JSON.parse(fs.readFileSync(process.argv[2], 'utf8')).filter((f) => f.type === 'file').map((f) => [f.path, f]));
const isIgnored = compileIgnore(fs.readFileSync('content-repo/.syncignore', 'utf8'));
const gh = (p) => JSON.parse(execSync(`gh api ${p}`, { maxBuffer: 64 << 20 }).toString());
const commit = gh(`repos/${repo}/commits/main`).sha;
const tree = gh(`repos/${repo}/git/trees/${commit}?recursive=1`).tree;
const files = tree
  .filter((t) => t.type === 'blob' && !/^(\.github\/|\.sync\/|README\.md$)/.test(t.path) && !isIgnored(t.path))
  .map((t) => {
    const d = manifest.get(t.path);
    return [t.path, t.size, d?.modified || null, d?.created || d?.modified || null, null, t.sha];
  });
const res = await fetch(`${process.env.SYNC_API}/api/internal/catalog`, {
  method: 'PUT',
  headers: { authorization: `Bearer ${process.env.SYNC_TOKEN}`, 'content-type': 'application/json' },
  body: JSON.stringify({ commit, generated: new Date().toISOString(), files, seeded: 'github-snapshot' }),
});
console.log(res.status, await res.text(), `commit ${commit.slice(0, 7)}`);
