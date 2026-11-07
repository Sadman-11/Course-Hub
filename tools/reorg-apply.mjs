#!/usr/bin/env node
// Apply a reorganisation plan (from tools/reorg-plan.mjs) to the Drive library.
//
//   node tools/reorg-apply.mjs reorg/plan.json            # dry run: shows what would happen
//   node tools/reorg-apply.mjs reorg/plan.json --apply    # do it, writes reorg/applied-<time>.json
//   node tools/reorg-apply.mjs --undo=reorg/applied-<time>.json [--apply]
//
// Credentials: same as the sync (SYNC_API + SYNC_TOKEN, or GOOGLE_CLIENT_ID /
// GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN). DRIVE_ROOT_ID and GITHUB_REPO too.
//
// Safety
// - Refuses to run before the first sync has written .sync/state.json: the sync
//   tracks files by Drive ID, which is what turns these moves into Git renames
//   instead of 920 deletions + 920 additions.
// - Moves keep each file's Drive ID, sharing and history. Nothing is re-uploaded.
// - Duplicates are trashed (recoverable 30 days) only if their md5 matches the copy kept.
// - Idempotent: files already at their destination are skipped, so it can be re-run.
// - Every operation is logged; --undo reverses a log.
import fs from 'node:fs';
import path from 'node:path';
import { Drive, tokenSource } from '../sync/google.js';

const args = Object.fromEntries(process.argv.slice(2).filter((a) => a.startsWith('--')).map((a) => {
  const [k, v] = a.slice(2).split('=');
  return [k, v ?? true];
}));
const planFile = process.argv.slice(2).find((a) => !a.startsWith('--'));
const APPLY = Boolean(args.apply);
const env = process.env;
const root = env.DRIVE_ROOT_ID || '1jTPTsKcrJIgU9ciUM1sSpYe0qig2MvZW';
const repo = env.GITHUB_REPO || 'Sadman-11/Course-Materials';
// SYNC_FAKE_DRIVE=<dir>: rehearse against a local folder instead of Google Drive.
const drive = env.SYNC_FAKE_DRIVE
  ? new (await import('../sync/test/fake-drive.js')).FakeDrive(env.SYNC_FAKE_DRIVE)
  : new Drive(tokenSource('storage', env));
const dir = (p) => p.slice(0, Math.max(0, p.lastIndexOf('/')));
const base = (p) => p.slice(p.lastIndexOf('/') + 1);
const log = [];
const say = (...a) => console.log(APPLY ? '' : '[dry run]', ...a);

async function main() {
  if (args.undo) return undo(args.undo);
  if (!planFile) throw new Error('usage: reorg-apply.mjs <plan.json> [--apply]');

  if (!args.force) {
    const r = await fetch(`https://raw.githubusercontent.com/${repo}/main/.sync/state.json`);
    if (!r.ok) throw new Error('No .sync/state.json on GitHub yet. Run the first sync before reorganising (or pass --force if you know why not).');
  }

  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  console.log('listing Drive…');
  const { files, folders } = await drive.tree(root);
  const moves = plan.filter((p) => p.action === 'move');
  const trash = plan.filter((p) => p.action === 'trash');
  const touchedDirs = new Set();
  const stats = { moved: 0, already: 0, missing: 0, trashed: 0, keptNotIdentical: 0, failed: 0 };

  for (const m of moves) {
    const f = files.get(m.from);
    if (!f) {
      if (files.has(m.to)) stats.already++;
      else { stats.missing++; console.warn(`  ? missing on Drive: ${m.from}`); }
      continue;
    }
    if (files.has(m.to) && m.to !== m.from) { stats.failed++; console.warn(`  ! destination taken, skipped: ${m.to}`); continue; }
    say(`  → ${m.from}\n      ${m.to}`);
    if (APPLY) {
      try {
        const parent = await drive.ensureFolder(dir(m.to), folders);
        await drive.move(f.id, { name: base(m.to), addParent: parent, removeParent: folders.get(dir(m.from)) });
        log.push({ op: 'move', id: f.id, from: m.from, to: m.to });
      } catch (e) { stats.failed++; console.error(`  ✗ ${m.from}: ${e.message}`); continue; }
    }
    files.set(m.to, f);
    files.delete(m.from);
    touchedDirs.add(dir(m.from));
    stats.moved++;
  }

  for (const t of trash) {
    const f = files.get(t.from);
    const keep = files.get(t.duplicateOf);
    if (!f) { stats.already++; continue; }
    if (!keep || !f.md5 || f.md5 !== keep.md5) {
      // Not really a duplicate: keep it, but still file it in the canonical folder.
      stats.keptNotIdentical++;
      let to = t.fallbackTo || t.duplicateOf;
      for (let n = 2; files.has(to); n++) to = to.replace(/(\.[^./]+)?$/, (e) => ` (${n})${e}`).replace(/ \((\d+)\) \((\d+)\)/, ' ($2)');
      say(`  = not identical to ${t.duplicateOf}; filing as ${to}`);
      if (APPLY) {
        try {
          const parent = await drive.ensureFolder(dir(to), folders);
          await drive.move(f.id, { name: base(to), addParent: parent, removeParent: folders.get(dir(t.from)) });
          log.push({ op: 'move', id: f.id, from: t.from, to });
        } catch (e) { stats.failed++; console.error(`  ✗ ${t.from}: ${e.message}`); continue; }
      }
      files.set(to, f);
      files.delete(t.from);
      touchedDirs.add(dir(t.from));
      continue;
    }
    say(`  ✗ trash duplicate ${t.from}`);
    if (APPLY) {
      try { await drive.trash(f.id); log.push({ op: 'trash', id: f.id, from: t.from }); } catch (e) { stats.failed++; console.error(`  ✗ ${t.from}: ${e.message}`); continue; }
    }
    files.delete(t.from);
    touchedDirs.add(dir(t.from));
    stats.trashed++;
  }

  // Trash folders that this run emptied, deepest first. Only ones we touched.
  const candidates = new Set();
  for (const d of touchedDirs) for (let p = d; p; p = dir(p)) candidates.add(p);
  const remaining = new Set([...files.keys()].flatMap((p) => { const out = []; for (let d = dir(p); d; d = dir(d)) out.push(d); return out; }));
  const emptied = [...candidates].filter((d) => !remaining.has(d) && folders.has(d)).sort((a, b) => b.split('/').length - a.split('/').length);
  for (const d of emptied) {
    if (APPLY) {
      const kids = await drive.children(folders.get(d));
      if (kids.length) continue; // something not in the plan lives here; leave it
      await drive.trash(folders.get(d));
      log.push({ op: 'trash-folder', id: folders.get(d), from: d });
    }
    say(`  ✗ empty folder ${d}`);
  }

  console.log('\n', { ...stats, emptyFolders: emptied.length });
  if (APPLY && log.length) {
    const out = path.join(path.dirname(planFile), `applied-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(out, JSON.stringify(log, null, 1));
    console.log(`log: ${out}  (undo with --undo=${out} --apply)`);
    console.log('Next: run a sync. Expect it to ask for approval of the duplicate removals; that is the mass-delete guard working.');
  } else if (!APPLY) console.log('Dry run only. Re-run with --apply to make these changes.');
}

async function undo(logFile) {
  const entries = JSON.parse(fs.readFileSync(logFile, 'utf8')).reverse();
  const untrash = (id) => drive.req(`https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=id`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ trashed: false }),
  });
  // Restore emptied folders first, then list, so moves go back into the original folders.
  for (const e of entries.filter((x) => x.op === 'trash-folder')) {
    say(`  restore folder ${e.from}`);
    if (APPLY) await untrash(e.id);
  }
  const { folders } = await drive.tree(root);
  for (const e of entries.filter((x) => x.op !== 'trash-folder')) {
    say(`  undo ${e.op} ${e.from}`);
    if (!APPLY) continue;
    if (e.op === 'move') {
      const parent = await drive.ensureFolder(dir(e.from), folders);
      await drive.move(e.id, { name: base(e.from), addParent: parent, removeParent: folders.get(dir(e.to)) });
    } else await untrash(e.id);
  }
  console.log(APPLY ? 'undone.' : 'Dry run only. Add --apply to undo.');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
