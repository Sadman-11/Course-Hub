#!/usr/bin/env node
// Build a reviewable reorganisation plan from a Drive manifest.
//
//   node tools/reorg-plan.mjs <manifest.json> [outDir]
//
// manifest.json: [{ path, type: "file"|"dir", size, modified }]
//   (produced by `node sync/index.js --list-drive` or the mirror crawler)
//
// Writes outDir/plan.json, outDir/plan.csv and outDir/PLAN.md.
// Nothing is changed anywhere; tools/reorg-apply.mjs executes a plan.
import fs from 'node:fs';
import path from 'node:path';
import { canonicalPath, categoryFromName, semesterKey, CATEGORIES } from '../shared/taxonomy.js';

const [manifestPath, outDir = 'reorg'] = process.argv.slice(2);
if (!manifestPath) {
  console.error('usage: reorg-plan.mjs <manifest.json> [outDir]');
  process.exit(2);
}

// Files that sit in the wrong course entirely. Redirected before classification.
const MISFILED = [
  {
    match: /^PHY109\/AROY\/Lab_Manuals\/Manuals_Printable\/([^/]*eco[^/]*)$/i,
    to: 'ECO7101/NTM/$1',
    why: 'Economics material inside PHY109 lab manuals',
  },
  {
    match: /^MAT205\/ALAM\/(CoverPage_Mat104_Assignment\.docx)$/,
    to: 'MAT104/DMY/$1',
    why: 'MAT104 cover page inside MAT205',
  },
];

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const files = manifest.filter((f) => f.type === 'file');

const entries = files.map((f) => {
  let source = f.path;
  const reasons = [];
  for (const m of MISFILED) {
    if (m.match.test(source)) {
      source = source.replace(m.match, m.to);
      reasons.push(m.why);
    }
  }
  const c = canonicalPath(source, { size: f.size });
  return { from: f.path, to: c.path, size: f.size, ...c, reasons: [...reasons, ...c.reasons], redirected: source !== f.path };
});

// --- duplicates: same course + instructor + tidy name + size ---------------
const groups = new Map();
for (const e of entries) {
  // "CSE207 MID Practice.pdf" and "CSE207_MID_Practice.pdf" at the same size are one file.
  // (md5 is re-checked before anything is trashed.)
  const key = [e.course, e.instructor, e.to.split('/').pop().toLowerCase().replace(/[\s_-]+/g, ' '), e.size].join('|');
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(e);
}
// Prefer: original course over a misfiled copy, a folder that agrees with the
// file name, a dated copy, the newest semester, then the shorter path.
const score = (e) =>
  (e.redirected ? 0 : 8) +
  (categoryFromName(e.from.split('/').pop(), e.size) === e.category ? 2 : 0) +
  (e.semester ? 1 : 0) + semesterKey(e.semester) / 1000 - e.from.length / 1e5;
for (const g of groups.values()) {
  if (g.length < 2 || g[0].size === 0) continue;
  g.sort((a, b) => score(b) - score(a));
  const keep = g[0];
  for (const d of g.slice(1)) {
    d.action = 'trash';
    d.duplicateOf = keep.to;
    d.reasons.push(`identical name+size to ${keep.from} (md5 re-checked before trashing)`);
  }
}

// --- target collisions with different content -----------------------------
const byTarget = new Map();
for (const e of entries.filter((x) => x.action !== 'trash')) {
  if (!byTarget.has(e.to)) byTarget.set(e.to, []);
  byTarget.get(e.to).push(e);
}
for (const [, g] of byTarget) {
  if (g.length < 2) continue;
  // Keep the first; disambiguate the rest by the folder they came from.
  g.slice(1).forEach((e, i) => {
    const origin = e.from.split('/').slice(-2, -1)[0].replace(/\s+/g, ' ');
    const dot = e.to.lastIndexOf('.');
    const tagged = `${e.to.slice(0, dot)} [${origin}]${e.to.slice(dot)}`;
    e.reasons.push(`name clash at ${e.to}, tagged with origin folder`);
    e.to = byTarget.has(tagged) ? `${e.to.slice(0, dot)} [${origin} ${i + 2}]${e.to.slice(dot)}` : tagged;
  });
}

for (const e of entries) e.action ??= e.from === e.to ? 'keep' : 'move';

// --- outputs ----------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true });
const plan = entries
  // A trash entry keeps its canonical path as `fallbackTo`: if the md5 check at
  // apply time shows it isn't really a duplicate, it is moved there instead.
  .map(({ from, to, action, size, reasons, duplicateOf }) => ({
    action, from, to: action === 'trash' ? null : to, size, duplicateOf, ...(action === 'trash' ? { fallbackTo: to } : {}), reasons,
  }))
  .sort((a, b) => a.from.localeCompare(b.from));
fs.writeFileSync(path.join(outDir, 'plan.json'), JSON.stringify(plan, null, 1) + '\n');

const csv = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
fs.writeFileSync(
  path.join(outDir, 'plan.csv'),
  ['action,from,to,size,reasons', ...plan.map((p) => [p.action, p.from, p.to ?? `(trash; duplicate of ${p.duplicateOf})`, p.size, p.reasons.join('; ')].map(csv).join(','))].join('\n') + '\n',
);

const count = (a) => plan.filter((p) => p.action === a).length;
const trashBytes = plan.filter((p) => p.action === 'trash').reduce((s, p) => s + p.size, 0);
const byCat = Object.fromEntries(CATEGORIES.map((c) => [c, 0]));
for (const e of entries) if (e.action !== 'trash') byCat[e.category]++;
const fromName = entries.filter((e) => e.action !== 'trash' && e.reasons.some((r) => r.startsWith('category from filename')));

const tree = new Map();
for (const e of entries) {
  if (e.action === 'trash') continue;
  const k = `${e.course}/${e.instructor}`;
  if (!tree.has(k)) tree.set(k, new Map());
  const cats = tree.get(k);
  const label = e.category + (e.semester ? `/${e.semester}` : '');
  cats.set(label, (cats.get(label) || 0) + 1);
}

const md = [];
md.push('# Drive reorganisation plan', '');
md.push(`Files: ${plan.length} · move/rename: ${count('move')} · already in place: ${count('keep')} · trash (duplicates): ${count('trash')} (${(trashBytes / 1e6).toFixed(1)} MB)`, '');
md.push('Layout: `COURSE / INSTRUCTOR / Category / [Semester] / …`', '');
md.push('Categories, in this order everywhere: ' + CATEGORIES.map((c) => `\`${c}\``).join(', '), '');
md.push('## Resulting structure', '', '```');
for (const k of [...tree.keys()].sort()) {
  md.push(k);
  const cats = tree.get(k);
  const labels = [...cats.keys()].sort((a, b) => CATEGORIES.indexOf(a.split('/')[0]) - CATEGORIES.indexOf(b.split('/')[0]) || semesterKey(b.split('/')[1]) - semesterKey(a.split('/')[1]));
  for (const l of labels) md.push(`    ${l.padEnd(26)} ${String(cats.get(l)).padStart(4)}`);
}
md.push('```', '', '## Duplicates to trash', '', 'Drive keeps trashed files for 30 days. md5 is re-verified before each one is trashed.', '');
for (const p of plan.filter((x) => x.action === 'trash')) md.push(`- \`${p.from}\` → duplicate of \`${p.duplicateOf}\``);
md.push('', '## Classified by filename (please skim)', '', 'These sat directly in an instructor folder, so the category comes from the file name.', '');
for (const e of fromName.sort((a, b) => a.to.localeCompare(b.to))) md.push(`- \`${e.from.split('/').slice(0, 2).join('/')}/…/${e.from.split('/').pop()}\` → **${e.category}**`);
md.push('', '## Per-category totals', '');
for (const [c, n] of Object.entries(byCat)) md.push(`- ${c}: ${n}`);
fs.writeFileSync(path.join(outDir, 'PLAN.md'), md.join('\n') + '\n');

console.log(`plan: ${plan.length} files · move ${count('move')} · keep ${count('keep')} · trash ${count('trash')} (${(trashBytes / 1e6).toFixed(1)} MB) · by-filename ${fromName.length}`);
console.log('categories:', byCat);
