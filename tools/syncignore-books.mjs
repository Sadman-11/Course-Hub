#!/usr/bin/env node
// Write content-repo/.syncignore so textbooks stay Drive-only: the canonical
// rule plus each book's pre-reorganisation path from the plan (so the first
// sync never publishes a book before the reorganisation moves it under Books/).
//   node tools/syncignore-books.mjs [reorg/plan.json] [content-repo/.syncignore]
import fs from 'node:fs';

const [planFile = 'reorg/plan.json', out = 'content-repo/.syncignore'] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
const isBook = (p) => (p.to && /^[^/]+\/[^/]+\/Books\//.test(p.to)) || (p.action === 'trash' && /^[^/]+\/[^/]+\/Books\//.test(p.duplicateOf || ''));
const books = plan.filter(isBook);
const escapeGlob = (p) => p.replace(/[*?[\]!#\\]/g, (c) => `\\${c}`);

fs.writeFileSync(out, [
  '# Paths listed here stay on Google Drive only and are never published to GitHub.',
  "# Same syntax as .gitignore. Files over 100 MiB are always Drive-only (GitHub's limit).",
  '#',
  '# Adding a pattern removes matching files from the GitHub tree on the next sync',
  '# (they remain in earlier Git history). Removing a pattern publishes them again.',
  '',
  '# Textbooks: Drive only (publisher-copyrighted; keeps them out of the public repo).',
  '*/*/Books/**',
  '',
  '# The same books at their pre-reorganisation paths. Safe to delete this block',
  '# once the reorganisation has run.',
  ...[...new Set(books.map((b) => b.from))].sort().map(escapeGlob),
  '',
].join('\n'));

console.log(`${books.length} book files, ${(books.reduce((s, b) => s + b.size, 0) / 1e6).toFixed(1)} MB → ${out}`);
for (const b of books) console.log(`  ${(b.size / 1e6).toFixed(1).padStart(5)} MB  ${b.from}`);
