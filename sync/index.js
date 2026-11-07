#!/usr/bin/env node
// Course Materials sync: Google Drive <-> GitHub, plus Classroom import.
//
//   node sync/index.js [--dry-run] [--approve=<planHash>] [--skip-classroom]
//                      [--list-drive=<out.json>] [--repo-dir=<dir>]
//
// Environment
//   DRIVE_ROOT_ID       Drive folder that holds the library (required)
//   GITHUB_REPOSITORY   owner/repo of the content repo (Actions sets this)
//   GITHUB_TOKEN        token with contents:write on that repo
//   SYNC_BRANCH         default "main"
//   SYNC_API, SYNC_TOKEN  Worker base URL + shared secret (token broker, reports)
//   GOOGLE_CLIENT_ID/SECRET/REFRESH_TOKEN  alternative to the broker (local runs)
//   MAX_DELETES         deletions allowed without approval (default: max(10, 3% of files))
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Drive, tokenSource, mapLimit } from './google.js';
import { Git, githubSizes } from './git.js';
import { plan as makePlan, planHash, deletions, summary } from './plan.js';
import { compileIgnore } from './ignore.js';
import { importClassroom } from './classroom.js';
import { Reporter } from './report.js';

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const env = process.env;
const DRY = Boolean(args['dry-run'] || env.SYNC_DRY_RUN === 'true');
const STATE_PATH = '.sync/state.json';
const REPO_ONLY = /^(\.github\/|\.sync\/|README\.md$|LICENSE$|\.gitattributes$|\.gitignore$|\.syncignore$)/i;
const AUTHOR = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com' };

const MIME = {
  pdf: 'application/pdf', doc: 'application/msword', txt: 'text/plain', md: 'text/markdown', csv: 'text/csv',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  zip: 'application/zip', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', mp4: 'video/mp4',
  html: 'text/html', json: 'application/json', c: 'text/x-c', cpp: 'text/x-c++', java: 'text/x-java', py: 'text/x-python',
};
const mimeOf = (p) => MIME[p.split('.').pop().toLowerCase()] || 'application/octet-stream';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function main() {
  const rootId = env.DRIVE_ROOT_ID;
  if (!rootId) throw new Error('DRIVE_ROOT_ID is not set');
  const reporter = new Reporter(env);
  const started = new Date().toISOString();
  // SYNC_FAKE_DRIVE=<dir> swaps Drive for a local folder (integration tests / offline dry runs).
  const storage = env.SYNC_FAKE_DRIVE
    ? new (await import('./test/fake-drive.js')).FakeDrive(env.SYNC_FAKE_DRIVE)
    : new Drive(tokenSource('storage', env));

  // --- Drive listing only (for planning tools) -------------------------------
  if (args['list-drive']) {
    const { files, folders } = await storage.tree(rootId);
    const rows = [...[...folders.keys()].filter(Boolean).map((p) => ({ path: p, type: 'dir' })),
      ...[...files].map(([p, f]) => ({ path: p, type: 'file', size: f.size, md5: f.md5, id: f.id, modified: f.mtime }))];
    fs.writeFileSync(args['list-drive'], JSON.stringify(rows, null, 1));
    log(`wrote ${files.size} files / ${folders.size - 1} folders to ${args['list-drive']}`);
    return;
  }

  // --- Repo ------------------------------------------------------------------
  const repo = env.GITHUB_REPOSITORY;
  const branch = env.SYNC_BRANCH || 'main';
  let git;
  if (args['repo-dir']) {
    git = new Git(args['repo-dir']);
  } else {
    const url = env.SYNC_REPO_URL || (repo && env.GITHUB_TOKEN && `https://x-access-token:${env.GITHUB_TOKEN}@github.com/${repo}.git`);
    if (!url) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'content-'));
    log(`cloning ${repo || url} (blobless)…`);
    git = await Git.clone(url, dir, { branch });
  }
  const headBefore = await git.head();
  // Blob sizes without downloading blobs: GitHub API in CI; a local bare repo in tests;
  // `ls-tree -l` only for explicit local runs (--repo-dir), where blobs are cheap.
  let sizeOf;
  if (env.SYNC_SIZES_GIT_DIR) {
    const out = await new Git(env.SYNC_SIZES_GIT_DIR).run(['ls-tree', '-r', '-l', '-z', headBefore]);
    const m = new Map(out.split('\0').filter(Boolean).map((r) => [r.slice(r.indexOf('\t') + 1), Number(r.split(/\s+/)[3])]));
    sizeOf = (p) => m.get(p);
  } else if (!args['repo-dir']) {
    sizeOf = await githubSizes(repo, env.GITHUB_TOKEN, headBefore).catch((e) => {
      log(`blob sizes unavailable (${e.message}); rename pairing disabled this run`);
      return () => -1;
    });
  }
  const fullTree = await git.tree('HEAD', { sizeOf });
  const readText = async (p) => (fullTree.has(p) ? (await git.catBlob(fullTree.get(p).sha)).toString('utf8') : null);
  const stateDoc = JSON.parse((await readText(STATE_PATH)) || '{"version":1,"files":{}}');
  const state = new Map(Object.entries(stateDoc.files));
  const isIgnored = compileIgnore((await readText('.syncignore')) || '');
  const gitFiles = new Map([...fullTree].filter(([p]) => !REPO_ONLY.test(p)));

  // --- Classroom → Drive -----------------------------------------------------
  let classroom = { imported: [], errors: [] };
  if (!args['skip-classroom'] && reporter.enabled) {
    try {
      classroom = await importClassroom({ env, storage, rootId, reporter, dry: DRY, log });
    } catch (e) {
      classroom.errors.push(String(e.message || e));
      log('classroom phase failed:', e.message);
    }
  }

  // --- Drive listing ---------------------------------------------------------
  log('listing Drive…');
  const { files: driveAll, folders, issues } = await storage.tree(rootId);
  const drive = new Map([...driveAll].filter(([p]) => !REPO_ONLY.test(p)));
  log(`drive: ${drive.size} files, ${folders.size - 1} folders · github: ${gitFiles.size} files · state: ${state.size}`);
  if (drive.size === 0 && gitFiles.size > 0) {
    throw new Error('Drive listing is empty but GitHub is not. Refusing to sync (wrong DRIVE_ROOT_ID or lost access?)');
  }

  // --- Plan --------------------------------------------------------------------
  const p = makePlan(drive, gitFiles, state, {
    isIgnored, ...(env.SYNC_MAX_GIT_BYTES ? { maxGitBytes: Number(env.SYNC_MAX_GIT_BYTES) } : {}),
  });
  const hash = planHash(p);
  const dels = deletions(p);
  const maxDeletes = Number(env.MAX_DELETES || Math.max(10, Math.ceil(drive.size * 0.03)));
  const counts = summary(p);
  log('plan', JSON.stringify(counts), `deletions=${dels.length} hash=${hash}`);

  const base = {
    started, trigger: env.SYNC_TRIGGER || env.GITHUB_EVENT_NAME || 'manual', runId: env.GITHUB_RUN_ID,
    runUrl: env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    planHash: hash, counts, issues: issues.slice(0, 200), conflicts: p.conflicts, classroom,
    details: detailLists(p),
  };

  if (dels.length > maxDeletes && args.approve !== hash) {
    log(`blocked: ${dels.length} deletions > ${maxDeletes}. Re-run with --approve=${hash} (or approve in the dashboard).`);
    await reporter.run({ ...base, status: 'needs_approval', finished: new Date().toISOString(), deletions: dels });
    process.exitCode = 3;
    return;
  }
  if (DRY) {
    await reporter.run({ ...base, status: 'dry_run', finished: new Date().toISOString(), deletions: dels });
    log('dry run: nothing changed');
    return;
  }

  // --- Apply: Drive → Git ------------------------------------------------------
  const errors = [];
  const fail = (where, item, e) => {
    const pathKey = item.path || item.to;
    errors.push({ where, path: pathKey, error: String(e.message || e).slice(0, 300) });
    log(`  ✗ ${where} ${pathKey}: ${e.message}`);
    // Restore the previous state for this path so the next run retries it.
    if (item.from) { p.next.delete(item.to); if (state.has(item.from)) p.next.set(item.from, state.get(item.from)); return; }
    if (state.has(pathKey)) p.next.set(pathKey, state.get(pathKey));
    else p.next.delete(pathKey);
  };
  const staged = [];
  const fallbackUploads = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-'));
  let verified = 0;

  const pulls = [...p.toGit.add, ...p.toGit.update];
  log(`downloading ${pulls.length} file(s) from Drive…`);
  await mapLimit(pulls, 6, async (item, i) => {
    const file = path.join(tmp, String(i));
    try {
      await storage.download(item.entry, file);
      const sha = await git.hashFile(file);
      const next = p.next.get(item.path);
      if (next) next.sha = sha;
      if (item.expectSha && item.expectSha === sha) { verified++; return; }
      if (item.replaces) {
        if (item.replaces.sha === sha) staged.push({ path: item.replaces.path, remove: true });
        else fallbackUploads.push({ path: item.replaces.path, sha: item.replaces.sha });
      }
      staged.push({ path: item.path, sha, mode: item.mode });
    } catch (e) {
      fail('drive→git', item, e);
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
  for (const mv of p.toGit.move) staged.push({ path: mv.from, remove: true }, { path: mv.to, sha: mv.sha, mode: mv.mode });
  for (const r of p.toGit.remove) staged.push({ path: r.path, remove: true });

  // --- Apply: Git → Drive ------------------------------------------------------
  const uploads = [...p.toDrive.upload, ...fallbackUploads];
  for (const u of fallbackUploads) p.next.set(u.path, { id: undefined, md5: undefined, sha: u.sha });
  await git.prefetch([...uploads, ...p.toDrive.update].map((x) => x.sha));
  const folderOf = (fp) => fp.slice(0, Math.max(0, fp.lastIndexOf('/')));
  const nameOf = (fp) => fp.slice(fp.lastIndexOf('/') + 1);
  for (const u of uploads) {
    try {
      const buf = await git.catBlob(u.sha);
      const parent = await storage.ensureFolder(folderOf(u.path), folders);
      const f = await storage.upload(nameOf(u.path), parent, buf, mimeOf(u.path));
      p.next.set(u.path, { id: f.id, md5: f.md5Checksum, sha: u.sha, size: Number(f.size) });
      driveAll.set(u.path, { id: f.id, size: Number(f.size), mtime: f.modifiedTime, ctime: f.createdTime });
      log(`  ↑ ${u.path}`);
    } catch (e) { fail('git→drive upload', u, e); }
  }
  for (const u of p.toDrive.update) {
    try {
      const f = await storage.updateContent(u.id, await git.catBlob(u.sha), mimeOf(u.path));
      p.next.set(u.path, { id: f.id, md5: f.md5Checksum, sha: u.sha, size: Number(f.size) });
    } catch (e) { fail('git→drive update', u, e); }
  }
  for (const mv of p.toDrive.move) {
    try {
      const parent = await storage.ensureFolder(folderOf(mv.to), folders);
      await storage.move(mv.id, { name: nameOf(mv.to), addParent: parent, removeParent: folders.get(folderOf(mv.from)) });
    } catch (e) { fail('git→drive move', mv, e); }
  }
  for (const t of p.toDrive.trash) {
    try { await storage.trash(t.id); } catch (e) { fail('git→drive trash', t, e); }
  }

  // --- State + commit ------------------------------------------------------------
  const nextState = [...p.next].filter(([, v]) => v && v.sha !== undefined).sort(([a], [b]) => a.localeCompare(b));
  const stateText = '{\n"version": 1,\n"root": ' + JSON.stringify(rootId) + ',\n"files": {\n' +
    nextState.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',\n') + '\n}\n}\n';
  staged.push({ path: STATE_PATH, sha: await git.hashBuffer(Buffer.from(stateText)) });
  await git.stage(staged);

  const c = summary(p);
  const title = `sync: ${[c.gitAdd && `+${c.gitAdd}`, c.gitUpdate && `~${c.gitUpdate}`, c.gitMove && `→${c.gitMove}`, c.gitRemove && `-${c.gitRemove}`].filter(Boolean).join(' ') || 'state'} from Drive`;
  const body = commitBody(p, base.runUrl);
  const commit = await git.commit(`${title}\n\n${body}`, AUTHOR);
  if (commit) {
    log(`pushing ${commit.slice(0, 7)}…`);
    await git.push(branch);
  } else log('nothing to commit');

  const status = errors.length ? 'partial' : 'ok';
  await reporter.run({ ...base, status, finished: new Date().toISOString(), commit: commit || headBefore, verified, errors });
  await reporter.catalog(buildCatalog(nextState, driveAll, commit || headBefore, isIgnored));
  log(`done: ${status}${errors.length ? ` (${errors.length} errors)` : ''}`);
  if (errors.length) process.exitCode = 1;
}

function detailLists(p, cap = 400) {
  const take = (arr, f) => arr.slice(0, cap).map(f);
  return {
    gitAdd: take(p.toGit.add, (x) => x.path),
    gitUpdate: take(p.toGit.update.filter((u) => !u.expectSha), (x) => x.path),
    gitMove: take(p.toGit.move, (x) => [x.from, x.to]),
    gitRemove: take(p.toGit.remove, (x) => [x.path, x.why]),
    driveUpload: take(p.toDrive.upload, (x) => x.path),
    driveUpdate: take(p.toDrive.update, (x) => x.path),
    driveMove: take(p.toDrive.move, (x) => [x.from, x.to]),
    driveTrash: take(p.toDrive.trash, (x) => [x.path, x.why]),
    driveOnly: take(p.driveOnly, (x) => [x.path, x.reason]),
  };
}

function commitBody(p, runUrl) {
  const lines = [];
  const sec = (label, arr, f) => {
    if (!arr.length) return;
    lines.push(`${label}:`);
    for (const x of arr.slice(0, 40)) lines.push(`  ${f(x)}`);
    if (arr.length > 40) lines.push(`  … and ${arr.length - 40} more`);
    lines.push('');
  };
  sec('Added', p.toGit.add, (x) => x.path);
  sec('Updated', p.toGit.update.filter((u) => !u.expectSha), (x) => x.path);
  sec('Moved', p.toGit.move, (x) => `${x.from} → ${x.to}`);
  sec('Removed', p.toGit.remove, (x) => `${x.path} (${x.why})`);
  sec('Pushed to Drive', [...p.toDrive.upload, ...p.toDrive.update], (x) => x.path);
  if (runUrl) lines.push(`Run: ${runUrl}`);
  return lines.join('\n');
}

function buildCatalog(nextState, driveAll, commit, isIgnored) {
  // Compact rows: [path, size, mtime, ctime, driveId, gitSha|null]
  const rows = [];
  for (const [p, s] of nextState) {
    const d = driveAll.get(p);
    if (!d) continue; // git-only leftovers (should not happen after a clean run)
    rows.push([p, d.size, d.mtime, d.ctime, d.id, s.sha || null]);
  }
  return { commit, generated: new Date().toISOString(), files: rows };
}

main().catch(async (e) => {
  console.error(e);
  try {
    await new Reporter(env).run({ status: 'failed', started: new Date().toISOString(), finished: new Date().toISOString(),
      trigger: env.SYNC_TRIGGER || env.GITHUB_EVENT_NAME, runId: env.GITHUB_RUN_ID, errors: [{ where: 'fatal', error: String(e.message || e) }] });
  } catch { /* ignore */ }
  process.exit(1);
});
