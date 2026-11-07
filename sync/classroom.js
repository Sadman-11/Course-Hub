// Google Classroom → Drive importer.
//
// 1. Ask the Worker which Classroom courses are mapped to which library folder.
// 2. List new/updated posts (materials, coursework, announcements) per course.
// 3. Send every Drive attachment to the Worker, which dedupes them and replies
//    with the ones to import now (auto-publish courses + items approved in the
//    dashboard inbox).
// 4. Copy those into the library on Drive. The Git sync that follows in the
//    same run publishes them to GitHub and the site.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Drive, tokenSource } from './google.js';
import { categoryFromFolder, matchCategory, semesterFromDate, cleanName, CATEGORIES } from '../shared/taxonomy.js';

const API = 'https://classroom.googleapis.com/v1';
const KINDS = [
  ['courseWorkMaterials', 'courseWorkMaterial', 'Lectures'],
  ['courseWork', 'courseWork', 'Assignments'],
  ['announcements', 'announcements', 'Lectures'],
];

class Classroom {
  constructor(getToken) { this.getToken = getToken; }

  async get(url) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${await this.getToken()}` } });
    if (!res.ok) {
      const e = new Error(`Classroom ${url.replace(API, '').split('?')[0]} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
    return res.json();
  }

  async all(url, key, stop = () => false) {
    const out = [];
    let token;
    do {
      const j = await this.get(`${url}${url.includes('?') ? '&' : '?'}pageSize=100${token ? `&pageToken=${token}` : ''}`);
      for (const x of j[key] || []) {
        if (stop(x)) return out;
        out.push(x);
      }
      token = j.nextPageToken;
    } while (token);
    return out;
  }

  courses() { return this.all(`${API}/courses?courseStates=ACTIVE`, 'courses'); }
  topics(id) { return this.all(`${API}/courses/${id}/topics`, 'topic'); }
  posts(id, kind, since) {
    return this.all(`${API}/courses/${id}/${kind}?orderBy=${encodeURIComponent('updateTime desc')}`,
      kind, (x) => since && x.updateTime <= since);
  }
}

/** Where an attachment should land in the library. */
export function destinationFor({ target, semester, topic, title, kindDefault, created }) {
  const category = (topic && categoryFromFolder(topic)) || matchCategory(title) || kindDefault;
  const sem = semester || semesterFromDate(created);
  return `${target}/${CATEGORIES.includes(category) ? category : 'Lectures'}/${sem}/${cleanName(title)}`;
}

export async function importClassroom({ env, storage, rootId, reporter, dry, log }) {
  const cfg = await reporter.classroomConfig();
  if (!cfg || !cfg.connected) return { imported: [], errors: [], skipped: 'not connected' };
  // Classroom API always uses the Classroom grant. Attachments are read with the
  // storage grant when it's the same Google account (then Drive can copy server-side).
  const cls = new Classroom(tokenSource('classroom', env));
  const source = cfg.sameAccount ? storage : new Drive(tokenSource('classroom', env));
  const errors = [];

  const courses = await cls.courses();
  const discovered = courses.map((c) => ({ id: c.id, name: c.name, section: c.section || null, link: c.alternateLink }));
  const mapped = (cfg.courses || []).filter((m) => m.target && courses.some((c) => c.id === m.id));
  log(`classroom: ${courses.length} active course(s), ${mapped.length} mapped`);

  const items = [];
  const cursors = {};
  for (const m of mapped) {
    let topics = new Map();
    try { topics = new Map((await cls.topics(m.id)).map((t) => [t.topicId, t.name])); } catch (e) { errors.push(e.message); }
    let newest = m.cursor || null;
    for (const [kind, , kindDefault] of KINDS) {
      let posts = [];
      try { posts = await cls.posts(m.id, kind, m.cursor); } catch (e) { errors.push(e.message); continue; }
      for (const post of posts) {
        if (!newest || post.updateTime > newest) newest = post.updateTime;
        const topic = post.topicId ? topics.get(post.topicId) : null;
        for (const mat of post.materials || []) {
          const df = mat.driveFile;
          if (!df) continue; // links, YouTube, forms: shown in Classroom, not mirrored
          if (df.shareMode === 'STUDENT_COPY') continue; // per-student working copies are personal
          const file = df.driveFile;
          items.push({
            key: `${m.id}:${file.id}`, courseId: m.id, fileId: file.id, title: file.title,
            link: file.alternateLink, postId: post.id, postKind: kind, postTitle: post.title || (post.text || '').slice(0, 120),
            postLink: post.alternateLink, topic, created: post.creationTime, updated: post.updateTime,
            dest: destinationFor({ target: m.target, semester: m.semester, topic, title: file.title, kindDefault, created: post.creationTime }),
          });
        }
      }
    }
    if (newest) cursors[m.id] = newest;
  }

  const reply = await reporter.classroomItems({ discovered, items, cursors: dry ? {} : cursors });
  const queue = reply?.import || [];
  log(`classroom: ${items.length} attachment(s) seen, ${queue.length} to import`);
  if (dry || !queue.length) return { imported: [], errors, seen: items.length, queued: queue.length };

  const { folders, files } = await storage.tree(rootId);
  const results = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cls-'));
  for (const it of queue) {
    try {
      const meta = await source.get(it.fileId, 'id,name,mimeType,md5Checksum,size');
      const native = meta.mimeType.startsWith('application/vnd.google-apps.');
      let dest = it.dest;
      const existing = files.get(dest);
      if (existing && existing.md5 && existing.md5 === meta.md5Checksum) {
        results.push({ key: it.key, status: 'imported', driveId: existing.id, path: dest, note: 'already in library' });
        continue;
      }
      if (existing) {
        const dot = dest.lastIndexOf('.');
        const stamp = new Date().toISOString().slice(0, 10);
        dest = dot > dest.lastIndexOf('/') ? `${dest.slice(0, dot)} (${stamp})${dest.slice(dot)}` : `${dest} (${stamp})`;
      }
      const dir = dest.slice(0, dest.lastIndexOf('/'));
      const name = dest.slice(dest.lastIndexOf('/') + 1);
      const parent = await storage.ensureFolder(dir, folders);
      let created;
      if (cfg.sameAccount) {
        created = await storage.copy(it.fileId, native ? name.replace(/\.pdf$/i, '') : name, parent);
      } else {
        const f = path.join(tmp, it.fileId);
        const exp = native ? { mime: 'application/pdf', ext: 'pdf' } : null;
        await source.download({ id: it.fileId, export: exp }, f);
        const finalName = exp && !/\.pdf$/i.test(name) ? `${name}.pdf` : name;
        created = await storage.upload(finalName, parent, fs.readFileSync(f), exp ? exp.mime : meta.mimeType);
        fs.rmSync(f, { force: true });
      }
      results.push({ key: it.key, status: 'imported', driveId: created.id, path: dest, md5: created.md5Checksum || null });
      log(`  ⇣ ${dest}`);
    } catch (e) {
      results.push({ key: it.key, status: 'failed', error: String(e.message).slice(0, 300) });
      errors.push(`${it.title}: ${e.message}`);
    }
  }
  await reporter.classroomResults({ results });
  return { imported: results.filter((r) => r.status === 'imported').map((r) => r.path), errors, seen: items.length };
}
