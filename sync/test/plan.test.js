import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plan, planHash, summary, MAX_GIT_BYTES } from '../plan.js';
import { compileIgnore } from '../ignore.js';

const D = (id, md5, size = 10, extra = {}) => ({ id, md5, size, mtime: '2026-01-01T00:00:00Z', ...extra });
const G = (sha, size = 10) => ({ sha, size, mode: '100644' });
const S = (id, md5, sha, size = 10) => ({ id, md5, sha, size });
const m = (o) => new Map(Object.entries(o));

test('unchanged on both sides does nothing', () => {
  const p = plan(m({ 'A/x.pdf': D('1', 'm1') }), m({ 'A/x.pdf': G('s1') }), m({ 'A/x.pdf': S('1', 'm1', 's1') }));
  assert.equal(p.unchanged, 1);
  assert.deepEqual(Object.values(summary(p)).reduce((a, b) => a + b, 0), 1);
});

test('new on Drive → added to GitHub', () => {
  const p = plan(m({ 'A/new.pdf': D('9', 'm9') }), m({}), m({}));
  assert.equal(p.toGit.add[0].path, 'A/new.pdf');
});

test('new on GitHub → uploaded to Drive', () => {
  const p = plan(m({}), m({ 'A/n.c': G('sn') }), m({}));
  assert.deepEqual(p.toDrive.upload, [{ path: 'A/n.c', sha: 'sn' }]);
});

test('edited on Drive → GitHub updated', () => {
  const p = plan(m({ x: D('1', 'm2') }), m({ x: G('s1') }), m({ x: S('1', 'm1', 's1') }));
  assert.equal(p.toGit.update.length, 1);
  assert.equal(p.toDrive.update.length, 0);
});

test('edited on GitHub → Drive updated', () => {
  const p = plan(m({ x: D('1', 'm1') }), m({ x: G('s2') }), m({ x: S('1', 'm1', 's1') }));
  assert.deepEqual(p.toDrive.update, [{ path: 'x', id: '1', sha: 's2' }]);
});

test('edited on both → conflict, Drive wins', () => {
  const p = plan(m({ x: D('1', 'm2') }), m({ x: G('s2') }), m({ x: S('1', 'm1', 's1') }));
  assert.equal(p.conflicts[0].kind, 'edited-on-both');
  assert.equal(p.toGit.update.length, 1);
  assert.equal(p.toDrive.update.length, 0);
});

test('deleted on Drive → removed from GitHub', () => {
  const p = plan(m({}), m({ x: G('s1') }), m({ x: S('1', 'm1', 's1') }));
  assert.equal(p.toGit.remove[0].path, 'x');
});

test('deleted on GitHub → trashed on Drive (recoverable)', () => {
  const p = plan(m({ x: D('1', 'm1') }), m({}), m({ x: S('1', 'm1', 's1') }));
  assert.equal(p.toDrive.trash[0].id, '1');
});

test('deleted on Drive but edited on GitHub → restored to Drive', () => {
  const p = plan(m({}), m({ x: G('s2') }), m({ x: S('1', 'm1', 's1') }));
  assert.equal(p.toDrive.upload[0].path, 'x');
  assert.equal(p.conflicts.length, 1);
});

test('deleted on GitHub but edited on Drive → restored to GitHub', () => {
  const p = plan(m({ x: D('1', 'm2') }), m({}), m({ x: S('1', 'm1', 's1') }));
  assert.equal(p.toGit.add[0].path, 'x');
  assert.equal(p.toDrive.trash.length, 0);
});

test('moved on Drive (same id) → git rename without re-download', () => {
  const p = plan(
    m({ 'CSE207/MI/Lectures/a.pdf': D('1', 'm1') }),
    m({ 'CSE207/MI/a.pdf': G('s1') }),
    m({ 'CSE207/MI/a.pdf': S('1', 'm1', 's1') }),
  );
  assert.deepEqual(p.toGit.move, [{ from: 'CSE207/MI/a.pdf', to: 'CSE207/MI/Lectures/a.pdf', sha: 's1', mode: '100644' }]);
  assert.equal(p.toGit.add.length + p.toGit.remove.length, 0);
  assert.equal(p.next.get('CSE207/MI/Lectures/a.pdf').sha, 's1');
});

test('moved and edited on Drive → remove old path, add new', () => {
  const p = plan(m({ 'new/a.pdf': D('1', 'm2') }), m({ 'old/a.pdf': G('s1') }), m({ 'old/a.pdf': S('1', 'm1', 's1') }));
  assert.equal(p.toGit.remove[0].path, 'old/a.pdf');
  assert.equal(p.toGit.add[0].path, 'new/a.pdf');
});

test('renamed on GitHub (same blob) → moved on Drive', () => {
  const p = plan(m({ 'old.pdf': D('1', 'm1') }), m({ 'new.pdf': G('s1') }), m({ 'old.pdf': S('1', 'm1', 's1') }));
  assert.deepEqual(p.toDrive.move, [{ id: '1', from: 'old.pdf', to: 'new.pdf' }]);
  assert.equal(p.toDrive.upload.length + p.toDrive.trash.length, 0);
});

test('files over 100 MiB stay Drive-only', () => {
  const p = plan(m({ 'v.mp4': D('1', 'm1', MAX_GIT_BYTES + 1) }), m({}), m({}));
  assert.equal(p.toGit.add.length, 0);
  assert.match(p.driveOnly[0].reason, /too large/);
  assert.equal(p.next.get('v.mp4').sha, null);
});

test('a file that grows past the limit is taken off GitHub', () => {
  const p = plan(m({ v: D('1', 'm2', MAX_GIT_BYTES + 5) }), m({ v: G('s1') }), m({ v: S('1', 'm1', 's1') }));
  assert.equal(p.toGit.remove[0].path, 'v');
});

test('Drive-only file is not trashed just because GitHub lacks it', () => {
  const p = plan(m({ v: D('1', 'm1', MAX_GIT_BYTES + 1) }), m({}), m({ v: S('1', 'm1', null) }));
  assert.equal(p.toDrive.trash.length, 0);
});

test('.syncignore paths stay Drive-only', () => {
  const isIgnored = compileIgnore('# books stay private\n*/*/Books/**\n');
  const p = plan(m({ 'CSE251/RDA/Books/x.pdf': D('1', 'm1'), 'CSE251/RDA/Labs/y.pdf': D('2', 'm2') }), m({}), m({}), { isIgnored });
  assert.deepEqual(p.toGit.add.map((a) => a.path), ['CSE251/RDA/Labs/y.pdf']);
  assert.equal(p.driveOnly[0].reason, 'ignored');
});

test('bootstrap: present on both, no state → verify by content', () => {
  const p = plan(m({ x: D('1', 'm1') }), m({ x: G('s1') }), m({}));
  assert.equal(p.toGit.update[0].expectSha, 's1');
  assert.equal(summary(p).verify, 1);
  assert.equal(summary(p).gitUpdate, 0);
});

test('bootstrap: probable rename in same folder is paired, not duplicated', () => {
  const p = plan(
    m({ 'E/Rubric 2.docx': D('7', 'mx', 2465773) }),
    m({ 'E/Rubric (2).docx': G('sx', 2465773) }),
    m({}),
  );
  assert.equal(p.toDrive.upload.length, 0);
  assert.deepEqual(p.toGit.add[0].replaces, { path: 'E/Rubric (2).docx', sha: 'sx', size: 2465773 });
});

test('bootstrap: GitHub-only exact duplicate of a Drive file is removed, not re-uploaded', () => {
  const p = plan(
    m({ 'E/Rubric 2.docx': D('7', 'mx', 5) }),
    m({ 'E/Rubric 2.docx': G('same', 5), 'E/Rubric (2).docx': G('same', 5) }),
    m({}),
  );
  assert.equal(p.toDrive.upload.length, 0);
  assert.deepEqual(p.toGit.remove, [{ path: 'E/Rubric (2).docx', why: 'duplicate of E/Rubric 2.docx' }]);
});

test('Google-native export: Drive is the only writer', () => {
  const exp = { mime: 'application/pdf', ext: 'pdf' };
  const s = new Map([['n.pdf', { id: '1', md5: null, sha: 's1', mtime: 't1', export: true }]]);
  const p = plan(m({ 'n.pdf': D('1', null, 0, { mtime: 't1', export: exp }) }), m({ 'n.pdf': G('s2') }), s);
  assert.equal(p.conflicts[0].kind, 'edited-export-on-github');
  assert.equal(p.toDrive.update.length, 0);
});

test('plan hash depends only on deletions', () => {
  const a = plan(m({}), m({ x: G('s1') }), m({ x: S('1', 'm1', 's1') }));
  const b = plan(m({ y: D('5', 'm5') }), m({ x: G('s1') }), m({ x: S('1', 'm1', 's1') }));
  assert.equal(planHash(a), planHash(b));
});
