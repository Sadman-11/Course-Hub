// End-to-end: real git (blobless clone, plumbing commit, push) against a local
// bare repo, with a local folder standing in for Drive.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'index.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sync-it-'));
const remote = path.join(tmp, 'remote.git');
const drive = path.join(tmp, 'drive');
const url = `file:///${remote.replace(/\\/g, '/')}`;

const git = (cwd, ...args) => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'buffer' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
};
const remoteTree = () => {
  const out = git(remote, 'ls-tree', '-r', 'main').toString();
  return new Map(out.trim().split('\n').filter(Boolean).map((l) => { const [meta, p] = l.split('\t'); return [p, meta.split(' ')[2]]; }));
};
const remoteFile = (p) => git(remote, 'show', `main:${p}`);
const head = () => git(remote, 'rev-parse', 'main').toString().trim();
const put = (root, rel, data) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), data); };

function sync(extraEnv = {}, extraArgs = []) {
  const r = spawnSync(process.execPath, [entry, ...extraArgs], {
    encoding: 'utf8',
    env: {
      // SYNC_SIZES_GIT_DIR stands in for the GitHub trees API, so the clone stays
      // truly blobless and the no-lazy-fetch guards on commit/push are exercised.
      ...process.env, SYNC_FAKE_DRIVE: drive, SYNC_REPO_URL: url, DRIVE_ROOT_ID: 'root', SYNC_SIZES_GIT_DIR: remote,
      SYNC_MAX_GIT_BYTES: '1000', SYNC_API: '', SYNC_TOKEN: '', GITHUB_REPOSITORY: '', ...extraEnv,
    },
  });
  return { code: r.status, out: r.stdout + r.stderr };
}

function pushFromClone(mutate) {
  const work = fs.mkdtempSync(path.join(tmp, 'work-'));
  git(tmp, 'clone', '-q', url, work);
  mutate(work);
  git(work, 'add', '-A');
  git(work, 'commit', '-qm', 'edit on github');
  git(work, 'push', '-q', 'origin', 'main');
}

test('setup', () => {
  git(tmp, 'init', '-q', '--bare', '-b', 'main', remote);
  git(remote, 'config', 'uploadpack.allowFilter', 'true');
  git(remote, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
  const seed = path.join(tmp, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  put(seed, 'README.md', '# readme\n');
  put(seed, '.github/workflows/sync.yml', 'on: push\n');
  put(seed, 'CSE207/MI/a.pdf', 'AAAA');
  put(seed, 'CSE207/MI/code.c', 'int main(){}\n');
  put(seed, 'ENG/Rubric (2).docx', 'RUBRIC-BYTES');
  put(seed, 'CSE207/MI/only-github.zip', 'ZIP');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', url, 'main');

  put(drive, 'CSE207/MI/a.pdf', 'AAAA');
  put(drive, 'CSE207/MI/code.c', 'int main(){}\r\n'); // Drive keeps CRLF
  put(drive, 'ENG/Rubric 2.docx', 'RUBRIC-BYTES'); // renamed on Drive
  put(drive, 'CSE207/MI/new.pdf', 'NEW');
  put(drive, 'PHY/video.mp4', Buffer.alloc(2000, 1)); // over the (test) limit
});

test('bootstrap run reconciles both sides', () => {
  const r = sync();
  assert.equal(r.code, 0, r.out);
  const t = remoteTree();
  assert.ok(t.has('README.md') && t.has('.github/workflows/sync.yml'), 'repo-only files untouched');
  assert.equal(remoteFile('CSE207/MI/code.c').toString(), 'int main(){}\r\n', 'byte-exact (CRLF kept)');
  assert.ok(t.has('ENG/Rubric 2.docx') && !t.has('ENG/Rubric (2).docx'), 'rename detected, not duplicated');
  assert.ok(!fs.existsSync(path.join(drive, 'ENG/Rubric (2).docx')), 'old name not re-created on Drive');
  assert.ok(t.has('CSE207/MI/new.pdf'));
  assert.ok(!t.has('PHY/video.mp4'), 'large file stays Drive-only');
  assert.equal(fs.readFileSync(path.join(drive, 'CSE207/MI/only-github.zip'), 'utf8'), 'ZIP', 'GitHub-only file copied to Drive');
  const state = JSON.parse(remoteFile('.sync/state.json'));
  assert.equal(state.files['PHY/video.mp4'].sha, null);
  assert.ok(state.files['CSE207/MI/a.pdf'].sha);
});

test('second run is a no-op', () => {
  const before = head();
  const r = sync();
  assert.equal(r.code, 0, r.out);
  assert.equal(head(), before, r.out);
});

test('Drive move becomes a git rename with the same blob', () => {
  const sha = remoteTree().get('CSE207/MI/a.pdf');
  const ids = JSON.parse(fs.readFileSync(path.join(drive, '.ids.json'), 'utf8'));
  fs.mkdirSync(path.join(drive, 'CSE207/MI/Lectures'), { recursive: true });
  fs.renameSync(path.join(drive, 'CSE207/MI/a.pdf'), path.join(drive, 'CSE207/MI/Lectures/a.pdf'));
  ids['CSE207/MI/Lectures/a.pdf'] = ids['CSE207/MI/a.pdf'];
  delete ids['CSE207/MI/a.pdf'];
  fs.writeFileSync(path.join(drive, '.ids.json'), JSON.stringify(ids));
  const r = sync();
  assert.equal(r.code, 0, r.out);
  const t = remoteTree();
  assert.equal(t.get('CSE207/MI/Lectures/a.pdf'), sha);
  assert.ok(!t.has('CSE207/MI/a.pdf'));
  assert.match(git(remote, 'log', '-1', '--format=%s', 'main').toString(), /→1/);
});

test('GitHub edits and additions flow to Drive', () => {
  pushFromClone((w) => {
    fs.writeFileSync(path.join(w, 'CSE207/MI/new.pdf'), 'NEW-v2');
    put(w, 'CSE110/X/Code/Hello.java', 'class Hello {}\n');
  });
  const r = sync();
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(path.join(drive, 'CSE207/MI/new.pdf'), 'utf8'), 'NEW-v2');
  assert.equal(fs.readFileSync(path.join(drive, 'CSE110/X/Code/Hello.java'), 'utf8'), 'class Hello {}\n');
});

test('GitHub deletion trashes on Drive (recoverable)', () => {
  pushFromClone((w) => fs.rmSync(path.join(w, 'CSE207/MI/only-github.zip')));
  const r = sync();
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(drive, 'CSE207/MI/only-github.zip')));
  assert.equal(fs.readdirSync(path.join(drive, '.trash')).length, 1);
});

test('mass deletion is blocked until approved by plan hash', () => {
  for (const f of ['CSE207/MI/new.pdf', 'CSE207/MI/code.c', 'ENG/Rubric 2.docx']) fs.rmSync(path.join(drive, f));
  const before = head();
  const blocked = sync({ MAX_DELETES: '1' });
  assert.equal(blocked.code, 3, blocked.out);
  assert.equal(head(), before, 'nothing pushed while blocked');
  const hash = /hash=([0-9a-f]+)/.exec(blocked.out)[1];
  const approved = sync({ MAX_DELETES: '1' }, [`--approve=${hash}`]);
  assert.equal(approved.code, 0, approved.out);
  const t = remoteTree();
  assert.ok(!t.has('CSE207/MI/new.pdf') && !t.has('CSE207/MI/code.c'));
  assert.ok(t.has('README.md'));
});
